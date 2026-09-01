#!/usr/bin/env bun
// 取消/恢复实测：复用 live-r13 的 A(hub)+C(目标 1.1.0) 拓扑（去掉 B），验证
//   1) 下载中刷新页面：行内显示进行中 + 停止按钮（状态从后端恢复）
//   2) 点击停止：入口 job 取消，状态 UPGRADE_CANCELLED，入口 cache 无 .part、目标 staged 目录为空
//   3) 取消后立刻再次发起：200 downloading
//   4) 推送完成后（目标 executing 起不来是实验室限制）不留 .part
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const S = '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad';
// 直接复用 live-r13 的启动逻辑：以子进程方式跑到 Part A 之前太重，这里改为 import 其工具不可行（脚本顶层有 main）。
// 所以本脚本假设 live-r13.ts 已把 A/C 起好并通过 LIVE_KEEP=1 保持运行；否则自己拉起（见下）。
const base = process.env.A_URL ?? '';
const cId = process.env.C_ID ?? '';
const rootDir = process.env.LIVE_ROOT ?? '';
if (!base || !cId || !rootDir) throw new Error('A_URL, C_ID, LIVE_ROOT required');
const USER = 'alice';
const PASSWORD = 'live-r13-Passw0rd!';
const log = (m: string) => process.stdout.write(`[cancel ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page: Page = await ctx.newPage();
page.on('dialog', (d) => void d.accept());
await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('login-username').fill(USER);
await page.getByTestId('login-password').fill(PASSWORD);
await page.getByTestId('login-submit').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]'), null, { timeout: 60_000 });
await page.waitForTimeout(5000);
const api = async (method: string, url: string, body?: unknown) => {
  const r = await page.request.fetch(`${base}${url}`, { method, data: body });
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const cacheDir = `${rootDir}/A/staging/release-cache`;
const stagedDir = `${rootDir}/C/staging/staged`;
const ls = (d: string) => (existsSync(d) ? readdirSync(d).join(',') || '(empty)' : '(absent)');

// 1) 发起 → 下载中 → 刷新页面 → 行应显示停止按钮
const start = await api('POST', `/api/mesh/nodes/${cId}/upgrade`, {});
log(`POST → ${start.status} ${JSON.stringify(start.body)}`);
await page.waitForTimeout(1500);
await page.goto(`${base}/settings?tab=nodes`, { waitUntil: 'domcontentloaded' });
const cancelBtn = page.getByTestId(`node-upgrade-cancel-${cId}`);
try {
  await cancelBtn.waitFor({ state: 'visible', timeout: 15_000 });
  log(`after reload: cancel button visible=${await cancelBtn.isVisible()} disabled=${await cancelBtn.isDisabled()} title=${await cancelBtn.getAttribute('title')}`);
} catch {
  const s = await api('GET', `/api/mesh/nodes/${cId}/upgrade`);
  log(`after reload: cancel button NOT visible; status now ${JSON.stringify(s.body)}`);
}
const rowBtn = page.getByTestId(`node-upgrade-${cId}`);
log(`row upgrade button text="${(await rowBtn.textContent().catch(() => ''))?.trim()}" disabled=${await rowBtn.isDisabled().catch(() => 'n/a')}`);
log(`cache during download: ${ls(cacheDir)} | staged: ${ls(stagedDir)}`);

// 2) 点击停止
if (await cancelBtn.isVisible().catch(() => false)) {
  await cancelBtn.click();
  await page.waitForTimeout(2500);
}
const afterCancel = await api('GET', `/api/mesh/nodes/${cId}/upgrade`);
log(`status after stop: ${afterCancel.status} ${JSON.stringify(afterCancel.body)}`);
await page.waitForTimeout(1500);
log(`cache after cancel: ${ls(cacheDir)} | staged after cancel: ${ls(stagedDir)}`);
const toasts = await page.evaluate(() => Array.from(document.querySelectorAll('[data-sonner-toast]')).map((e) => e.textContent?.trim() ?? ''));
log(`toasts: ${JSON.stringify(toasts)}`);
log(`row button after cancel: text="${(await rowBtn.textContent().catch(() => ''))?.trim()}" disabled=${await rowBtn.isDisabled().catch(() => 'n/a')}`);

// 3) 立刻再次发起
const again = await api('POST', `/api/mesh/nodes/${cId}/upgrade`, {});
log(`POST again → ${again.status} ${JSON.stringify(again.body)}`);
let last = '';
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  const s = await api('GET', `/api/mesh/nodes/${cId}/upgrade`);
  const cur = JSON.stringify(s.body);
  if (cur !== last) {
    log(`  status: ${cur}`);
    last = cur;
  }
  const st = s.body as { state?: string; error?: string | null } | null;
  if (st && st.state === 'idle') break;
}
log(`cache final: ${ls(cacheDir)} | staged final: ${ls(stagedDir)} | C staging: ${ls(`${rootDir}/C/staging`)}`);
log(`A log: ${spawnSync('bash', ['-c', `grep -n 'upgrade\\|cancel' ${rootDir}/A/server.log | grep -v ws-metrics | tail -6`]).stdout.toString().trim()}`);
await browser.close();
log('DONE');
