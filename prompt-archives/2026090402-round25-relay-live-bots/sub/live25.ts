/**
 * LT（第 25 轮）：Hub → 中继 现网迁移的多进程演练驱动。
 *
 * 场景（与生产迁移 runbook 一一对应）：
 *  1. hub mesh 起来：H1(hub,node "tmexhub-sh") + E(node "mac", token 加入, 驱动持根钥当浏览器)
 *     + N1(node "jiefa-app", Hub 口令加入) + N2(node "docker-node", token 加入)
 *  2. 开 TOTP；N3 走「带 TOTP 码的 Hub 口令加入」（G2），并验证不带码应回 totp_required
 *  3. 迁移：H1 hub leave → setup/relay(role=relay) → E 接入中继(enroll+set-relays+pack)
 *     → 各节点 hub leave + relay join → E 吊销旧身份 + meta-key rotate → enrollment 扇出(G4)
 *  4. 负例：relay,node → /api/local/leave{targetRole:'relay'}（G3 幽灵租户），再 relay join 恢复
 *
 * 安全边界：
 *  - 只监听 127.0.0.1:19981–19989；生产 9883 与 ~/Library/Application Support/tmex 只读不碰
 *  - tmux 一律 `tmex-live25` 独立 socket；service-name 一律 `tmex-live25-*`（绝不用默认 `tmex`）
 *  - 每个实例跑在自己的仓库 APFS 克隆里，setup 写的 test.env.local 落在 scratch
 *  - 进程 env 白名单构造，不 spread process.env
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const REPO = '/Users/konata/code/tmex-r25';
const LIVE =
  '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/2da64d3c-b5e4-4192-98f5-dbd74931b528/scratchpad/live/r25';
const TMUX_SOCKET = 'tmex-live25';
const FE_DIST = `${REPO}/apps/fe/dist`;
const SKIP_CLONE = process.argv.includes('--skip-clone');
/** 根轮换后迁移的复现模式：H1/E/N1/N2 四台 + 一次 rotate-root-keep + readmit（G7）。 */
const ROTATED = process.argv.includes('--rotated');

import {
  type RootKey,
  buildKeyLogRecord,
  buildLogin,
  createDelegation,
  createEnrollment,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeDelegation,
  encodeJoinToken,
  encodeKeyLogRecord,
  encodeLogin,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  encodeSetTotpPayload,
  generateKdfParams,
  encryptTotpSecret,
  generateEd25519KeyPair,
  hexToBytes,
  hubHostFromUrl,
  randomBytes,
  rootKeyFromSeed,
  signHubEnrollProof,
  signKeyLogRecordWithRoot,
  signLogin,
  totpCode,
} from '/Users/konata/code/tmex-r25/packages/shared/src/auth';
import * as wsBorsh from '/Users/konata/code/tmex-r25/packages/shared/src/ws-borsh/index';
import {
  encodeRelayJoinToken,
  kdfParamsToWire,
  sealRelayPack,
  signRelayEnrollProof,
} from '/Users/konata/code/tmex-r25/packages/shared/src/relay';

const MASTER_KEY = (() => {
  const text = readFileSync(`${REPO}/test.env`, 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('TMEX_MASTER_KEY='));
  if (!line) throw new Error('TMEX_MASTER_KEY missing from test.env');
  return line.slice('TMEX_MASTER_KEY='.length).trim();
})();

const USER_PASSWORD = 'lt25-live-password-1';
const NEW_PASSWORD = 'lt25-live-password-2-rotated';
const RELAY_PASSWORD = 'relay-pass-r25-hub';

// ── 日志与断言 ───────────────────────────────────────────────────────────────
const t0 = Date.now();
const results: Array<{ step: string; ok: boolean; note: string }> = [];
const runbook: string[] = [];
function log(msg: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  console.log(`[${s}s] ${msg}`);
}
function rb(line: string): void {
  runbook.push(line);
  log(`RUN  ${line}`);
}
function record(step: string, ok: boolean, note: string): void {
  results.push({ step, ok, note });
  log(`${ok ? 'PASS' : 'FAIL'} ${step} — ${note}`);
}
function check(cond: unknown, step: string, note: string): boolean {
  const ok = Boolean(cond);
  record(step, ok, note);
  return ok;
}
function must(cond: unknown, step: string, note: string): void {
  if (!check(cond, step, note)) throw new Error(`step failed: ${step} — ${note}`);
}
function short(v: unknown, n = 220): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, n).replaceAll('\n', ' / ');
}

// ── 实例管理 ────────────────────────────────────────────────────────────────
type Inst = {
  name: string;
  dir: string;
  repoRoot: string;
  db: string;
  port: number;
  peer: number;
  roles: string;
  url: string;
  siteName: string;
  proc?: Bun.Subprocess;
  extraEnv: Record<string, string>;
};

const instances: Inst[] = [];

function serviceName(i: Inst): string {
  return `tmex-live25-${i.name.toLowerCase()}`;
}

function baseEnv(i: Inst): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    USER: process.env.USER ?? '',
    SHELL: process.env.SHELL ?? '/bin/zsh',
    TERM: 'xterm-256color',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NODE_ENV: 'test',
    TMEX_MASTER_KEY: MASTER_KEY,
    TMEX_ROLES: i.roles,
    GATEWAY_PORT: String(i.port),
    TMEX_BIND_HOST: '127.0.0.1',
    DATABASE_URL: i.db,
    TMEX_MIGRATIONS_DIR: `${i.repoRoot}/apps/gateway/drizzle`,
    TMEX_FE_DIST_DIR: FE_DIST,
    TMEX_BASE_URL: i.url,
    TMEX_PEER_PORT: String(i.peer),
    TMEX_PEER_BIND_HOST: '127.0.0.1',
    TMEX_STUN_SERVERS: '',
    TMEX_DIRECT_ENABLED: 'false',
    TMEX_TMUX_SOCKET: TMUX_SOCKET,
    TMEX_SITE_NAME: i.siteName,
    TMEX_INSTALL_DIR: i.dir,
    ...i.extraEnv,
  };
}

function cloneRepo(name: string): string {
  const dst = `${LIVE}/repos/${name}`;
  if (SKIP_CLONE && existsSync(`${dst}/packages/app/src/runtime/server.ts`)) {
    log(`repo clone ${name} reused`);
    return dst;
  }
  const started = Date.now();
  const run = spawnSync('bash', [`${LIVE}/clone-repo.sh`, REPO, dst], { stdio: 'pipe' });
  if (run.status !== 0) throw new Error(`clone ${name} failed: ${run.stdout}${run.stderr}`);
  log(`repo clone ${name} ready in ${Date.now() - started}ms`);
  return dst;
}

function mkInst(
  name: string,
  port: number,
  peer: number,
  roles: string,
  siteName: string
): Inst {
  const dir = `${LIVE}/inst/${name}`;
  mkdirSync(dir, { recursive: true });
  const inst: Inst = {
    name,
    dir,
    repoRoot: cloneRepo(name),
    db: `${dir}/tmex.db`,
    port,
    peer,
    roles,
    url: `http://127.0.0.1:${port}`,
    siteName,
    extraEnv: {},
  };
  instances.push(inst);
  writeAppEnv(inst);
  return inst;
}

const MIRRORED_ENV_KEYS = [
  'TMEX_HUB_URL',
  'TMEX_HUB_PUBLIC_URL',
  'TMEX_HUB_MODE',
  'TMEX_HUB_PRIORITY',
  'TMEX_HUB_WRITER_EPOCH',
  'TMEX_HUB_PEERS',
  'TMEX_RELAY_PUBLIC_URL',
  'TMEX_RELAY_ADMIN_TOKEN',
] as const;

/** CLI（`tmex hub leave` / `tmex relay join`）读的安装态 env；接线键与 test.env.local 双向同步。 */
function writeAppEnv(i: Inst): void {
  const local = readEnvLocal(i);
  const mirrored: Record<string, string> = {};
  for (const key of MIRRORED_ENV_KEYS) {
    if (local[key] !== undefined) mirrored[key] = local[key];
  }
  const merged: Record<string, string> = {
    DATABASE_URL: i.db,
    TMEX_MASTER_KEY: MASTER_KEY,
    TMEX_MIGRATIONS_DIR: `${i.repoRoot}/apps/gateway/drizzle`,
    NODE_ENV: 'test',
    TMEX_SITE_NAME: i.siteName,
    ...mirrored,
    ...i.extraEnv,
    TMEX_ROLES: i.roles,
  };
  writeFileSync(
    `${i.dir}/app.env`,
    `${Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`
  );
}

function readEnvFileAt(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
const readEnvLocal = (i: Inst): Record<string, string> =>
  readEnvFileAt(`${i.repoRoot}/test.env.local`);
const readAppEnv = (i: Inst): Record<string, string> => readEnvFileAt(`${i.dir}/app.env`);

function writeEnvLocal(i: Inst, patch: Record<string, string>): void {
  const next = { ...readEnvLocal(i), ...patch };
  writeFileSync(
    `${i.repoRoot}/test.env.local`,
    `${Object.entries(next)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`
  );
}

/**
 * loadEnv() 里 `<repoRoot>/test.env.local` 覆盖进程 env，所以每次启动前把权威角色
 * 同步进该文件；setup 路由写进去的中继键（TMEX_RELAY_*）原样保留。
 */
/** CLI 写完 app.env 之后，把角色/上级键同步进 test.env.local（loadEnv 以该文件为准）。 */
function adoptAppEnv(i: Inst): Record<string, string> {
  const env = readAppEnv(i);
  i.roles = env.TMEX_ROLES ?? i.roles;
  const patch: Record<string, string> = { TMEX_ROLES: i.roles };
  for (const key of MIRRORED_ENV_KEYS) {
    if (env[key] !== undefined) patch[key] = env[key];
  }
  if (env.TMEX_HUB_URL === undefined) patch.TMEX_HUB_URL = '';
  if (env.TMEX_HUB_PUBLIC_URL === undefined) patch.TMEX_HUB_PUBLIC_URL = '';
  writeEnvLocal(i, patch);
  return env;
}

async function boot(i: Inst): Promise<void> {
  writeEnvLocal(i, { TMEX_ROLES: i.roles, ...i.extraEnv });
  writeAppEnv(i);
  const logFile = `${i.dir}/server.log`;
  const proc = Bun.spawn(
    [
      'bash',
      '-c',
      `exec ${process.execPath} ${i.repoRoot}/packages/app/src/runtime/server.ts >> ${logFile} 2>&1`,
    ],
    { cwd: i.repoRoot, env: baseEnv(i), stdout: 'ignore', stderr: 'ignore' }
  );
  i.proc = proc;
  log(`${i.name} spawned pid=${proc.pid} port=${i.port} roles=${i.roles}`);
  await waitHealthy(i);
}

async function waitHealthy(i: Inst, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${i.url}/healthz`);
      if (r.ok) {
        log(`${i.name} healthy`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(300);
  }
  const tail = spawnSync('tail', ['-40', `${i.dir}/server.log`]).stdout.toString();
  throw new Error(`${i.name} not healthy in ${ms}ms\n${tail}`);
}

async function waitExitAndReboot(i: Inst, roles?: string): Promise<number> {
  const code = i.proc ? await i.proc.exited : -1;
  i.proc = undefined;
  await waitPortFree(i.port);
  if (roles) i.roles = roles;
  await boot(i);
  return code;
}

async function stopInst(i: Inst): Promise<void> {
  if (i.proc) {
    try {
      i.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    await i.proc.exited.catch(() => 0);
    i.proc = undefined;
  }
  killStrays(i);
  await waitPortFree(i.port);
}

function killStrays(i: Inst): void {
  spawnSync('bash', [
    '-c',
    `for p in $(pgrep -f "${LIVE}/repos/" 2>/dev/null); do if ps eww $p 2>/dev/null | grep -q "DATABASE_URL=${i.db}"; then kill $p; fi; done; true`,
  ]);
}

async function waitPortFree(port: number, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await canBind(port)) return;
    await Bun.sleep(200);
  }
  throw new Error(`port ${port} still busy`);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = net.createServer();
    s.once('error', () => done(false));
    s.once('listening', () => s.close(() => done(true)));
    s.listen(port, '127.0.0.1');
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
type CliResult = { status: number | null; out: string };

function cli(i: Inst, args: string[], env: Record<string, string> = {}): CliResult {
  const full = [...args, '--install-dir', i.dir, '--service-name', serviceName(i)];
  const run = spawnSync(process.execPath, [`${i.repoRoot}/packages/app/src/cli-auth-entry.ts`, ...full], {
    cwd: i.repoRoot,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      NODE_ENV: 'test',
      TMEX_MASTER_KEY: MASTER_KEY,
      TMEX_MIGRATIONS_DIR: `${i.repoRoot}/apps/gateway/drizzle`,
      TMEX_CLI_LANG: 'en_US',
      TMEX_TMUX_SOCKET: TMUX_SOCKET,
      ...env,
    },
  });
  const out = `${run.stdout?.toString() ?? ''}${run.stderr?.toString() ?? ''}`.trim();
  log(`${i.name} cli ${full.join(' ')} → exit=${run.status}\n      ${short(out, 400)}`);
  return { status: run.status, out };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;

async function call(
  url: string,
  init: RequestInit & { cookie?: string } = {}
): Promise<{ status: number; body: Json; text: string }> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(url, { ...init, headers, redirect: 'error' });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
}

async function callRaw(url: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await fetch(url, { ...init, headers, redirect: 'error' });
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | false | undefined>,
  ms = 30_000,
  every = 500
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = await fn().catch((e) => {
      last = e;
      return null;
    });
    if (value) return value as T;
    await Bun.sleep(every);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${String(last)})` : ''}`);
}

async function tryWaitFor<T>(
  label: string,
  fn: () => Promise<T | null | false | undefined>,
  ms = 30_000,
  every = 500
): Promise<T | null> {
  try {
    return await waitFor(label, fn, ms, every);
  } catch {
    return null;
  }
}

// ── 会话（驱动 = 浏览器：持根种子） ─────────────────────────────────────────
type Session = { url: string; cookie: string; userId: string; rootKey: RootKey; nodeId: string };

/** TOTP 打开之后所有 method=root 的登录都要带 `totp`。 */
let totpSecret: Uint8Array | null = null;

function totpBody(rootKey: RootKey, uid: string, rootEpoch: number): Json | null {
  if (!totpSecret) return null;
  const kTotp = deriveTotpKey(rootKey.seed, uid, rootEpoch);
  return {
    code: totpCode(totpSecret, Math.floor(Date.now() / 1000)),
    k_totp: encodeBase64url(kTotp),
  };
}

async function openSession(
  i: Inst,
  password: string,
  opts: { withTotp?: boolean } = {}
): Promise<Session> {
  const mode = (await call(`${i.url}/api/auth/mode`)).body as {
    uid?: string;
    nodeId?: string;
    rootEpoch?: number;
    kdfParams?: { salt: string; memory_kib: number; iterations: number; parallelism: number };
  };
  if (!mode.kdfParams || !mode.uid) throw new Error(`no user on ${i.name}: ${JSON.stringify(mode)}`);
  const kdf = {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  };
  const rootKey = rootKeyFromSeed(await deriveSeed(password, kdf));
  const uid = mode.uid;
  const chRes = await callRaw(`${i.url}/api/auth/challenge`, {
    method: 'POST',
    body: JSON.stringify({ uid }),
  });
  const ch = (await chRes.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const sess = generateEd25519KeyPair();
  const del = createDelegation(rootKey, { uid, sessPk: sess.publicKey, now: Date.now() });
  const nodeId = mode.nodeId || 'self';
  const login = buildLogin({
    challengeId: ch.challenge_id,
    nonce: decodeBase64url(ch.nonce),
    target: nodeId,
    targetPk: decodeBase64url(ch.nodePk),
    uid,
    entry: 'self',
  });
  const totp =
    opts.withTotp === false ? null : totpBody(rootKey, uid, mode.rootEpoch ?? 0);
  const loginRes = await callRaw(`${i.url}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(encodeDelegation(del.delegation)),
      delegation_sig: encodeBase64url(del.sig),
      ...(totp ? { totp } : {}),
    }),
  });
  if (loginRes.status !== 200) {
    throw new Error(`login on ${i.name} ${loginRes.status}: ${await loginRes.text()}`);
  }
  return {
    url: i.url,
    cookie: `tmex_s_self=${sidFrom(loginRes, 'self')}`,
    userId: uid,
    rootKey,
    nodeId,
  };
}

function sidFrom(res: Response, nodeId: string): string {
  const prefix = `tmex_s_${nodeId}=`;
  for (const cookie of res.headers.getSetCookie?.() ?? []) {
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length).split(';')[0] ?? '';
  }
  const header = res.headers.get('set-cookie') ?? '';
  const m = header.match(new RegExp(`tmex_s_${nodeId}=([^;]*)`));
  if (m?.[1]) return m[1];
  throw new Error(`no session cookie for ${nodeId}: ${header}`);
}

async function sessionJson(s: Session, path: string, init: RequestInit = {}): Promise<Json> {
  const r = await call(`${s.url}${path}`, { ...init, cookie: s.cookie });
  if (r.status !== 200 && r.status !== 201) throw new Error(`${path} ${r.status}: ${r.text}`);
  return r.body;
}

type RecordType =
  | 'set-relays'
  | 'meta-key'
  | 'rename-node'
  | 'admit-node'
  | 'readmit-node'
  | 'revoke-node'
  | 'rotate-root-keep'
  | 'set-totp';

async function submitRecord(
  s: Session,
  type: RecordType,
  payload: Uint8Array,
  sync: boolean
): Promise<{ status: number; body: Json; text: string }> {
  const head = (await sessionJson(s, '/api/auth/keylog/head')) as {
    seq: number | string;
    hash: string;
    rootEpoch: number;
    uid?: string;
  };
  const rec = buildKeyLogRecord(
    { seq: BigInt(head.seq), hash: decodeBase64url(head.hash) },
    head.rootEpoch,
    { uid: head.uid ?? s.userId, type, payload, signer: 'root', credential_id: null }
  );
  const bytes = encodeKeyLogRecord(rec);
  const sig = signKeyLogRecordWithRoot(s.rootKey, bytes);
  return await call(`${s.url}/api/auth/keylog${sync ? '?hub=sync' : ''}`, {
    method: 'POST',
    cookie: s.cookie,
    body: JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) }),
  });
}

type RelayStatus = {
  mode: string;
  tenantId: string | null;
  relays: Array<{ url: string; online: boolean; attached: boolean; kicked: boolean; rttMs: number | null }>;
  metaEpoch: number;
  nodesViaRelay: number;
  quota: { currentNodes?: number } | null;
};

const relayStatus = async (s: Session): Promise<RelayStatus> =>
  (await sessionJson(s, '/api/mesh/relay/status')) as unknown as RelayStatus;

async function applyPrepared(
  s: Session,
  body: Json,
  type: 'set-relays' | 'meta-key',
  sync: boolean
): Promise<{ status: number; text: string }> {
  const payload = body.payload;
  if (typeof payload !== 'string') throw new Error(`no payload in ${short(body)}`);
  const r = await submitRecord(s, type, decodeBase64url(payload), sync);
  return { status: r.status, text: r.text };
}

function sqlite(db: string, query: string): string {
  return spawnSync('sqlite3', [db, query]).stdout.toString().trim();
}

type MeshNode = { id: string; name: string | null; online: boolean };
async function meshNodes(s: Session): Promise<MeshNode[]> {
  const body = (await sessionJson(s, '/api/mesh/nodes')) as unknown as { nodes: MeshNode[] };
  return body.nodes ?? [];
}
const nodesBrief = (rows: MeshNode[]): string =>
  JSON.stringify(rows.map((n) => ({ id: n.id.slice(0, 8), name: n.name, online: n.online })));

// ═══════════════════════════════════════════════════════════════════════════
const st: {
  uid?: string;
  certCount?: number;
  tenantId?: string;
  relayUrl?: string;
  old: Record<string, string>;
  fresh: Record<string, string>;
} = { old: {}, fresh: {} };

async function main(): Promise<void> {
  // 网关口 19981–19986（任务指定窗口）；对端口 19971–19976：peer server 即使
  // TMEX_DIRECT_ENABLED=false 也照样 bind，6 个实例在 19981–19989 里放不下两套口。
  const ports = [
    19981, 19982, 19983, 19984, 19985, 19986, 19987, 19988, 19989, 19971, 19972, 19973, 19974,
    19975, 19976, 19977,
  ];
  for (const port of ports) {
    if (!(await canBind(port))) throw new Error(`port ${port} is busy — refusing to start`);
  }
  spawnSync('bash', ['-c', `rm -rf ${LIVE}/inst; rm -f ${LIVE}/repos/*/test.env.local`]);
  log(`preflight ok. fe dist present=${existsSync(FE_DIST)}`);

  const H1 = mkInst('H1', 19981, 19971, 'standalone', 'tmexhub-sh');
  const E = mkInst('E', 19982, 19972, 'standalone', 'mac');
  const N1 = mkInst('N1', 19983, 19973, 'standalone', 'jiefa-app');
  const N2 = mkInst('N2', 19984, 19974, 'standalone', 'docker-node');
  const N3 = mkInst('N3', 19985, 19975, 'standalone', 'n3-totp');
  const N4 = mkInst('N4', 19986, 19976, 'standalone', 'n4-token');
  const A = mkInst('A', 19987, 19977, 'standalone', 'hub-a');

  if (ROTATED) {
    await mainRotated(H1, E, N1, N2);
    return;
  }
  const sh = await step1(H1, E, N1, N2);
  await step1c(sh, H1, A);
  let se = await openSession(E, USER_PASSWORD);
  await step1b(se);
  await step2(sh, se, N3);
  se = await openSession(E, USER_PASSWORD); // TOTP 打开之后重新登录一次，证明带码可登
  await step3a(H1, se);
  await step3b(H1);
  await step3c(H1, E, se);
  await step3d(N1, se, 'jiefa-app');
  await step3e(H1, se);
  await step3d(N2, se, 'docker-node');
  await step3d(N3, se, 'n3-totp');
  await step3d(A, se, 'hub-a');
  checkStandbyLeftovers(A);
  await step3g(H1, se);
  await step3h(H1, N4, se);
  await step4(H1, se);
}

// ═══════════════════════════════════════════════════════════════════════════
// --rotated：根轮换之后的迁移（复现现网 member-epoch_mismatch，并证明 G7 的修法）
// ═══════════════════════════════════════════════════════════════════════════
async function mainRotated(H1: Inst, E: Inst, N1: Inst, N2: Inst): Promise<void> {
  await step1(H1, E, N1, N2);
  let se = await openSession(E, USER_PASSWORD);
  await step1b(se, 4);
  se = await stepRotate(E, se);
  await step3a(H1, se);
  await step3b(H1);
  await step3cRotated(H1, E, se);
  // 改密之后节点侧的密码加入要用**新**密码（旧密码派生出的根钥对不上，中继回 RELAY_BAD_PROOF）
  await step3d(N1, se, 'jiefa-app', NEW_PASSWORD);
}

/** 一次常规改密（`rotate-root-keep`）：新密码派生新根，记录仍由**旧**根签。 */
async function stepRotate(E: Inst, se: Session): Promise<Session> {
  const before = (await call(`${E.url}/api/auth/mode`, { cookie: se.cookie })).body as {
    rootEpoch?: number;
  };
  const newKdf = generateKdfParams();
  const newSeed = await deriveSeed(NEW_PASSWORD, newKdf);
  const newRoot = rootKeyFromSeed(newSeed);
  rb('browser@E: 常规改密 —— 旧根签 rotate-root-keep{root_public_key:新根, kdf_params:新盐, totp:null} → POST /api/auth/keylog?hub=sync');
  const res = await submitRecord(
    se,
    'rotate-root-keep',
    encodeRotateRootKeepPayload({
      root_public_key: new Uint8Array(newRoot.publicKey),
      kdf_params: newKdf,
      totp: null,
    }),
    true
  );
  must(
    res.status === 200,
    'R1.1 旧根签的 rotate-root-keep 落账（?hub=sync）',
    `HTTP ${res.status} ${short(res.text)}`
  );

  const after = (await call(`${E.url}/api/auth/mode`)).body as { rootEpoch?: number };
  must(
    (after.rootEpoch ?? -1) === (before.rootEpoch ?? 0) + 1,
    'R1.2 /api/auth/mode 的 rootEpoch +1',
    `${String(before.rootEpoch)} → ${String(after.rootEpoch)}`
  );

  const next = await openSession(E, NEW_PASSWORD);
  must(
    next.userId === se.userId,
    'R1.3 E 能用新密码登录（驱动切到新根钥）',
    `uid=${next.userId} nodeId=${next.nodeId}`
  );

  const rows = await waitFor(
    'all 4 nodes still online after rotate',
    async () => {
      const list = await meshNodes(next);
      return list.filter((n) => n.online).length >= 4 ? list : null;
    },
    60_000
  );
  check(true, 'R1.4 改密后其余节点照常在线（rotate-root-keep 不动会话与证书）', nodesBrief(rows));

  const certs = sqlite(E.db, 'select count(*) from node_certs where revoked_log_seq is null;');
  const stale = sqlite(
    E.db,
    `select count(*) from node_certs where revoked_log_seq is null and admit_record_seq in (select seq from user_key_log where type='admit-node');`
  );
  check(
    certs === stale && Number(certs) >= 4,
    'R1.5 全部未吊销证书的 admit-node 都停留在旧 epoch（正是现网的病灶）',
    `未吊销证书=${certs}，其中由 admit-node 承认的=${stale}；新 rootEpoch=${String(after.rootEpoch)}`
  );
  st.certCount = Number(certs);
  return next;
}

type ReadmitEntry = {
  nodeId: string;
  name: string;
  admitSeq: number;
  admitRootEpoch: number;
  authorization_bytes: string;
  certificate_bytes: string;
  cert_sig: string;
};

/** G7 的 readmit：用当前根重签 authorization，记录类型 `readmit-node`。 */
async function runReadmit(se: Session): Promise<{ total: number; ok: number; detail: string[] }> {
  const prep = (await sessionJson(se, '/api/mesh/relay/readmit/prepare')) as unknown as {
    rootEpoch: number;
    entries: ReadmitEntry[];
  };
  const detail: string[] = [];
  let ok = 0;
  for (const entry of prep.entries) {
    const authorizationBytes = decodeBase64url(entry.authorization_bytes);
    const payload = encodeAdmitNodePayload({
      authorization_bytes: authorizationBytes,
      authorization_sig: se.rootKey.sign(authorizationBytes),
      certificate_bytes: decodeBase64url(entry.certificate_bytes),
      cert_sig: decodeBase64url(entry.cert_sig),
    });
    const r = await submitRecord(se, 'readmit-node', payload, true);
    detail.push(
      `${entry.name}(${entry.nodeId.slice(0, 8)}) admitSeq=${entry.admitSeq} epoch ${entry.admitRootEpoch}→${prep.rootEpoch} HTTP ${r.status}`
    );
    if (r.status === 200) ok += 1;
    else detail[detail.length - 1] += ` ${short(r.text, 140)}`;
  }
  return { total: prep.entries.length, ok, detail };
}

// ── 3c（根轮换版）：enroll → 先复现失败 → readmit → set-relays 成功 ────────
async function step3cRotated(H1: Inst, E: Inst, se: Session): Promise<void> {
  rb(`browser@E: POST /api/mesh/relay/enroll/proof-material {url:'${H1.url}'} → signRelayEnrollProof(新根)`);
  const material = (await sessionJson(se, '/api/mesh/relay/enroll/proof-material', {
    method: 'POST',
    body: JSON.stringify({ url: H1.url }),
  })) as unknown as { relayHost: string; ts: number };
  const proof = signRelayEnrollProof(se.rootKey, { relayHost: material.relayHost, ts: material.ts });
  rb(`browser@E: POST /api/mesh/relay/enroll {url, password, proof} → 关注 readmitRequired`);
  const enrolled = await call(`${se.url}/api/mesh/relay/enroll`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      url: H1.url,
      password: RELAY_PASSWORD,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  must(
    enrolled.status === 200 && typeof enrolled.body.tenantId === 'string',
    'R2.1 POST /api/mesh/relay/enroll → 200 + tenantId',
    `HTTP ${enrolled.status} ${short(enrolled.text)}`
  );
  st.tenantId = String(enrolled.body.tenantId);
  const required = Number(enrolled.body.readmitRequired ?? -1);
  check(
    required === st.certCount,
    'R2.2 [G7] enroll 响应带 readmitRequired = 未吊销证书数',
    `readmitRequired=${required}，未吊销证书=${String(st.certCount)}；tenantId=${st.tenantId}`
  );

  const prep = (await sessionJson(se, '/api/mesh/relay/readmit/prepare')) as unknown as {
    rootEpoch: number;
    entries: ReadmitEntry[];
  };
  const listed = prep.entries.map((e) => `${e.name}(${e.nodeId.slice(0, 8)})@epoch${e.admitRootEpoch}`);
  check(
    prep.entries.length === required && prep.entries.every((e) => e.admitRootEpoch < prep.rootEpoch),
    'R2.3 [G7] GET /api/mesh/relay/readmit/prepare 列出全部陈旧成员',
    `rootEpoch=${prep.rootEpoch} entries(${prep.entries.length})=${listed.join(', ')}`
  );
  const pendingBefore = (await relayStatus(se)) as RelayStatus & { readmitPending?: number };
  check(
    pendingBefore.readmitPending === required,
    'R2.4 [G7] /api/mesh/relay/status 的 readmitPending 与之一致',
    `readmitPending=${String(pendingBefore.readmitPending)}`
  );

  // ── 反面对照：先不 readmit，直接写 set-relays，复现现网的 member-epoch_mismatch ──
  rb('【对照·现网故障】不先 readmit，直接根钥签 set-relays → POST /api/auth/keylog?hub=sync');
  const early = await applyPrepared(se, enrolled.body, 'set-relays', true);
  must(early.status === 200, 'R3.1 set-relays 落账（尚未 readmit）', `HTTP ${early.status} ${short(early.text)}`);
  // 拒绝原因由中继在 relay.auth 里回给节点，落在**节点自己**的 uplink 日志里
  // （中继侧不打印；`/api/mesh/relay/status` 的 lastError 只在 attached 时才填，
  //  挂不上的时候恒为 null——这是个可观测性缺口，见 §七）。
  const nodeErr = (): string =>
    spawnSync('bash', ['-c', `grep -o 'err=member-[a-z_]*' ${E.dir}/server.log 2>/dev/null | tail -1`])
      .stdout.toString()
      .trim();
  const stuck = await tryWaitFor(
    'relay auth rejected with member-epoch_mismatch',
    async () => {
      const st2 = await relayStatus(se);
      return !st2.relays[0]?.attached && /member-epoch_mismatch/.test(nodeErr()) ? st2 : null;
    },
    90_000,
    2000
  );
  const afterEarly = await relayStatus(se);
  const registryEmpty = sqlite(
    H1.db,
    `select count(*) from relay_nodes where tenant_id='${st.tenantId}';`
  );
  check(
    stuck !== null,
    'R3.2 【复现】跳过 readmit 时中继拒绝 relay.auth：member-epoch_mismatch，E 一直挂不上',
    `mode=${afterEarly.mode} attached=${String(afterEarly.relays[0]?.attached)} ` +
      `E 的 uplink 日志: ${nodeErr() || '(无)'}；status.lastError=${String(afterEarly.relays[0]?.lastError)}（挂不上时恒 null）；` +
      `relay_nodes(本租户)=${registryEmpty}（空 = 一个成员也没登记上）`
  );

  // ── G7 的修法：用当前根重签全部成员，节点随即挂上 ──
  rb('browser@E: GET /api/mesh/relay/readmit/prepare → 每条用新根重签 authorization → readmit-node → POST /api/auth/keylog?hub=sync');
  const readmit = await runReadmit(se);
  must(
    readmit.ok === readmit.total && readmit.total === required,
    'R4.1 [G7] 逐条 readmit-node 落账（root signer，重签 authorization_bytes）',
    `${readmit.ok}/${readmit.total}；${readmit.detail.join(' | ')}`
  );

  const attached = await waitFor(
    'E attached after readmit',
    async () => {
      const st2 = await relayStatus(se);
      return st2.mode === 'relay' && st2.relays[0]?.attached && st2.relays[0]?.online ? st2 : null;
    },
    120_000
  );
  check(
    true,
    'R4.2 readmit 之后 E 立刻挂上中继（mode=relay attached=true）',
    `relays=${short(attached.relays, 260)}`
  );
  const pendingAfter = (await relayStatus(se)) as RelayStatus & { readmitPending?: number };
  check(
    pendingAfter.readmitPending === 0,
    'R4.3 readmitPending 归零',
    `readmitPending=${String(pendingAfter.readmitPending)}`
  );

  // 密封包（与非轮换路径同一条）
  const jm = (await sessionJson(se, '/api/mesh/relay/join-material?scope=all')) as unknown as {
    logKey: string;
    relays: Array<{ url: string; tenantId: string; token: string }>;
  };
  const head = (await sessionJson(se, '/api/auth/keylog/head')) as {
    seq: number | string;
    hash: string;
    rootEpoch: number;
  };
  const mode = (await call(`${E.url}/api/auth/mode`, { cookie: se.cookie })).body as {
    kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
  };
  const kdfWire = kdfParamsToWire({
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  const packs: Array<{ url: string; sealed_pack: string }> = [];
  for (const relay of jm.relays) {
    const sealed = await sealRelayPack({
      rootSeed: se.rootKey.seed,
      tenantId: relay.tenantId,
      rootPublicKey: se.rootKey.publicKey,
      rootEpoch: head.rootEpoch,
      plaintext: {
        log_key: decodeBase64url(jm.logKey),
        token: decodeBase64url(relay.token),
        head_seq: BigInt(head.seq),
        head_hash: decodeBase64url(head.hash),
        issued_at: BigInt(Date.now()),
      },
    });
    packs.push({ url: relay.url, sealed_pack: encodeBase64url(sealed) });
  }
  rb('browser@E: 按新 root_epoch 重封密封包 → POST /api/mesh/relay/pack');
  const upload = await call(`${E.url}/api/mesh/relay/pack`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      packs,
      kdf_params: kdfWire,
      root_epoch: head.rootEpoch,
      head_seq: Number(head.seq),
    }),
  });
  must(
    upload.status === 200 && upload.body.ok === true,
    'R4.4 新 root_epoch 的密封包上传成功',
    `root_epoch=${head.rootEpoch} HTTP ${upload.status} ${short(upload.text)}`
  );

  const rows = await tryWaitFor(
    'relay registry admitted',
    async () => {
      const text = sqlite(
        H1.db,
        `select group_concat(substr(node_id,1,8)||':'||status, ' | ') from relay_nodes where tenant_id='${st.tenantId}';`
      );
      return text.includes('admitted') ? text : null;
    },
    60_000
  );
  const wanted = [st.old.H1, st.old.E, st.old.N1, st.old.N2].filter(Boolean);
  const full = sqlite(
    H1.db,
    `select group_concat(node_id||':'||status, ' | ') from relay_nodes where tenant_id='${st.tenantId}';`
  );
  const present = wanted.filter((id) => full.includes(`${id}:admitted`));
  check(
    present.length >= 1 && rows !== null,
    'R4.5 中继注册表把成员标为 admitted',
    `期望 ${wanted.length} 台（H1/E/N1/N2）中至少 E 已 admitted，实到 ${present.length}；relay_nodes = ${full || '(空)'}`
  );
}

// ── 1. hub mesh 起来 ────────────────────────────────────────────────────────
async function step1(H1: Inst, E: Inst, N1: Inst, N2: Inst): Promise<Session> {
  await boot(H1);
  rb(`H1: POST /api/setup/hub {hubPublicUrl:'${H1.url}', username:'admin', password:'<mesh pw>'}`);
  const setup = await call(`${H1.url}/api/setup/hub`, {
    method: 'POST',
    body: JSON.stringify({ hubPublicUrl: H1.url, username: 'admin', password: USER_PASSWORD }),
  });
  must(
    setup.status === 200 && setup.body.restarting === true,
    '1.1 H1 POST /api/setup/hub → restarting:true',
    `HTTP ${setup.status} ${short(setup.text)}`
  );
  await waitExitAndReboot(H1, 'hub,node');
  const sh = await openSession(H1, USER_PASSWORD);
  st.uid = sh.userId;
  st.old.H1 = sh.nodeId;
  must(
    (await sessionJson(sh, '/api/local/status')).role === 'hub,node',
    '1.2 H1 重启后 role=hub,node',
    `nodeId=${sh.nodeId} uid=${sh.userId} env=${short(readEnvLocal(H1))}`
  );

  st.old.E = await joinByToken(sh, H1, E, 'mac');
  st.old.N2 = await joinByToken(sh, H1, N2, 'docker-node');
  st.old.N1 = await joinByHubPassword(sh, H1, N1, 'jiefa-app', undefined, '1.5');
  return sh;
}

/** 浏览器建 enrollment → 节点 `/api/setup/join {method:'token'}` → 浏览器签 admit-node。 */
async function joinByToken(sh: Session, H1: Inst, target: Inst, name: string): Promise<string> {
  const mode = (await call(`${H1.url}/api/auth/mode`, { cookie: sh.cookie })).body as {
    rootEpoch?: number;
    rootPublicKey?: string;
  };
  const head = (await sessionJson(sh, '/api/auth/keylog/head')) as { hash: string };
  const now = Date.now();
  const enrollment = await createEnrollment(sh.rootKey, {
    uid: sh.userId,
    rootEpoch: mode.rootEpoch ?? 0,
    now,
  });
  rb(`browser@H1: POST /api/hub/enrollments {enroll_pk, authorization, authorization_sig, exp} (为 ${name} 生成 join 串)`);
  const created = await call(`${H1.url}/api/hub/enrollments`, {
    method: 'POST',
    cookie: sh.cookie,
    body: JSON.stringify({
      enroll_pk: encodeBase64url(enrollment.enrollPk),
      authorization: encodeBase64url(enrollment.authorizationBytes),
      authorization_sig: encodeBase64url(enrollment.authorizationSig),
      exp: now + 600_000,
    }),
  });
  must(
    created.status === 200 || created.status === 201,
    `1.3 ${name}: POST /api/hub/enrollments 建 enrollment`,
    `HTTP ${created.status} ${short(created.text)}`
  );
  const token = encodeJoinToken(
    enrollment.enrollSk,
    decodeBase64url(mode.rootPublicKey as string),
    decodeBase64url(head.hash),
    (created.body.ca_fingerprint as string | null) ?? null
  );

  await boot(target);
  rb(`${target.name}: POST /api/setup/join {method:'token', hubUrl:'${H1.url}', token:'<join 串>', name:'${name}', insecureLocal:true}`);
  const join = await call(`${target.url}/api/setup/join`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'token',
      hubUrl: H1.url,
      token,
      name,
      insecureLocal: true,
    }),
  });
  must(
    join.status === 200 && join.body.restarting === true,
    `1.3b ${name} token 加入 → restarting:true`,
    `HTTP ${join.status} ${short(join.text)}`
  );
  await waitExitAndReboot(target, 'node');

  const row = await waitFor(
    `${name} pending on hub`,
    async () => {
      const list = (await sessionJson(sh, '/api/hub/nodes')) as unknown as {
        nodes?: Array<Record<string, unknown>>;
      };
      const rows = list.nodes ?? (list as unknown as Array<Record<string, unknown>>);
      const hit = Array.isArray(rows)
        ? rows.find((n) => n.enrollment_id === created.body.id || n.name === name)
        : undefined;
      return hit?.certificate && hit?.cert_sig ? hit : null;
    },
    60_000
  );
  rb(`browser@H1: 根钥签 admit-node（authorization + certificate）→ POST /api/auth/keylog?hub=sync`);
  const admit = await submitRecord(
    sh,
    'admit-node',
    encodeAdmitNodePayload({
      authorization_bytes: enrollment.authorizationBytes,
      authorization_sig: enrollment.authorizationSig,
      certificate_bytes: decodeBase64url(row.certificate as string),
      cert_sig: decodeBase64url(row.cert_sig as string),
    }),
    true
  );
  must(admit.status === 200, `1.3c ${name} admit-node 落账`, `HTTP ${admit.status} ${short(admit.text)}`);
  const nodeId = String(row.id);
  const online = await tryWaitFor(
    `${name} online`,
    async () => {
      const rows = await meshNodes(sh);
      return rows.find((n) => n.id === nodeId && n.online) ? true : null;
    },
    60_000
  );
  check(online === true, `1.3d ${name} 在 H1 的 mesh 清单里 online`, `nodeId=${nodeId}`);
  return nodeId;
}

/** Hub 口令加入（1.1.24 起加入方自签 admit-node）。 */
async function joinByHubPassword(
  sh: Session,
  H1: Inst,
  target: Inst,
  name: string,
  totp: string | undefined,
  tag: string
): Promise<string> {
  await boot(target);
  const body: Json = {
    method: 'password',
    hubUrl: H1.url,
    password: USER_PASSWORD,
    name,
    insecureLocal: true,
  };
  if (totp !== undefined) body.totpCode = totp;
  rb(
    `${target.name}: POST /api/setup/join {method:'password', hubUrl:'${H1.url}', password:'<mesh pw>', name:'${name}'${totp !== undefined ? ", totpCode:'<6 位>'" : ''}, insecureLocal:true}`
  );
  const join = await call(`${target.url}/api/setup/join`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  must(
    join.status === 200 && join.body.restarting === true,
    `${tag} ${name} Hub 口令加入 → restarting:true`,
    `HTTP ${join.status} ${short(join.text)}`
  );
  await waitExitAndReboot(target, 'node');
  const row = await waitFor(
    `${name} online on hub`,
    async () => {
      const rows = await meshNodes(sh);
      return rows.find((n) => n.name === name && n.online) ?? null;
    },
    90_000
  );
  check(true, `${tag}b ${name} 自承认后在 mesh 清单里 online`, `nodeId=${row.id}`);
  return row.id;
}

// ── 1c. A：备用 hub（env 授权，无需 admit-hub 签名） ───────────────────────
async function step1c(sh: Session, H1: Inst, A: Inst): Promise<void> {
  st.old.A = await joinByToken(sh, H1, A, 'hub-a');
  await stopInst(A);
  rb(`A: tmex hub standby --public-url ${A.url} --priority 200 --insecure-local --no-restart`);
  const standby = cli(A, [
    'hub',
    'standby',
    '--public-url',
    A.url,
    '--priority',
    '200',
    '--insecure-local',
    '--no-restart',
  ]);
  const aEnv = readAppEnv(A);
  must(
    standby.status === 0 && aEnv.TMEX_ROLES === 'hub,node' && aEnv.TMEX_HUB_MODE === 'standby',
    '1.7 A `tmex hub standby` → hub,node + TMEX_HUB_MODE=standby + 自动写入主 hub 的 TMEX_HUB_PEERS',
    `exit=${standby.status} out=${short(standby.out, 300)} env={roles:${aEnv.TMEX_ROLES}, mode:${aEnv.TMEX_HUB_MODE}, priority:${aEnv.TMEX_HUB_PRIORITY}, peers:${aEnv.TMEX_HUB_PEERS}}`
  );
  adoptAppEnv(A);
  await boot(A);

  await stopInst(H1);
  rb(`H1（主 hub）: tmex hub allow ${st.old.A} --no-restart`);
  const allow = cli(H1, ['hub', 'allow', st.old.A as string, '--no-restart']);
  const hEnv = readAppEnv(H1);
  must(
    allow.status === 0 && (hEnv.TMEX_HUB_PEERS ?? '').includes(st.old.A as string),
    '1.8 H1 `tmex hub allow <A nodeId>` 写入 TMEX_HUB_PEERS',
    `exit=${allow.status} out=${short(allow.out, 240)} peers=${hEnv.TMEX_HUB_PEERS}`
  );
  adoptAppEnv(H1);
  await boot(H1);

  const list = await tryWaitFor(
    'A visible as standby hub',
    async () => {
      const body = (await sessionJson(sh, '/api/mesh/hubs')) as unknown as {
        hubs?: Array<{ nodeId: string; mode?: string; authorized?: boolean; online?: boolean }>;
      };
      const row = body.hubs?.find((h) => h.nodeId === st.old.A);
      return row?.mode === 'standby' ? { row, hubs: body.hubs } : null;
    },
    90_000
  );
  check(
    list !== null,
    '1.9 /api/mesh/hubs 出现 A（mode=standby，env 授权）',
    short(list?.hubs ?? 'A 未在 90s 内出现在 hubs[]', 320)
  );
}

/** `hub leave` 只清 TMEX_ROLES / TMEX_HUB_URL / TMEX_HUB_PUBLIC_URL，备份 hub 的模式键会留下。 */
function checkStandbyLeftovers(A: Inst): void {
  const env = readAppEnv(A);
  check(
    true,
    '3d.6 [记录] 备用 hub 迁移后 app.env 的遗留键',
    `TMEX_ROLES=${env.TMEX_ROLES} TMEX_HUB_MODE=${env.TMEX_HUB_MODE ?? '(none)'} TMEX_HUB_PRIORITY=${env.TMEX_HUB_PRIORITY ?? '(none)'} TMEX_HUB_PEERS=${env.TMEX_HUB_PEERS ?? '(none)'} TMEX_HUB_PUBLIC_URL='${env.TMEX_HUB_PUBLIC_URL ?? ''}' → hub leave 只清 ROLES/HUB_URL/HUB_PUBLIC_URL，MODE/PRIORITY/PEERS 需人工清理`
  );
}

// ── 1b. 从 E 看全网 ────────────────────────────────────────────────────────
async function step1b(se: Session, expect = 5): Promise<void> {
  const rows = await waitFor(
    `E sees ${expect} online nodes`,
    async () => {
      const list = await meshNodes(se);
      return list.filter((n) => n.online).length >= expect ? list : null;
    },
    90_000
  );
  st.old.Eself = se.nodeId;
  check(
    rows.filter((n) => n.online).length >= expect,
    `1.6 E 的 /api/mesh/nodes 列出全部 ${expect} 台 online`,
    `${nodesBrief(rows)}; ids: H1=${st.old.H1} E=${st.old.E} N1=${st.old.N1} N2=${st.old.N2}`
  );
}

// ── 2. TOTP + 带码 Hub 口令加入 ────────────────────────────────────────────
async function step2(sh: Session, se: Session, N3: Inst): Promise<void> {
  const head = (await sessionJson(se, '/api/auth/keylog/head')) as {
    seq: number | string;
    rootEpoch: number;
  };
  const secret = randomBytes(20);
  const kTotp = deriveTotpKey(se.rootKey.seed, se.userId, head.rootEpoch);
  const payload = await encryptTotpSecret(kTotp, secret, {
    uid: se.userId,
    root_epoch: head.rootEpoch,
    seq: BigInt(head.seq) + 1n,
  });
  rb(`browser@E: 根钥签 set-totp（encryptTotpSecret + encodeSetTotpPayload）→ POST /api/auth/keylog?hub=sync`);
  const res = await submitRecord(se, 'set-totp', encodeSetTotpPayload(payload), true);
  must(res.status === 200, '2.1 set-totp 落账（开启 TOTP）', `HTTP ${res.status} ${short(res.text)}`);
  totpSecret = secret;

  const rec = await call(`${se.url}/api/auth/totp-record`, { cookie: se.cookie });
  check(rec.status === 200, '2.2 GET /api/auth/totp-record 200', `HTTP ${rec.status} ${short(rec.text)}`);

  // 不带 totp 的登录必须被拒
  let noTotp = '';
  try {
    await openSession({ url: se.url, name: 'E' } as Inst, USER_PASSWORD, { withTotp: false });
    noTotp = 'LOGIN SUCCEEDED (should not)';
  } catch (e) {
    noTotp = e instanceof Error ? e.message : String(e);
  }
  check(
    /TOTP_REQUIRED/.test(noTotp),
    '2.3 开启 TOTP 后不带码登录 → TOTP_REQUIRED',
    short(noTotp)
  );

  // N3：先试不带码的 Hub 口令加入（G2 期望 totp_required）
  await boot(N3);
  rb(`N3: POST /api/setup/join {method:'password', ...} 不带 totpCode（期望 totp_required）`);
  const noCode = await call(`${N3.url}/api/setup/join`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'password',
      hubUrl: instances[0].url,
      password: USER_PASSWORD,
      name: 'n3-totp',
      insecureLocal: true,
    }),
  });
  const code = (noCode.body as { error?: { code?: string } }).error?.code ?? '';
  const rejected = noCode.status >= 400 && /totp/i.test(code);
  check(
    rejected,
    '2.4 [G2] TOTP 账号不带码的 Hub 口令加入 → 稳定错误码 totp_required',
    `HTTP ${noCode.status} ${short(noCode.text)}`
  );

  if (rejected) {
    await stopInst(N3);
    spawnSync('bash', ['-c', `rm -f ${N3.db} ${N3.db}-wal ${N3.db}-shm`]);
    N3.roles = 'standalone';
    st.old.N3 = await joinByHubPassword(
      sh,
      instances[0],
      N3,
      'n3-totp',
      totpCode(secret, Math.floor(Date.now() / 1000)),
      '2.5'
    );
  } else {
    // G2 未落地：不带码就加入成功了；把它当作已加入的节点继续跑迁移
    await waitExitAndReboot(N3, 'node');
    const row = await tryWaitFor(
      'n3 online',
      async () => (await meshNodes(sh)).find((n) => n.name === 'n3-totp' && n.online) ?? null,
      90_000
    );
    st.old.N3 = row?.id ?? '';
    check(
      false,
      '2.5 [G2] 带 --totp / totpCode 的 Hub 口令加入',
      `G2 尚未落地：不带码即加入成功（HTTP ${noCode.status}），totpCode 参数被忽略；nodeId=${st.old.N3}`
    );
  }
}

// ── 3a. H1 tmex hub leave ──────────────────────────────────────────────────
async function step3a(H1: Inst, se: Session): Promise<void> {
  await stopInst(H1);
  rb(`H1: tmex hub leave --no-restart（真机上不带 --no-restart，服务自己停/起；不需要密码）`);
  const r = cli(H1, ['hub', 'leave', '--no-restart']);
  const env = readAppEnv(H1);
  must(
    r.status === 0 && env.TMEX_ROLES === 'standalone',
    '3a.1 H1 `tmex hub leave` 成功（无需密码）→ app.env TMEX_ROLES=standalone',
    `exit=${r.status} out=${short(r.out)} env=${short(env)}`
  );
  adoptAppEnv(H1);
  await boot(H1);
  const users = sqlite(H1.db, 'select count(*) from users;');
  const identity = sqlite(H1.db, "select coalesce(user_id,'(none)') from node_identity;");
  const nowId = sqlite(H1.db, 'select node_id from node_identity limit 1;').trim();
  check(
    users === '0' && identity === '(none)' && nowId !== st.old.H1,
    '3a.2 leave 后 H1 库里 users 清空、节点身份重建（新 node id、无 user_id）',
    `users=${users} node_identity.user_id=${identity} old=${st.old.H1.slice(0, 12)} new=${nowId.slice(0, 12)}`
  );
  const stillUp = await call(`${se.url}/api/mesh/nodes`, { cookie: se.cookie });
  const hubs = await call(`${se.url}/api/mesh/hubs`, { cookie: se.cookie });
  check(
    stillUp.status === 200,
    '3a.3 E 仍然在线（会话可用、/api/mesh/nodes 200），H1 上级不可达',
    `E nodes HTTP ${stillUp.status}; /api/mesh/hubs ${short(hubs.text)}`
  );
}

// ── 3b. H1 → 纯中继 ────────────────────────────────────────────────────────
async function step3b(H1: Inst): Promise<void> {
  rb(`H1: POST /api/setup/relay {role:'relay', relayPublicUrl:'${H1.url}', relayPassword:'<relay pw>'}`);
  const setup = await call(`${H1.url}/api/setup/relay`, {
    method: 'POST',
    body: JSON.stringify({
      role: 'relay',
      relayPublicUrl: H1.url,
      relayPassword: RELAY_PASSWORD,
    }),
  });
  must(
    setup.status === 200 && setup.body.restarting === true,
    '3b.1 H1 POST /api/setup/relay {role:relay} → restarting:true（不建新用户）',
    `HTTP ${setup.status} ${short(setup.text)}`
  );
  const env = readEnvLocal(H1);
  H1.extraEnv = {
    TMEX_RELAY_PUBLIC_URL: env.TMEX_RELAY_PUBLIC_URL ?? H1.url,
    ...(env.TMEX_RELAY_ADMIN_TOKEN ? { TMEX_RELAY_ADMIN_TOKEN: env.TMEX_RELAY_ADMIN_TOKEN } : {}),
  };
  await waitExitAndReboot(H1, 'relay');
  st.relayUrl = H1.url;
  const health = await call(`${H1.url}/api/relay/health`);
  const root = await call(`${H1.url}/`);
  const users = sqlite(H1.db, 'select count(*) from users;');
  check(
    health.status === 200 && root.status === 404 && users === '0',
    '3b.2 GET /api/relay/health 200、GET / 404、库里仍无用户',
    `health=${health.status} ${short(health.text, 80)} root=${root.status} users=${users} env=${short(env)}`
  );
}

// ── 3c. E 接入中继（hub → 中继迁移入口） ───────────────────────────────────
async function step3c(H1: Inst, E: Inst, se: Session): Promise<void> {
  rb(`browser@E: POST /api/mesh/relay/enroll/proof-material {url:'${H1.url}'} → signRelayEnrollProof(rootKey)`);
  const material = (await sessionJson(se, '/api/mesh/relay/enroll/proof-material', {
    method: 'POST',
    body: JSON.stringify({ url: H1.url }),
  })) as unknown as { relayHost: string; ts: number };
  const proof = signRelayEnrollProof(se.rootKey, { relayHost: material.relayHost, ts: material.ts });
  rb(`browser@E: POST /api/mesh/relay/enroll {url, password:'<relay pw>', proof}`);
  const enrolled = await call(`${se.url}/api/mesh/relay/enroll`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      url: H1.url,
      password: RELAY_PASSWORD,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  must(
    enrolled.status === 200 && typeof enrolled.body.tenantId === 'string',
    '3c.1 E（hub 模式）POST /api/mesh/relay/enroll → 200 + tenantId',
    `HTTP ${enrolled.status} ${short(enrolled.text)}`
  );
  st.tenantId = String(enrolled.body.tenantId);
  rb(`browser@E: 根钥签 set-relays（enroll 返回的 payload）→ POST /api/auth/keylog?hub=sync`);
  const applied = await applyPrepared(se, enrolled.body, 'set-relays', true);
  must(applied.status === 200, '3c.2 set-relays 落账（?hub=sync）', `HTTP ${applied.status} ${short(applied.text)}`);

  const attached = await waitFor(
    'E attached to relay',
    async () => {
      const s = await relayStatus(se);
      return s.mode === 'relay' && s.relays[0]?.attached && s.relays[0]?.online ? s : null;
    },
    90_000
  );
  check(
    true,
    '3c.3 E 切到中继模式并 attached',
    `tenantId=${st.tenantId} relays=${short(attached.relays, 300)}`
  );

  // 密封包（浏览器持根种子时的同一条路径）
  const jm = (await sessionJson(se, '/api/mesh/relay/join-material?scope=all')) as unknown as {
    logKey: string;
    relays: Array<{ url: string; tenantId: string; token: string }>;
  };
  const head = (await sessionJson(se, '/api/auth/keylog/head')) as {
    seq: number | string;
    hash: string;
    rootEpoch: number;
  };
  const mode = (await call(`${E.url}/api/auth/mode`)).body as {
    kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
  };
  const kdfWire = kdfParamsToWire({
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  const packs: Array<{ url: string; sealed_pack: string }> = [];
  for (const relay of jm.relays) {
    const sealed = await sealRelayPack({
      rootSeed: se.rootKey.seed,
      tenantId: relay.tenantId,
      rootPublicKey: se.rootKey.publicKey,
      rootEpoch: head.rootEpoch,
      plaintext: {
        log_key: decodeBase64url(jm.logKey),
        token: decodeBase64url(relay.token),
        head_seq: BigInt(head.seq),
        head_hash: decodeBase64url(head.hash),
        issued_at: BigInt(Date.now()),
      },
    });
    packs.push({ url: relay.url, sealed_pack: encodeBase64url(sealed) });
  }
  rb(`browser@E: GET /api/mesh/relay/join-material?scope=all → sealRelayPack → POST /api/mesh/relay/pack`);
  const upload = await call(`${E.url}/api/mesh/relay/pack`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      packs,
      kdf_params: kdfWire,
      root_epoch: head.rootEpoch,
      head_seq: Number(head.seq),
    }),
  });
  must(
    upload.status === 200 && upload.body.ok === true,
    '3c.4 POST /api/mesh/relay/pack 上传密封包',
    `relays=${jm.relays.length} HTTP ${upload.status} ${short(upload.text)}`
  );

  const rows = sqlite(
    H1.db,
    `select group_concat(node_id||':'||status, ' | ') from relay_nodes where tenant_id='${st.tenantId}';`
  );
  const wanted = [st.old.H1, st.old.E, st.old.N1, st.old.N2, st.old.N3, st.old.A].filter(Boolean);
  const present = wanted.filter((id) => rows.includes(id));
  check(
    present.length === wanted.length,
    '3c.5 中继注册表按历史 admit sidecar 重建出全部旧节点',
    `期望 ${wanted.length} 台（H1/E/N1/N2/N3/A），实到 ${present.length}；relay_nodes = ${rows || '(空)'}`
  );
  const keylog = sqlite(H1.db, 'select count(*) from relay_key_log;');
  log(`relay_key_log rows on H1 = ${keylog}`);
}

// ── 3d. 节点迁移：hub leave → relay join ───────────────────────────────────
async function step3d(
  node: Inst,
  se: Session,
  name: string,
  meshPassword: string = USER_PASSWORD
): Promise<void> {
  const oldId = st.old[node.name] ?? '';
  await stopInst(node);
  rb(`${name}: tmex hub leave --no-restart`);
  const left = cli(node, ['hub', 'leave', '--no-restart']);
  must(
    left.status === 0 && readAppEnv(node).TMEX_ROLES === 'standalone',
    `3d.1 ${name} tmex hub leave → standalone`,
    `exit=${left.status} out=${short(left.out)}`
  );
  adoptAppEnv(node);
  await boot(node);

  rb(
    `${name}: TMEX_PASSWORD=<mesh pw> tmex relay join ${st.relayUrl} --tenant ${st.tenantId} --name ${name} --no-restart`
  );
  const joined = cli(
    node,
    ['relay', 'join', st.relayUrl as string, '--tenant', st.tenantId as string, '--name', name, '--no-restart'],
    { TMEX_PASSWORD: meshPassword }
  );
  const env = readAppEnv(node);
  must(
    joined.status === 0 && /node/.test(env.TMEX_ROLES ?? ''),
    `3d.2 ${name} tmex relay join → app.env TMEX_ROLES=${env.TMEX_ROLES}`,
    `exit=${joined.status} out=${short(joined.out)}`
  );
  await stopInst(node);
  adoptAppEnv(node);
  await boot(node);

  const newId = sqlite(node.db, 'select lower(hex(node_id)) from node_identity limit 1;').trim() ||
    sqlite(node.db, 'select node_id from node_identity limit 1;').trim();
  st.fresh[node.name] = newId;

  const seen = await tryWaitFor(
    `${name} online via relay`,
    async () => {
      const rows = await meshNodes(se);
      return rows.find((n) => n.name === name && n.online) ?? null;
    },
    90_000
  );
  check(
    seen !== null && seen.id !== oldId,
    `3d.3 E 经中继看到 ${name} online，node id 已换新`,
    `old=${oldId.slice(0, 12)} new=${(seen?.id ?? newId).slice(0, 12)} online=${seen?.online}`
  );
  if (seen) st.fresh[node.name] = seen.id;
  await proxyCheck(se, st.fresh[node.name] ?? '', name);
}

/** 经入口 E 的 `/n/<nodeId>/...` 反代（= 中继流真的通了）。 */
async function proxyCheck(se: Session, nodeId: string, name: string): Promise<void> {
  if (!nodeId) {
    check(false, `3d.4 ${name} 经 E 的 /n/<id>/ 反代`, 'no node id');
    return;
  }
  const ch = await call(`${se.url}/n/${nodeId}/api/auth/challenge`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({ uid: se.userId }),
  });
  if (ch.status !== 200) {
    check(false, `3d.4 ${name} 经 E 的 /n/<id>/ 反代`, `challenge HTTP ${ch.status} ${short(ch.text)}`);
    return;
  }
  const body = ch.body as unknown as { challenge_id: string; nonce: string; nodePk: string };
  const sess = generateEd25519KeyPair();
  const del = createDelegation(se.rootKey, {
    uid: se.userId,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: se.userId,
    entry: se.nodeId,
  });
  const mode = (await call(`${se.url}/api/auth/mode`, { cookie: se.cookie })).body as { rootEpoch?: number };
  const totp = totpBody(se.rootKey, se.userId, mode.rootEpoch ?? 0);
  const res = await callRaw(`${se.url}/n/${nodeId}/api/auth/login`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(encodeDelegation(del.delegation)),
      delegation_sig: encodeBase64url(del.sig),
      ...(totp ? { totp } : {}),
    }),
  });
  if (res.status !== 200) {
    check(false, `3d.4 ${name} 经 E 的 /n/<id>/ 反代`, `remote login HTTP ${res.status} ${short(await res.text())}`);
    return;
  }
  const jar = `${se.cookie}; tmex_s_${nodeId}=${sidFrom(res, nodeId)}`;
  const devices = await call(`${se.url}/n/${nodeId}/api/devices`, { cookie: jar });
  check(
    devices.status === 200,
    `3d.4 ${name} 经 E 的 /n/<id>/ HTTP 反代（remote login + GET /api/devices）`,
    `HTTP ${devices.status} ${short(devices.text, 160)}`
  );
  let hello: HelloProbe | null = null;
  let helloErr = '';
  try {
    hello = await helloProbe(`ws://127.0.0.1:${new URL(se.url).port}/n/${nodeId}/ws`, jar, '1.1.25');
  } catch (e) {
    helloErr = e instanceof Error ? e.message : String(e);
  }
  check(
    hello?.helloS2C !== undefined && !hello?.error,
    `3d.5 ${name} canonical 流经中继打通（WS /n/<id>/ws HELLO → HELLO_S2C）`,
    hello
      ? `helloS2C=${short(hello.helloS2C)} error=${short(hello.error)} close=${short(hello.close)}`
      : helloErr
  );
}

type HelloProbe = {
  error?: { code: number; message: string };
  helloS2C?: { serverVersion: string };
  close?: { code: number; reason: string };
};

function helloProbe(url: string, cookie: string, clientVersion: string): Promise<HelloProbe> {
  return new Promise((resolve, reject) => {
    const out: HelloProbe = {};
    const socket = new WebSocket(url, { headers: { cookie } } as unknown as string[]);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => finish(new Error('hello probe timed out')), 20_000);
    let settled = false;
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(out);
    }
    socket.addEventListener('open', () => {
      const hello = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
        clientImpl: 'lt25-probe',
        clientVersion,
        maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
        supportsCompression: false,
        supportsDiffSnapshot: false,
      });
      socket.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, hello, 1));
    });
    socket.addEventListener('message', (event) => {
      const data: unknown = (event as MessageEvent).data;
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      if (!wsBorsh.checkMagic(bytes)) return;
      let envelope: wsBorsh.Envelope;
      try {
        envelope = wsBorsh.decodeEnvelope(bytes);
      } catch {
        return;
      }
      if (envelope.kind === wsBorsh.KIND_HELLO_S2C) {
        out.helloS2C = wsBorsh.decodePayload(wsBorsh.schema.HelloS2CSchema, envelope.payload);
        finish();
        return;
      }
      if (envelope.kind === wsBorsh.KIND_ERROR) {
        out.error = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
      }
    });
    socket.addEventListener('close', (event) => {
      const ev = event as CloseEvent;
      out.close = { code: ev.code, reason: ev.reason };
      finish();
    });
    socket.addEventListener('error', () => {
      if (!out.error && !out.helloS2C) finish(new Error(`websocket error on ${url}`));
    });
  });
}

// ── 3e. H1 自己也挂回中继（relay → relay,node） ────────────────────────────
async function step3e(H1: Inst, se: Session): Promise<void> {
  rb(
    `H1: TMEX_PASSWORD=<mesh pw> tmex relay join ${st.relayUrl} --tenant ${st.tenantId} --name tmexhub-sh --no-restart（中继保持运行）`
  );
  const joined = cli(
    H1,
    ['relay', 'join', st.relayUrl as string, '--tenant', st.tenantId as string, '--name', 'tmexhub-sh', '--no-restart'],
    { TMEX_PASSWORD: USER_PASSWORD }
  );
  const env = readAppEnv(H1);
  must(
    joined.status === 0 && env.TMEX_ROLES === 'relay,node',
    '3e.1 H1 relay join 自己 → app.env TMEX_ROLES=relay,node',
    `exit=${joined.status} out=${short(joined.out)} env.TMEX_ROLES=${env.TMEX_ROLES}`
  );
  await stopInst(H1);
  adoptAppEnv(H1);
  await boot(H1);
  const seen = await tryWaitFor(
    'E sees tmexhub-sh',
    async () => (await meshNodes(se)).find((n) => n.name === 'tmexhub-sh' && n.online) ?? null,
    90_000
  );
  st.fresh.H1 = seen?.id ?? '';
  check(seen !== null, '3e.2 E 看到 tmexhub-sh（relay,node）online', `id=${short(seen?.id ?? 'none')}`);
}

// ── 3g. 吊销旧身份 + meta-key rotate ───────────────────────────────────────
async function step3g(H1: Inst, se: Session): Promise<void> {
  const ghosts = Object.entries(st.old)
    .filter(([k]) => k !== 'Eself')
    .map(([, v]) => v)
    .filter((id) => id && id !== se.nodeId);
  const outcomes: string[] = [];
  for (const id of ghosts) {
    rb(`browser@E: 根钥签 revoke-node {node_id:${id.slice(0, 8)}…} → POST /api/auth/keylog?hub=sync`);
    const r = await submitRecord(
      se,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: hexToBytes(id), reason: 'migrated to relay' }),
      true
    );
    outcomes.push(`${id.slice(0, 8)}=${r.status}${r.status === 200 ? '' : `(${short(r.text, 90)})`}`);
  }
  check(
    outcomes.every((o) => o.includes('=200')),
    '3g.1 E 为每个旧 node id 签 revoke-node',
    outcomes.join(' ')
  );

  rb(`browser@E: POST /api/mesh/relay/meta-key/prepare {op:'rotate'} → 根钥签 meta-key → POST /api/auth/keylog?hub=sync`);
  const prep = await call(`${se.url}/api/mesh/relay/meta-key/prepare`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({ op: 'rotate' }),
  });
  let rotated = { status: -1, text: 'prepare failed' };
  if (prep.status === 200) rotated = await applyPrepared(se, prep.body, 'meta-key', true);
  check(
    prep.status === 200 && rotated.status === 200,
    '3g.2 meta-key {op:rotate} 落账',
    `prepare HTTP ${prep.status} ${short(prep.text, 120)}; append HTTP ${rotated.status} ${short(rotated.text, 120)}`
  );

  await Bun.sleep(3000);
  const revoked = sqlite(
    H1.db,
    `select group_concat(substr(node_id,1,8)||':'||status, ' | ') from relay_nodes where tenant_id='${st.tenantId}';`
  );
  const ghostStatuses = ghosts.map((id) => {
    const s = sqlite(
      H1.db,
      `select coalesce(status,'(absent)') from relay_nodes where tenant_id='${st.tenantId}' and node_id='${id}';`
    );
    return `${id.slice(0, 8)}=${s || '(absent)'}`;
  });
  const live = await meshNodes(se);
  check(
    ghostStatuses.every((s) => s.includes('revoked') || s.includes('(absent)')),
    '3g.3 中继注册表里旧身份被标 revoked（或从未建行），在网节点不受影响',
    `ghosts: ${ghostStatuses.join(' ')}; relay_nodes=${revoked || '(空)'}; live=${nodesBrief(live)}`
  );
}

// ── 3h. enrollment 扇出 + r3 token 加入 ────────────────────────────────────
async function step3h(H1: Inst, N4: Inst, se: Session): Promise<void> {
  const mode = (await call(`${se.url}/api/auth/mode`, { cookie: se.cookie })).body as {
    rootEpoch?: number;
    rootPublicKey?: string;
  };
  const head = (await sessionJson(se, '/api/auth/keylog/head')) as { hash: string };
  const now = Date.now();
  const enrollment = await createEnrollment(se.rootKey, {
    uid: se.userId,
    rootEpoch: mode.rootEpoch ?? 0,
    now,
  });
  rb(`browser@E: POST /api/mesh/relay/enrollments {enroll_pk, authorization, authorization_sig, exp}`);
  const created = await call(`${se.url}/api/mesh/relay/enrollments`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      enroll_pk: encodeBase64url(enrollment.enrollPk),
      authorization: encodeBase64url(enrollment.authorizationBytes),
      authorization_sig: encodeBase64url(enrollment.authorizationSig),
      exp: now + 600_000,
    }),
  });
  must(
    created.status === 200 || created.status === 201,
    '3h.1 POST /api/mesh/relay/enrollments → 2xx',
    `HTTP ${created.status} ${short(created.text, 300)}`
  );
  const relays = created.body.relays;
  const fanout =
    Array.isArray(relays) &&
    relays.length > 0 &&
    typeof relays[0] === 'object' &&
    relays[0] !== null &&
    'accepted' in (relays[0] as object);
  check(
    fanout,
    '3h.2 [G4] enrollment 扇出返回 relays:[{url,tenantId,token,accepted}]',
    fanout ? short(relays, 300) : `未落地：relays = ${short(relays, 200)}（旧形状 string[]）`
  );

  const jm = (await sessionJson(se, '/api/mesh/relay/join-material')) as unknown as {
    logKey: string;
    relays: Array<{ url: string; tenantId: string; token: string }>;
  };
  const token = encodeRelayJoinToken({
    enrollSk: enrollment.enrollSk,
    rootPublicKey: decodeBase64url(mode.rootPublicKey as string),
    keyLogHeadHash: decodeBase64url(head.hash),
    logKey: decodeBase64url(jm.logKey),
    relays: jm.relays.map((r) => ({
      url: r.url,
      tenantId: r.tenantId,
      token: decodeBase64url(r.token),
    })),
  });

  await boot(N4);
  await stopInst(N4);
  rb(`N4: tmex hub join ${st.relayUrl} --token r3.… --name n4-token --insecure-local --no-restart`);
  const joined = cli(N4, [
    'hub',
    'join',
    st.relayUrl as string,
    '--token',
    token,
    '--name',
    'n4-token',
    '--insecure-local',
    '--no-restart',
  ]);
  const env = readAppEnv(N4);
  const ok = joined.status === 0 && /node/.test(env.TMEX_ROLES ?? '');
  check(ok, '3h.3 r3 token 加入（tmex hub join --token r3.…）成功', `exit=${joined.status} out=${short(joined.out, 300)} roles=${env.TMEX_ROLES}`);
  if (!ok) return;
  N4.roles = env.TMEX_ROLES ?? 'node';
  await boot(N4);

  // 入口补签 admit-node + meta-key{op:'admit'}（浏览器加节点向导的收尾动作）
  const enrollId = String(created.body.id ?? '');
  const cert = await tryWaitFor(
    'N4 certificate on relay',
    async () => {
      const r = await call(`${se.url}/api/mesh/relay/enrollments/${enrollId}`, { cookie: se.cookie });
      const b = r.body as { certificate?: string; cert_sig?: string };
      return b.certificate && b.cert_sig ? b : null;
    },
    60_000
  );
  if (!cert) {
    check(false, '3h.4 入口为 N4 补签 admit-node', 'certificate 未在 60s 内出现在 /api/mesh/relay/enrollments/:id');
    return;
  }
  rb(`browser@E: 根钥签 admit-node（N4）→ POST /api/auth/keylog?hub=sync；再 meta-key {op:'admit', node_id}`);
  const admit = await submitRecord(
    se,
    'admit-node',
    encodeAdmitNodePayload({
      authorization_bytes: enrollment.authorizationBytes,
      authorization_sig: enrollment.authorizationSig,
      certificate_bytes: decodeBase64url(cert.certificate as string),
      cert_sig: decodeBase64url(cert.cert_sig as string),
    }),
    true
  );
  const n4Id = sqlite(N4.db, 'select node_id from node_identity limit 1;').trim();
  const prep = await call(`${se.url}/api/mesh/relay/meta-key/prepare`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({ op: 'admit', node_id: n4Id }),
  });
  let mk = { status: -1, text: 'skipped' };
  if (prep.status === 200) mk = await applyPrepared(se, prep.body, 'meta-key', true);
  const online = await tryWaitFor(
    'N4 online',
    async () => (await meshNodes(se)).find((n) => n.name === 'n4-token' && n.online) ?? null,
    90_000
  );
  check(
    admit.status === 200 && online !== null,
    '3h.4 admit-node + meta-key{op:admit} 后 N4 经中继 online',
    `admit HTTP ${admit.status}; meta-key prepare ${prep.status} append ${mk.status}; online=${online !== null}`
  );
}

// ── 4. relay,node → relay（G3 幽灵租户） ───────────────────────────────────
async function step4(H1: Inst, se: Session): Promise<void> {
  const before = sqlite(H1.db, 'select count(*) from relay_tenants;');
  const sh = await openSession(H1, USER_PASSWORD);
  rb(`H1: POST /api/local/leave {expectedRole:'relay,node', targetRole:'relay'}`);
  const leave = await call(`${H1.url}/api/local/leave`, {
    method: 'POST',
    cookie: sh.cookie,
    body: JSON.stringify({ expectedRole: 'relay,node', targetRole: 'relay' }),
  });
  must(
    leave.status === 200,
    '4.1 POST /api/local/leave {targetRole:relay} → 200',
    `HTTP ${leave.status} ${short(leave.text)}`
  );
  await waitExitAndReboot(H1, 'relay');
  const after = sqlite(H1.db, 'select count(*) from relay_tenants;');
  const mine = sqlite(
    H1.db,
    `select count(*) from relay_tenants where id='${st.tenantId}';`
  );
  check(
    mine === '0',
    '4.2 [G3] leave→relay 删掉本机根钥对应的租户（幽灵租户）',
    `relay_tenants before=${before} after=${after}; 本租户 ${st.tenantId} 行数=${mine}（0 = 已删）`
  );
  const eStatus = await tryWaitFor(
    'E detached',
    async () => {
      const s = await relayStatus(se);
      return s.relays[0] && !s.relays[0].attached ? s : null;
    },
    45_000
  );
  check(
    eStatus !== null,
    '4.3 E 与中继断开',
    eStatus ? short(eStatus.relays, 240) : '45s 内 E 仍显示 attached'
  );

  rb(`H1: tmex relay join ${st.relayUrl} --tenant <旧 tenant> …（预期失败：租户已被删）`);
  const rejoin = cli(
    H1,
    ['relay', 'join', st.relayUrl as string, '--tenant', st.tenantId as string, '--name', 'tmexhub-sh', '--no-restart'],
    { TMEX_PASSWORD: USER_PASSWORD }
  );
  check(
    rejoin.status !== 0 && /RELAY_TENANT_NOT_FOUND/.test(rejoin.out),
    '4.4 用旧 tenant id 直接 relay join 无法恢复（租户连同密钥日志一并被删）',
    `exit=${rejoin.status} out=${short(rejoin.out, 220)}`
  );

  // 真正的恢复路径：持根钥的入口重新 enroll 一个新租户，再让各节点按新 tenant id 重新加入
  rb(`browser@E: 重新 POST /api/mesh/relay/enroll/proof-material + /api/mesh/relay/enroll（新租户）`);
  const material = (await sessionJson(se, '/api/mesh/relay/enroll/proof-material', {
    method: 'POST',
    body: JSON.stringify({ url: st.relayUrl }),
  })) as unknown as { relayHost: string; ts: number };
  const proof = signRelayEnrollProof(se.rootKey, { relayHost: material.relayHost, ts: material.ts });
  const enrolled = await call(`${se.url}/api/mesh/relay/enroll`, {
    method: 'POST',
    cookie: se.cookie,
    body: JSON.stringify({
      url: st.relayUrl,
      password: RELAY_PASSWORD,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  const newTenant = String(enrolled.body.tenantId ?? '');
  let applied = { status: -1, text: 'skipped' };
  if (enrolled.status === 200) applied = await applyPrepared(se, enrolled.body, 'set-relays', true);
  const back = await tryWaitFor(
    'E re-attached',
    async () => {
      const s = await relayStatus(se);
      return s.relays[0]?.attached && s.relays[0]?.online ? s : null;
    },
    60_000
  );
  check(
    enrolled.status === 200 && newTenant !== st.tenantId && applied.status === 200 && back !== null,
    '4.5 恢复路径：入口重新 enroll 拿到新 tenant id 并重新 attach',
    `enroll HTTP ${enrolled.status} newTenant=${newTenant} (old=${st.tenantId}); set-relays HTTP ${applied.status}; attached=${back !== null}`
  );

  const stranded = await call(`${se.url}/api/mesh/nodes`, { cookie: se.cookie });
  const rows = ((stranded.body as unknown as { nodes?: MeshNode[] }).nodes ?? []).filter(
    (n) => n.online
  );
  check(
    rows.length <= 1,
    '4.6 旧租户被删后其余节点全部掉线（必须按新 tenant id 重新 relay join）',
    `仍在线：${nodesBrief(rows)}`
  );
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  for (const i of instances) {
    try {
      await stopInst(i);
    } catch {
      /* best effort */
    }
  }
  spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  const survivors = spawnSync('tmux', ['ls']).stdout.toString().trim();
  log(`default tmux socket after cleanup: ${survivors.replaceAll('\n', ' / ') || '(none)'}`);
}

let failure: unknown = null;
try {
  await main();
} catch (error) {
  failure = error;
  log(`ERROR: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
}

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}  ${r.note}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
console.log('\n===== RUNBOOK (in order) =====');
runbook.forEach((line, index) => console.log(`${String(index + 1).padStart(2)}. ${line}`));
if (failure) {
  console.log(`\nABORTED: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(1);
}
if (failed > 0) process.exit(2);
console.log('\nALL STEPS PASSED');
