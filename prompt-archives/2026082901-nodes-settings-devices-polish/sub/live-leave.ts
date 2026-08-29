#!/usr/bin/env bun
// 临时双实例（hub,node + node）实测 POST /api/local/leave：仓库源码起服务，production 模式、独立 install dir，
// 绝不触碰生产 tmex（9883）与 tmux session `tmex`。
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildLogin, createDelegation, decodeBase64url, deriveSeed, encodeBase64url, encodeLogin,
  generateEd25519KeyPair, rootKeyFromSeed, signLogin,
} from '/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/auth/index.ts';
import { parseEnvFile } from '/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/env/load-env.ts';

const REPO = '/Users/konata/code/tmex-enhanced-wt-merge';
const CLI_AUTH = resolve(REPO, 'packages/app/src/cli-auth-entry.ts');
const SERVER = resolve(REPO, 'packages/app/src/runtime/server.ts');
const MIGRATIONS = resolve(REPO, 'apps/gateway/drizzle');
const FE_DIST = resolve(REPO, 'apps/fe/dist');
const ROOT = process.argv[2] ?? `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/17e325ff-d664-45a5-b10d-4b3092e18cdd/scratchpad/live/run-${process.pid}`;
const USER = 'alice';
const PASSWORD = 'live-leave-Passw0rd!';
const MASTER_KEY = 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=';
const log = (m: string) => process.stdout.write(`[live] ${m}\n`);
const children = new Set<Bun.Subprocess>();

function canBind(port: number) { return new Promise<boolean>((d) => { const s = net.createServer(); s.once('error', () => d(false)); s.once('listening', () => s.close(() => d(true))); s.listen(port, '127.0.0.1'); }); }
async function freePort(from: number) { for (let p = from; p < from + 200; p++) if (await canBind(p)) return p; throw new Error('no port'); }
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
async function waitHealthy(port: number, notStartedAt?: number, ms = 60_000) { const dl = Date.now() + ms; while (Date.now() < dl) { const h = await healthz(port); if (h && h.startedAt !== notStartedAt) return h; await Bun.sleep(500); } throw new Error(`port ${port} not healthy`); }
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
async function waitNode(base: string, cookies: Record<string, string>, name: string, online = true, ms = 90_000) {
  const dl = Date.now() + ms; let last = '';
  while (Date.now() < dl) { try { const b = (await (await fetch(`${base}/api/mesh/nodes`, { headers: { cookie: cookieHeader(cookies) } })).json()) as any; last = JSON.stringify(b); const rows = (b.nodes ?? []).filter((n: any) => n.name === name); const hit = rows.find((n: any) => n.online === online); if (hit) return { hit, rows }; } catch (e) { last = String(e); } await Bun.sleep(1000); }
  throw new Error(`node ${name} online=${online} never: ${last}`);
}
function tableCounts(db: string) {
  const tables = ['users', 'user_key_log', 'user_keys', 'node_sessions', 'node_certs', 'nodes', 'enrollment_tokens', 'peer_cache', 'hub_trust', 'node_identity'];
  const sql = tables.map((t) => `select '${t}', count(*) from ${t}`).join(' union all ');
  return spawnSync('sqlite3', [db, sql]).stdout.toString().trim();
}
async function joinNode(hubDir: string, nodeDir: string, hubUrl: string, name: string) {
  const enroll = Bun.spawn([process.execPath, CLI_AUTH, 'enroll', '--ttl', '10m', '--install-dir', hubDir], { cwd: REPO, env: { ...process.env, NODE_ENV: 'production', TMEX_MIGRATIONS_DIR: MIGRATIONS, TMEX_PASSWORD: PASSWORD } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  children.add(enroll); const out = { text: '' };
  const reader = (async () => { for await (const c of enroll.stdout as ReadableStream<Uint8Array>) out.text += new TextDecoder().decode(c); })();
  const errText = { text: '' }; (async () => { for await (const c of enroll.stderr as ReadableStream<Uint8Array>) errText.text += new TextDecoder().decode(c); })();
  let token = ''; for (let i = 0; i < 60 && !token; i++) { const m = /join token: ([A-Za-z0-9_.-]+)/.exec(out.text); if (m) token = m[1]; else await Bun.sleep(500); }
  if (!token) throw new Error(`no token: ${out.text}\nSTDERR: ${errText.text}`);
  log(`token len=${token.length}`);
  const j = await cli(['hub', 'join', hubUrl, '--token', token, '--name', name, '--install-dir', nodeDir, '--no-restart']);
  log(`join: ${j.trim().split('\n').slice(-2).join(' | ')}`);
  for (let i = 0; i < 60 && !out.text.includes('node admitted'); i++) await Bun.sleep(500);
  enroll.kill('SIGTERM'); children.delete(enroll); await reader.catch(() => {});
}

async function main() {
  const hubDir = `${ROOT}/hub`, nodeDir = `${ROOT}/node`; mkInst(hubDir); mkInst(nodeDir);
  const hubPort = await freePort(21500), nodePort = await freePort(hubPort + 1), hp = await freePort(39500), np = await freePort(hp + 1);
  const tlsPort = await freePort(29500);
  const hubUrl = `http://localhost:${hubPort}`, nodeUrl = `http://127.0.0.1:${nodePort}`, hubHttps = `https://localhost:${tlsPort}`;
  await Bun.write(`${hubDir}/app.env`, appEnv(hubDir, 'hub,node', hubPort, hp, 'tmex-live-hub', '', hubHttps));
  await Bun.write(`${nodeDir}/app.env`, appEnv(nodeDir, 'standalone', nodePort, np, 'tmex-live-node', '', ''));
  spawnSync('tmux', ['-L', 'tmex-live-hub', 'kill-server']); spawnSync('tmux', ['-L', 'tmex-live-node', 'kill-server']);
  log(`hub=${hubPort} node=${nodePort} root=${ROOT}`);
  await cli(['hub', 'user', 'add', USER, '--install-dir', hubDir], { TMEX_PASSWORD: PASSWORD });
  startLoop(hubDir, 'hub'); await waitHealthy(hubPort); log('hub healthy');
  startLoop(nodeDir, 'node'); const nh0 = await waitHealthy(nodePort); log('node healthy (standalone)');

  // 0. standalone leave → 400 not_member
  let r = await fetch(`${nodeUrl}/api/local/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRole: 'node' }) });
  log(`standalone leave → ${r.status} ${await r.text()}`);

  // TLS on hub (selfsigned) so join can go over https with CA pin
  const hub0 = await apiLogin(hubUrl);
  r = await fetch(`${hubUrl}/api/tls`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookieHeader(hub0.cookies) }, body: JSON.stringify({ mode: 'selfsigned', sans: ['localhost', '127.0.0.1'], tlsPort, bindHost: '127.0.0.1' }) });
  log(`hub tls selfsigned → ${r.status} ${(await r.text()).slice(0, 160)}`);
  for (let i = 0; i < 40; i++) { try { const t = await fetch(`${hubHttps}/healthz`, { tls: { rejectUnauthorized: false } } as any); if (t.ok) break; } catch {} await Bun.sleep(500); }
  log('hub https up');
  // 1. join
  await joinNode(hubDir, nodeDir, hubHttps, 'live-node');
  await killServer(nodeDir); const nh1 = await waitHealthy(nodePort, nh0.startedAt); log('node restarted as node');
  const hub = await apiLogin(hubUrl); const first = await waitNode(hubUrl, hub.cookies, 'live-node'); log(`hub sees live-node online id=${first.hit.id}`);
  log(`node tables before leave:\n${tableCounts(`${nodeDir}/tmex.db`)}`);

  // 2. leave: unauth → 401; wrong role → 409; ok
  r = await fetch(`${nodeUrl}/api/local/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRole: 'node' }) });
  log(`node leave unauth → ${r.status}`);
  const node = await apiLogin(nodeUrl); log(`node login ok uid=${node.mode.uid}`);
  const H = { 'content-type': 'application/json', cookie: cookieHeader(node.cookies) };
  r = await fetch(`${nodeUrl}/api/local/leave`, { method: 'POST', headers: H, body: JSON.stringify({ expectedRole: 'hub,node' }) });
  log(`node leave wrong role → ${r.status} ${await r.text()}`);
  r = await fetch(`${nodeUrl}/api/local/leave`, { method: 'POST', headers: H, body: JSON.stringify({ expectedRole: 'node' }) });
  log(`node leave → ${r.status} ${await r.text()}`);
  const nh2 = await waitHealthy(nodePort, nh1.startedAt); log('node restarted after leave');
  const env = parseEnvFile(await Bun.file(`${nodeDir}/app.env`).text());
  log(`node env: ROLES=${env.TMEX_ROLES} HUB_URL='${env.TMEX_HUB_URL}' PUBLIC='${env.TMEX_HUB_PUBLIC_URL}'`);
  log(`node tables after leave:\n${tableCounts(`${nodeDir}/tmex.db`)}`);
  log(`node auth mode: ${await (await fetch(`${nodeUrl}/api/auth/mode`)).text()}`);
  const off = await waitNode(hubUrl, hub.cookies, 'live-node', false); log(`hub now sees live-node offline (rows=${off.rows.length})`);

  // 3. rejoin
  await joinNode(hubDir, nodeDir, hubHttps, 'live-node');
  await killServer(nodeDir); await waitHealthy(nodePort, nh2.startedAt); log('node restarted as node (rejoin)');
  const second = await waitNode(hubUrl, hub.cookies, 'live-node'); log(`hub sees live-node online again id=${second.hit.id} (old=${first.hit.id}, rows named live-node=${second.rows.length})`);
  log(`node tables after rejoin:\n${tableCounts(`${nodeDir}/tmex.db`)}`);
  log(`node identity: ${spawnSync('sqlite3', [`${nodeDir}/tmex.db`, 'select id, hub_url from node_identity']).stdout.toString().trim()}`);

  // 4. hub,node leave
  const hh = await healthz(hubPort);
  r = await fetch(`${hubUrl}/api/local/leave`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(hub.cookies) }, body: JSON.stringify({ expectedRole: 'hub,node' }) });
  log(`hub leave → ${r.status} ${await r.text()}`);
  await waitHealthy(hubPort, hh!.startedAt); log('hub restarted');
  const henv = parseEnvFile(await Bun.file(`${hubDir}/app.env`).text());
  log(`hub env: ROLES=${henv.TMEX_ROLES} PUBLIC='${henv.TMEX_HUB_PUBLIC_URL}'`);
  log(`hub tables:\n${tableCounts(`${hubDir}/tmex.db`)}`);
  log(`hub auth mode: ${await (await fetch(`${hubUrl}/api/auth/mode`)).text()}`);
  log('DONE');
}
function cleanup() { for (const c of children) try { c.kill('SIGTERM'); } catch {} spawnSync('bash', ['-c', `pkill -f "DATABASE_URL=${ROOT}" ; for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${ROOT}"; then kill $p; fi; done; true`]); spawnSync('tmux', ['-L', 'tmex-live-hub', 'kill-server']); spawnSync('tmux', ['-L', 'tmex-live-node', 'kill-server']); }
main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error(e); cleanup(); process.exit(1); });
