// 经本机生产 tmex（entry）把 tarball 上传到 hub 节点并在其终端里离线升级。
// 只读本机生产 UI（登录 + /n/<hub>/api/*），写操作全部发生在远端 hub 节点上（用户明确要求升级 hub）。
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const base = 'http://127.0.0.1:9883';
const hubId = process.env.HUB_ID ?? 'ec42f36455c164117088e7b786c56425';
const version = process.env.VER ?? '1.1.10';
const tarball = process.env.TARBALL ?? `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/rel110/tmex-cli-${version}.tgz`;
const password = process.env.PROBE_PASS ?? '';
const REMOTE_DIR = '/root/tmex-hub';
const INSTALL_DIR = '/root/tmex-hub/install';
const log = (m: string) => process.stdout.write(`[hub-upg ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('login-username').fill('admin');
await page.getByTestId('login-password').fill(password);
await page.getByTestId('login-submit').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]'), null, { timeout: 60_000 });
await page.waitForTimeout(6000);

const n = (p: string) => `${base}/n/${hubId}${p}`;
async function getJson(url: string) {
  const r = await page.request.get(url);
  return { status: r.status(), body: await r.json().catch(async () => await r.text()) };
}
async function postJson(url: string, data: unknown) {
  const r = await page.request.post(url, { data });
  return { status: r.status(), body: await r.json().catch(async () => await r.text()) };
}

// 1. hub 版本与设备
const info = await getJson(n('/api/system/info'));
log(`hub info: ${JSON.stringify(info.body)}`);
const devices = await getJson(n('/api/devices'));
const devList = ((devices.body as { devices?: Array<{ id: string; name: string; type: string; session?: string }> })?.devices ?? []);
log(`hub devices: ${JSON.stringify(devList.map((d) => ({ id: d.id, name: d.name, type: d.type })))}`);

// 2. 临时终端设备
const created = await postJson(n('/api/devices'), { name: 'tmex-upgrade-tmp', type: 'local', session: 'tmex-upg', authMode: 'auto' });
log(`create device: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
const devId = (created.body as { device?: { id: string } })?.device?.id;
if (!devId) throw new Error('no device');

// 3. 文件根
let roots = ((await getJson(n('/api/files/roots'))).body as { roots?: Array<{ id: string; path: string; deviceId?: string }> })?.roots ?? [];
log(`roots: ${JSON.stringify(roots)}`);
let root = roots.find((r) => r.path === REMOTE_DIR);
let createdRoot = false;
if (!root) {
  const cr = await postJson(n('/api/files/roots'), { deviceId: devId, path: REMOTE_DIR });
  log(`create root: ${cr.status} ${JSON.stringify(cr.body).slice(0, 300)}`);
  roots = ((cr.body as { roots?: typeof roots })?.roots ?? ((await getJson(n('/api/files/roots'))).body as { roots?: typeof roots })?.roots ?? []);
  root = roots.find((r) => r.path === REMOTE_DIR);
  createdRoot = Boolean(root);
}
if (!root) throw new Error('no root');
const rootId = root.id;
log(`rootId=${rootId}`);

async function upload(name: string, bytes: Buffer) {
  for (const destDir of ['/', REMOTE_DIR]) {
    const init = await postJson(n('/api/files/upload/init'), { rootId, path: destDir, name, size: bytes.length });
    if (init.status !== 200) {
      log(`upload init ${name} path=${destDir} → ${init.status} ${JSON.stringify(init.body)}`);
      continue;
    }
    const { uploadId, chunkSize } = init.body as { uploadId: string; chunkSize: number };
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      const r = await page.request.put(n(`/api/files/upload/${uploadId}?offset=${offset}`), {
        data: chunk,
        headers: { 'content-type': 'application/octet-stream' },
        timeout: 600_000,
      });
      if (r.status() !== 200) throw new Error(`chunk ${offset} → ${r.status()} ${await r.text()}`);
      offset += chunk.length;
      log(`  ${name}: ${offset}/${bytes.length}`);
    }
    const commit = await page.request.post(n(`/api/files/upload/${uploadId}/commit`), { timeout: 600_000 });
    const text = await commit.text();
    log(`commit ${name}: ${commit.status()} ${text.trim().split('\n').slice(-1)[0]}`);
    if (!text.includes('"done"')) throw new Error(`commit failed: ${text}`);
    return destDir;
  }
  throw new Error(`upload init failed for ${name}`);
}

const script = `#!/bin/bash
set -u
cd ${REMOTE_DIR} || exit 1
export PATH="$PATH:/usr/local/bin:/usr/bin:/root/.bun/bin:/root/.local/bin:/root/.nvm/current/bin"
echo "== $(date -u) start upgrade to ${version}"
echo "node=$(command -v node) npx=$(command -v npx) bun=$(command -v bun)"
node -v 2>&1 || true
ls -la ${INSTALL_DIR} | head -20
sha256sum tmex-cli-${version}.tgz
if command -v npx >/dev/null 2>&1; then
  npx --yes ./tmex-cli-${version}.tgz upgrade --apply-current-package --yes --lang zh-CN --install-dir ${INSTALL_DIR}
  echo "EXIT=$?"
else
  rm -rf ${REMOTE_DIR}/pkg && mkdir -p ${REMOTE_DIR}/pkg && tar -xzf tmex-cli-${version}.tgz -C ${REMOTE_DIR}/pkg
  bun ${REMOTE_DIR}/pkg/package/bin/tmex.js upgrade --apply-current-package --yes --lang zh-CN --install-dir ${INSTALL_DIR}
  echo "EXIT=$?"
fi
echo "== $(date -u) done"
`;
const destDir = await upload(`upg-${version}.sh`, Buffer.from(script));
await upload(`tmex-cli-${version}.tgz`, readFileSync(tarball));
const st = await getJson(n(`/api/files/stat?rootId=${rootId}&path=${encodeURIComponent(destDir === '/' ? `/tmex-cli-${version}.tgz` : `${REMOTE_DIR}/tmex-cli-${version}.tgz`)}`));
log(`stat tarball: ${JSON.stringify(st.body)}`);

// 4. 终端执行
await page.goto(`${base}/n/${hubId}/devices/${devId}`, { waitUntil: 'domcontentloaded' });
await page.locator('.xterm').first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
await page.locator('.xterm').first().click();
const logPath = `${REMOTE_DIR}/upgrade-${version}.log`;
await page.keyboard.type(`nohup setsid bash ${REMOTE_DIR}/upg-${version}.sh > ${logPath} 2>&1 & disown; echo LAUNCHED`);
await page.keyboard.press('Enter');
await page.waitForTimeout(4000);
const buf = await page.evaluate(() => Array.from(document.querySelectorAll('.xterm-rows > div')).map((d) => d.textContent ?? '').join('\n'));
log(`terminal:\n${buf.split('\n').filter((l) => l.trim()).slice(-8).join('\n')}`);

// 5. 轮询 hub 重启 + 版本
const readLog = async () => (await getJson(n(`/api/files/content?rootId=${rootId}&path=${encodeURIComponent(destDir === '/' ? `/upgrade-${version}.log` : logPath)}`))).body as { content?: string } | string;
const startedAt0 = ((await (await fetch('https://ai.jiefakj.com:18443/healthz')).json()) as { startedAt: number }).startedAt;
log(`hub startedAt before: ${startedAt0}`);
const deadline = Date.now() + 15 * 60_000;
let restarted = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const h = (await (await fetch('https://ai.jiefakj.com:18443/healthz', { signal: AbortSignal.timeout(8000) })).json()) as { startedAt: number };
    if (h.startedAt !== startedAt0) {
      log(`hub restarted: startedAt=${h.startedAt}`);
      restarted = true;
      break;
    }
  } catch (e) {
    log(`healthz: ${String(e).slice(0, 80)}`);
  }
  const l = await readLog();
  const text = typeof l === 'string' ? l : (l?.content ?? JSON.stringify(l));
  log(`log tail: ${text.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  if (text.includes('EXIT=')) break;
}
await new Promise((r) => setTimeout(r, 20_000));
for (let i = 0; i < 12; i++) {
  const v = await getJson(n('/api/system/info'));
  log(`hub info after: ${v.status} ${JSON.stringify(v.body).slice(0, 200)}`);
  if (v.status === 200) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
const l = await readLog();
const text = typeof l === 'string' ? l : (l?.content ?? JSON.stringify(l));
log(`upgrade log:\n${text.trim().split('\n').slice(-40).join('\n')}`);

// 6. 清理临时设备（保留根目录与日志以便复查）
const del = await page.request.delete(n(`/api/devices/${devId}`));
log(`delete temp device: ${del.status()} restarted=${restarted} createdRoot=${createdRoot} rootId=${rootId}`);
await browser.close();
