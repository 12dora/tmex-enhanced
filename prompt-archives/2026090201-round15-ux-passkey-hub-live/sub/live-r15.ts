// 第十五轮真实主机实测驱动：A = 生产 hub（ai.jiefakj.com:18443），B = 新 standby hub（tmexhub-sh.jiefakj.com），
// M = 本机生产 node（只读观察）。凭据从环境变量读取（creds.env），不落盘。
//   STATUS   打印 A/B/M 的 hubs / nodes 视图（版本、附着、RTT）
//   ADMIT    在 A 上以 root 签名追加 admit-hub(B)，等 A/B 都把 B 列为 signed standby
//   ROLE     A→standby、B→active（epoch 服务端分配），等过渡 complete、节点 writer 切到 B
//   ROLLBACK B→standby、A→active
import {
  fetchAuthMode,
  loginWithRootKey,
} from '/Users/konata/code/tmex-enhanced-r15/packages/app/src/lib/hub-client';
import {
  type KdfParams,
  type RootKey,
  buildAdmitHubPayload,
  buildKeyLogRecord,
  buildLogin,
  createDelegation,
  createEnrollment,
  decodeBase64url,
  deriveSeed,
  encodeDelegation,
  encodeLogin,
  encodeBase64url,
  encodeKeyLogRecord,
  generateEd25519KeyPair,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  signLogin,
} from '/Users/konata/code/tmex-enhanced-r15/packages/shared/src/auth';

const PART = (process.argv[2] ?? 'STATUS').toUpperCase();
const PASSWORD = process.env.TMEX_UI_PASS ?? '';
if (!PASSWORD) throw new Error('TMEX_UI_PASS missing');

type Inst = { name: string; url: string; nodeId?: string; sid?: string };
const A: Inst = { name: 'A', url: process.env.HUB_A_URL ?? 'https://ai.jiefakj.com:18443' };
const B: Inst = { name: 'B', url: `https://${process.env.HUB_B_HOST ?? 'tmexhub-sh.jiefakj.com'}` };
const M: Inst = { name: 'M', url: 'http://127.0.0.1:9883' };

const t0 = Date.now();
function log(msg: string): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, ms: number, every = 2000): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timeout waiting: ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
}

let rootKey: RootKey | null = null;
let meshUid = '';
function kdfFromJson(p: { salt: string; memory_kib: number; iterations: number; parallelism: number }): KdfParams {
  return { salt: decodeBase64url(p.salt), memory_kib: p.memory_kib, iterations: p.iterations, parallelism: p.parallelism };
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
type Jar = { self?: string; via: Map<string, string> };
const jars = new Map<string, Jar>();
function jarOf(inst: Inst): Jar {
  let jar = jars.get(inst.name);
  if (!jar) { jar = { via: new Map() }; jars.set(inst.name, jar); }
  return jar;
}
async function login(inst: Inst): Promise<void> {
  const key = await ensureRootKey(inst);
  const res = await loginWithRootKey({ baseUrl: inst.url, rootKey: key, uid: meshUid });
  inst.sid = res.sid;
  jarOf(inst).self = res.sid;
  if (!inst.nodeId) {
    const mode = await fetchAuthMode(inst.url);
    inst.nodeId = mode.nodeId;
  }
  log(`${inst.name} login ok node=${inst.nodeId?.slice(0, 8)}`);
}
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
type ApiResult = { status: number; json: unknown; headers: Headers; text: string };
async function rawApi(target: Inst, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  const res = await fetch(`${target.url}${path}`, {
    method,
    headers: { cookie: cookieFor(target), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, headers: res.headers, text };
}
async function api(target: Inst, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  let res = await rawApi(target, method, path, body, headers);
  if (res.status === 401 && (res.json as { code?: string } | null)?.code !== 'NODE_LOGIN_REQUIRED') {
    await login(target);
    res = await rawApi(target, method, path, body, headers);
  }
  return res;
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
async function loginVia(entry: Inst, target: Inst): Promise<void> {
  assert(target.nodeId, `${target.name} has no node id`);
  const key = await ensureRootKey(entry);
  const prefix = `/n/${target.nodeId}`;
  const chRes = await api(entry, 'POST', `${prefix}/api/auth/challenge`, { uid: meshUid });
  assert(chRes.status === 200, `challenge via ${entry.name} → ${chRes.status} ${chRes.text}`);
  const ch = chRes.json as { challenge_id: string; nonce: string; nodePk: string };
  const sess = generateEd25519KeyPair();
  const signed = createDelegation(key, { uid: meshUid, sessPk: sess.publicKey, now: Date.now() });
  const loginMsg = buildLogin({
    challengeId: ch.challenge_id, nonce: decodeBase64url(ch.nonce), target: target.nodeId,
    targetPk: decodeBase64url(ch.nodePk), uid: meshUid, entry: entry.nodeId ?? 'self',
  });
  const res = await api(entry, 'POST', `${prefix}/api/auth/login`, {
    login: encodeBase64url(encodeLogin(loginMsg)),
    sig: encodeBase64url(signLogin(sess.secretKey, loginMsg)),
    delegation: encodeBase64url(encodeDelegation(signed.delegation)),
    delegation_sig: encodeBase64url(signed.sig),
  });
  assert(res.status === 200, `login via ${entry.name} → ${res.status} ${res.text}`);
  const sid = sidFromLoginResponse(res, target.nodeId);
  assert(sid, `login via ${entry.name} returned no sid for ${target.name}`);
  jarOf(entry).via.set(target.nodeId, sid);
}
async function relay(entry: Inst, target: Inst, method: string, path: string, body?: unknown): Promise<ApiResult> {
  if (target.nodeId && !jarOf(entry).via.has(target.nodeId)) await loginVia(entry, target);
  const full = `/n/${target.nodeId}${path}`;
  let res = await api(entry, method, full, body);
  if (res.status === 401 && target.nodeId) {
    jarOf(entry).via.delete(target.nodeId);
    await loginVia(entry, target);
    res = await api(entry, method, full, body);
  }
  return res;
}

type HubRow = { nodeId: string; publicUrl: string; mode: string; priority: number; writerEpoch: number; online: boolean; authorization?: string };
type Cand = { publicUrl: string; lastError?: string | null; rttMs?: number | null };
type HubsView = { hubs: HubRow[]; attached?: { hubNodeId?: string | null } | null; writerHubId?: string | null; writerEpoch?: number; candidates?: Cand[] };
type NodeRow = { id: string; name: string; online?: boolean; version?: string | null; attachedHubId?: string | null; rttMs?: number | null; hubMode?: string | null; transport?: string | null };
async function hubsOf(inst: Inst): Promise<HubsView> {
  const res = await api(inst, 'GET', '/api/mesh/hubs');
  assert(res.status === 200, `mesh/hubs on ${inst.name} → ${res.status} ${res.text}`);
  return res.json as HubsView;
}
async function nodesOf(inst: Inst): Promise<NodeRow[]> {
  const res = await api(inst, 'GET', '/api/mesh/nodes');
  assert(res.status === 200, `mesh/nodes on ${inst.name} → ${res.status} ${res.text}`);
  return (res.json as { nodes?: NodeRow[] })?.nodes ?? [];
}
function describeHubs(v: HubsView): string {
  return `${JSON.stringify(v.hubs.map((h) => ({ id: h.nodeId.slice(0, 6), url: h.publicUrl, mode: h.mode, prio: h.priority, epoch: h.writerEpoch, auth: h.authorization ?? '-', online: h.online })))} attached=${v.attached?.hubNodeId?.slice(0, 6) ?? '-'} writer=${v.writerHubId?.slice(0, 6) ?? '-'} epoch=${v.writerEpoch ?? '-'} cand=${JSON.stringify((v.candidates ?? []).map((c) => ({ url: c.publicUrl, rtt: c.rttMs ?? null, err: c.lastError ?? null })))}`;
}
async function status(): Promise<void> {
  for (const inst of [A, B, M]) {
    try {
      await login(inst);
      log(`${inst.name} hubs: ${describeHubs(await hubsOf(inst))}`);
      const nodes = await nodesOf(inst);
      log(`${inst.name} nodes: ${JSON.stringify(nodes.map((n) => ({ id: n.id.slice(0, 6), name: n.name, online: n.online, v: n.version, hub: n.attachedHubId?.slice(0, 6) ?? null, rtt: n.rttMs ?? null, mode: n.hubMode ?? null })))}`);
    } catch (e) {
      log(`${inst.name} status failed: ${(e as Error).message}`);
    }
  }
}
async function keyLogHead(inst: Inst) {
  const res = await api(inst, 'GET', '/api/auth/keylog/head');
  assert(res.status === 200, `keylog head on ${inst.name} → ${res.status} ${res.text}`);
  const body = res.json as { seq: string | number; hash: string; rootEpoch: number; uid: string };
  meshUid = body.uid;
  return { seq: BigInt(String(body.seq)), hash: decodeBase64url(body.hash), rootEpoch: body.rootEpoch, uid: body.uid };
}
async function appendAdmitHub(writer: Inst, hub: Inst, priority: number, headers: Record<string, string> = {}): Promise<ApiResult> {
  const key = await ensureRootKey(writer);
  const head = await keyLogHead(writer);
  const payload = buildAdmitHubPayload({ hubNodeId: hexToBytes(hub.nodeId ?? ''), publicUrl: hub.url, priority });
  const record = buildKeyLogRecord({ seq: head.seq, hash: head.hash }, head.rootEpoch, { uid: head.uid, type: 'admit-hub', payload, signer: 'root', credential_id: null });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(key, bytes);
  return api(writer, 'POST', '/api/auth/keylog?hub=sync', { bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) }, headers);
}
async function admit(): Promise<void> {
  await login(A); await login(B);
  const before = await hubsOf(A);
  log(`A hubs before: ${describeHubs(before)}`);
  const already = before.hubs.find((h) => h.nodeId === B.nodeId && h.authorization === 'signed');
  if (already) { log('B already signed-authorized on A'); }
  else {
    let res = await appendAdmitHub(A, B, 200);
    if (res.status === 409 && res.text.includes('KEYLOG_TYPE_UNSUPPORTED_BY_NODES')) {
      log(`compat gate refused: ${res.text}; retrying with force header`);
      res = await appendAdmitHub(A, B, 200, { 'x-tmex-force-keylog': '1' });
    }
    assert(res.status === 200, `admit-hub → ${res.status} ${res.text}`);
    log(`admit-hub applied ${res.text.slice(0, 200)}`);
  }
  const viewA = await waitFor('A lists B as signed standby', async () => {
    const v = await hubsOf(A);
    return v.hubs.some((h) => h.nodeId === B.nodeId && h.authorization === 'signed') ? v : null;
  }, 120_000, 3000);
  log(`A hubs: ${describeHubs(viewA)}`);
  const viewB = await waitFor('B sees itself + A', async () => {
    const v = await hubsOf(B);
    return v.hubs.some((h) => h.nodeId === A.nodeId) && v.hubs.some((h) => h.nodeId === B.nodeId) ? v : null;
  }, 120_000, 3000);
  log(`B hubs: ${describeHubs(viewB)}`);
}
async function healthz(inst: Inst): Promise<{ startedAt: number } | null> {
  try {
    const r = await fetch(`${inst.url}/healthz`, { signal: AbortSignal.timeout(8000) });
    return r.ok ? ((await r.json()) as { startedAt: number }) : null;
  } catch { return null; }
}
async function switchRole(entry: Inst, target: Inst, mode: 'active' | 'standby', direct = false): Promise<void> {
  const operationId = crypto.randomUUID();
  const before = (await healthz(target))?.startedAt ?? 0;
  const res = await waitFor(`${target.name} accepts role=${mode}`, async () => {
    const r = direct ? await api(target, 'POST', '/api/hub/role', { mode, operationId }) : await relay(entry, target, 'POST', '/api/hub/role', { mode, operationId });
    if (r.status === 503) return null;
    return r;
  }, 120_000, 3000);
  assert(res.status === 202 || res.status === 200, `role ${mode} on ${target.name} → ${res.status} ${res.text}`);
  log(`${target.name} role→${mode} accepted ${res.text.slice(0, 200)}`);
  await waitFor(`${target.name} self-restart`, async () => {
    const h = await healthz(target);
    return h && h.startedAt !== before ? h : null;
  }, 120_000, 2000);
  jars.delete(target.name);
  await login(target);
  const st = await waitFor(`${target.name} transition ${operationId.slice(0, 8)} complete`, async () => {
    const r = await api(target, 'GET', `/api/hub/role/status?operationId=${operationId}`);
    if (r.status !== 200) return null;
    const body = r.json as { phase?: string; writerEpoch?: number | null; error?: string };
    if (body.phase === 'complete') return body;
    if (body.phase === 'failed') throw new Error(`role transition failed: ${r.text}`);
    return null;
  }, 120_000, 2000);
  log(`${target.name} transition complete epoch=${st.writerEpoch ?? '-'}`);
}
async function role(from: Inst, to: Inst): Promise<void> {
  await login(from); await login(to);
  log(`before: ${from.name} ${describeHubs(await hubsOf(from))}`);
  await switchRole(from, from, 'standby', true);
  await switchRole(from, to, 'active', true);
  const v = await waitFor(`${to.name} is writer everywhere`, async () => {
    const a = await hubsOf(from); const b = await hubsOf(to);
    return a.writerHubId === to.nodeId && b.writerHubId === to.nodeId ? { a, b } : null;
  }, 180_000, 3000);
  log(`${from.name} hubs: ${describeHubs(v.a)}`);
  log(`${to.name} hubs: ${describeHubs(v.b)}`);
  const nodes = await waitFor('nodes report writer/attached', async () => {
    const ns = await nodesOf(to);
    return ns.length > 0 ? ns : null;
  }, 60_000, 3000);
  log(`${to.name} nodes: ${JSON.stringify(nodes.map((n) => ({ name: n.name, online: n.online, v: n.version, hub: n.attachedHubId?.slice(0, 6) ?? null, rtt: n.rttMs ?? null })))}`);
}
async function forward(): Promise<void> {
  await login(A); await login(B);
  const key = await ensureRootKey(B);
  const head = await keyLogHead(B);
  const now = Date.now();
  const ttlMs = 2 * 60_000;
  const enrollment = await createEnrollment(key, { uid: head.uid, rootEpoch: head.rootEpoch, now, ttlMs });
  const res = await api(B, 'POST', '/api/hub/enrollments', {
    enroll_pk: encodeBase64url(enrollment.enrollPk),
    authorization: encodeBase64url(enrollment.authorizationBytes),
    authorization_sig: encodeBase64url(enrollment.authorizationSig),
    exp: now + ttlMs,
  });
  log(`enrollment via B → ${res.status} forwardedBy=${res.headers.get('x-tmex-forwarded-by')?.slice(0, 6) ?? '-'} body=${res.text.slice(0, 220)}`);
  assert(res.status === 200 || res.status === 201, 'enrollment via standby failed');
  const body = res.json as { id: string; replicatedTo?: string[] };
  log(`replicatedTo=${JSON.stringify(body.replicatedTo ?? [])} (expect B ${B.nodeId?.slice(0, 6)})`);
  const list = await api(A, 'GET', '/api/hub/enrollments');
  log(`A enrollments list → ${list.status} ${list.text.slice(0, 300)}`);
}
async function main(): Promise<void> {
  if (PART === 'STATUS') await status();
  else if (PART === 'ADMIT') await admit();
  else if (PART === 'ROLE') await role(A, B);
  else if (PART === 'ROLLBACK') await role(B, A);
  else if (PART === 'FORWARD') await forward();
  else throw new Error(`unknown part ${PART}`);
  log('DONE');
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
