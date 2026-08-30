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


// 极简 OpenAI 兼容 mock：用户消息含 RUN_COMMAND <cmd> 且本轮尚无 tool 结果 → 返回 send_input 工具调用；否则收尾文本。
function sse(delta: Record<string, unknown>, finish: string | null = null) { return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`; }
function startMockLlm() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models')) return Response.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
    if (req.method === 'POST' && url.pathname.startsWith('/v1/chat/completions')) {
      const body = (await req.json()) as { stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> };
      const messages = body.messages ?? []; let lastUser = -1; for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') { lastUser = i; break; }
      const text = typeof messages[lastUser]?.content === 'string' ? (messages[lastUser]!.content as string) : JSON.stringify(messages[lastUser]?.content ?? '');
      const hasTool = messages.slice(lastUser + 1).some((m) => m.role === 'tool'); const m = text.match(/RUN_COMMAND ([A-Za-z0-9_ -]+)/);
      if (!body.stream) return Response.json({ id: 't', object: 'chat.completion', created: 1, model: 'mock-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Live test' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      let out = '';
      if (m && !hasTool) { out += sse({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'send_input', arguments: JSON.stringify({ text: m[1], keys: ['enter'] }) } }] }); out += sse({}, 'tool_calls'); }
      else { out += sse({ role: 'assistant', content: 'done' }); out += sse({}, 'stop'); }
      out += 'data: [DONE]\n\n';
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  } });
  log(`mock llm on ${server.port}`); return server;
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

async function main() {
  const hubDir = `${ROOT}/hub`, nodeDir = `${ROOT}/node`; mkInst(hubDir); mkInst(nodeDir);
  const hubPort = await freePort(21500), nodePort = await freePort(hubPort + 1), hp = await freePort(39500), np = await freePort(hp + 1);
  const tlsPort = await freePort(29500);
  const hubUrl = `http://localhost:${hubPort}`, hubHttps = `https://localhost:${tlsPort}`;
  await Bun.write(`${hubDir}/app.env`, appEnv(hubDir, 'hub,node', hubPort, hp, 'tmex-live-hub', '', hubHttps));
  await Bun.write(`${nodeDir}/app.env`, appEnv(nodeDir, 'standalone', nodePort, np, 'tmex-live-node', '', ''));
  spawnSync('tmux', ['-L', 'tmex-live-hub', 'kill-server']); spawnSync('tmux', ['-L', 'tmex-live-node', 'kill-server']);
  log(`hub=${hubPort} node=${nodePort} root=${ROOT}`);
  await cli(['hub', 'user', 'add', USER, '--install-dir', hubDir], { TMEX_PASSWORD: PASSWORD });
  startLoop(hubDir, 'hub'); await waitHealthy(hubPort); log('hub healthy');
  // tmux session on node socket BEFORE boot：push supervisor 启动时即连上本机设备
  spawnSync('tmux', ['-L', 'tmex-live-node', 'new-session', '-d', '-s', 'tmex', '-x', '120', '-y', '30']);
  spawnSync('tmux', ['-L', 'tmex-live-node', 'send-keys', '-t', 'tmex', 'echo REMOTE_PANE_OK', 'Enter']);
  startLoop(nodeDir, 'node'); const nh0 = await waitHealthy(nodePort); log('node healthy (standalone)');
  const hub0 = await apiLogin(hubUrl);
  let r = await fetch(`${hubUrl}/api/tls`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookieHeader(hub0.cookies) }, body: JSON.stringify({ mode: 'selfsigned', sans: ['localhost', '127.0.0.1'], tlsPort, bindHost: '127.0.0.1' }) });
  log(`hub tls selfsigned → ${r.status}`);
  for (let i = 0; i < 40; i++) { try { const t = await fetch(`${hubHttps}/healthz`, { tls: { rejectUnauthorized: false } } as any); if (t.ok) break; } catch {} await Bun.sleep(500); }
  await joinNode(hubDir, nodeDir, hubHttps, 'live-node');
  await killServer(nodeDir); await waitHealthy(nodePort, nh0.startedAt); log('node restarted as node');
  const hub = await apiLogin(hubUrl); const first = await waitNode(hubUrl, hub.cookies, 'live-node'); const nodeId = first.hit.id as string;
  const H = { 'content-type': 'application/json', cookie: cookieHeader(hub.cookies) };
  const nodesRow = async () => ((await (await fetch(`${hubUrl}/api/mesh/nodes`, { headers: H })).json()) as any).nodes.find((n: any) => n.id === nodeId);
  let row = await nodesRow(); log(`[T3] node row: online=${row.online} reach=${row.reach} transport=${row.transport} rttMs=${row.rttMs}`);

  const NH = { 'content-type': 'application/json', cookie: cookieHeader(await nodeLogin(hubUrl, hub, nodeId)) };
  const devices = (await (await fetch(`${hubUrl}/n/${nodeId}/api/devices`, { headers: NH })).json()) as any;
  const dev = (devices.devices ?? devices)[0]; log(`[T2] node devices: ${JSON.stringify((devices.devices ?? devices).map((d: any) => ({ id: d.id, name: d.name, type: d.type })))}`);
  let paneId = ''; let paneTitle = '';
  for (let i = 0; i < 6 && !paneId; i++) { const tree = (await (await fetch(`${hubUrl}/n/${nodeId}/api/tmux/tree?deviceId=${dev.id}`, { headers: NH })).json()) as any; const s = tree.devices?.[0]?.session; const p = s?.windows?.[0]?.panes?.[0]; if (p) { paneId = p.id; paneTitle = p.title ?? ''; } else await Bun.sleep(500); }
  if (!paneId) { paneId = spawnSync('tmux', ['-L', 'tmex-live-node', 'list-panes', '-t', 'tmex:0', '-F', '#{pane_id}']).stdout.toString().trim().split('\n')[0] ?? ''; paneTitle = '(from tmux)'; }
  log(`[T2] remote pane: ${paneId || 'NONE'} title=${paneTitle}`);

  // T1: directory browse through /n/:id
  r = await fetch(`${hubUrl}/n/${nodeId}/api/files/browse?deviceId=${dev.id}`, { headers: NH }); let b = (await r.json()) as any;
  log(`[T1] browse home → ${r.status} path=${b.path} entries=${b.entries?.length} parent=${b.parent}`);
  r = await fetch(`${hubUrl}/n/${nodeId}/api/files/browse?deviceId=${dev.id}&path=/private/tmp&hidden=1`, { headers: NH }); b = (await r.json()) as any;
  log(`[T1] browse /private/tmp hidden → ${r.status} entries=${b.entries?.length} truncated=${b.truncated} first=${JSON.stringify(b.entries?.[0])}`);
  r = await fetch(`${hubUrl}/n/${nodeId}/api/files/browse?deviceId=${dev.id}&path=relative`, { headers: NH }); log(`[T1] browse relative → ${r.status} ${(await r.text()).slice(0, 100)}`);

  // T2: spoofed peer marker must be rejected on both hops
  for (const [label, url] of [['hub direct', `${hubUrl}/api/mesh-internal/tmux/pane-info`], ['via /n/:id', `${hubUrl}/n/${nodeId}/api/mesh-internal/tmux/pane-info`]]) {
    r = await fetch(url, { method: 'POST', headers: { ...NH, 'x-tmex-mesh-peer': nodeId }, body: JSON.stringify({ deviceId: dev.id, paneId }) });
    log(`[T2] spoof ${label} → ${r.status} ${(await r.text()).slice(0, 80)}`);
  }
  // T2: create remote agent session on hub (origin captured over mesh RPC)
  const mock = startMockLlm();
  r = await fetch(`${hubUrl}/api/llm/providers`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'live-mock', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'live-mock-key' }) });
  const prov = (await r.json()) as any; log(`[T2] provider → ${r.status} ${prov.provider?.id ?? JSON.stringify(prov).slice(0, 100)}`);
  r = await fetch(`${hubUrl}/api/llm/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ defaultProviderId: prov.provider?.id, defaultModelId: 'mock-model' }) }); log(`[T2] default model → ${r.status}`);
  r = await fetch(`${hubUrl}/api/agent/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ nodeId, deviceId: dev.id, paneId, writeMode: 'auto' }) });
  const created = (await r.json()) as any; log(`[T2] create remote session → ${r.status} ${JSON.stringify({ id: created.session?.id, nodeId: created.session?.nodeId, originPaneTitle: created.session?.originPaneTitle, originProcessName: created.session?.originProcessName, status: created.session?.status, error: created.error })}`);
  r = await fetch(`${hubUrl}/api/agent/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ nodeId: 'no-such-node', deviceId: dev.id, paneId }) }); log(`[T2] create with unknown node → ${r.status} ${(await r.text()).slice(0, 100)}`);
  if (created.session?.id) {
    r = await fetch(`${hubUrl}/api/agent/sessions/${created.session.id}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'RUN_COMMAND echo HELLO_FROM_HUB' }) });
    log(`[T2] send message → ${r.status} ${(await r.text()).slice(0, 120)}`);
    let seen = ''; for (let i = 0; i < 40; i++) { await Bun.sleep(1000); seen = spawnSync('tmux', ['-L', 'tmex-live-node', 'capture-pane', '-p', '-t', 'tmex:0']).stdout.toString(); if (seen.includes('HELLO_FROM_HUB')) break; }
    log(`[T2] remote pane received input: ${seen.includes('HELLO_FROM_HUB')} (pane tail: ${JSON.stringify(seen.trim().split('\n').slice(-3))})`);
    const s = (await (await fetch(`${hubUrl}/api/agent/sessions/${created.session.id}`, { headers: H })).json()) as any; log(`[T2] session after run: status=${s.session?.status} lastError=${s.session?.lastError}`);
    const msgs = (await (await fetch(`${hubUrl}/api/agent/sessions/${created.session.id}/messages`, { headers: H })).json()) as any; log(`[T2] messages: ${(msgs.messages ?? []).map((m: any) => m.role).join(',')}`);
  }
  for (const q of ['', '?nodeId=self', `?nodeId=${nodeId}`]) { const l = (await (await fetch(`${hubUrl}/api/agent/sessions${q}`, { headers: H })).json()) as any; log(`[T2] list${q || ' (all)'} → ${l.sessions?.length}`); }

  // T3: RTT after a ping interval
  await Bun.sleep(20_000); row = await nodesRow(); log(`[T3] node row after 20s: reach=${row.reach} transport=${row.transport} rttMs=${row.rttMs}`);

  // T5: node offline → hub side
  await killServer(nodeDir); spawnSync('bash', ['-c', `pkill -f "cd ${REPO}; while true; do set -a; . ${nodeDir}/app.env" ; true`]);
  const off = await waitNode(hubUrl, hub.cookies, 'live-node', false); log(`[T5] hub sees node offline reach=${off.hit.reach} rttMs=${off.hit.rttMs}`);
  if (created.session?.id) { const s = (await (await fetch(`${hubUrl}/api/agent/sessions/${created.session.id}`, { headers: H })).json()) as any; log(`[T5] remote session after offline: status=${s.session?.status} lastError=${s.session?.lastError}`); }
  r = await fetch(`${hubUrl}/api/agent/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ nodeId, deviceId: dev.id, paneId }) }); log(`[T5] create on offline node → ${r.status} ${(await r.text()).slice(0, 100)}`);

  // T6: tunnel
  r = await fetch(`${hubUrl}/api/tunnel/status`, { headers: H }); let st = (await r.json()) as any;
  log(`[T6] status → ${r.status} supported=${st.supported} platform=${st.platform} binary=${JSON.stringify(st.binary)} mode=${st.config?.mode} originPort=${st.config?.originPort} trustProxy=${st.trustProxy}`);
  r = await fetch(`${hubUrl}/api/tunnel/status`); log(`[T6] status unauth → ${r.status}`);
  const act = async (body: any) => { const res = await fetch(`${hubUrl}/api/tunnel/actions`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: res.status, body: (await res.json()) as any }; };
  const waitJob = async (label: string, ms = 180_000) => { const dl = Date.now() + ms; while (Date.now() < dl) { st = (await (await fetch(`${hubUrl}/api/tunnel/status`, { headers: H })).json()) as any; if (!st.job || st.job.state !== 'running') return st; await Bun.sleep(1000); } log(`[T6] ${label} job timeout`); return st; };
  if (process.env.LIVE_TUNNEL === '1') {
    if (!st.binary.installed) { const a = await act({ action: 'install' }); log(`[T6] install → ${a.status} job=${a.body.job?.kind}/${a.body.job?.state}`); st = await waitJob('install'); log(`[T6] after install: binary=${JSON.stringify(st.binary)} job=${JSON.stringify(st.job)}`); }
    const q = await act({ action: 'quick_start' }); log(`[T6] quick_start → ${q.status} ${JSON.stringify(q.body.job ?? q.body.error)}`);
    st = await waitJob('quick_start'); for (let i = 0; i < 60 && !st.process?.publicUrl; i++) { await Bun.sleep(1000); st = (await (await fetch(`${hubUrl}/api/tunnel/status`, { headers: H })).json()) as any; }
    log(`[T6] process: ${JSON.stringify(st.process)} log tail: ${JSON.stringify(st.log?.slice(-3))}`);
    if (st.process?.publicUrl) { const c = await act({ action: 'check' }); log(`[T6] check → ${c.status} ${JSON.stringify(c.body.job)}`); try { const ext = await fetch(`${st.process.publicUrl}/healthz`); log(`[T6] external healthz → ${ext.status} ${(await ext.text()).slice(0, 80)}`); } catch (e) { log(`[T6] external healthz error ${e}`); } }
    const s2 = await act({ action: 'stop' }); log(`[T6] stop → ${s2.status} state=${s2.body.status?.process?.state}`);
  }
  const tp = await act({ action: 'set_trust_proxy', trustProxy: true }); log(`[T6] set_trust_proxy → ${tp.status} ${JSON.stringify(tp.body.error ?? tp.body.status?.restartRequired)}`);
  const bad = await act({ action: 'create', hostname: 'Not a host' }); log(`[T6] create bad hostname → ${bad.status} ${JSON.stringify(bad.body.error)}`);
  log('DONE');
}
function cleanup() { for (const c of children) try { c.kill('SIGTERM'); } catch {} spawnSync('bash', ['-c', `pkill -f "DATABASE_URL=${ROOT}" ; for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${ROOT}"; then kill $p; fi; done; pkill -f "cloudflared tunnel --url http://127.0.0.1:2" ; true`]); spawnSync('tmux', ['-L', 'tmex-live-hub', 'kill-server']); spawnSync('tmux', ['-L', 'tmex-live-node', 'kill-server']); }
main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error(e); cleanup(); process.exit(1); });
