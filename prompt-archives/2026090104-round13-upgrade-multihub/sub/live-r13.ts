#!/usr/bin/env bun
// 第十三轮实测：仓库源码起三个 production 模式临时实例（A=hub 主、B=节点→standby hub、C=节点/升级目标），
// 独立 install dir / 端口 / tmux socket，绝不触碰生产 tmex（9883）与 tmux session `tmex`。
//
//   Part A  远程升级「入口下载 → 推送 → 目标暂存 → 启动」：C 的 install-meta 自称 1.1.0，A 作为入口推真实 GitHub 最新包。
//   Part B  多 hub 主备：B 变 standby（自签 TLS，CA 指纹经 node.list 下发给 C 自动 pin），A 允许 B；
//           C 看到 hubs[]、standby 拒写、B 复制注册表；杀 A → C 切到 B；A 回来 → C 切回；B promote → A 被围栏。
//
// 用法：bun run live-r13.ts [A|B|all]   （默认 all）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

const REPO = '/Users/konata/code/tmex-enhanced-wt-r13';
const CLI_AUTH = resolve(REPO, 'packages/app/src/cli-auth-entry.ts');
const SERVER = resolve(REPO, 'packages/app/src/runtime/server.ts');
const MIGRATIONS = resolve(REPO, 'apps/gateway/drizzle');
const FE_DIST = resolve(REPO, 'apps/fe/dist');
const ROOT =
  process.env.LIVE_ROOT ??
  `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/live/run-${process.pid}`;
const PART = process.argv[2] ?? 'all';
const USER = 'alice';
const PASSWORD = 'live-r13-Passw0rd!';
const MASTER_KEY = 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=';
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
};

function canBind(port: number) {
  return new Promise<boolean>((d) => {
    const s = net.createServer();
    s.once('error', () => d(false));
    s.once('listening', () => s.close(() => d(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function freePort(from: number) {
  for (let p = from; p < from + 300; p++) if (await canBind(p)) return p;
  throw new Error('no port');
}
function appEnv(i: Inst, roles: string, hubUrl: string, extra: string[] = []) {
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
    `TMEX_TMUX_SOCKET=${i.sock}`,
    'TMEX_SITE_NAME=tmex',
    `TMEX_FE_DIST_DIR=${i.dir}/resources/fe-dist`,
    `TMEX_MIGRATIONS_DIR=${MIGRATIONS}`,
    `TMEX_INSTALL_DIR=${i.dir}`,
    ...extra,
    '',
  ].join('\n');
}
function mkInst(i: Inst, cliVersion: string) {
  mkdirSync(`${i.dir}/resources`, { recursive: true });
  if (!existsSync(`${i.dir}/resources/fe-dist`)) symlinkSync(FE_DIST, `${i.dir}/resources/fe-dist`);
  Bun.write(
    `${i.dir}/install-meta.json`,
    JSON.stringify({
      cliVersion,
      serviceName: `tmex-live-${i.name}`,
      platform: 'darwin',
      serviceMode: 'none',
      installDir: i.dir,
    })
  );
}
async function cli(args: string[], extra: Record<string, string> = {}) {
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
const loops = new Map<string, Bun.Subprocess>();
function startLoop(i: Inst) {
  const script = `cd ${REPO}; while true; do set -a; . ${i.dir}/app.env; set +a; ${process.execPath} ${SERVER} >> ${i.dir}/server.log 2>&1; echo "[loop] exit $? restart" >> ${i.dir}/server.log; sleep 1; done`;
  const p = Bun.spawn(['bash', '-c', script], { stdout: 'ignore', stderr: 'ignore' });
  children.add(p);
  loops.set(i.name, p);
  log(`${i.name} loop pid=${p.pid} port=${i.port}`);
}
function stopLoop(i: Inst) {
  const p = loops.get(i.name);
  if (p) {
    p.kill('SIGTERM');
    children.delete(p);
    loops.delete(i.name);
  }
  killServer(i);
}
function killServer(i: Inst) {
  spawnSync('bash', [
    '-c',
    `for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${i.dir}/tmex.db"; then kill $p; fi; done; true`,
  ]);
}
async function healthz(port: number) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return r.ok ? ((await r.json()) as { startedAt: number }) : null;
  } catch {
    return null;
  }
}
async function waitHealthy(port: number, notStartedAt?: number, ms = 90_000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const h = await healthz(port);
    if (h && h.startedAt !== notStartedAt) return h;
    await Bun.sleep(500);
  }
  throw new Error(`port ${port} not healthy`);
}
async function restart(i: Inst) {
  const h = await healthz(i.port);
  killServer(i);
  return waitHealthy(i.port, h?.startedAt);
}

// ---- 浏览器登录（登录页会自动对所有节点 fan-out，拿到每个节点的 cookie）----
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
async function uiLogin(base: string): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-username').fill(USER);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]'), null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  return page;
}
async function api(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const r = await fetch(url, {
        method,
        credentials: 'include',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json: unknown = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json };
    },
    { method, url, body }
  );
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false>, ms = 120_000, every = 2000): Promise<T> {
  const dl = Date.now() + ms;
  let last: unknown;
  while (Date.now() < dl) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(every);
  }
  throw new Error(`timeout waiting ${label}: ${String(last)}`);
}
function sql(i: Inst, q: string) {
  return spawnSync('sqlite3', [`${i.dir}/tmex.db`, q]).stdout.toString().trim();
}
async function joinNode(hub: Inst, node: Inst, name: string) {
  const enroll = Bun.spawn(
    [process.execPath, CLI_AUTH, 'enroll', '--ttl', '10m', '--install-dir', hub.dir],
    {
      cwd: REPO,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TMEX_MIGRATIONS_DIR: MIGRATIONS,
        TMEX_PASSWORD: PASSWORD,
      } as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  children.add(enroll);
  const out = { text: '' };
  const reader = (async () => {
    for await (const c of enroll.stdout as ReadableStream<Uint8Array>) out.text += new TextDecoder().decode(c);
  })();
  const err = { text: '' };
  (async () => {
    for await (const c of enroll.stderr as ReadableStream<Uint8Array>) err.text += new TextDecoder().decode(c);
  })();
  let token = '';
  for (let i = 0; i < 60 && !token; i++) {
    const m = /join token: ([A-Za-z0-9_.-]+)/.exec(out.text);
    if (m) token = m[1] ?? '';
    else await Bun.sleep(500);
  }
  if (!token) throw new Error(`no token: ${out.text}\nSTDERR: ${err.text}`);
  const j = await cli(['hub', 'join', hub.https, '--token', token, '--name', name, '--install-dir', node.dir, '--no-restart']);
  log(`${name} join: ${j.trim().split('\n').slice(-1).join(' | ')}`);
  for (let i = 0; i < 60 && !out.text.includes('node admitted'); i++) await Bun.sleep(500);
  enroll.kill('SIGTERM');
  children.delete(enroll);
  await reader.catch(() => {});
  node.nodeId = sql(node, 'select node_id from node_identity');
  log(`${name} nodeId=${node.nodeId}`);
}
async function enableTls(i: Inst) {
  const page = await uiLogin(i.url);
  const r = await api(page, 'PUT', '/api/tls', {
    mode: 'selfsigned',
    sans: ['localhost', '127.0.0.1'],
    tlsPort: i.tls,
    bindHost: '127.0.0.1',
  });
  log(`${i.name} tls selfsigned → ${r.status}`);
  await waitFor(`${i.name} https`, async () => {
    try {
      const t = await fetch(`${i.https}/healthz`, { tls: { rejectUnauthorized: false } } as RequestInit);
      return t.ok;
    } catch {
      return false;
    }
  }, 40_000, 500);
  const st = await api(page, 'GET', '/api/tls');
  await page.context().close();
  return st.json as { caFingerprint?: string | null } | null;
}

async function main() {
  const base = await freePort(21600);
  const mk = (name: string, k: number): Inst => ({
    name,
    dir: `${ROOT}/${name}`,
    port: base + k,
    peer: base + 100 + k,
    tls: base + 200 + k,
    sock: `tmex-live-${name}`,
    url: `http://127.0.0.1:${base + k}`,
    https: `https://localhost:${base + 200 + k}`,
  });
  const A = mk('A', 0);
  const B = mk('B', 1);
  const C = mk('C', 2);
  for (const i of [A, B, C]) spawnSync('tmux', ['-L', i.sock, 'kill-server']);
  mkInst(A, '1.1.10');
  mkInst(B, '1.1.10');
  mkInst(C, '1.1.0');
  await Bun.write(`${A.dir}/app.env`, appEnv(A, 'hub,node', ''));
  await Bun.write(`${B.dir}/app.env`, appEnv(B, 'standalone', ''));
  await Bun.write(`${C.dir}/app.env`, appEnv(C, 'standalone', ''));
  log(`root=${ROOT} A=${A.port} B=${B.port} C=${C.port}`);

  await cli(['hub', 'user', 'add', USER, '--install-dir', A.dir], { TMEX_PASSWORD: PASSWORD });
  startLoop(A);
  await waitHealthy(A.port);
  A.nodeId = sql(A, 'select node_id from node_identity');
  log(`A healthy nodeId=${A.nodeId}`);
  await enableTls(A);
  startLoop(B);
  await waitHealthy(B.port);
  startLoop(C);
  await waitHealthy(C.port);
  await joinNode(A, B, 'node-b');
  await restart(B);
  await joinNode(A, C, 'node-c');
  await restart(C);

  const pageA = await uiLogin(A.url);
  const nodes = await waitFor('A sees B,C online', async () => {
    const r = await api(pageA, 'GET', '/api/mesh/nodes');
    const rows = ((r.json as { nodes?: Array<{ id: string; online: boolean; loggedIn: boolean; version: string | null }> })?.nodes ?? []);
    const ok = [B.nodeId, C.nodeId].every((id) => rows.some((n) => n.id === id && n.online));
    return ok ? rows : null;
  });
  log(`A nodes: ${JSON.stringify(nodes.map((n) => ({ id: n.id.slice(0, 6), online: n.online, loggedIn: n.loggedIn, v: n.version })))}`);

  if (PART === 'A' || PART === 'all') await partA(pageA, C);
  if (PART === 'B' || PART === 'all') await partB(A, B, C, pageA);
  log('DONE');
}

// ---- Part A：远程升级推送 ----
async function partA(pageA: Page, C: Inst) {
  log('--- Part A: staged-package remote upgrade A→C ---');
  await waitFor('C logged in from A', async () => {
    const r = await api(pageA, 'GET', '/api/mesh/nodes');
    const rows = ((r.json as { nodes?: Array<{ id: string; loggedIn: boolean }> })?.nodes ?? []);
    return rows.some((n) => n.id === C.nodeId && n.loggedIn);
  }, 60_000);
  const info = await api(pageA, 'GET', `/n/${C.nodeId}/api/system/info`);
  log(`C info via A: ${JSON.stringify(info.json)}`);
  const latest = await api(pageA, 'GET', '/api/mesh/upgrade/latest');
  log(`latest: ${(latest.json as { latestVersion?: string })?.latestVersion}`);
  const start = await api(pageA, 'POST', `/api/mesh/nodes/${C.nodeId}/upgrade`, {});
  log(`POST upgrade → ${start.status} ${JSON.stringify(start.json)}`);
  const t0 = Date.now();
  let last = '';
  await waitFor('upgrade leaves downloading', async () => {
    const s = await api(pageA, 'GET', `/api/mesh/nodes/${C.nodeId}/upgrade`);
    const cur = `${s.status} ${JSON.stringify(s.json)}`;
    if (cur !== last) {
      last = cur;
      log(`  status +${Math.round((Date.now() - t0) / 1000)}s: ${cur}`);
    }
    const st = s.json as { state?: string; error?: string | null } | null;
    if (!st) return false;
    if (st.state === 'executing') return true;
    if (st.state === 'idle' && st.error) return true;
    return false;
  }, 15 * 60_000, 3000);
  const staged = existsSync(`${C.dir}/staging`) ? spawnSync('bash', ['-c', `find ${C.dir}/staging -maxdepth 3 | head -30`]).stdout.toString() : '(no staging dir)';
  log(`C staging tree:\n${staged}`);
  const cache = existsSync(`${ROOT}/A/staging/release-cache`) ? readdirSync(`${ROOT}/A/staging/release-cache`).join(', ') : '(no cache)';
  log(`A release-cache: ${cache}`);
  await Bun.sleep(8000);
  const tail = spawnSync('bash', ['-c', `grep -n -i 'upgrade\\|staged\\|applier\\|preflight' ${C.dir}/server.log | tail -25`]).stdout.toString();
  log(`C server.log (upgrade lines):\n${tail}`);
  const upgradeLog = existsSync(`${C.dir}/upgrade.log`) ? spawnSync('tail', ['-30', `${C.dir}/upgrade.log`]).stdout.toString() : '(no upgrade.log)';
  log(`C upgrade.log:\n${upgradeLog}`);
}

// ---- Part B：多 hub 主备 ----
async function partB(A: Inst, B: Inst, C: Inst, pageA: Page) {
  log('--- Part B: multi-hub active/standby ---');
  const tlsB = await enableTls(B);
  log(`B CA fingerprint: ${tlsB?.caFingerprint}`);
  const sb = await cli(['hub', 'standby', '--public-url', B.https, '--priority', '200', '--install-dir', B.dir, '--no-restart']);
  log(`B standby cli: ${sb.trim().split('\n').slice(-3).join(' | ')}`);
  const allow = await cli(['hub', 'allow', B.nodeId ?? '', '--install-dir', A.dir, '--no-restart']);
  log(`A allow cli: ${allow.trim().split('\n').slice(-2).join(' | ')}`);
  await restart(A);
  await restart(B);
  log(`A env: ${spawnSync('grep', ['-E', 'TMEX_HUB_(MODE|PEERS|PRIORITY|WRITER)', `${A.dir}/app.env`]).stdout.toString().trim().replace(/\n/g, ' ')}`);
  log(`B env: ${spawnSync('grep', ['-E', 'TMEX_ROLES|TMEX_HUB_(MODE|PEERS|PRIORITY|WRITER|URL|PUBLIC)', `${B.dir}/app.env`]).stdout.toString().trim().replace(/\n/g, ' ')}`);

  const pageC = await uiLogin(C.url);
  type Hubs = { hubs: Array<{ nodeId: string; mode: string; online?: boolean; writerEpoch: number; publicUrl: string }>; attached: { hubNodeId: string | null; publicUrl: string; mode: string | null } | null; writerHubId: string | null };
  const hubs = await waitFor('C sees A active + B standby', async () => {
    const r = await api(pageC, 'GET', '/api/mesh/hubs');
    const h = r.json as Hubs | null;
    if (!h?.hubs) return null;
    const a = h.hubs.find((x) => x.nodeId === A.nodeId);
    const b = h.hubs.find((x) => x.nodeId === B.nodeId);
    return a?.mode === 'active' && b?.mode === 'standby' ? h : null;
  }, 120_000);
  log(`C hubs: ${JSON.stringify(hubs.hubs.map((h) => ({ id: h.nodeId.slice(0, 6), mode: h.mode, online: h.online, epoch: h.writerEpoch, url: h.publicUrl })))} attached=${hubs.attached?.hubNodeId?.slice(0, 6)}/${hubs.attached?.publicUrl} writer=${hubs.writerHubId?.slice(0, 6)}`);
  log(`C hub_trust: ${sql(C, 'select hub_url, substr(ca_fingerprint,1,16) from hub_trust')}`);
  log(`C mesh_hubs: ${sql(C, 'select substr(hub_node_id,1,6), mode, priority, writer_epoch, online from mesh_hubs')}`);
  log(`B nodes (replicated): ${sql(B, 'select substr(id,1,6), name, status, version from nodes')}`);
  log(`B mesh_hubs: ${sql(B, 'select substr(hub_node_id,1,6), mode, priority, writer_epoch, online from mesh_hubs')}`);

  // standby 拒写（C → B）
  await waitFor('C logged into B', async () => {
    const r = await api(pageC, 'GET', '/api/mesh/nodes');
    const rows = ((r.json as { nodes?: Array<{ id: string; loggedIn: boolean }> })?.nodes ?? []);
    return rows.some((n) => n.id === B.nodeId && n.loggedIn);
  }, 60_000);
  const fenced = await api(pageC, 'POST', `/n/${B.nodeId}/api/hub/enrollments`, { enroll_pk: 'x', authorization: 'x', authorization_sig: 'x' });
  log(`C → B enrollments (standby) → ${fenced.status} ${JSON.stringify(fenced.json)}`);
  const readOk = await api(pageC, 'GET', `/n/${B.nodeId}/api/hub/nodes`);
  log(`C → B GET hub/nodes → ${readOk.status} rows=${((readOk.json as { nodes?: unknown[] })?.nodes ?? []).length}`);

  // failover：停 A
  log('stopping A …');
  stopLoop(A);
  const t0 = Date.now();
  const fo = await waitFor('C attached to B', async () => {
    const r = await api(pageC, 'GET', '/api/mesh/hubs');
    const h = r.json as Hubs | null;
    return h?.attached?.hubNodeId === B.nodeId ? h : null;
  }, 180_000, 3000);
  log(`failover done in ${Math.round((Date.now() - t0) / 1000)}s: attached=${fo.attached?.publicUrl} writer=${fo.writerHubId?.slice(0, 6)}`);
  const viaB = await api(pageC, 'GET', `/n/${B.nodeId}/api/system/info`);
  log(`C → B system/info after failover → ${viaB.status}`);
  const nodesOnB = sql(B, 'select substr(id,1,6), name from nodes');
  log(`B nodes now: ${nodesOnB.replace(/\n/g, ' | ')}`);

  // fail-back：A 回来
  log('restarting A …');
  startLoop(A);
  await waitHealthy(A.port);
  const t1 = Date.now();
  const fb = await waitFor('C back on A', async () => {
    const r = await api(pageC, 'GET', '/api/mesh/hubs');
    const h = r.json as Hubs | null;
    return h?.attached?.hubNodeId === A.nodeId ? h : null;
  }, 240_000, 3000);
  log(`fail-back done in ${Math.round((Date.now() - t1) / 1000)}s: attached=${fb.attached?.publicUrl}`);

  // promote B → A 被围栏
  const pr = await cli(['hub', 'promote', '--yes', '--install-dir', B.dir, '--no-restart']);
  log(`B promote cli: ${pr.trim().split('\n').slice(-2).join(' | ')}`);
  await restart(B);
  const fencedA = await waitFor('A fenced to standby', async () => {
    const r = await api(pageC, 'GET', '/api/mesh/hubs');
    const h = r.json as Hubs | null;
    const a = h?.hubs.find((x) => x.nodeId === A.nodeId);
    const b = h?.hubs.find((x) => x.nodeId === B.nodeId);
    return a?.mode === 'standby' && b?.mode === 'active' && h?.writerHubId === B.nodeId ? h : null;
  }, 120_000, 3000);
  log(`after promote: ${JSON.stringify(fencedA.hubs.map((h) => ({ id: h.nodeId.slice(0, 6), mode: h.mode, epoch: h.writerEpoch })))} writer=${fencedA.writerHubId?.slice(0, 6)}`);
  log(`A log fenced: ${spawnSync('bash', ['-c', `grep -n 'fenced\\|split-brain' ${A.dir}/server.log | tail -3`]).stdout.toString().trim()}`);
  const aWrite = await api(pageA, 'POST', `/n/${A.nodeId}/api/hub/enrollments`, { enroll_pk: 'x', authorization: 'x', authorization_sig: 'x' });
  log(`A (fenced) enrollments → ${aWrite.status} ${JSON.stringify(aWrite.json)}`);
  await restart(A);
  const afterRestart = await api(pageA, 'POST', `/n/${A.nodeId}/api/hub/enrollments`, { enroll_pk: 'x', authorization: 'x', authorization_sig: 'x' });
  log(`A after restart (must stay fenced) enrollments → ${afterRestart.status} ${JSON.stringify(afterRestart.json)}`);
}

function cleanup() {
  for (const c of children)
    try {
      c.kill('SIGTERM');
    } catch {}
  spawnSync('bash', [
    '-c',
    `for p in $(pgrep -f "${SERVER}"); do if ps eww $p | grep -q "DATABASE_URL=${ROOT}"; then kill $p; fi; done; true`,
  ]);
  for (const n of ['A', 'B', 'C']) spawnSync('tmux', ['-L', `tmex-live-${n}`, 'kill-server']);
  void browser?.close();
}
main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    cleanup();
    process.exit(1);
  });
