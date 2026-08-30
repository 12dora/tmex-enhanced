#!/usr/bin/env bun
// 第五轮实测：临时 hub+node 双实例——reach/RTT、经 entry 登录 node、远端目录浏览、peer 标记防伪、远端 agent session、node 离线、tunnel quick 模式。
// 绝不触碰生产 tmex（9883）与 tmux session `tmex`。
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildLogin, createDelegation, decodeBase64url, deriveSeed, encodeBase64url, encodeLogin,
  generateEd25519KeyPair, rootKeyFromSeed, signLogin,
} from '/Users/konata/code/tmex-enhanced-wt-r5/packages/shared/src/auth/index.ts';
import { parseEnvFile } from '/Users/konata/code/tmex-enhanced-wt-r5/packages/shared/src/env/load-env.ts';

const REPO = '/Users/konata/code/tmex-enhanced-wt-r5';
const CLI_AUTH = resolve(REPO, 'packages/app/src/cli-auth-entry.ts');
const SERVER = resolve(REPO, 'packages/app/src/runtime/server.ts');
const MIGRATIONS = resolve(REPO, 'apps/gateway/drizzle');
const FE_DIST = resolve(REPO, 'apps/fe/dist');
const ROOT = process.argv[2] ?? `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/9adb7bf6-d1e6-4976-a682-49e3187bf84f/scratchpad/live/run-${process.pid}`;
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
async function main() {
  const dir = `${ROOT}/solo`; mkInst(dir); const port = await freePort(21600), pp = await freePort(39600);
  await Bun.write(`${dir}/app.env`, appEnv(dir, 'standalone', port, pp, 'tmex-live-solo', '', ''));
  spawnSync('tmux', ['-L', 'tmex-live-solo', 'kill-server']);
  spawnSync('tmux', ['-L', 'tmex-live-solo', 'new-session', '-d', '-s', 'tmex', '-x', '120', '-y', '30']);
  log(`tmux ls: ${spawnSync('tmux', ['-L', 'tmex-live-solo', 'ls']).stdout.toString().trim()}`);
  await cli(['hub', 'user', 'add', USER, '--install-dir', dir], { TMEX_PASSWORD: PASSWORD });
  startLoop(dir, 'solo'); await waitHealthy(port); log('solo healthy');
  log(`auth mode: ${await (await fetch(`http://127.0.0.1:${port}/api/auth/mode`)).text()}`);
  log(`healthz: ${await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()}`);
  const H = {} as Record<string, string>;
  for (let i = 0; i < 6; i++) {
    const devs = (await (await fetch(`http://127.0.0.1:${port}/api/devices`, { headers: H })).json()) as any;
    const tree = (await (await fetch(`http://127.0.0.1:${port}/api/tmux/tree`, { headers: H })).json()) as any;
    log(`devices=${JSON.stringify(devs).slice(0, 300)}`);
    log(`tree=${JSON.stringify(tree).slice(0, 300)}`);
    await Bun.sleep(2000);
  }
  log(`server.log:\n${(await Bun.file(`${dir}/server.log`).text()).split('\n').slice(-15).join('\n')}`);
}
function cleanup() { for (const c of children) try { c.kill('SIGTERM'); } catch {} spawnSync('bash', ['-c', `for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${ROOT}"; then kill $p; fi; done; true`]); spawnSync('tmux', ['-L', 'tmex-live-solo', 'kill-server']); }
main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error(e); cleanup(); process.exit(1); });
