#!/usr/bin/env bun
/**
 * migrate-prod.ts —— 现网 Hub → 中继 迁移的入口机驱动（第二十五轮 LT 的生产版）。
 *
 * 它把 `live25.ts` 里验证过的「浏览器」动作搬到真实入口节点上：派生根钥、开会话、
 * 签 `set-relays` / `revoke-node` / `meta-key`、密封包上传、经 `/n/<id>/` 反代与
 * canonical 流验活。**它只操作本机入口（默认 http://127.0.0.1:9883），不碰任何远端机器**；
 * 远端机器的 `tmex hub leave` / `tmex relay join` 仍由运维手工执行（见 LT-result.md 的 runbook）。
 *
 * 安全约定
 *  - 账户密码只从 `MESH_PASSWORD` 读，绝不打印、绝不落盘；根种子用完立刻清零。
 *  - 不设置 `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`：入口对 127.0.0.1 直连
 *    才会豁免通行密钥二次验证（`isTrustedLocalClient`），带上任一转发头就会要求 passkey。
 *  - `--dry-run` 完全离线：不派生根钥、不开会话、不发任何请求，只打印将要执行的调用。
 *  - 会改状态的子命令（enroll / revoke / rotate）真实执行时必须显式加 `--yes`。
 *
 * 用法见文件末尾 USAGE 或 `bun migrate-prod.ts --help`。
 */
import {
  type RootKey,
  buildKeyLogRecord,
  buildLogin,
  createDelegation,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  KeyLogType,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeDelegation,
  encodeKeyLogRecord,
  encodeLogin,
  encodeRevokeNodePayload,
  generateEd25519KeyPair,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  signLogin,
  totpCode,
} from '/Users/konata/code/tmex-r25/packages/shared/src/auth';
import { MIN_RELAY_RECORD_VERSION } from '/Users/konata/code/tmex-r25/packages/shared/src/auth/relay-records';
import {
  kdfParamsToWire,
  sealRelayPack,
  signRelayEnrollProof,
} from '/Users/konata/code/tmex-r25/packages/shared/src/relay';
import * as wsBorsh from '/Users/konata/code/tmex-r25/packages/shared/src/ws-borsh/index';

const DEFAULT_BASE = 'http://127.0.0.1:9883';
const HEX32 = /^[0-9a-f]{32}$/;

// ── 参数 ────────────────────────────────────────────────────────────────────
type Flags = Record<string, string | boolean>;

function parseArgv(argv: string[]): { cmd: string; flags: Flags } {
  const flags: Flags = {};
  let cmd = '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) {
      if (!cmd) cmd = token;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { cmd, flags };
}

const { cmd, flags } = parseArgv(process.argv.slice(2));
const DRY = flags['dry-run'] === true || flags['dry-run'] === 'true';
const YES = flags.yes === true || flags.yes === 'true';
const BASE = (typeof flags.base === 'string' ? flags.base : DEFAULT_BASE).replace(/\/+$/, '');
const WAIT_MS = Number(typeof flags['wait-ms'] === 'string' ? flags['wait-ms'] : '120000');

function str(name: string): string {
  const v = flags[name];
  return typeof v === 'string' ? v : '';
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
function log(msg: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${msg}`);
}
let planStep = 0;
function plan(line: string): void {
  planStep += 1;
  console.log(`  ${String(planStep).padStart(2)}. ${line}`);
}
function head(title: string): void {
  console.log(`\n=== ${title} ===`);
}
function short(v: unknown, n = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, n).replaceAll('\n', ' ');
}
function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// ── HTTP ────────────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;

/**
 * 绝不带 x-forwarded-for / x-real-ip / cf-connecting-ip：见文件头的安全约定。
 */
async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {}
): Promise<{ status: number; body: Json; text: string; res: Response }> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'error' });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = {};
  }
  return { status: res.status, body, text, res };
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | false | undefined>,
  ms: number,
  every = 1000
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

// ── 会话（= 浏览器：现场派生根钥） ─────────────────────────────────────────
type Session = {
  cookie: string;
  userId: string;
  nodeId: string;
  rootEpoch: number;
  totpEnabled: boolean;
  rootKey: RootKey;
};

type AuthMode = {
  mode?: string;
  uid?: string | null;
  username?: string | null;
  nodeId?: string | null;
  rootEpoch?: number | null;
  totpEnabled?: boolean;
  passkeySecondFactor?: boolean;
  passkeySecondFactorWaived?: boolean;
  hubNodeId?: string | null;
  hubPublicUrl?: string | null;
  rootPublicKey?: string | null;
  kdfParams?: { salt: string; memory_kib: number; iterations: number; parallelism: number } | null;
};

function requirePassword(): string {
  const pw = process.env.MESH_PASSWORD ?? '';
  if (!pw) {
    die('MESH_PASSWORD is not set (mesh account password; never printed, never written to disk)');
  }
  return pw;
}

function totpBodyFor(session: Session): Json | null {
  if (!session.totpEnabled) return null;
  const code = process.env.TMEX_TOTP ?? '';
  if (!/^\d{6}$/.test(code)) {
    die('this account has TOTP enabled: set TMEX_TOTP to the current 6-digit code');
  }
  const kTotp = deriveTotpKey(session.rootKey.seed, session.userId, session.rootEpoch);
  return { code, k_totp: encodeBase64url(kTotp) };
}

/** 与 live25 / 浏览器同一条 challenge → delegation → login 路径。 */
async function openSession(): Promise<Session> {
  const password = requirePassword();
  const mode = (await call('/api/auth/mode')).body as AuthMode;
  if (!mode.uid || !mode.kdfParams) {
    die(`no mesh user on ${BASE}: ${short(mode)}`);
  }
  const rootKey = rootKeyFromSeed(
    await deriveSeed(password, {
      salt: decodeBase64url(mode.kdfParams.salt),
      memory_kib: mode.kdfParams.memory_kib,
      iterations: mode.kdfParams.iterations,
      parallelism: mode.kdfParams.parallelism,
    })
  );
  const session: Session = {
    cookie: '',
    userId: mode.uid,
    nodeId: mode.nodeId || 'self',
    rootEpoch: mode.rootEpoch ?? 0,
    totpEnabled: mode.totpEnabled === true,
    rootKey,
  };
  const ch = await call('/api/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ uid: session.userId }),
  });
  if (ch.status !== 200) die(`challenge HTTP ${ch.status}: ${short(ch.text)}`);
  const challenge = ch.body as unknown as { challenge_id: string; nonce: string; nodePk: string };
  const sess = generateEd25519KeyPair();
  const del = createDelegation(rootKey, {
    uid: session.userId,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: session.nodeId,
    targetPk: decodeBase64url(challenge.nodePk),
    uid: session.userId,
    entry: 'self',
  });
  const totp = totpBodyFor(session);
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(encodeDelegation(del.delegation)),
      delegation_sig: encodeBase64url(del.sig),
      ...(totp ? { totp } : {}),
    }),
  });
  if (res.status !== 200) {
    const code = (res.body as { code?: string }).code ?? '';
    if (code === 'PASSKEY_REQUIRED') {
      die(
        'login needs a passkey second factor — run this on the machine itself against 127.0.0.1 ' +
          '(no reverse proxy, no x-forwarded-for/x-real-ip header), otherwise the local waiver does not apply'
      );
    }
    if (code === 'TOTP_REQUIRED' || code === 'TOTP_INVALID') {
      die(`login rejected: ${code} — set TMEX_TOTP to a fresh 6-digit code`);
    }
    die(`login HTTP ${res.status}: ${short(res.text)}`);
  }
  const sid = sidCookieFrom(res.res, session.nodeId);
  session.cookie = `${sid.name}=${sid.value}`;
  log(`session opened uid=${session.userId} nodeId=${session.nodeId} rootEpoch=${session.rootEpoch}`);
  return session;
}

function sidFrom(res: Response, nodeId: string): string {
  return sidCookieFrom(res, nodeId).value;
}

function sidCookieFrom(res: Response, nodeId: string): { name: string; value: string } {
  for (const name of [`tmex_s_${nodeId}`, 'tmex_s_self']) {
    const prefix = `${name}=`;
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      if (cookie.startsWith(prefix)) return { name, value: cookie.slice(prefix.length).split(';')[0] ?? '' };
    }
    const header = res.headers.get('set-cookie') ?? '';
    const m = header.match(new RegExp(`${name}=([^;]*)`));
    if (m?.[1]) return { name, value: m[1] };
  }
  throw new Error(`no session cookie for ${nodeId}`);
}

function wipe(session: Session | null): void {
  try {
    session?.rootKey.seed.fill(0);
  } catch {
    /* nothing to wipe */
  }
}

async function sessionJson(s: Session, path: string, init: RequestInit = {}): Promise<Json> {
  const r = await call(path, { ...init, cookie: s.cookie });
  if (r.status !== 200 && r.status !== 201) throw new Error(`${path} ${r.status}: ${r.text}`);
  return r.body;
}

// ── 密钥日志追加（根钥签名） ───────────────────────────────────────────────
/** `readmit-node` 是 G7 引入的新类型；shared 的 `KeyLogType` 枚举里可能还没有（见 assertReadmitSupported）。 */
type RecordType = 'set-relays' | 'meta-key' | 'revoke-node' | 'readmit-node';

async function submitRecord(
  s: Session,
  type: RecordType,
  payload: Uint8Array
): Promise<{ status: number; body: Json; text: string }> {
  const headRec = (await sessionJson(s, '/api/auth/keylog/head')) as {
    seq: number | string;
    hash: string;
    rootEpoch: number;
    uid?: string;
  };
  const rec = buildKeyLogRecord(
    { seq: BigInt(headRec.seq), hash: decodeBase64url(headRec.hash) },
    headRec.rootEpoch,
    {
      uid: headRec.uid ?? s.userId,
      // `readmit-node` 在 G7 落地前不在 shared 的 KeyLogType 联合里；编码期由
      // assertReadmitSupported() 先挡住，这里只是让它在 G7 之前也能编译。
      type: type as unknown as (typeof KeyLogType)[keyof typeof KeyLogType],
      payload,
      signer: 'root',
      credential_id: null,
    }
  );
  const bytes = encodeKeyLogRecord(rec);
  const sig = signKeyLogRecordWithRoot(s.rootKey, bytes);
  return await call('/api/auth/keylog?hub=sync', {
    method: 'POST',
    cookie: s.cookie,
    body: JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) }),
  });
}

function explainAppendFailure(r: { status: number; text: string }): string {
  if (/KEYLOG_TYPE_UNSUPPORTED_BY_NODES/.test(r.text)) {
    return `版本门拒绝：有未吊销节点的版本 < ${MIN_RELAY_RECORD_VERSION} 或版本未知。先把这些节点升级（status 子命令会列出）。`;
  }
  return '';
}

// ── 投影 ────────────────────────────────────────────────────────────────────
type MeshNode = {
  id: string;
  name: string;
  online: boolean;
  version: string | null;
  reach?: string | null;
  transport?: string | null;
  isHub?: boolean;
};

async function meshNodes(s: Session): Promise<MeshNode[]> {
  const body = (await sessionJson(s, '/api/mesh/nodes')) as unknown as { nodes?: MeshNode[] };
  return body.nodes ?? [];
}

type RelayStatus = {
  mode: string;
  tenantId: string | null;
  relays: Array<{
    url: string;
    priority?: number;
    online: boolean;
    attached: boolean;
    kicked: boolean;
    rttMs: number | null;
    lastError: string | null;
  }>;
  metaEpoch: number;
  nodesViaRelay: number;
  quota: unknown;
};

const relayStatus = async (s: Session): Promise<RelayStatus> =>
  (await sessionJson(s, '/api/mesh/relay/status')) as unknown as RelayStatus;

function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.replace(/[^0-9.].*$/, '').split('.').map((x) => Number(x) || 0);
  const b = min.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const l = a[i] ?? 0;
    const r = b[i] ?? 0;
    if (l !== r) return l > r;
  }
  return true;
}

// ── 子命令：status ─────────────────────────────────────────────────────────
async function cmdStatus(): Promise<void> {
  if (DRY) {
    head(`status --dry-run（不开会话、不发任何请求；目标 ${BASE}）`);
    plan('GET  /api/auth/mode                （无会话即可读 uid / nodeId / kdfParams / totpEnabled）');
    plan('POST /api/auth/challenge {uid}      ← 开会话（需要 MESH_PASSWORD）');
    plan('POST /api/auth/login {login, sig, delegation, delegation_sig[, totp]}');
    plan('GET  /api/auth/mode                （带会话，多出 rootPublicKey）');
    plan('GET  /api/mesh/nodes               → 打印 id / name / online / version');
    plan('GET  /api/mesh/hubs                → 打印 hub 集合与授权来源');
    plan('GET  /api/mesh/relay/status        → 打印 mode / tenantId / relays / metaEpoch');
    console.log(`\n只读，不写任何状态。真实执行：MESH_PASSWORD=… bun migrate-prod.ts status`);
    return;
  }
  let s: Session | null = null;
  try {
    s = await openSession();
    const mode = (await call('/api/auth/mode', { cookie: s.cookie })).body as AuthMode;
    head('/api/auth/mode');
    console.log(
      JSON.stringify(
        {
          mode: mode.mode,
          uid: mode.uid,
          username: mode.username,
          nodeId: mode.nodeId,
          rootEpoch: mode.rootEpoch,
          totpEnabled: mode.totpEnabled,
          passkeySecondFactor: mode.passkeySecondFactor,
          passkeySecondFactorWaived: mode.passkeySecondFactorWaived,
          hubNodeId: mode.hubNodeId,
          hubPublicUrl: mode.hubPublicUrl,
        },
        null,
        2
      )
    );

    head('/api/mesh/nodes');
    const nodes = await meshNodes(s);
    for (const n of nodes) {
      const flagsText = [n.isHub ? 'hub' : '', n.reach ?? '', n.transport ?? '']
        .filter(Boolean)
        .join('/');
      console.log(
        `  ${n.id}  ${(n.name ?? '').padEnd(16)} ${n.online ? 'online ' : 'OFFLINE'} ` +
          `v=${(n.version ?? '?').padEnd(10)} ${flagsText}`
      );
    }
    const stale = nodes.filter((n) => !versionAtLeast(n.version, MIN_RELAY_RECORD_VERSION));
    if (stale.length > 0) {
      console.log(
        `\n  !! ${stale.length} 台版本 < ${MIN_RELAY_RECORD_VERSION} 或版本未知，` +
          `会让 set-relays / meta-key 被版本门拒（KEYLOG_TYPE_UNSUPPORTED_BY_NODES）：` +
          stale.map((n) => `${n.name}(${n.version ?? '?'})`).join(', ')
      );
    }

    head('/api/mesh/hubs');
    console.log(JSON.stringify(await sessionJson(s, '/api/mesh/hubs'), null, 2));

    head('/api/mesh/relay/status');
    console.log(JSON.stringify(await relayStatus(s), null, 2));
  } finally {
    wipe(s);
  }
}

// ── 子命令：enroll（runbook 阶段 2） ───────────────────────────────────────
function relayPasswordFromEnv(): string {
  const pw = process.env.RELAY_PASSWORD ?? '';
  if (!pw) die('RELAY_PASSWORD is not set (the relay tenant password set in POST /api/setup/relay)');
  return pw;
}

async function cmdEnroll(): Promise<void> {
  const url = str('url');
  if (!url) die('enroll requires --url https://<relay host>');
  if (DRY) {
    head(`enroll --dry-run（不开会话、不发任何请求；入口 ${BASE} → 中继 ${url}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    plan(`POST /api/mesh/relay/enroll/proof-material {"url":"${url}"} → {relayHost, ts}`);
    plan('本地：signRelayEnrollProof(rootKey, {relayHost, ts})');
    plan(
      `POST /api/mesh/relay/enroll {"url":"${url}","password":"<$RELAY_PASSWORD>","proof":{bytes,sig}}` +
        ' → {tenantId, token, metaEpoch, payload}'
    );
    plan("若 enroll 响应带 readmitRequired > 0（且没给 --skip-readmit）→ 先跑下面这三步 readmit，再写 set-relays：");
    planReadmit('  └ ');
    plan('GET  /api/auth/keylog/head → 根钥签 set-relays(payload) → POST /api/auth/keylog?hub=sync');
    plan(`轮询 GET /api/mesh/relay/status 直到 mode=relay 且 relays[0].attached（上限 ${WAIT_MS}ms）`);
    plan('GET  /api/mesh/relay/join-material?scope=all → 每中继一份 sealRelayPack(rootSeed, …)');
    plan('POST /api/mesh/relay/pack {packs, kdf_params, root_epoch, head_seq}');
    console.log(
      `\n会改状态（追加 set-relays 记录 + 把入口切到中继模式）。真实执行需要：\n` +
        `  MESH_PASSWORD=… RELAY_PASSWORD=… bun migrate-prod.ts enroll --url ${url} --yes`
    );
    return;
  }
  if (!YES) die('enroll changes state: re-run with --yes (or use --dry-run to preview)');
  const relayPassword = relayPasswordFromEnv();
  let s: Session | null = null;
  try {
    s = await openSession();

    const material = (await sessionJson(s, '/api/mesh/relay/enroll/proof-material', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })) as unknown as { relayHost: string; ts: number };
    log(`proof-material relayHost=${material.relayHost} ts=${material.ts}`);
    const proof = signRelayEnrollProof(s.rootKey, {
      relayHost: material.relayHost,
      ts: material.ts,
    });

    const enrolled = await call('/api/mesh/relay/enroll', {
      method: 'POST',
      cookie: s.cookie,
      body: JSON.stringify({
        url,
        password: relayPassword,
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      }),
    });
    if (enrolled.status !== 200 || typeof enrolled.body.tenantId !== 'string') {
      die(`POST /api/mesh/relay/enroll HTTP ${enrolled.status}: ${short(enrolled.text)}`);
    }
    const tenantId = String(enrolled.body.tenantId);
    console.log(`\n>>> TENANT ID = ${tenantId}`);
    console.log('>>> 每台节点迁移时都要用它：');
    console.log(`>>>   TMEX_PASSWORD='<mesh pw>' tmex relay join ${url} --tenant ${tenantId} --name <原来的名字>\n`);

    const readmitRequired = Number(enrolled.body.readmitRequired ?? 0);
    if (readmitRequired > 0 && flags['skip-readmit'] === true) {
      log(`readmitRequired=${readmitRequired}，但给了 --skip-readmit：跳过重签（节点可能会被中继拒 member-epoch_mismatch）`);
    } else if (readmitRequired > 0) {
      log(`readmitRequired=${readmitRequired} → 先重签 ${READMIT_RECORD_TYPE}，再写 set-relays`);
      const res = await runReadmit(s);
      log(`readmit 完成：${res.ok}/${res.total}`);
    }

    const payload = enrolled.body.payload;
    if (typeof payload !== 'string') die(`enroll response has no payload: ${short(enrolled.body)}`);
    const applied = await submitRecord(s, 'set-relays', decodeBase64url(payload));
    if (applied.status !== 200) {
      die(
        `set-relays append HTTP ${applied.status}: ${short(applied.text)}` +
          (explainAppendFailure(applied) ? `\n${explainAppendFailure(applied)}` : '')
      );
    }
    log(`set-relays 落账 ${short(applied.body)}`);

    const attached = await waitFor(
      'relay attached',
      async () => {
        const st = await relayStatus(s as Session);
        return st.mode === 'relay' && st.relays[0]?.attached && st.relays[0]?.online ? st : null;
      },
      WAIT_MS
    );
    log(`入口已切到中继模式：${short(attached.relays)}`);

    const jm = (await sessionJson(s, '/api/mesh/relay/join-material?scope=all')) as unknown as {
      logKey: string;
      relays: Array<{ url: string; tenantId: string; token: string }>;
    };
    const headRec = (await sessionJson(s, '/api/auth/keylog/head')) as {
      seq: number | string;
      hash: string;
      rootEpoch: number;
    };
    const mode = (await call('/api/auth/mode', { cookie: s.cookie })).body as AuthMode;
    if (!mode.kdfParams) die('auth mode has no kdf params');
    const kdfWire = kdfParamsToWire({
      salt: decodeBase64url(mode.kdfParams.salt),
      memory_kib: mode.kdfParams.memory_kib,
      iterations: mode.kdfParams.iterations,
      parallelism: mode.kdfParams.parallelism,
    });
    const packs: Array<{ url: string; sealed_pack: string }> = [];
    for (const relay of jm.relays) {
      const sealed = await sealRelayPack({
        rootSeed: s.rootKey.seed,
        tenantId: relay.tenantId,
        rootPublicKey: s.rootKey.publicKey,
        rootEpoch: headRec.rootEpoch,
        plaintext: {
          log_key: decodeBase64url(jm.logKey),
          token: decodeBase64url(relay.token),
          head_seq: BigInt(headRec.seq),
          head_hash: decodeBase64url(headRec.hash),
          issued_at: BigInt(Date.now()),
        },
      });
      packs.push({ url: relay.url, sealed_pack: encodeBase64url(sealed) });
    }
    const upload = await call('/api/mesh/relay/pack', {
      method: 'POST',
      cookie: s.cookie,
      body: JSON.stringify({
        packs,
        kdf_params: kdfWire,
        root_epoch: headRec.rootEpoch,
        head_seq: Number(headRec.seq),
      }),
    });
    if (upload.status !== 200 || upload.body.ok !== true) {
      die(`POST /api/mesh/relay/pack HTTP ${upload.status}: ${short(upload.text)}`);
    }
    log(`密封包已上传（${packs.length} 台中继）：${short(upload.body)}`);
    console.log(`\nOK。TENANT ID = ${tenantId}`);
  } finally {
    wipe(s);
  }
}

// ── meta-key 轮换 ──────────────────────────────────────────────────────────
async function rotateMetaKey(s: Session, exclude: string[]): Promise<void> {
  const prep = await call('/api/mesh/relay/meta-key/prepare', {
    method: 'POST',
    cookie: s.cookie,
    body: JSON.stringify({ op: 'rotate', ...(exclude.length > 0 ? { exclude } : {}) }),
  });
  if (prep.status !== 200) {
    die(`POST /api/mesh/relay/meta-key/prepare HTTP ${prep.status}: ${short(prep.text)}`);
  }
  const payload = prep.body.payload;
  if (typeof payload !== 'string') die(`meta-key prepare has no payload: ${short(prep.body)}`);
  const applied = await submitRecord(s, 'meta-key', decodeBase64url(payload));
  if (applied.status !== 200) {
    die(
      `meta-key append HTTP ${applied.status}: ${short(applied.text)}` +
        (explainAppendFailure(applied) ? `\n${explainAppendFailure(applied)}` : '')
    );
  }
  log(`meta-key {op:'rotate'} 落账 epoch=${String(prep.body.epoch)} ${short(applied.body)}`);
}

// ── 子命令：revoke ─────────────────────────────────────────────────────────
function parseIds(): string[] {
  const raw = str('ids');
  if (!raw) die('revoke requires --ids <32-hex>[,<32-hex>…]');
  const ids = raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const bad = ids.filter((id) => !HEX32.test(id));
  if (bad.length > 0) die(`not 32-hex node ids: ${bad.join(', ')}`);
  if (ids.length === 0) die('revoke requires at least one node id');
  return [...new Set(ids)];
}

async function cmdRevoke(): Promise<void> {
  const ids = parseIds();
  const reason = str('reason') || 'migrated to relay';
  if (DRY) {
    head(`revoke --dry-run（不开会话、不发任何请求；入口 ${BASE}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    for (const id of ids) {
      plan(
        `GET /api/auth/keylog/head → 根钥签 revoke-node {node_id:${id}, reason:"${reason}"} → POST /api/auth/keylog?hub=sync`
      );
    }
    plan(`POST /api/mesh/relay/meta-key/prepare {"op":"rotate","exclude":[${ids.length} 个旧 id]}`);
    plan('GET /api/auth/keylog/head → 根钥签 meta-key → POST /api/auth/keylog?hub=sync');
    console.log(
      `\n会改状态（${ids.length} 条 revoke-node + 1 条 meta-key）。真实执行需要：\n` +
        `  MESH_PASSWORD=… bun migrate-prod.ts revoke --ids ${ids.join(',')} --yes`
    );
    return;
  }
  if (!YES) die('revoke changes state: re-run with --yes (or use --dry-run to preview)');
  let s: Session | null = null;
  try {
    s = await openSession();
    const before = await meshNodes(s);
    const live = before.filter((n) => n.online).map((n) => n.id);
    const hitLive = ids.filter((id) => live.includes(id));
    if (hitLive.length > 0 && flags['allow-online'] !== true) {
      die(
        `拒绝执行：这些 id 现在还在线，吊销会把在网机器踢掉 —— ${hitLive.join(', ')}。` +
          '确认它们确实是迁移后残留的旧身份后加 --allow-online 重跑。'
      );
    }
    for (const id of ids) {
      const r = await submitRecord(
        s,
        'revoke-node',
        encodeRevokeNodePayload({ node_id: hexToBytes(id), reason })
      );
      if (r.status !== 200) {
        die(
          `revoke-node ${id} HTTP ${r.status}: ${short(r.text)}` +
            (explainAppendFailure(r) ? `\n${explainAppendFailure(r)}` : '')
        );
      }
      log(`revoke-node ${id} 落账 ${short(r.body, 120)}`);
    }
    await rotateMetaKey(s, ids);
    console.log('\nOK。用 status 复核：中继注册表里旧 id 应变 revoked，在网节点不掉线。');
  } finally {
    wipe(s);
  }
}

// ── 子命令：rotate ─────────────────────────────────────────────────────────
async function cmdRotate(): Promise<void> {
  if (DRY) {
    head(`rotate --dry-run（不开会话、不发任何请求；入口 ${BASE}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    plan('POST /api/mesh/relay/meta-key/prepare {"op":"rotate"} → {epoch, payload}');
    plan('GET /api/auth/keylog/head → 根钥签 meta-key → POST /api/auth/keylog?hub=sync');
    console.log(`\n会改状态（1 条 meta-key）。真实执行：MESH_PASSWORD=… bun migrate-prod.ts rotate --yes`);
    return;
  }
  if (!YES) die('rotate changes state: re-run with --yes (or use --dry-run to preview)');
  let s: Session | null = null;
  try {
    s = await openSession();
    await rotateMetaKey(s, []);
    console.log('\nOK。');
  } finally {
    wipe(s);
  }
}

// ── readmit（G7：把 admit-node 按当前 root epoch 重签一遍） ────────────────
/**
 * 现网踩到的设计缺口：账户根已经轮换到 epoch 4，但全部 `admit-node` 记录还停在 epoch 1，
 * 中继的 `verifyRelayMemberProof` 要求 `record.root_epoch === 租户当前 epoch`，于是
 * `relay.auth` 一律回 `member-epoch_mismatch`。G7 的修法是由持根钥的入口重签一批
 * `readmit-node` 记录（同样内嵌 authorization + certificate，但 root_epoch 是当前值）。
 */
const READMIT_RECORD_TYPE = 'readmit-node';

type ReadmitEntry = {
  nodeId: string;
  name?: string | null;
  admitSeq?: number | string;
  admitRootEpoch?: number;
  authorization_bytes: string;
  certificate_bytes: string;
  cert_sig: string;
};

type ReadmitPrepare = { rootEpoch: number; entries: ReadmitEntry[] };

/** G7 未落地时 shared 的 KeyLogType 里没有这个值，Borsh 编码会在运行时炸；先给一条人话。 */
function assertReadmitSupported(): void {
  const known = Object.keys(KeyLogType as unknown as Record<string, string>);
  if (!known.includes(READMIT_RECORD_TYPE)) {
    die(
      `G7 尚未落地：/Users/konata/code/tmex-r25 的 packages/shared/src/auth/encoding.ts ` +
        `KeyLogType 里还没有 '${READMIT_RECORD_TYPE}'（现有：${known.join(', ')}）。` +
        '等 G7 合入后重跑本命令即可，脚本本身不用改。'
    );
  }
}

/** 顺序重签并提交；返回成功条数。任一条失败即中止（半截的成员表比不动更糟）。 */
async function runReadmit(s: Session): Promise<{ total: number; ok: number }> {
  assertReadmitSupported();
  const prep = await call('/api/mesh/relay/readmit/prepare', { cookie: s.cookie });
  if (prep.status !== 200) {
    die(`GET /api/mesh/relay/readmit/prepare HTTP ${prep.status}: ${short(prep.text)}`);
  }
  const body = prep.body as unknown as ReadmitPrepare;
  const entries = Array.isArray(body.entries) ? body.entries : [];
  log(`readmit/prepare: rootEpoch=${body.rootEpoch} entries=${entries.length}`);
  if (entries.length === 0) {
    console.log('没有需要重签的 admit-node。');
    return { total: 0, ok: 0 };
  }
  let ok = 0;
  for (const entry of entries) {
    const authorizationBytes = decodeBase64url(entry.authorization_bytes);
    const authorizationSig = s.rootKey.sign(authorizationBytes);
    const payload = encodeAdmitNodePayload({
      authorization_bytes: authorizationBytes,
      authorization_sig: authorizationSig,
      certificate_bytes: decodeBase64url(entry.certificate_bytes),
      cert_sig: decodeBase64url(entry.cert_sig),
    });
    const r = await submitRecord(s, READMIT_RECORD_TYPE, payload);
    const label =
      `${(entry.name ?? '?').padEnd(16)} ${entry.nodeId} ` +
      `admitSeq=${String(entry.admitSeq ?? '?')} admitRootEpoch=${String(entry.admitRootEpoch ?? '?')} ` +
      `→ rootEpoch=${body.rootEpoch}`;
    if (r.status !== 200) {
      console.log(`FAIL ${label} HTTP ${r.status} ${short(r.text, 200)}`);
      die(
        `readmit-node 在 ${entry.nodeId} 上失败，已中止（前 ${ok} 条已落账）。` +
          (explainAppendFailure(r) ? `\n${explainAppendFailure(r)}` : '')
      );
    }
    ok += 1;
    console.log(`PASS ${label} seq=${String((r.body as { seq?: unknown }).seq ?? '?')}`);
  }
  return { total: entries.length, ok };
}

function planReadmit(prefix: string): void {
  plan(`${prefix}GET /api/mesh/relay/readmit/prepare → {rootEpoch, entries:[{nodeId,name,admitSeq,admitRootEpoch,authorization_bytes,certificate_bytes,cert_sig}]}`);
  plan(
    `${prefix}每条 entry：authorization_sig = rootKey.sign(authorization_bytes) → ` +
      `encodeAdmitNodePayload({authorization_bytes, authorization_sig, certificate_bytes, cert_sig})`
  );
  plan(
    `${prefix}每条 entry：GET /api/auth/keylog/head → 根钥签 '${READMIT_RECORD_TYPE}' 记录 → POST /api/auth/keylog?hub=sync（顺序，逐条打印结果）`
  );
}

async function cmdReadmit(): Promise<void> {
  if (DRY) {
    head(`readmit --dry-run（不开会话、不发任何请求；入口 ${BASE}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    planReadmit('');
    const known = Object.keys(KeyLogType as unknown as Record<string, string>);
    console.log(
      `\nshared 的 KeyLogType ${known.includes(READMIT_RECORD_TYPE) ? '已' : '尚未'}包含 '${READMIT_RECORD_TYPE}'` +
        `${known.includes(READMIT_RECORD_TYPE) ? '（G7 已落地）' : '（G7 未落地：真实执行会被前置检查挡下并提示，不会发出畸形记录）'}`
    );
    console.log(`会改状态（每台一条 ${READMIT_RECORD_TYPE}）。真实执行：MESH_PASSWORD=… bun migrate-prod.ts readmit --yes`);
    return;
  }
  if (!YES) die('readmit changes state: re-run with --yes (or use --dry-run to preview)');
  let s: Session | null = null;
  try {
    s = await openSession();
    const res = await runReadmit(s);
    console.log(`\n${res.ok}/${res.total} 条 ${READMIT_RECORD_TYPE} 已落账。`);
  } finally {
    wipe(s);
  }
}

// ── 子命令：leave（中继 → hub 回滚，等价前端「离开中继」） ─────────────────
type HubsView = {
  hubs: Array<{
    nodeId: string;
    publicUrl: string;
    name?: string;
    mode: string;
    writerEpoch: number;
    online: boolean;
    authorization?: string;
  }>;
  attached: unknown;
  writerHubId?: string | null;
};

const meshHubs = async (s: Session): Promise<HubsView> =>
  (await sessionJson(s, '/api/mesh/hubs')) as unknown as HubsView;

async function cmdLeave(): Promise<void> {
  if (DRY) {
    head(`leave --dry-run（不开会话、不发任何请求；入口 ${BASE}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    plan('GET  /api/mesh/relay/status                         ← 先确认当前 mode=relay');
    plan('POST /api/mesh/relay/leave/prepare                  → {metaEpoch, payload, payloadHash}（空中继表的 set-relays）');
    plan('GET  /api/auth/keylog/head → 根钥签 set-relays(payload) → POST /api/auth/keylog?hub=sync');
    plan(
      `轮询 GET /api/mesh/relay/status 直到 mode !== 'relay'，且 GET /api/mesh/hubs 的 attached 非空（上限 ${WAIT_MS}ms）`
    );
    plan('打印最终的 /api/mesh/relay/status 与 /api/mesh/hubs');
    console.log(
      `\n会改状态（1 条空列表 set-relays，把本机从中继模式退回 hub 模式）。真实执行：\n` +
        `  MESH_PASSWORD=… bun migrate-prod.ts leave --yes
  MESH_PASSWORD=… bun migrate-prod.ts readmit --yes`
    );
    return;
  }
  if (!YES) die('leave changes state: re-run with --yes (or use --dry-run to preview)');
  let s: Session | null = null;
  try {
    s = await openSession();
    const before = await relayStatus(s);
    if (before.mode !== 'relay') {
      die(
        `本机当前 mode=${before.mode}，不在中继模式，没有可离开的中继（leave/prepare 会回 409 RELAY_NOT_CONFIGURED）`
      );
    }
    log(`当前：mode=${before.mode} tenantId=${before.tenantId} relays=${short(before.relays)}`);

    const prep = await call('/api/mesh/relay/leave/prepare', {
      method: 'POST',
      cookie: s.cookie,
      body: JSON.stringify({}),
    });
    if (prep.status !== 200) {
      die(`POST /api/mesh/relay/leave/prepare HTTP ${prep.status}: ${short(prep.text)}`);
    }
    const payload = prep.body.payload;
    if (typeof payload !== 'string') die(`leave/prepare has no payload: ${short(prep.body)}`);
    const applied = await submitRecord(s, 'set-relays', decodeBase64url(payload));
    if (applied.status !== 200) {
      die(
        `set-relays（空列表）append HTTP ${applied.status}: ${short(applied.text)}` +
          (explainAppendFailure(applied) ? `\n${explainAppendFailure(applied)}` : '')
      );
    }
    log(`空列表 set-relays 落账 ${short(applied.body)}`);

    let lastStatus: RelayStatus | null = null;
    let lastHubs: HubsView | null = null;
    try {
      await waitFor(
        "mode !== 'relay' and a hub attached",
        async () => {
          lastStatus = await relayStatus(s as Session);
          lastHubs = await meshHubs(s as Session);
          const off = lastStatus.mode !== 'relay';
          const attached = lastHubs.attached != null;
          return off && attached ? true : null;
        },
        WAIT_MS,
        2000
      );
    } catch (e) {
      head('/api/mesh/relay/status（超时时的最后一次读数）');
      console.log(JSON.stringify(lastStatus, null, 2));
      head('/api/mesh/hubs（超时时的最后一次读数）');
      console.log(JSON.stringify(lastHubs, null, 2));
      die(
        `记录已落账，但 ${WAIT_MS}ms 内没能回到「hub 模式 + 已挂上 hub」：` +
          `${e instanceof Error ? e.message : String(e)}。` +
          '若 mode 已经不是 relay 而只是 attached 还空，多半是 hub 侧还没接上，稍等或重启本机服务再看。'
      );
    }

    head('/api/mesh/relay/status');
    console.log(JSON.stringify(lastStatus, null, 2));
    head('/api/mesh/hubs');
    console.log(JSON.stringify(lastHubs, null, 2));
    console.log('\nOK：已退回 hub 模式并挂上 hub。');
  } finally {
    wipe(s);
  }
}

// ── 子命令：verify ─────────────────────────────────────────────────────────
type HelloProbe = {
  error?: { code: number; message: string };
  helloS2C?: { serverVersion: string };
  close?: { code: number; reason: string };
};

function helloProbe(wsUrl: string, cookie: string, clientVersion: string): Promise<HelloProbe> {
  return new Promise((resolve, reject) => {
    const out: HelloProbe = {};
    const socket = new WebSocket(wsUrl, { headers: { cookie } } as unknown as string[]);
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
        clientImpl: 'migrate-prod-probe',
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
      if (!out.error && !out.helloS2C) finish(new Error(`websocket error on ${wsUrl}`));
    });
  });
}

/** 经入口反代到远端节点：challenge → login → GET /n/<id>/api/devices。 */
async function proxyLogin(s: Session, nodeId: string): Promise<string> {
  const ch = await call(`/n/${nodeId}/api/auth/challenge`, {
    method: 'POST',
    cookie: s.cookie,
    body: JSON.stringify({ uid: s.userId }),
  });
  if (ch.status !== 200) throw new Error(`challenge HTTP ${ch.status}: ${short(ch.text, 160)}`);
  const body = ch.body as unknown as { challenge_id: string; nonce: string; nodePk: string };
  const sess = generateEd25519KeyPair();
  const del = createDelegation(s.rootKey, {
    uid: s.userId,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: s.userId,
    entry: s.nodeId,
  });
  const totp = totpBodyFor(s);
  const res = await call(`/n/${nodeId}/api/auth/login`, {
    method: 'POST',
    cookie: s.cookie,
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(encodeDelegation(del.delegation)),
      delegation_sig: encodeBase64url(del.sig),
      ...(totp ? { totp } : {}),
    }),
  });
  if (res.status !== 200) throw new Error(`remote login HTTP ${res.status}: ${short(res.text, 160)}`);
  return `${s.cookie}; tmex_s_${nodeId}=${sidFrom(res.res, nodeId)}`;
}

async function cmdVerify(): Promise<void> {
  const names = str('names')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (DRY) {
    head(`verify --dry-run（不开会话、不发任何请求；入口 ${BASE}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    plan('GET  /api/mesh/nodes                                ← 按 name 找 online 的节点 id');
    for (const name of names.length > 0 ? names : ['<--names 未给：默认验全部 online 节点>']) {
      plan(`${name}: POST /n/<id>/api/auth/challenge → POST /n/<id>/api/auth/login → GET /n/<id>/api/devices`);
      plan(`${name}: WS ${BASE.replace(/^http/, 'ws')}/n/<id>/ws 发 HELLO_C2S，期望 HELLO_S2C`);
    }
    console.log('\n只读（会在远端节点上开一个会话，不写任何配置）。');
    console.log(`真实执行：MESH_PASSWORD=… bun migrate-prod.ts verify --names a,b,c`);
    return;
  }
  let s: Session | null = null;
  let failed = 0;
  try {
    s = await openSession();
    const nodes = await meshNodes(s);
    const targets =
      names.length > 0
        ? names.map((name) => ({ name, row: nodes.find((n) => n.name === name && n.online) }))
        : nodes
            .filter((n) => n.online && n.id !== s?.nodeId)
            .map((n) => ({ name: n.name, row: n }));
    for (const { name, row } of targets) {
      if (!row) {
        failed += 1;
        console.log(`FAIL ${name}: 不在 /api/mesh/nodes 的 online 列表里`);
        continue;
      }
      let jar = '';
      try {
        jar = await proxyLogin(s, row.id);
      } catch (e) {
        failed += 1;
        console.log(`FAIL ${name} (${row.id}): 反代登录失败 — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const devices = await call(`/n/${row.id}/api/devices`, { cookie: jar });
      const httpOk = devices.status === 200;
      let hello: HelloProbe | null = null;
      let helloErr = '';
      try {
        hello = await helloProbe(
          `${BASE.replace(/^http/, 'ws')}/n/${row.id}/ws`,
          jar,
          row.version ?? '1.1.25'
        );
      } catch (e) {
        helloErr = e instanceof Error ? e.message : String(e);
      }
      const wsOk = hello?.helloS2C !== undefined && !hello?.error;
      if (!httpOk || !wsOk) failed += 1;
      console.log(
        `${httpOk && wsOk ? 'PASS' : 'FAIL'} ${name} (${row.id}) v=${row.version ?? '?'} ` +
          `reach=${row.reach ?? '?'} | GET /n/<id>/api/devices ${devices.status} | ` +
          `HELLO ${wsOk ? `ok serverVersion=${hello?.helloS2C?.serverVersion}` : `失败 ${helloErr || short(hello?.error)}`}`
      );
    }
    console.log(`\n${targets.length - failed}/${targets.length} 台通过`);
  } finally {
    wipe(s);
  }
  if (failed > 0) process.exit(2);
}

// ── 子命令：upgrade（远程升级节点，复刻前端「节点管理 → 升级」） ───────────
//
// 真实调用链（apps/fe/.../use-node-upgrade.ts + apps/gateway/src/system/upgrade-service.ts）：
//   1. 目标节点的会话：经入口 `/n/<id>/api/auth/challenge` + `/api/auth/login`
//      —— 入口侧 `readNodeSession(req, nodeId)` 要求 cookie 里有 `tmex_s_<nodeId>`，
//         没有就直接 401 `NODE_LOGIN_REQUIRED`；
//   2. `POST /api/mesh/nodes/<id>/upgrade`（**入口侧**路由，body `{}`）：
//      入口先 `GET /n/<id>/api/system/info` 看 `canSelfUpdate` 与 `upgradeCapabilities`，
//      - 带 `staged-package` → 入口自己下载一次 release，再经 `/api/system/upgrade/package`
//        推给目标（**github 不可达的机器走这条**），然后 `/api/system/upgrade` 起执行；
//      - 不带 → 入口只转发 `POST /api/system/upgrade {version}`，由目标自己去下载。
//   3. `GET /api/mesh/nodes/<id>/upgrade` 轮询，直到状态机收敛（见 watchUpgrade 的判定链）。
//
// 版本不可选：入口固定用 `requireLatestUpgradeRelease()`（GitHub latest），请求体里的
// version 会被忽略。所以 `--version` 只当**期望值**：与 latest 不符就拒跑，跑完拿它核对。
const UPGRADE_POLL_MS = 2000;
const upgradeJar = new Map<string, string>();
const UPGRADE_BUDGET_MS = 6 * 60_000;
/** POST 之后迟迟不进入非 idle：判定没真正开始，不空等满预算（与 FE 的 START_GRACE_MS 一致）。 */
const UPGRADE_START_GRACE_MS = 30_000;
const UPGRADE_CANCELLED_ERROR = 'UPGRADE_CANCELLED';
/** 轮询遇到这些码立刻收尾，其余 4xx 也是确定性结论，5xx 视为「重启中」继续等。 */
const UPGRADE_DEFINITIVE_CODES = new Set([
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NODE_LOGIN_REQUIRED',
  'UPGRADE_NOT_ALLOWED',
  'UPGRADE_UNSUPPORTED',
]);

type UpgradeStatus = {
  state?: string;
  targetVersion?: string | null;
  error?: string | null;
  startedAt?: string | null;
};

function codeOf(body: Json): string {
  const code = (body as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const err = (body as { error?: unknown }).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'UPGRADE_FAILED';
}

type UpgradeOutcome = 'done' | 'alreadyLatest' | 'failed' | 'timeout' | 'stopped' | 'skipped';

async function nodeVersionOf(s: Session, nodeId: string): Promise<string | null | undefined> {
  const row = (await meshNodes(s)).find((n) => n.id === nodeId);
  return row ? (row.version ?? null) : undefined;
}

/** 复刻 FE 的 watchUpgrade / settleIdle 判定链。 */
async function watchUpgrade(
  s: Session,
  nodeId: string,
  label: string,
  targetVersion: string,
  sawActiveInit: boolean,
  unconfirmedStart: boolean,
  budgetMs: number
): Promise<{ outcome: UpgradeOutcome; note: string }> {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let sawActive = sawActiveInit;
  let phase = '';
  const say = (next: string): void => {
    if (next === phase) return;
    phase = next;
    log(`  ${label}: ${next} (+${((Date.now() - startedAt) / 1000).toFixed(0)}s)`);
  };
  const versionConfirmed = async (strict: boolean): Promise<boolean> => {
    const version = await nodeVersionOf(s, nodeId).catch(() => undefined);
    if (version === undefined) return false;
    if (!targetVersion) return !strict;
    return version === targetVersion;
  };
  while (Date.now() < deadline) {
    await Bun.sleep(UPGRADE_POLL_MS);
    let res: { status: number; body: Json; text: string };
    try {
      res = await call(`/api/mesh/nodes/${nodeId}/upgrade`, { cookie: upgradeJar.get(nodeId) ?? s.cookie });
    } catch {
      // 入口自己打不通：等价 FE 的 unreachable
      say(sawActive || unconfirmedStart ? 'restarting' : 'pending');
      continue;
    }
    if (res.status !== 200) {
      const code = codeOf(res.body);
      const definitive = UPGRADE_DEFINITIVE_CODES.has(code) || res.status < 500;
      if (!definitive) {
        // 5xx = 入口转发不到目标，正是「重启中」的常态
        say(sawActive || unconfirmedStart ? 'restarting' : 'pending');
        continue;
      }
      // 升完重启把会话弄丢也会走到这里：版本对上就算成功
      if (await versionConfirmed(true)) return { outcome: 'done', note: `版本已到 ${targetVersion}` };
      return { outcome: 'failed', note: `poll HTTP ${res.status} ${code}` };
    }
    const status = res.body as UpgradeStatus;
    if (status.state && status.state !== 'idle') {
      sawActive = true;
      say(status.state);
      continue;
    }
    // idle：状态不跨进程持久化，idle 上还挂着 error 就是下载阶段失败
    if (status.error === UPGRADE_CANCELLED_ERROR) return { outcome: 'stopped', note: '已被取消' };
    if (status.error) return { outcome: 'failed', note: String(status.error) };
    if (!sawActive) {
      if (unconfirmedStart && (await versionConfirmed(true))) {
        return { outcome: 'done', note: `版本已到 ${targetVersion}（POST 回包丢了但升级跑完了）` };
      }
      if (Date.now() - startedAt > UPGRADE_START_GRACE_MS) {
        return { outcome: 'timeout', note: `${UPGRADE_START_GRACE_MS / 1000}s 内没进入 downloading/executing，判定没真正开始` };
      }
      continue;
    }
    say('restarting');
    if (await versionConfirmed(false)) {
      return { outcome: 'done', note: `版本已到 ${targetVersion}` };
    }
  }
  const seen = await nodeVersionOf(s, nodeId).catch(() => undefined);
  return {
    outcome: 'timeout',
    note: `${budgetMs / 1000}s 预算内没确认到新版本（当前 mesh 清单里是 ${String(seen)}）；升级可能仍在跑，用 status 复核`,
  };
}

async function upgradeOne(
  s: Session,
  row: MeshNode,
  targetVersion: string,
  budgetMs: number
): Promise<{ outcome: UpgradeOutcome; note: string }> {
  const label = `${row.name}(${row.id.slice(0, 8)})`;
  let jar = '';
  try {
    jar = await proxyLogin(s, row.id);
  } catch (e) {
    return { outcome: 'failed', note: `目标会话建不起来（入口侧要 tmex_s_<id> cookie）：${e instanceof Error ? e.message : String(e)}` };
  }
  const info = await call(`/n/${row.id}/api/system/info`, { cookie: jar });
  const caps = (info.body as { upgradeCapabilities?: unknown }).upgradeCapabilities;
  const capList = Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : [];
  const canSelfUpdate = (info.body as { canSelfUpdate?: unknown }).canSelfUpdate;
  const baseVersion = (info.body as { baseVersion?: unknown }).baseVersion;
  const staged = capList.includes('staged-package');
  log(
    `  ${label}: /api/system/info → baseVersion=${String(baseVersion)} canSelfUpdate=${String(canSelfUpdate)} ` +
      `capabilities=[${capList.join(',')}] → ${staged ? '入口下载一次并推包（目标无需访问 github）' : '目标自行下载（需要能访问 github）'}`
  );
  if (canSelfUpdate === false) {
    return { outcome: 'failed', note: 'canSelfUpdate=false（无 install-meta 的手工部署，UI 升级不可用）' };
  }

  let started: { status: number; body: Json; text: string } | null = null;
  try {
    // body 固定 `{}`：版本由入口自己解析 GitHub latest，请求体里的 version 会被忽略
    upgradeJar.set(row.id, jar);
    started = await call(`/api/mesh/nodes/${row.id}/upgrade`, {
      method: 'POST',
      cookie: jar,
      body: '{}',
    });
  } catch {
    started = null; // 回包丢了：目标可能已经开始，绝不重发 POST
  }
  let sawActive = false;
  let unconfirmed = false;
  if (!started) {
    unconfirmed = true;
    log(`  ${label}: POST 回包丢失 → 结果未知，转入轮询确认（不重发）`);
  } else if (started.status === 200) {
    const st = started.body as UpgradeStatus;
    sawActive = Boolean(st.state && st.state !== 'idle');
    log(`  ${label}: POST 已受理 state=${String(st.state)} targetVersion=${String(st.targetVersion)}`);
  } else {
    const code = codeOf(started.body);
    if (code === 'UPGRADE_ALREADY_LATEST') {
      return { outcome: 'alreadyLatest', note: `已是最新（${short(started.text, 120)}）` };
    }
    if (code === 'NODE_UNREACHABLE') {
      unconfirmed = true;
      log(`  ${label}: POST 回 NODE_UNREACHABLE → 结果未知，转入轮询确认（不重发）`);
    } else {
      return { outcome: 'failed', note: `POST HTTP ${started.status} ${code} ${short(started.text, 160)}` };
    }
  }
  return await watchUpgrade(s, row.id, label, targetVersion, sawActive, unconfirmed, budgetMs);
}

async function cmdUpgrade(): Promise<void> {
  const names = str('names')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const wantVersion = str('version');
  const budgetMs = Number(str('budget-ms') || String(UPGRADE_BUDGET_MS));
  if (DRY) {
    head(`upgrade --dry-run（不开会话、不发任何请求；入口 ${BASE}）`);
    plan('POST /api/auth/challenge + /api/auth/login          ← 开会话（MESH_PASSWORD）');
    plan('GET  /api/mesh/upgrade/latest                       → {latestVersion, changelog, publishedAt}');
    if (wantVersion) {
      plan(`本地：断言 latestVersion === '${wantVersion}'（版本不可指定，见下）；不符即拒跑`);
    }
    plan('GET  /api/mesh/nodes                                ← 按 name 找 online 的节点 id 与当前 version');
    for (const name of names.length > 0 ? names : ['<--names 未给>']) {
      plan(`${name}: POST /n/<id>/api/auth/challenge → POST /n/<id>/api/auth/login（入口侧要 tmex_s_<id> cookie，否则 401 NODE_LOGIN_REQUIRED）`);
      plan(`${name}: GET /n/<id>/api/system/info → baseVersion / canSelfUpdate / upgradeCapabilities（含 staged-package 则由入口下载并推包）`);
      plan(`${name}: POST /api/mesh/nodes/<id>/upgrade  body {}（入口路由；版本由入口取 GitHub latest）`);
      plan(`${name}: 轮询 GET /api/mesh/nodes/<id>/upgrade 每 ${UPGRADE_POLL_MS}ms，直到 idle+版本对上 / 报错 / ${budgetMs / 1000}s 预算耗尽`);
    }
    console.log(
      `\n版本不可指定：入口的 handleMeshNodeUpgradeStart 固定调用 requireLatestUpgradeRelease()` +
        `（GitHub latest），POST body 里的 version 会被忽略。--version 只作为期望值校验。`
    );
    console.log(`推包路径：目标 /api/system/info 的 upgradeCapabilities 含 'staged-package' 时，`);
    console.log(`入口自己下载一次 release，经 /api/system/upgrade/package 推给目标 —— 访问不了 github 的机器（jiefa-dns-1）走这条；`);
    console.log(`不含时入口只转发 POST /api/system/upgrade {version}，由目标自己下载（jiefa-app 走这条）。`);
    console.log(`中途要停：DELETE /api/mesh/nodes/<id>/upgrade（本脚本不实现，网页上有「停止升级」）。`);
    console.log(
      `\n会改状态（目标机会被替换并重启）。真实执行：\n` +
        `  MESH_PASSWORD=… bun migrate-prod.ts upgrade --names ${names.join(',') || 'a,b'}${wantVersion ? ` --version ${wantVersion}` : ''} --yes`
    );
    return;
  }
  if (names.length === 0) die('upgrade requires --names <name>[,<name>…]');
  if (!YES) die('upgrade changes state: re-run with --yes (or use --dry-run to preview)');
  let s: Session | null = null;
  let failed = 0;
  try {
    s = await openSession();
    const latest = await call('/api/mesh/upgrade/latest', { cookie: s.cookie });
    const latestVersion =
      typeof (latest.body as { latestVersion?: unknown }).latestVersion === 'string'
        ? String((latest.body as { latestVersion: string }).latestVersion)
        : '';
    if (!latestVersion) {
      die(`GET /api/mesh/upgrade/latest HTTP ${latest.status}: ${short(latest.text)}（拿不到 GitHub latest，升级无法开始）`);
    }
    log(`GitHub latest = ${latestVersion}`);
    if (wantVersion && wantVersion !== latestVersion) {
      die(
        `--version ${wantVersion} 与 GitHub latest ${latestVersion} 不符。` +
          '入口只会升到 latest（handleMeshNodeUpgradeStart 固定用 requireLatestUpgradeRelease），无法指定别的版本。'
      );
    }
    const nodes = await meshNodes(s);
    for (const name of names) {
      const row = nodes.find((n) => n.name === name);
      head(`${name}`);
      if (!row) {
        failed += 1;
        console.log(`SKIP ${name}: 不在 /api/mesh/nodes 里`);
        continue;
      }
      if (!row.online) {
        failed += 1;
        console.log(`SKIP ${name} (${row.id}): 当前离线`);
        continue;
      }
      if (row.version === latestVersion) {
        console.log(`SKIP ${name} (${row.id}): 已经是 ${latestVersion}`);
        continue;
      }
      log(`${name} (${row.id}) 当前 ${row.version ?? '?'} → ${latestVersion}`);
      const res = await upgradeOne(s, row, latestVersion, budgetMs);
      if (res.outcome !== 'done' && res.outcome !== 'alreadyLatest') failed += 1;
      console.log(`${res.outcome === 'done' ? 'PASS' : res.outcome.toUpperCase()} ${name} — ${res.note}`);
    }
    head('升级后的节点清单');
    for (const n of await meshNodes(s)) {
      console.log(`  ${n.id}  ${(n.name ?? '').padEnd(16)} ${n.online ? 'online ' : 'OFFLINE'} v=${n.version ?? '?'}`);
    }
  } finally {
    wipe(s);
  }
  if (failed > 0) process.exit(2);
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const USAGE = `
migrate-prod.ts —— 现网 Hub → 中继 迁移的入口机驱动（只操作本机入口，不碰远端）

  bun migrate-prod.ts <子命令> [选项]

子命令
  status                      打印 /api/auth/mode、/api/mesh/nodes（id/name/online/version）、
                              /api/mesh/hubs、/api/mesh/relay/status；并标出版本 < ${MIN_RELAY_RECORD_VERSION} 的节点
  enroll --url <中继地址>      runbook 阶段 2：proof-material → enroll → 签 set-relays →
                              keylog?hub=sync → 等 mode=relay attached →
                              join-material?scope=all → 密封包 → POST /api/mesh/relay/pack
                              （清楚地打印 TENANT ID）
  revoke --ids <hex,hex,…>    每个旧 node id 签一条 revoke-node，然后 meta-key {op:'rotate'}
  rotate                      只做 meta-key {op:'rotate'}
  readmit                     [G7] GET /api/mesh/relay/readmit/prepare，把每条历史 admit-node
                              用当前 root epoch 重签成 readmit-node 并顺序提交
                              （修 relay.auth 的 member-epoch_mismatch）
  leave                       中继 → hub 回滚（等价前端「离开中继」）：leave/prepare →
                              根钥签空列表 set-relays → keylog?hub=sync →
                              等 /api/mesh/relay/status 的 mode 不再是 relay 且
                              /api/mesh/hubs 的 attached 非空，然后把两者都打印出来
  upgrade --names a,b         远程升级（复刻网页「节点管理 → 升级」）：经入口给目标建会话 →
          [--version v]       POST /api/mesh/nodes/<id>/upgrade → 轮询到收敛，逐台打印进度。
                              **版本不可指定**：入口固定升到 GitHub latest，--version 只作期望值校验。
                              目标 upgradeCapabilities 含 staged-package 时由入口下载并推包
                              （github 不可达的机器走这条），否则目标自行下载
  verify [--names a,b,c]      对每台（指定名字的）online 节点做 /n/<id>/api/devices 反代检查
                              + canonical WS HELLO 探测；不给 --names 就验全部 online 节点

选项
  --dry-run                   只打印将要发起的调用；完全离线（不派生根钥、不开会话、不发请求）
  --yes                       enroll / revoke / rotate / leave / readmit / upgrade 真实执行时必须显式给
  --budget-ms <ms>            upgrade 每台的总预算（下载+解包+重启+版本回传），默认 360000
  --skip-readmit              enroll 时即使 readmitRequired > 0 也不自动重签（一般不要用）
  --base <url>                入口地址，默认 ${DEFAULT_BASE}
  --wait-ms <ms>              enroll / leave 等待状态收敛的上限，默认 120000
  --reason <text>             revoke-node 的原因，默认 "migrated to relay"
  --allow-online              revoke 时允许吊销仍在线的 id（默认拒绝，防止误踢在网机器）

环境变量
  MESH_PASSWORD               mesh 账户密码。只在内存里用来派生根钥，绝不打印、绝不落盘
  TMEX_TOTP                   账户开了 TOTP 时的当前 6 位验证码
  RELAY_PASSWORD              enroll 用的中继租户口令（POST /api/setup/relay 里设的那个）

注意
  · 必须在入口机本机直连 127.0.0.1 执行：只有这样才满足 isTrustedLocalClient，
    通行密钥二次验证才会被豁免。经反代访问、或带上 x-forwarded-for / x-real-ip /
    cf-connecting-ip，登录会要求 passkey（本脚本不会设置这些头）。
  · 远端机器的 \`tmex hub leave\` / \`tmex relay join\` 不在本脚本范围内，见
    prompt-archives/2026090402-round25-relay-live-bots/sub/LT-result.md 的 runbook。

示例
  bun migrate-prod.ts status --dry-run
  MESH_PASSWORD=… bun migrate-prod.ts status
  MESH_PASSWORD=… RELAY_PASSWORD=… bun migrate-prod.ts enroll --url https://tmexhub-sh.jiefakj.com --yes
  MESH_PASSWORD=… bun migrate-prod.ts revoke --ids aaaa…,bbbb… --yes
  MESH_PASSWORD=… bun migrate-prod.ts leave --yes
  MESH_PASSWORD=… bun migrate-prod.ts verify --names jiefa-app,jiefa-dns-1,docker-node,tmexhub-sh
  MESH_PASSWORD=… bun migrate-prod.ts upgrade --names jiefa-app,jiefa-dns-1 --version 1.1.26 --yes
`;

async function main(): Promise<void> {
  if (!cmd || flags.help === true || cmd === 'help') {
    console.log(USAGE.trim());
    return;
  }
  switch (cmd) {
    case 'status':
      await cmdStatus();
      return;
    case 'enroll':
      await cmdEnroll();
      return;
    case 'revoke':
      await cmdRevoke();
      return;
    case 'rotate':
      await cmdRotate();
      return;
    case 'leave':
      await cmdLeave();
      return;
    case 'readmit':
      await cmdReadmit();
      return;
    case 'verify':
      await cmdVerify();
      return;
    case 'upgrade':
      await cmdUpgrade();
      return;
    default:
      console.log(USAGE.trim());
      die(`unknown subcommand: ${cmd}`);
  }
}

await main();
