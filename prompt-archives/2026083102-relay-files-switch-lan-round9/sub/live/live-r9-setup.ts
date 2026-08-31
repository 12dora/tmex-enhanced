#!/usr/bin/env bun
// V1 实测：临时 hub+node 双实例（改编自 r5 harness）。绝不触碰生产 tmex(9883) 与 session `tmex`。
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildLogin, createDelegation, decodeBase64url, deriveSeed, encodeBase64url, encodeLogin,
  generateEd25519KeyPair, rootKeyFromSeed, signLogin,
} from '/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/auth/index.ts';

const REPO = '/Users/konata/code/tmex-enhanced-wt-r9';
const CLI_AUTH = resolve(REPO, 'packages/app/src/cli-auth-entry.ts');
const SERVER = resolve(REPO, 'packages/app/src/runtime/server.ts');
const MIGRATIONS = resolve(REPO, 'apps/gateway/drizzle');
const SCRATCH = '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad/live';
const FE_DIST = `${SCRATCH}/fe-dist`;
const ROOT = `${SCRATCH}/run`;
const TMUX_SOCK = 'tmex-r9-live';
const USER = 'alice';
const PASSWORD = 'live-r9-Passw0rd!';
const MASTER_KEY = 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=';
const log = (m: string) => process.stdout.write(`[live] ${m}\n`);
const children = new Set<Bun.Subprocess>();

function canBind(port: number) { return new Promise<boolean>((d) => { const s = net.createServer(); s.once('error', () => d(false)); s.once('listening', () => s.close(() => d(true))); s.listen(port, '127.0.0.1'); }); }
const BANNED = new Set([9883, 19883, 19765, 39001, 9663, 19663]);
async function freePort(from: number) { for (let p = from; p < from + 200; p++) { if (BANNED.has(p)) continue; if (await canBind(p)) return p; } throw new Error('no port'); }
function appEnv(dir: string, roles: string, port: number, peer: number, sock: string, hubUrl: string, pub: string) {
  return ['NODE_ENV=production', `TMEX_ROLES=${roles}`, `TMEX_MASTER_KEY=${MASTER_KEY}`, `GATEWAY_PORT=${port}`, 'TMEX_BIND_HOST=127.0.0.1', `DATABASE_URL=${dir}/tmex.db`, `TMEX_BASE_URL=http://localhost:${port}`, `TMEX_HUB_URL=${hubUrl}`, `TMEX_HUB_PUBLIC_URL=${pub}`, `TMEX_PEER_PORT=${peer}`, 'TMEX_PEER_BIND_HOST=127.0.0.1', 'TMEX_STUN_SERVERS=', `TMEX_TMUX_SOCKET=${sock}`, 'TMEX_SITE_NAME=tmex', `TMEX_FE_DIST_DIR=${dir}/resources/fe-dist`, `TMEX_MIGRATIONS_DIR=${MIGRATIONS}`, ''].join('\n');
}
function mkInst(dir: string) { mkdirSync(`${dir}/resources`, { recursive: true }); if (!existsSync(`${dir}/resources/fe-dist`)) symlinkSync(FE_DIST, `${dir}/resources/fe-dist`); }
async function cli(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, CLI_AUTH, ...args], { cwd: REPO, env: { ...process.env, NODE_ENV: 'production', TMEX_MIGRATIONS_DIR: MIGRATIONS, ...extra } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`cli ${args.join(' ')} exit ${code}\n${out}\n${err}`);
  return out;
}
function startLoop(dir: string, name: string) {
  const script = `cd ${REPO}; while true; do set -a; . ${dir}/app.env; set +a; ${process.execPath} ${SERVER} >> ${dir}/server.log 2>&1; echo "[loop] exit $? restart" >> ${dir}/server.log; sleep 1; done`;
  const p = Bun.spawn(['bash', '-c', script], { stdout: 'ignore', stderr: 'ignore' });
  children.add(p); log(`${name} loop pid=${p.pid}`); return p;
}
async function healthz(port: number) { try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); return r.ok ? ((await r.json()) as { startedAt: number }) : null; } catch { return null; } }
async function waitHealthy(port: number, notStartedAt?: number, ms = 90_000) { const dl = Date.now() + ms; while (Date.now() < dl) { const h = await healthz(port); if (h && h.startedAt !== notStartedAt) return h; await Bun.sleep(500); } throw new Error(`port ${port} not healthy`); }
async function killServer(dir: string) { spawnSync('bash', ['-c', `for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${dir}/tmex.db"; then kill $p; fi; done; true`]); }
function cookieHeader(c: Record<string, string>) { return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '); }
async function apiLogin(base: string) {
  const mode = (await (await fetch(`${base}/api/auth/mode`)).json()) as any;
  const seed = await deriveSeed(PASSWORD, { salt: decodeBase64url(mode.kdfParams.salt), memory_kib: mode.kdfParams.memory_kib, iterations: mode.kdfParams.iterations, parallelism: mode.kdfParams.parallelism });
  const rootKey = rootKeyFromSeed(seed); const sess = generateEd25519KeyPair();
  const delegation = createDelegation(rootKey, { uid: mode.uid, sessPk: sess.publicKey, now: Date.now() });
  const ch = (await (await fetch(`${base}/api/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: mode.uid }) })).json()) as any;
  const login = buildLogin({ challengeId: ch.challenge_id, nonce: decodeBase64url(ch.nonce), target: 'self', targetPk: decodeBase64url(ch.nodePk), uid: mode.uid, entry: 'self' });
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: encodeBase64url(encodeLogin(login)), sig: encodeBase64url(signLogin(sess.secretKey, login)), delegation: encodeBase64url(delegation.bytes), delegation_sig: encodeBase64url(delegation.sig) }) });
  if (!res.ok) throw new Error(`login ${res.status} ${await res.text()}`);
  const cookies: Record<string, string> = {}; for (const l of res.headers.getSetCookie()) { const pair = l.split(';', 1)[0] ?? ''; const eq = pair.indexOf('='); if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
  return { cookies, mode };
}
async function nodeLogin(base: string, entry: { cookies: Record<string, string>; mode: any }, nodeId: string) {
  const seed = await deriveSeed(PASSWORD, { salt: decodeBase64url(entry.mode.kdfParams.salt), memory_kib: entry.mode.kdfParams.memory_kib, iterations: entry.mode.kdfParams.iterations, parallelism: entry.mode.kdfParams.parallelism });
  const rootKey = rootKeyFromSeed(seed); const sess = generateEd25519KeyPair();
  const delegation = createDelegation(rootKey, { uid: entry.mode.uid, sessPk: sess.publicKey, now: Date.now() });
  const H = { 'content-type': 'application/json', cookie: cookieHeader(entry.cookies) };
  const ch = (await (await fetch(`${base}/n/${nodeId}/api/auth/challenge`, { method: 'POST', headers: H, body: JSON.stringify({ uid: entry.mode.uid }) })).json()) as any;
  for (const entryId of [entry.mode.nodeId ?? 'self', 'self']) {
    const login = buildLogin({ challengeId: ch.challenge_id, nonce: decodeBase64url(ch.nonce), target: nodeId, targetPk: decodeBase64url(ch.nodePk), uid: entry.mode.uid, entry: entryId });
    const res = await fetch(`${base}/n/${nodeId}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ login: encodeBase64url(encodeLogin(login)), sig: encodeBase64url(signLogin(sess.secretKey, login)), delegation: encodeBase64url(delegation.bytes), delegation_sig: encodeBase64url(delegation.sig) }) });
    if (res.ok) { const cookies = { ...entry.cookies }; for (const l of res.headers.getSetCookie()) { const pair = l.split(';', 1)[0] ?? ''; const eq = pair.indexOf('='); if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } log(`node login ok (entry=${entryId})`); return cookies; }
    log(`node login entry=${entryId} → ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
  throw new Error('node login failed');
}
async function waitNode(base: string, cookies: Record<string, string>, name: string, online = true, ms = 120_000) {
  const dl = Date.now() + ms; let last = '';
  while (Date.now() < dl) { try { const b = (await (await fetch(`${base}/api/mesh/nodes`, { headers: { cookie: cookieHeader(cookies) } })).json()) as any; last = JSON.stringify(b); const hit = (b.nodes ?? []).find((n: any) => n.name === name && n.online === online); if (hit) return hit; } catch (e) { last = String(e); } await Bun.sleep(1000); }
  throw new Error(`node ${name} online=${online} never: ${last}`);
}
async function joinNode(hubDir: string, nodeDir: string, hubUrl: string, name: string) {
  const enroll = Bun.spawn([process.execPath, CLI_AUTH, 'enroll', '--ttl', '10m', '--install-dir', hubDir], { cwd: REPO, env: { ...process.env, NODE_ENV: 'production', TMEX_MIGRATIONS_DIR: MIGRATIONS, TMEX_PASSWORD: PASSWORD } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  children.add(enroll); const out = { text: '' };
  const reader = (async () => { for await (const c of enroll.stdout as ReadableStream<Uint8Array>) out.text += new TextDecoder().decode(c); })();
  const errText = { text: '' }; (async () => { for await (const c of enroll.stderr as ReadableStream<Uint8Array>) errText.text += new TextDecoder().decode(c); })();
  let token = ''; for (let i = 0; i < 60 && !token; i++) { const m = /join token: ([A-Za-z0-9_.-]+)/.exec(out.text); if (m) token = m[1]; else await Bun.sleep(500); }
  if (!token) throw new Error(`no token: ${out.text}\nSTDERR: ${errText.text}`);
  const j = await cli(['hub', 'join', hubUrl, '--token', token, '--name', name, '--install-dir', nodeDir, '--no-restart']);
  log(`join: ${j.trim().split('\n').slice(-2).join(' | ')}`);
  for (let i = 0; i < 60 && !out.text.includes('node admitted'); i++) await Bun.sleep(500);
  enroll.kill('SIGTERM'); children.delete(enroll); await reader.catch(() => {});
}

async function main() {
  const hubDir = `${ROOT}/hub`, nodeDir = `${ROOT}/node`; mkInst(hubDir); mkInst(nodeDir);
  const hubFiles = `${SCRATCH}/hub-files`, nodeFiles = `${SCRATCH}/node-files`, nodeFiles2 = `${SCRATCH}/node-files-2`;
  for (const d of [hubFiles, nodeFiles, nodeFiles2]) mkdirSync(d, { recursive: true });
  writeFileSync(`${hubFiles}/a.txt`, 'hub file a\n'); writeFileSync(`${hubFiles}/b.txt`, 'hub file b\n');
  writeFileSync(`${nodeFiles}/n1.txt`, 'node file n1\n'); writeFileSync(`${nodeFiles}/n2.txt`, 'node file n2\n');
  writeFileSync(`${nodeFiles2}/m1.txt`, 'node file m1\n');

  const hubPort = await freePort(21600), nodePort = await freePort(hubPort + 1);
  const hp = await freePort(39111), np = await freePort(hp + 1);
  const tlsPort = await freePort(29600);
  const hubUrl = `http://localhost:${hubPort}`, hubHttps = `https://localhost:${tlsPort}`;
  await Bun.write(`${hubDir}/app.env`, appEnv(hubDir, 'hub,node', hubPort, hp, TMUX_SOCK, '', hubHttps));
  await Bun.write(`${nodeDir}/app.env`, appEnv(nodeDir, 'standalone', nodePort, np, TMUX_SOCK, '', ''));
  log(`hub=${hubPort} node=${nodePort} peers=${hp}/${np} tls=${tlsPort}`);

  spawnSync('tmux', ['-L', TMUX_SOCK, 'kill-server']);
  spawnSync('tmux', ['-L', TMUX_SOCK, 'new-session', '-d', '-s', 'r9hub', '-x', '120', '-y', '30']);
  spawnSync('tmux', ['-L', TMUX_SOCK, 'new-session', '-d', '-s', 'r9node', '-x', '120', '-y', '30']);
  spawnSync('tmux', ['-L', TMUX_SOCK, 'send-keys', '-t', 'r9node', 'echo REMOTE_PANE_OK', 'Enter']);
  spawnSync('tmux', ['-L', TMUX_SOCK, 'send-keys', '-t', 'r9hub', 'echo HUB_PANE_OK', 'Enter']);

  await cli(['hub', 'user', 'add', USER, '--install-dir', hubDir], { TMEX_PASSWORD: PASSWORD });
  startLoop(hubDir, 'hub'); await waitHealthy(hubPort); log('hub healthy');
  startLoop(nodeDir, 'node'); const nh0 = await waitHealthy(nodePort); log('node healthy (standalone)');

  const hub0 = await apiLogin(hubUrl);
  let r = await fetch(`${hubUrl}/api/tls`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookieHeader(hub0.cookies) }, body: JSON.stringify({ mode: 'selfsigned', sans: ['localhost', '127.0.0.1'], tlsPort, bindHost: '127.0.0.1' }) });
  log(`hub tls selfsigned → ${r.status}`);
  for (let i = 0; i < 60; i++) { try { const t = await fetch(`${hubHttps}/healthz`, { tls: { rejectUnauthorized: false } } as any); if (t.ok) break; } catch {} await Bun.sleep(500); }
  await joinNode(hubDir, nodeDir, hubHttps, 'r9-remote-node');
  await killServer(nodeDir); await waitHealthy(nodePort, nh0.startedAt); log('node restarted as node');

  const hub = await apiLogin(hubUrl);
  const nodeRow = await waitNode(hubUrl, hub.cookies, 'r9-remote-node');
  const nodeId = nodeRow.id as string; log(`nodeId=${nodeId}`);
  const H = { 'content-type': 'application/json', cookie: cookieHeader(hub.cookies) };

  // hub 本机：设备 + 文件根
  r = await fetch(`${hubUrl}/api/devices`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'hub-dev', type: 'local', session: 'r9hub', authMode: 'auto' }) });
  const hubDev = (await r.json()) as any; log(`hub device → ${r.status} ${hubDev.device?.id}`);
  r = await fetch(`${hubUrl}/api/files/roots`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: hubDev.device.id, path: hubFiles }) });
  const hubRoot = (await r.json()) as any; log(`hub root → ${r.status} ${JSON.stringify(hubRoot.root ?? hubRoot)}`);

  // node：经 entry 登录后建设备 + 两个文件根
  const nodeCookies = await nodeLogin(hubUrl, hub, nodeId);
  const NH = { 'content-type': 'application/json', cookie: cookieHeader(nodeCookies) };
  r = await fetch(`${hubUrl}/n/${nodeId}/api/devices`, { method: 'POST', headers: NH, body: JSON.stringify({ name: 'node-dev', type: 'local', session: 'r9node', authMode: 'auto' }) });
  const nodeDev = (await r.json()) as any; log(`node device → ${r.status} ${nodeDev.device?.id}`);
  const roots: any[] = [];
  for (const p of [nodeFiles, nodeFiles2]) {
    r = await fetch(`${hubUrl}/n/${nodeId}/api/files/roots`, { method: 'POST', headers: NH, body: JSON.stringify({ deviceId: nodeDev.device.id, path: p }) });
    const body = (await r.json()) as any; log(`node root ${p} → ${r.status} ${JSON.stringify(body.root ?? body)}`); roots.push(body.root);
  }

  const state = { hubPort, nodePort, hubUrl, nodeId, hubDeviceId: hubDev.device.id, nodeDeviceId: nodeDev.device.id, hubRootId: hubRoot.root.id, nodeRootIds: roots.map((x) => x.id), hubFiles, nodeFiles, nodeFiles2, user: USER, password: PASSWORD, hubDir, nodeDir, tmuxSocket: TMUX_SOCK, nodeCookies, hubCookies: hub.cookies };
  writeFileSync(`${SCRATCH}/state.json`, JSON.stringify(state, null, 2));
  log(`STATE WRITTEN ${SCRATCH}/state.json`);
  log('READY — keeping instances alive; kill this process to tear down');
  while (true) await Bun.sleep(5000);
}
function cleanup() { for (const c of children) try { c.kill('SIGTERM'); } catch {} spawnSync('bash', ['-c', `pkill -f "DATABASE_URL=${ROOT}" ; for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${ROOT}"; then kill $p; fi; done; true`]); spawnSync('tmux', ['-L', TMUX_SOCK, 'kill-server']); }
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
