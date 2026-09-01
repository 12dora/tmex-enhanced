#!/usr/bin/env bun
// 第十四轮实测：仓库源码起若干 production 模式临时实例，验证多 hub 第二阶段
// （签名授权 / 远程角色切换 / 跨 hub relay / token 复制 / 卸载守卫 / 写入转发）。
//
// 拓扑：A = hub,node（active 写者）；B = 已加入的 node → `tmex hub standby`；
//       C = 挂在 A 的 node；D = 经 B 加入、且被钉在 B 上的 node；
//       E / F 为 TOKENS / UNINSTALL 部分按需起的一次性实例。
//
// 分部（argv[2]，缺省 all）：
//   ADMIT      admit-hub 签名授权：无 TMEX_HUB_PEERS，B 以 authorization=signed 进入 hubs[]
//   RELAY      C 挂 A、D 挂 B，双向 `/n/<id>/api/system/info` 走跨 hub relay
//   FORWARD    经 B（standby）创建 enrollment → 转发到写者 A，带 X-Tmex-Forwarded-By
//   UNINSTALL  一次性节点 F 的卸载守卫：本机 409 UNINSTALL_NOT_ALLOWED，入口中继同样 409 且不留悬挂 operation
//   ROLE       `POST /api/hub/role` 降 A、升 B（省略 writerEpoch）→ 过渡 complete、C 切到 B、A 被围栏、再升回 A
//   TOKENS     写者 A 上建 token → replicatedTo 含 B → 杀 A、升 B → 新实例 E 凭该 token 加入 B
//
// 硬性约束：绝不触碰生产 tmex（9883 / ~/Library/Application Support/tmex）与名为 `tmex` 的 tmux session。
// 每个实例独立 install dir、端口、tmux socket（`tmex-live-r14-*`），全部 127.0.0.1。
//
// 说明：本机两台 hub 互相可达时，普通 node 的候选顺序永远是「active 优先」，
// 不存在把 D 长期留在 standby 上的天然手段（生产里靠网络分区或 G6 的 RTT 就近挂载）。
// 因此 D 加入后往 D 的 `hub_trust` 里预置一条「A 的 URL ↔ B 的 CA」错误 pin：
// D 对 A 的 TLS 永远失败 → 稳定留在 B 上。这只影响 D 的候选可达性，
// 跨 hub relay 的数据面与授权判定都还是真实路径。
//
// 用法：bun run live-r14.ts [ADMIT|RELAY|FORWARD|UNINSTALL|ROLE|TOKENS|all]
//       KEEP=1 保留 LIVE_ROOT；LIVE_ROOT=<dir> 指定根目录。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import {
  fetchAuthMode,
  loginWithRootKey,
} from '/Users/konata/code/tmex-enhanced-wt-r14/packages/app/src/lib/hub-client';
import {
  type KdfParams,
  type RootKey,
  buildAdmitHubPayload,
  buildKeyLogRecord,
  buildLogin,
  canonicalHubUrl,
  createDelegation,
  createEnrollment,
  decodeBase64url,
  deriveSeed,
  encodeDelegation,
  encodeLogin,
  generateEd25519KeyPair,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeJoinToken,
  encodeKeyLogRecord,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  signLogin,
} from '/Users/konata/code/tmex-enhanced-wt-r14/packages/shared/src/auth';

// 上面两处绝对路径必须与 REPO 一致（脚本会被复制到 scratchpad 里跑，相对路径不可用）。
const REPO = '/Users/konata/code/tmex-enhanced-wt-r14';
const CLI_AUTH = resolve(REPO, 'packages/app/src/cli-auth-entry.ts');
const SERVER = resolve(REPO, 'packages/app/src/runtime/server.ts');
const MIGRATIONS = resolve(REPO, 'apps/gateway/drizzle');
const FE_DIST = resolve(REPO, 'apps/fe/dist');
const SCRATCH =
  '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c87e7d41-4167-4f04-b03f-99760894dfcc/scratchpad';
const ROOT = process.env.LIVE_ROOT ?? `${SCRATCH}/live/run-${process.pid}`;
const PART = (process.argv[2] ?? 'all').toUpperCase();
const USER = 'alice';
const PASSWORD = 'live-r14-Passw0rd!';
const MASTER_KEY = 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=';
// 门控 hub.tokens / hub.attachments / hub.write-forward / admit-hub 的最低版本。
// 仓库 package.json 还是 1.1.12，production 下版本从 install-meta.cliVersion 读，故直接钉成 1.1.13。
const CLI_VERSION = '1.1.13';
const SOCK_PREFIX = 'tmex-live-r14-';

const log = (m: string) => process.stdout.write(`[live ${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const children = new Set<Bun.Subprocess>();

type Inst = {
  name: string;
  dir: string;
  port: number;
  peer: number;
  tls: number;
  sock: string;
  url: string;
  https: string;
  nodeId?: string;
  sid?: string;
};

const instances: Inst[] = [];

// ---------------------------------------------------------------------------
// 基础设施：端口 / 目录 / app.env / 进程守护
// ---------------------------------------------------------------------------

function canBind(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = net.createServer();
    s.once('error', () => done(false));
    s.once('listening', () => s.close(() => done(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** 一次要 6 组（A..F）三段端口：gateway=base+k、peer=base+100+k、tls=base+200+k，整块都得空着。 */
async function freeBase(from: number): Promise<number> {
  for (let base = from; base < from + 2000; base += 10) {
    let ok = true;
    for (let k = 0; k < 6 && ok; k++) {
      for (const port of [base + k, base + 100 + k, base + 200 + k]) {
        if (!(await canBind(port))) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return base;
  }
  throw new Error('no free port block');
}

function mkInst(name: string, base: number, k: number): Inst {
  const inst: Inst = {
    name,
    dir: `${ROOT}/${name}`,
    port: base + k,
    peer: base + 100 + k,
    tls: base + 200 + k,
    sock: `${SOCK_PREFIX}${name}`,
    url: `http://127.0.0.1:${base + k}`,
    https: `https://localhost:${base + 200 + k}`,
  };
  instances.push(inst);
  return inst;
}

function appEnv(i: Inst, roles: string, hubUrl: string, extra: string[] = []): string {
  return [
    'NODE_ENV=production',
    `TMEX_ROLES=${roles}`,
    `TMEX_MASTER_KEY=${MASTER_KEY}`,
    `GATEWAY_PORT=${i.port}`,
    'TMEX_BIND_HOST=127.0.0.1',
    `DATABASE_URL=${i.dir}/tmex.db`,
    `TMEX_BASE_URL=http://localhost:${i.port}`,
    `TMEX_HUB_URL=${hubUrl}`,
    `TMEX_HUB_PUBLIC_URL=${roles.includes('hub') ? i.https : ''}`,
    `TMEX_PEER_PORT=${i.peer}`,
    'TMEX_PEER_BIND_HOST=127.0.0.1',
    'TMEX_STUN_SERVERS=',
    'TMEX_UPLINK_PREFER_NEAREST=0',
    `TMEX_TMUX_SOCKET=${i.sock}`,
    'TMEX_SITE_NAME=tmex',
    `TMEX_FE_DIST_DIR=${i.dir}/resources/fe-dist`,
    `TMEX_MIGRATIONS_DIR=${MIGRATIONS}`,
    `TMEX_INSTALL_DIR=${i.dir}`,
    ...extra,
    '',
  ].join('\n');
}

/**
 * `TMEX_FE_DIST_DIR` 在 production 下必须指向存在的目录（load-env 会校验）。
 * 仓库里没有构建产物时用一份占位（本驱动只打 HTTP API，不看页面）。
 */
let feDistDir = '';
async function ensureFeDist(): Promise<string> {
  if (feDistDir) return feDistDir;
  if (existsSync(FE_DIST)) {
    feDistDir = FE_DIST;
    return feDistDir;
  }
  const stub = `${ROOT}/fe-dist-stub`;
  mkdirSync(stub, { recursive: true });
  await Bun.write(`${stub}/index.html`, '<!doctype html><title>live-r14</title>\n');
  log(`apps/fe/dist missing → using stub static root ${stub}`);
  feDistDir = stub;
  return feDistDir;
}

/** install-meta：`platform` 决定 `deployment`，这里刻意不是 darwin/linux，实例本来就没有服务管理器。 */
async function writeInstall(i: Inst, roles: string, hubUrl: string): Promise<void> {
  const dist = await ensureFeDist();
  mkdirSync(`${i.dir}/resources`, { recursive: true });
  if (!existsSync(`${i.dir}/resources/fe-dist`)) symlinkSync(dist, `${i.dir}/resources/fe-dist`);
  await Bun.write(
    `${i.dir}/install-meta.json`,
    JSON.stringify({
      cliVersion: CLI_VERSION,
      serviceName: `tmex-live-r14-${i.name}`,
      platform: 'live',
      installDir: i.dir,
    })
  );
  await Bun.write(`${i.dir}/app.env`, appEnv(i, roles, hubUrl));
}

const loops = new Map<string, Bun.Subprocess>();

function startLoop(i: Inst): void {
  const script = `cd ${REPO}; while true; do set -a; . ${i.dir}/app.env; set +a; ${process.execPath} ${SERVER} >> ${i.dir}/server.log 2>&1; echo "[loop] exit $? restart" >> ${i.dir}/server.log; sleep 1; done`;
  const p = Bun.spawn(['bash', '-c', script], { stdout: 'ignore', stderr: 'ignore' });
  children.add(p);
  loops.set(i.name, p);
  log(`${i.name} loop pid=${p.pid} port=${i.port}`);
}

function killServer(i: Inst): void {
  spawnSync('bash', [
    '-c',
    `for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${i.dir}/tmex.db"; then kill $p; fi; done; true`,
  ]);
}

function stopLoop(i: Inst): void {
  const p = loops.get(i.name);
  if (p) {
    p.kill('SIGTERM');
    children.delete(p);
    loops.delete(i.name);
  }
  killServer(i);
}

async function healthz(port: number): Promise<{ startedAt: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return r.ok ? ((await r.json()) as { startedAt: number }) : null;
  } catch {
    return null;
  }
}

async function waitHealthy(port: number, notStartedAt?: number, ms = 90_000): Promise<{ startedAt: number }> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const h = await healthz(port);
    if (h && h.startedAt !== notStartedAt) return h;
    await Bun.sleep(500);
  }
  throw new Error(`port ${port} not healthy within ${ms}ms`);
}

/** 外部强杀重启（守护 loop 会拉起来）。 */
async function restart(i: Inst): Promise<void> {
  const before = await healthz(i.port);
  killServer(i);
  await waitHealthy(i.port, before?.startedAt);
}

/** 等待实例自重启（`POST /api/hub/role` 等触发的 RuntimeController.requestRestart）。 */
async function waitSelfRestart(i: Inst, before: number, ms = 90_000): Promise<void> {
  await waitHealthy(i.port, before, ms);
}

function sql(i: Inst, query: string): string {
  return spawnSync('sqlite3', [`${i.dir}/tmex.db`, query]).stdout.toString().trim();
}

async function cli(args: string[], extra: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn([process.execPath, CLI_AUTH, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TMEX_MIGRATIONS_DIR: MIGRATIONS,
      ...extra,
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`cli ${args.join(' ')} exit ${code}\n${out}\n${err}`);
  return out;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | false>,
  ms = 120_000,
  every = 2000
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(every);
  }
  throw new Error(`timeout waiting ${label}: ${String(last)}`);
}

// ---------------------------------------------------------------------------
// 会话与 HTTP（纯 HTTP，不用浏览器）：每台实例各自登录一次，
// 组合出与前端等价的 cookie（`tmex_s_self` + 每个 node 一条）。
// ---------------------------------------------------------------------------

let rootKey: RootKey | null = null;
let meshUid = '';
let rootEpoch = 1;

function kdfFromJson(p: { salt: string; memory_kib: number; iterations: number; parallelism: number }): KdfParams {
  return {
    salt: decodeBase64url(p.salt),
    memory_kib: p.memory_kib,
    iterations: p.iterations,
    parallelism: p.parallelism,
  };
}

async function ensureRootKey(inst: Inst): Promise<RootKey> {
  if (rootKey) return rootKey;
  const mode = await fetchAuthMode(inst.url);
  if (!mode.kdfParams || !mode.uid) throw new Error(`auth mode has no user on ${inst.name}`);
  meshUid = mode.uid;
  const seed = await deriveSeed(PASSWORD, kdfFromJson(mode.kdfParams));
  rootKey = rootKeyFromSeed(seed);
  seed.fill(0);
  return rootKey;
}

/**
 * 会话按「入口」分桶：node 会话绑定签发它的入口（`viaNodeId`），
 * 直连本机拿到的 sid 只能用于本机，经 `/n/<id>/...` 转发必须用「经该入口登录」拿到的 sid。
 */
type Jar = { self?: string; via: Map<string, string> };
const jars = new Map<string, Jar>();

function jarOf(inst: Inst): Jar {
  let jar = jars.get(inst.name);
  if (!jar) {
    jar = { via: new Map() };
    jars.set(inst.name, jar);
  }
  return jar;
}

async function login(inst: Inst): Promise<void> {
  const key = await ensureRootKey(inst);
  const res = await loginWithRootKey({ baseUrl: inst.url, rootKey: key, uid: meshUid });
  inst.sid = res.sid;
  jarOf(inst).self = res.sid;
  if (!inst.nodeId) inst.nodeId = sql(inst, 'select node_id from node_identity') || undefined;
  log(`${inst.name} login ok node=${inst.nodeId?.slice(0, 8)}`);
}

/** 打某台实例时带的 cookie：本机会话 + 该入口下已登录的每个目标 node。 */
function cookieFor(entry: Inst): string {
  const jar = jarOf(entry);
  const parts: string[] = [];
  if (jar.self) {
    parts.push(`tmex_s_self=${jar.self}`);
    if (entry.nodeId) parts.push(`tmex_s_${entry.nodeId}=${jar.self}`);
  }
  for (const [nodeId, sid] of jar.via) parts.push(`tmex_s_${nodeId}=${sid}`);
  return parts.join('; ');
}

function sidFromLoginResponse(res: ApiResult, nodeId: string): string {
  const setSession = res.headers.get('x-tmex-set-session');
  if (setSession) {
    const split = setSession.indexOf(';');
    const sid = (split === -1 ? setSession : setSession.slice(0, split)).trim();
    if (sid) return sid;
  }
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(';')[0] ?? '';
    const sep = pair.indexOf('=');
    if (sep === -1) continue;
    if (pair.slice(0, sep).trim() === `tmex_s_${nodeId}`) return pair.slice(sep + 1).trim();
  }
  return '';
}

/** 经入口 `entry` 登录目标 node，拿到绑定 `via=entry` 的会话（浏览器的 fan-out 就是这么做的）。 */
async function loginVia(entry: Inst, target: Inst): Promise<void> {
  assert(target.nodeId, `${target.name} has no node id`);
  const key = await ensureRootKey(entry);
  const prefix = `/n/${target.nodeId}`;
  const targetNodeId = target.nodeId;
  // 入口只对 /api/auth/challenge 与 /api/auth/login 免节点会话转发（forwarder 的 AUTH_SKIP），
  // 所以这里不能先去读 /api/auth/mode。
  const chRes = await api(entry, 'POST', `${prefix}/api/auth/challenge`, { uid: meshUid });
  assert(chRes.status === 200, `challenge via ${entry.name} → ${chRes.status} ${chRes.text}`);
  const ch = chRes.json as { challenge_id: string; nonce: string; nodePk: string };
  const sess = generateEd25519KeyPair();
  const signed = createDelegation(key, { uid: meshUid, sessPk: sess.publicKey, now: Date.now() });
  const login = buildLogin({
    challengeId: ch.challenge_id,
    nonce: decodeBase64url(ch.nonce),
    target: targetNodeId,
    targetPk: decodeBase64url(ch.nodePk),
    uid: meshUid,
    entry: entry.nodeId ?? 'self',
  });
  const res = await api(entry, 'POST', `${prefix}/api/auth/login`, {
    login: encodeBase64url(encodeLogin(login)),
    sig: encodeBase64url(signLogin(sess.secretKey, login)),
    delegation: encodeBase64url(encodeDelegation(signed.delegation)),
    delegation_sig: encodeBase64url(signed.sig),
  });
  assert(res.status === 200, `login via ${entry.name} → ${res.status} ${res.text}`);
  const sid = sidFromLoginResponse(res, target.nodeId);
  assert(sid, `login via ${entry.name} returned no sid for ${target.name}`);
  jarOf(entry).via.set(target.nodeId, sid);
  log(`${entry.name} → ${target.name} node session issued`);
}

async function ensureVia(entry: Inst, target: Inst): Promise<void> {
  if (entry === target || !target.nodeId) return;
  if (jarOf(entry).via.has(target.nodeId)) return;
  await loginVia(entry, target);
}

/** 经入口打目标 node 的接口；节点会话失效（401 NODE_LOGIN_REQUIRED）时重登一次。 */
async function relay(
  entry: Inst,
  target: Inst,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  await ensureVia(entry, target);
  const full = `/n/${target.nodeId}${path}`;
  let res = await api(entry, method, full, body);
  if (res.status === 401 && target.nodeId) {
    jarOf(entry).via.delete(target.nodeId);
    await ensureVia(entry, target);
    res = await api(entry, method, full, body);
  }
  return res;
}

type ApiResult = { status: number; json: unknown; headers: Headers; text: string };

async function rawApi(
  target: Inst,
  method: string,
  path: string,
  body?: unknown,
  opts: { https?: boolean; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  const base = opts.https ? target.https : target.url;
  const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    method,
    headers: {
      cookie: cookieFor(target),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.headers ?? {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
  };
  if (opts.https) init.tls = { rejectUnauthorized: false };
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}

/** 会话可能因重启/过期失效，401 时重登一次。 */
async function api(
  target: Inst,
  method: string,
  path: string,
  body?: unknown,
  opts: { https?: boolean; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  let res = await rawApi(target, method, path, body, opts);
  if (res.status === 401 && (res.json as { code?: string } | null)?.code !== 'NODE_LOGIN_REQUIRED') {
    await login(target);
    res = await rawApi(target, method, path, body, opts);
  }
  return res;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// key log：admit-node / admit-hub 记录的构造与提交
// ---------------------------------------------------------------------------

type Head = { seq: bigint; hash: Uint8Array; rootEpoch: number; uid: string };

async function keyLogHead(inst: Inst): Promise<Head> {
  const res = await api(inst, 'GET', '/api/auth/keylog/head');
  assert(res.status === 200, `keylog head on ${inst.name} → ${res.status} ${res.text}`);
  const body = res.json as { seq: string | number; hash: string; rootEpoch: number; uid: string };
  rootEpoch = body.rootEpoch;
  meshUid = body.uid;
  return {
    seq: BigInt(String(body.seq)),
    hash: decodeBase64url(body.hash),
    rootEpoch: body.rootEpoch,
    uid: body.uid,
  };
}

async function appendSigned(
  writer: Inst,
  type: 'admit-node' | 'admit-hub',
  payload: Uint8Array,
  headers: Record<string, string> = {}
): Promise<ApiResult> {
  const key = await ensureRootKey(writer);
  const head = await keyLogHead(writer);
  const record = buildKeyLogRecord(
    { seq: head.seq, hash: head.hash },
    head.rootEpoch,
    { uid: head.uid, type, payload, signer: 'root', credential_id: null }
  );
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(key, bytes);
  return api(
    writer,
    'POST',
    '/api/auth/keylog?hub=sync',
    { bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) },
    { headers }
  );
}

// ---------------------------------------------------------------------------
// enrollment / join（全程 HTTP + CLI，不依赖 `tmex enroll` 的交互输出）
// ---------------------------------------------------------------------------

type Enrollment = Awaited<ReturnType<typeof createEnrollment>>;

type CreatedToken = {
  id: string;
  token: string;
  enrollment: Enrollment;
  caPem: string | null;
  caFingerprint: string | null;
  status: number;
  forwardedBy: string | null;
  replicatedTo: string[];
};

/**
 * 经 `hub` 这台实例创建 enrollment（standby 会转发到写者），并组装 join 串。
 * join 串里的 CA 指纹必须是**被 join 的那台 hub** 的，否则 node 侧 pin bootstrap 会失败。
 */
async function createToken(hub: Inst, opts: { https?: boolean; ttlMs?: number } = {}): Promise<CreatedToken> {
  const key = await ensureRootKey(hub);
  const head = await keyLogHead(hub);
  const now = Date.now();
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const enrollment = await createEnrollment(key, { uid: head.uid, rootEpoch: head.rootEpoch, now, ttlMs });
  const res = await api(
    hub,
    'POST',
    '/api/hub/enrollments',
    {
      enroll_pk: encodeBase64url(enrollment.enrollPk),
      authorization: encodeBase64url(enrollment.authorizationBytes),
      authorization_sig: encodeBase64url(enrollment.authorizationSig),
      exp: now + ttlMs,
    },
    { https: opts.https }
  );
  assert(
    res.status === 200 || res.status === 201,
    `create enrollment on ${hub.name} → ${res.status} ${res.text}`
  );
  const body = res.json as {
    id: string;
    ca_fingerprint?: string | null;
    ca_cert_pem?: string | null;
    replicatedTo?: string[];
  };
  const rootPk = await modeRootPublicKey(hub);
  assert(rootPk, `auth mode on ${hub.name} has no rootPublicKey`);
  // 经 standby 创建时响应里的 ca_fingerprint / public_url 属于**写者**，
  // join 串要的是被 join 的这台 hub 自己的 CA。
  const caFingerprint = await hubCaFingerprint(hub);
  assert(caFingerprint, `no CA fingerprint for ${hub.name}`);
  const token = encodeJoinToken(enrollment.enrollSk, rootPk, head.hash, caFingerprint);
  return {
    id: body.id,
    token,
    enrollment,
    caPem: body.ca_cert_pem ?? null,
    caFingerprint,
    status: res.status,
    forwardedBy: res.headers.get('x-tmex-forwarded-by'),
    replicatedTo: body.replicatedTo ?? [],
  };
}

async function modeRootPublicKey(inst: Inst): Promise<Uint8Array | null> {
  const res = await fetch(`${inst.url}/api/auth/mode`);
  const body = (await res.json()) as { rootPublicKey?: string | null };
  if (!body.rootPublicKey) return null;
  return decodeBase64url(body.rootPublicKey);
}

async function hubCaFingerprint(inst: Inst): Promise<string | null> {
  const res = await api(inst, 'GET', '/api/tls');
  const body = res.json as { caFingerprint?: string | null } | null;
  return body?.caFingerprint ?? null;
}

/** 在写者上等 token 被 redeem，然后签一条 admit-node 让全网认这台机器。 */
async function admitRedeemed(
  writer: Inst,
  created: { id: string; enrollment: Enrollment },
  label: string
): Promise<void> {
  const cert = await waitFor(
    `${label} redeemed on ${writer.name}`,
    async () => {
      const res = await api(writer, 'GET', `/api/hub/enrollments/${created.id}`);
      if (res.status !== 200) return null;
      const body = res.json as { status?: string; certificate?: string; cert_sig?: string; already_admitted?: boolean };
      if (body.status !== 'redeemed' || !body.certificate || !body.cert_sig) return null;
      return body as { certificate: string; cert_sig: string; already_admitted?: boolean };
    },
    120_000,
    1000
  );
  if (cert.already_admitted) {
    log(`${label} already admitted`);
    return;
  }
  const payload = encodeAdmitNodePayload({
    authorization_bytes: created.enrollment.authorizationBytes,
    authorization_sig: created.enrollment.authorizationSig,
    certificate_bytes: decodeBase64url(cert.certificate),
    cert_sig: decodeBase64url(cert.cert_sig),
  });
  const res = await appendSigned(writer, 'admit-node', payload);
  assert(res.status === 200, `admit-node for ${label} → ${res.status} ${res.text}`);
  log(`${label} admitted (seq=${(res.json as { seq?: unknown })?.seq})`);
}

/** joinHub 决定 join 串的 CA 与 TMEX_HUB_URL；token 的落库与 admit 永远在写者上。 */
async function joinNode(joinHub: Inst, writer: Inst, node: Inst, name: string): Promise<CreatedToken> {
  const created = await createToken(joinHub, { https: joinHub !== writer });
  log(
    `${name} token via ${joinHub.name} status=${created.status} forwardedBy=${created.forwardedBy ?? '-'} replicated=${JSON.stringify(created.replicatedTo)}`
  );
  const out = await cli([
    'hub',
    'join',
    joinHub.https,
    '--token',
    created.token,
    '--name',
    name,
    '--install-dir',
    node.dir,
    '--no-restart',
  ]);
  log(`${name} join: ${out.trim().split('\n').slice(-1).join(' | ')}`);
  await admitRedeemed(writer, created, name);
  node.nodeId = sql(node, 'select node_id from node_identity');
  assert(node.nodeId, `${name} has no node_identity`);
  return created;
}

async function enableTls(inst: Inst): Promise<string> {
  const res = await api(inst, 'PUT', '/api/tls', {
    mode: 'selfsigned',
    sans: ['localhost', '127.0.0.1'],
    tlsPort: inst.tls,
    bindHost: '127.0.0.1',
  });
  assert(res.status === 200, `enable tls on ${inst.name} → ${res.status} ${res.text}`);
  await waitFor(
    `${inst.name} https up`,
    async () => {
      try {
        const probe = await fetch(`${inst.https}/healthz`, {
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        return probe.ok;
      } catch {
        return false;
      }
    },
    60_000,
    500
  );
  const fp = await hubCaFingerprint(inst);
  assert(fp, `${inst.name} has no CA fingerprint after enabling TLS`);
  log(`${inst.name} tls selfsigned ca=${fp.slice(0, 16)}`);
  return fp;
}

// ---------------------------------------------------------------------------
// mesh 视图辅助
// ---------------------------------------------------------------------------

type HubRow = {
  nodeId: string;
  publicUrl: string;
  mode: string;
  priority: number;
  writerEpoch: number;
  online?: boolean;
  authorization?: string;
};
type HubsView = {
  hubs: HubRow[];
  attached: { hubNodeId: string | null; publicUrl: string; mode: string | null } | null;
  writerHubId: string | null;
  candidates: Array<{ publicUrl: string; lastError?: string | null }>;
};
type MeshNodeRow = { id: string; name: string; online: boolean; loggedIn: boolean; version: string | null; attachedHubId?: string | null };

async function hubsOf(inst: Inst): Promise<HubsView> {
  const res = await api(inst, 'GET', '/api/mesh/hubs');
  assert(res.status === 200, `mesh/hubs on ${inst.name} → ${res.status} ${res.text}`);
  return res.json as HubsView;
}

async function nodesOf(inst: Inst): Promise<MeshNodeRow[]> {
  const res = await api(inst, 'GET', '/api/mesh/nodes');
  assert(res.status === 200, `mesh/nodes on ${inst.name} → ${res.status} ${res.text}`);
  return ((res.json as { nodes?: MeshNodeRow[] })?.nodes ?? []);
}

function describeHubs(view: HubsView): string {
  return `${JSON.stringify(
    view.hubs.map((h) => ({
      id: h.nodeId.slice(0, 6),
      mode: h.mode,
      epoch: h.writerEpoch,
      auth: h.authorization ?? '-',
      online: h.online,
    }))
  )} attached=${view.attached?.hubNodeId?.slice(0, 6) ?? '-'} writer=${view.writerHubId?.slice(0, 6) ?? '-'}`;
}

async function waitAttached(node: Inst, hub: Inst, ms: number): Promise<void> {
  await waitFor(
    `${node.name} attached to ${hub.name}`,
    async () => {
      const view = await hubsOf(node);
      return view.attached?.hubNodeId === hub.nodeId ? view : null;
    },
    ms,
    2000
  );
}

/** 目标 hub 的角色切换：走入口 A 的 `/n/<hubId>/api/hub/role`；A 自己不可用时直连目标。 */
async function switchRole(
  entry: Inst,
  target: Inst,
  mode: 'active' | 'standby',
  opts: { direct?: boolean } = {}
): Promise<string> {
  const operationId = crypto.randomUUID();
  const before = (await healthz(target.port))?.startedAt;
  const res = await waitFor(
    `${target.name} accepts role=${mode}`,
    async () => {
      const r = opts.direct
        ? await api(target, 'POST', '/api/hub/role', { mode, operationId })
        : await relay(entry, target, 'POST', '/api/hub/role', { mode, operationId });
      // 入口刚重启时目标 uplink 还没回来，503 NODE_UNREACHABLE 只是暂态
      if (r.status === 503) return null;
      return r;
    },
    120_000,
    3000
  );
  assert(
    res.status === 202 || res.status === 200,
    `role ${mode} on ${target.name} → ${res.status} ${res.text}`
  );
  log(`${target.name} role→${mode} accepted ${JSON.stringify(res.json)}`);
  await waitSelfRestart(target, before ?? 0);
  await login(target);
  const status = await waitFor(
    `${target.name} role transition ${operationId.slice(0, 8)} complete`,
    async () => {
      const r = await api(target, 'GET', `/api/hub/role/status?operationId=${operationId}`);
      if (r.status !== 200) return null;
      const body = r.json as { phase?: string; writerEpoch?: number | null };
      if (body.phase === 'complete') return body;
      if (body.phase === 'failed') throw new Error(`role transition failed: ${r.text}`);
      return null;
    },
    90_000,
    2000
  );
  log(`${target.name} role transition complete epoch=${status.writerEpoch ?? '-'}`);
  return operationId;
}

/** 目标不是当前写者时，把它提升回写者（分部之间互不依赖前一部的收尾状态）。 */
async function ensureWriter(t: Topology, target: Inst): Promise<void> {
  const view = await hubsOf(target);
  if (view.writerHubId === target.nodeId) return;
  log(`${target.name} is not the writer (${view.writerHubId?.slice(0, 6) ?? '-'}), promoting`);
  await switchRole(t.A, target, 'active', { direct: true });
  await waitFor(
    `${target.name} becomes writer`,
    async () => (await hubsOf(target)).writerHubId === target.nodeId,
    120_000
  );
}

// ---------------------------------------------------------------------------
// bootstrap：A/B/C/D 拓扑（所有分部共用）
// ---------------------------------------------------------------------------

type Topology = { A: Inst; B: Inst; C: Inst; base: number; D?: Inst };

async function bootstrap(): Promise<Topology> {
  const base = await freeBase(21800);
  const A = mkInst('A', base, 0);
  const B = mkInst('B', base, 1);
  const C = mkInst('C', base, 2);
  for (const i of [A, B, C]) spawnSync('tmux', ['-L', i.sock, 'kill-server']);
  await writeInstall(A, 'hub,node', '');
  await writeInstall(B, 'standalone', '');
  await writeInstall(C, 'standalone', '');
  log(`root=${ROOT} A=${A.port} B=${B.port} C=${C.port}`);

  await cli(['hub', 'user', 'add', USER, '--install-dir', A.dir], { TMEX_PASSWORD: PASSWORD });
  startLoop(A);
  await waitHealthy(A.port);
  A.nodeId = sql(A, 'select node_id from node_identity');
  await login(A);
  await enableTls(A);

  startLoop(B);
  startLoop(C);
  await waitHealthy(B.port);
  await waitHealthy(C.port);

  await joinNode(A, A, B, 'node-b');
  await restart(B);
  await login(B);
  await joinNode(A, A, C, 'node-c');
  await restart(C);
  await login(C);

  const seen = await waitFor(
    'A sees B,C online with version',
    async () => {
      const rows = await nodesOf(A);
      const ok = [B.nodeId, C.nodeId].every((id) =>
        rows.some((n) => n.id === id && n.online && n.version === CLI_VERSION)
      );
      return ok ? rows : null;
    },
    120_000
  );
  log(`A nodes: ${JSON.stringify(seen.map((n) => ({ id: n.id.slice(0, 6), on: n.online, v: n.version })))}`);

  // B → standby hub（自动把 A 写进 B 的 TMEX_HUB_PEERS；A 侧不写 env，只靠签名 admit-hub）
  await enableTls(B);
  const standbyOut = await cli([
    'hub',
    'standby',
    '--public-url',
    B.https,
    '--priority',
    '200',
    '--install-dir',
    B.dir,
    '--no-restart',
  ]);
  log(`B standby: ${standbyOut.trim().split('\n').slice(-3).join(' | ')}`);
  await restart(B);
  await login(B);

  // 签名授权：admit-hub（A 的 app.env 里不写 TMEX_HUB_PEERS）
  const admit = await appendSigned(
    A,
    'admit-hub',
    buildAdmitHubPayload({ hubNodeId: hexToBytes(B.nodeId ?? ''), publicUrl: B.https, priority: 200 })
  );
  assert(admit.status === 200, `admit-hub → ${admit.status} ${admit.text}`);
  log(`admit-hub applied seq=${(admit.json as { seq?: unknown })?.seq}`);

  await waitFor(
    'A publishes B as standby',
    async () => {
      const view = await hubsOf(A);
      const b = view.hubs.find((h) => h.nodeId === B.nodeId);
      return b?.mode === 'standby' ? view : null;
    },
    120_000
  );

  return { A, B, C, base };
}

/** D 只有 RELAY 需要：经 B 加入（standby 把写入转发给写者 A），随后钉死在 B 上。 */
async function ensureD(t: Topology): Promise<Inst> {
  if (t.D) return t.D;
  const D = mkInst('D', t.base, 3);
  t.D = D;
  await writeInstall(D, 'standalone', '');
  spawnSync('tmux', ['-L', D.sock, 'kill-server']);
  startLoop(D);
  await waitHealthy(D.port);
  await joinNode(t.B, t.A, D, 'node-d');
  poisonHubPin(D, t.A, t.B);
  await restart(D);
  await login(D);
  await waitAttached(D, t.B, 120_000);
  log(`D hubs: ${describeHubs(await hubsOf(D))}`);
  return D;
}

/** 给 `victim` 预置一条指向 `unreachable` URL 的错误 CA pin（用 `pinFrom` 的 CA），使其永远连不上那台 hub。 */
function poisonHubPin(victim: Inst, unreachable: Inst, pinFrom: Inst): void {
  const caPem = sql(pinFrom, 'select ca_cert_pem from tls_config limit 1');
  assert(caPem.includes('BEGIN CERTIFICATE'), `no CA pem on ${pinFrom.name}`);
  const url = canonicalHubUrl(unreachable.https);
  const escaped = caPem.replace(/'/g, "''");
  const out = spawnSync('sqlite3', [
    `${victim.dir}/tmex.db`,
    `insert or replace into hub_trust (hub_url, ca_pem, fingerprint, created_at) values ('${url}', '${escaped}', '${'0'.repeat(64)}', ${Date.now()});`,
  ]);
  assert(out.status === 0, `poison pin failed: ${out.stderr.toString()}`);
  log(`${victim.name} pinned a wrong CA for ${url} (keeps it attached to ${pinFrom.name})`);
}

// ---------------------------------------------------------------------------
// 分部
// ---------------------------------------------------------------------------

async function partAdmit(t: Topology): Promise<void> {
  const envPeers = spawnSync('grep', ['-c', '^TMEX_HUB_PEERS=..*', `${t.A.dir}/app.env`]).stdout.toString().trim();
  assert(envPeers === '0', `A must not need TMEX_HUB_PEERS (grep count=${envPeers})`);

  for (const viewer of [t.A, t.C]) {
    const view = await waitFor(
      `${viewer.name} sees B signed`,
      async () => {
        const v = await hubsOf(viewer);
        const b = v.hubs.find((h) => h.nodeId === t.B.nodeId);
        return b && b.mode === 'standby' && b.authorization === 'signed' ? v : null;
      },
      120_000
    );
    log(`${viewer.name} hubs: ${describeHubs(view)}`);
    const a = view.hubs.find((h) => h.nodeId === t.A.nodeId);
    assert(a?.mode === 'active', `${viewer.name}: A must stay active, got ${a?.mode}`);
    assert(view.writerHubId === t.A.nodeId, `${viewer.name}: writer must be A`);
  }
  log(`C mesh_hubs: ${sql(t.C, 'select substr(hub_node_id,1,6), mode, priority, writer_epoch, online from mesh_hubs')}`);
  log(`C hub_trust: ${sql(t.C, 'select hub_url, substr(fingerprint,1,12) from hub_trust')}`);
}

async function partRelay(t: Topology): Promise<void> {
  const D = await ensureD(t);
  await waitAttached(t.C, t.A, 120_000);
  await waitAttached(D, t.B, 120_000);

  const routed = await waitFor(
    'writer projects attachedHubId for C and D',
    async () => {
      const rows = await nodesOf(t.A);
      const c = rows.find((n) => n.id === t.C.nodeId);
      const d = rows.find((n) => n.id === D.nodeId);
      return c?.attachedHubId === t.A.nodeId && d?.attachedHubId === t.B.nodeId ? rows : null;
    },
    120_000
  );
  log(
    `A mesh/nodes: ${JSON.stringify(
      routed.map((n) => ({ id: n.id.slice(0, 6), hub: n.attachedHubId?.slice(0, 6) ?? '-', on: n.online }))
    )}`
  );

  const cToD = await waitFor(
    'C → D cross-hub relay',
    async () => {
      const res = await relay(t.C, D, 'GET', '/api/system/info');
      return res.status === 200 ? res : null;
    },
    90_000,
    3000
  );
  log(`C → D /api/system/info → ${cToD.status} ${cToD.text.slice(0, 120)}`);

  const dToC = await waitFor(
    'D → C cross-hub relay',
    async () => {
      const res = await relay(D, t.C, 'GET', '/api/system/info');
      return res.status === 200 ? res : null;
    },
    90_000,
    3000
  );
  log(`D → C /api/system/info → ${dToC.status} ${dToC.text.slice(0, 120)}`);
}

async function partForward(t: Topology): Promise<void> {
  await ensureWriter(t, t.A);
  const view = await hubsOf(t.B);
  assert(view.writerHubId === t.A.nodeId, `B must see A as writer, got ${view.writerHubId}`);
  const created = await createToken(t.B, { https: true });
  assert(created.status === 200 || created.status === 201, `forwarded create → ${created.status}`);
  assert(
    created.forwardedBy === t.B.nodeId,
    `X-Tmex-Forwarded-By must be B (${t.B.nodeId}), got ${created.forwardedBy}`
  );
  const onWriter = await api(t.A, 'GET', `/api/hub/enrollments/${created.id}`);
  assert(onWriter.status === 200, `token ${created.id} missing on writer A → ${onWriter.status}`);
  log(`forwarded enrollment ${created.id} status=${created.status} forwardedBy=${created.forwardedBy}`);
  const row = sql(t.A, `select id from enrollment_tokens where id='${created.id}'`);
  assert(row === created.id, `token row not on A: ${row}`);
}

async function partUninstall(t: Topology): Promise<void> {
  const F = mkInst('F', t.base, 5);
  await writeInstall(F, 'standalone', '');
  spawnSync('tmux', ['-L', F.sock, 'kill-server']);
  startLoop(F);
  await waitHealthy(F.port);
  await joinNode(t.A, t.A, F, 'node-f');
  await restart(F);
  await login(F);
  await waitFor(
    'A sees F online',
    async () => (await nodesOf(t.A)).some((n) => n.id === F.nodeId && n.online),
    120_000
  );

  const local = await api(F, 'POST', '/api/system/uninstall', { mode: 'full' });
  log(`F local uninstall → ${local.status} ${local.text}`);
  assert(local.status === 409, `local uninstall must be 409, got ${local.status} ${local.text}`);
  const localBody = local.json as { code?: string; reason?: string };
  assert(
    localBody.code === 'UNINSTALL_NOT_ALLOWED',
    `local uninstall code must be UNINSTALL_NOT_ALLOWED, got ${localBody.code}`
  );
  log(`F local uninstall reason=${localBody.reason ?? '-'}`);

  await ensureVia(t.A, F);
  const relayed = await api(t.A, 'POST', `/api/mesh/nodes/${F.nodeId}/uninstall`, {});
  log(`A → F uninstall relay → ${relayed.status} ${relayed.text}`);
  assert(relayed.status === 409, `relayed uninstall must be 409, got ${relayed.status} ${relayed.text}`);
  const relayedBody = relayed.json as { code?: string; reason?: string };
  assert(
    relayedBody.code === 'UNINSTALL_NOT_ALLOWED',
    `relayed code must be UNINSTALL_NOT_ALLOWED, got ${relayedBody.code}`
  );

  const op = await api(t.A, 'GET', `/api/mesh/nodes/${F.nodeId}/operation`);
  log(`A F operation → ${op.status} ${op.text}`);
  if (op.status === 200) {
    const phase = (op.json as { phase?: string }).phase;
    assert(
      phase === 'failed',
      `operation must not linger in-flight, phase=${phase}`
    );
  } else {
    assert(op.status === 404, `operation lookup → ${op.status}`);
  }
  const alive = await healthz(F.port);
  assert(alive, 'F must still be running after a blocked uninstall');
}

async function partRole(t: Topology): Promise<void> {
  const before = await hubsOf(t.C);
  log(`before role switch, C: ${describeHubs(before)}`);
  const epochBefore = before.hubs.find((h) => h.nodeId === t.A.nodeId)?.writerEpoch ?? 0;

  await switchRole(t.A, t.A, 'standby');
  await switchRole(t.A, t.B, 'active');

  const afterPromote = await waitFor(
    'C sees B as writer',
    async () => {
      const v = await hubsOf(t.C);
      const a = v.hubs.find((h) => h.nodeId === t.A.nodeId);
      const b = v.hubs.find((h) => h.nodeId === t.B.nodeId);
      return a?.mode === 'standby' && b?.mode === 'active' && v.writerHubId === t.B.nodeId ? v : null;
    },
    120_000
  );
  log(`after promote B, C: ${describeHubs(afterPromote)}`);
  const bEpoch = afterPromote.hubs.find((h) => h.nodeId === t.B.nodeId)?.writerEpoch ?? 0;
  assert(bEpoch > epochBefore, `B epoch must exceed A's old epoch (${bEpoch} vs ${epochBefore})`);

  await waitAttached(t.C, t.B, 120_000);
  log(`C failed over to B, candidates=${JSON.stringify((await hubsOf(t.C)).candidates)}`);

  // A 回到 standby 且被更高 epoch 围栏（重启后依然是 standby）
  await restart(t.A);
  await login(t.A);
  const aView = await waitFor(
    'A stays fenced as standby after restart',
    async () => {
      const v = await hubsOf(t.A);
      const self = v.hubs.find((h) => h.nodeId === t.A.nodeId);
      return self?.mode === 'standby' && v.writerHubId === t.B.nodeId ? v : null;
    },
    120_000
  );
  log(`A after restart: ${describeHubs(aView)}`);
  const fenceLog = spawnSync('bash', [
    '-c',
    `grep -n 'fenced\\|split-brain' ${t.A.dir}/server.log | tail -3`,
  ]).stdout.toString().trim();
  log(`A fence log: ${fenceLog || '(none)'}`);

  // 切回 A：省略 writerEpoch，由目标自行分配
  await switchRole(t.B, t.A, 'active', { direct: true });
  const back = await waitFor(
    'writer switches back to A',
    async () => {
      const v = await hubsOf(t.C);
      const a = v.hubs.find((h) => h.nodeId === t.A.nodeId);
      return a?.mode === 'active' && v.writerHubId === t.A.nodeId ? v : null;
    },
    120_000
  );
  log(`after promote A, C: ${describeHubs(back)}`);
  const aEpoch = back.hubs.find((h) => h.nodeId === t.A.nodeId)?.writerEpoch ?? 0;
  assert(aEpoch > bEpoch, `A epoch must exceed B's (${aEpoch} vs ${bEpoch})`);
  await waitAttached(t.C, t.A, 180_000);
}

async function partTokens(t: Topology): Promise<void> {
  await ensureWriter(t, t.A);

  const key = await ensureRootKey(t.A);
  const head = await keyLogHead(t.A);
  const now = Date.now();
  const ttlMs = 30 * 60_000;
  const enrollment = await createEnrollment(key, { uid: head.uid, rootEpoch: head.rootEpoch, now, ttlMs });
  const res = await api(t.A, 'POST', '/api/hub/enrollments', {
    enroll_pk: encodeBase64url(enrollment.enrollPk),
    authorization: encodeBase64url(enrollment.authorizationBytes),
    authorization_sig: encodeBase64url(enrollment.authorizationSig),
    exp: now + ttlMs,
  });
  assert(res.status === 201 || res.status === 200, `create on writer → ${res.status} ${res.text}`);
  const body = res.json as { id: string; replicatedTo?: string[] };
  log(`writer token ${body.id} replicatedTo=${JSON.stringify(body.replicatedTo ?? [])}`);
  if (!(body.replicatedTo ?? []).includes(t.B.nodeId ?? '')) {
    // ACK 是 2 s 尽力而为，复制本身仍应到达 standby
    await waitFor(
      'token replicated to B',
      () => Promise.resolve(sql(t.B, `select id from enrollment_tokens where id='${body.id}'`) === body.id),
      60_000,
      2000
    );
    log(`token ${body.id} present on B (replicatedTo was empty, ACK raced)`);
  } else {
    assert(
      sql(t.B, `select id from enrollment_tokens where id='${body.id}'`) === body.id,
      'replicatedTo claimed B but the row is missing there'
    );
  }

  // 杀写者 → 提升 B → 用同一个 token 让新实例 E 加入 B
  log('stopping A …');
  stopLoop(t.A);
  await switchRole(t.B, t.B, 'active', { direct: true });
  await waitFor(
    'B is the writer',
    async () => (await hubsOf(t.B)).writerHubId === t.B.nodeId,
    120_000
  );

  const bFingerprint = await hubCaFingerprint(t.B);
  assert(bFingerprint, 'B has no CA fingerprint');
  const rootPk = await modeRootPublicKey(t.B);
  assert(rootPk, 'B has no rootPublicKey');
  const bHead = await keyLogHead(t.B);
  const token = encodeJoinToken(enrollment.enrollSk, rootPk, bHead.hash, bFingerprint);

  const E = mkInst('E', t.base, 4);
  await writeInstall(E, 'standalone', '');
  spawnSync('tmux', ['-L', E.sock, 'kill-server']);
  startLoop(E);
  await waitHealthy(E.port);
  const out = await cli([
    'hub',
    'join',
    t.B.https,
    '--token',
    token,
    '--name',
    'node-e',
    '--install-dir',
    E.dir,
    '--no-restart',
  ]);
  log(`E join via B: ${out.trim().split('\n').slice(-1).join(' | ')}`);
  E.nodeId = sql(E, 'select node_id from node_identity');
  assert(E.nodeId, 'E has no node_identity after join');
  const redeemed = sql(t.B, `select used_at is not null, node_id from enrollment_tokens where id='${body.id}'`);
  log(`B token row after redeem: ${redeemed}`);
  assert(redeemed.startsWith('1|'), `token must be redeemed on B, got ${redeemed}`);
  await admitRedeemed(t.B, { id: body.id, enrollment }, 'node-e');
  await restart(E);
  await login(E);
  log(`E joined: node=${E.nodeId.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

const ORDER = ['ADMIT', 'RELAY', 'FORWARD', 'UNINSTALL', 'ROLE', 'TOKENS'] as const;
type PartName = (typeof ORDER)[number];
const PARTS: Record<PartName, (t: Topology) => Promise<void>> = {
  ADMIT: partAdmit,
  RELAY: partRelay,
  FORWARD: partForward,
  UNINSTALL: partUninstall,
  ROLE: partRole,
  TOKENS: partTokens,
};

const failures: string[] = [];

async function runPart(name: PartName, t: Topology): Promise<void> {
  log(`--- Part ${name} ---`);
  try {
    await PARTS[name](t);
    process.stdout.write(`PASS ${name}\n`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stdout.write(`FAIL ${name}: ${reason}\n`);
    failures.push(name);
  }
}

async function main(): Promise<void> {
  const selected: PartName[] =
    PART === 'ALL' ? [...ORDER] : ORDER.filter((n) => n === PART);
  if (selected.length === 0) throw new Error(`unknown part ${PART}; use ${ORDER.join('|')}|all`);
  mkdirSync(ROOT, { recursive: true });
  const t = await bootstrap();
  for (const name of selected) await runPart(name, t);
  log(`DONE failures=${failures.length ? failures.join(',') : 'none'}`);
}

function cleanup(): void {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  spawnSync('bash', [
    '-c',
    `for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${ROOT}"; then kill $p; fi; done; true`,
  ]);
  for (const inst of instances) {
    spawnSync('tmux', ['-L', inst.sock, 'kill-server']);
    spawnSync('bash', ['-c', `rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${inst.sock}"`]);
  }
  if (process.env.KEEP !== '1') {
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  } else {
    log(`KEEP=1 → LIVE_ROOT=${ROOT}`);
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    cleanup();
    process.exit(1);
  });
