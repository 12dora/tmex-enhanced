#!/usr/bin/env bun
import { chromium } from '/Users/konata/code/tmex-enhanced-wt-r9/node_modules/.bun/playwright-core@1.58.2/node_modules/playwright-core/index.js';
const SCRATCH = '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad/live';
const SHOTS = '/Users/konata/code/tmex-enhanced/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/live';
const S = JSON.parse(await Bun.file(`${SCRATCH}/state.json`).text());
const BASE = `http://localhost:${S.hubPort}`;
const log = (m: string) => process.stdout.write(`${m}\n`);
const step = async (name: string, fn: () => Promise<void>) => { log(`\n===== ${name} =====`); try { await fn(); } catch (e) { log(`!! ${name} FAILED: ${e}`); } };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') log(`[console.error] ${m.text().slice(0, 300)}`); });

await step('login', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-page').waitFor({ timeout: 30_000 });
  await page.getByTestId('login-username').fill(S.user);
  await page.getByTestId('login-password').fill(S.password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('sidebar').waitFor({ timeout: 90_000 });
  log('logged in, sidebar visible');
});

const dumpFiles = async (label: string) => {
  const html = await page.getByTestId('files-tab').innerHTML().catch(() => '');
  await Bun.write(`${SCRATCH}/files-tab-${label}.html`, html);
  const structure = await page.evaluate(() => {
    const tab = document.querySelector('[data-testid="files-tab"]');
    if (!tab) return null;
    const out: any[] = [];
    for (const sec of Array.from(tab.querySelectorAll('[data-testid^="files-node-section-"]'))) {
      const id = sec.getAttribute('data-testid')!.replace('files-node-section-', '');
      const toggle = sec.querySelector(`[data-testid="files-node-toggle-${id}"]`);
      const handle = sec.querySelector('button[aria-label]');
      out.push({
        section: id,
        headerText: toggle?.textContent?.trim() ?? null,
        dragHandleAriaLabels: Array.from(sec.querySelectorAll(':scope > div > button[aria-label]')).map((b) => b.getAttribute('aria-label')),
        loginRow: !!sec.querySelector(`[data-testid="files-node-login-${id}"]`),
        loginRowText: sec.querySelector(`[data-testid="files-node-login-${id}"]`)?.textContent?.trim() ?? null,
        offlineRow: !!sec.querySelector(`[data-testid="files-node-offline-${id}"]`),
        rootRows: Array.from(sec.querySelectorAll('[data-testid^="file-dir-"]')).map((b) => ({ testid: b.getAttribute('data-testid'), text: b.textContent?.trim() })),
        fileRows: Array.from(sec.querySelectorAll('[data-testid^="file-item-"]')).map((b) => ({ testid: b.getAttribute('data-testid'), text: b.textContent?.trim() })),
        rootDragHandles: Array.from(sec.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label')),
      });
    }
    return { sectionCount: out.length, sections: out, headerLabel: tab.querySelector('span')?.textContent };
  });
  log(`[files:${label}] ${JSON.stringify(structure, null, 1)}`);
  return structure;
};

await step('A1 open files tab (node NOT signed in)', async () => {
  await page.getByTestId('sidebar-tab-files').click();
  await page.getByTestId('files-tab').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await dumpFiles('pre-login');
  await page.getByTestId('sidebar').screenshot({ path: `${SHOTS}/A1-sidebar-files-node-signed-out.png` });
  await page.screenshot({ path: `${SHOTS}/A1-full-signed-out.png` });
});

await step('A2 sign in to remote node from devices page', async () => {
  await page.locator('a[href="/devices"]').first().click();
  await page.getByTestId('devices-page').first().waitFor({ timeout: 30_000 });
  await page.getByTestId(`devices-node-login-${S.nodeId}`).waitFor({ timeout: 30_000 });
  await page.getByTestId(`devices-node-login-${S.nodeId}`).getByTestId(`node-login-${S.nodeId}`).click();
  await page.getByTestId(`devices-node-login-${S.nodeId}`).waitFor({ state: 'detached', timeout: 60_000 });
  log('node signed in');
  await page.waitForTimeout(3000);
});

await step('A3 files tab after node sign-in', async () => {
  await page.getByTestId('sidebar-tab-files').click();
  await page.getByTestId('files-tab').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  await dumpFiles('post-login');
  await page.getByTestId('sidebar').screenshot({ path: `${SHOTS}/A2-sidebar-files-two-sections.png` });
});

await step('A4 expand roots', async () => {
  for (const [rootId, path] of [[S.nodeRootIds[0], S.nodeFiles], [S.hubRootId, S.hubFiles]] as [string, string][]) {
    const loc = page.getByTestId(`file-dir-${rootId}-${path}`);
    await loc.waitFor({ timeout: 20_000 });
    await loc.click();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);
  await dumpFiles('expanded');
  await page.getByTestId('sidebar').screenshot({ path: `${SHOTS}/A3-sidebar-files-expanded.png` });
});

await step('A5 reorder node roots via API', async () => {
  const before = await page.request.get(`${BASE}/n/${S.nodeId}/api/files/roots`);
  const b = await before.json();
  log(`before order: ${JSON.stringify(b.roots.map((r: any) => [r.id, r.name, r.sortOrder]))}`);
  const reversed = b.roots.map((r: any) => r.id).reverse();
  const res = await page.request.put(`${BASE}/n/${S.nodeId}/api/files/roots/order`, { data: { rootIds: reversed } });
  log(`PUT order → ${res.status()}`);
  const after = await res.json();
  log(`after order: ${JSON.stringify((after.roots ?? []).map((r: any) => [r.id, r.name, r.sortOrder]))}`);
  await page.getByTestId('files-refresh').click();
  await page.waitForTimeout(3000);
  const st = await dumpFiles('reordered');
  await page.getByTestId('sidebar').screenshot({ path: `${SHOTS}/A4-sidebar-files-reordered.png` });
});

let paneUrl = '';
await step('B1 open remote device terminal', async () => {
  await page.locator('a[href="/devices"]').first().click();
  await page.getByTestId('devices-page').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')));
  log(`all hrefs: ${JSON.stringify(hrefs)}`);
  const target = page.locator(`a[href*="/n/${S.nodeId}/devices/${S.nodeDeviceId}"]`).first();
  if (await target.count() > 0) { await target.click(); }
  else {
    log('no device anchor; clicking device card');
    await page.getByTestId(`device-card-${S.nodeDeviceId}`).first().click({ timeout: 15_000 }).catch(async () => {
      await page.locator(`[data-testid*="${S.nodeDeviceId}"]`).first().click();
    });
  }
  await page.waitForTimeout(10000);
  paneUrl = page.url();
  log(`url now: ${paneUrl}`);
  await page.getByTestId('device-page').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/B0-device-page.png` });
});

await step('B2 badge', async () => {
  const badge = page.getByTestId('badge-node-link');
  await badge.waitFor({ timeout: 30_000 });
  log(`badge text: ${JSON.stringify(await badge.textContent())}`);
  await page.locator('[data-testid="device-node-badges"]').screenshot({ path: `${SHOTS}/B1-badge.png` });
  await badge.click();
  await page.getByTestId('ice-diagnostics').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => {
    const pop = document.querySelector('[data-testid="ice-diagnostics"]');
    if (!pop) return null;
    return {
      text: pop.textContent,
      titles: Array.from(pop.querySelectorAll('div.font-semibold')).map((d) => d.textContent),
      rows: Array.from(pop.querySelectorAll('dl > div')).map((d) => ({ label: d.querySelector('dt')?.textContent, value: d.querySelector('dd')?.textContent })),
    };
  });
  log(`ice-diagnostics: ${JSON.stringify(rows, null, 1)}`);
  log(`contains 未知: ${JSON.stringify(rows?.text?.includes('未知'))}`);
  const box = await page.locator('[data-testid="device-node-badges"]').boundingBox();
  await page.screenshot({ path: `${SHOTS}/B2-ice-diagnostics.png`, clip: box ? { x: Math.max(0, box.x - 320), y: box.y - 10, width: 640, height: 340 } : undefined });
  await page.screenshot({ path: `${SHOTS}/B2-ice-diagnostics-full.png` });
});

await step('B3 toolbar buttons', async () => {
  const info = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const inHeader = (b: Element) => !!b.closest('header') || !!b.closest('[data-slot="sidebar-inset"] > div');
    return {
      allButtons: btns.map((b) => ({ testid: b.getAttribute('data-testid'), aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), icons: Array.from(b.querySelectorAll('svg')).map((s) => s.getAttribute('class')?.split(' ').find((c) => c.startsWith('lucide-')) ?? null), header: inHeader(b) })),
      arrowDownToLine: Array.from(document.querySelectorAll('svg')).filter((s) => (s.getAttribute('class') ?? '').includes('arrow-down-to-line')).length,
      headerHtmlLen: document.querySelector('header')?.outerHTML.length ?? 0,
    };
  });
  const toolbar = info.allButtons.filter((b: any) => b.header);
  log(`header/toolbar buttons: ${JSON.stringify(toolbar, null, 1)}`);
  log(`ArrowDownToLine svg count on page: ${info.arrowDownToLine}`);
  log(`ALL buttons: ${JSON.stringify(info.allButtons.map((b: any) => [b.testid, b.aria, b.icons.join('/')]))}`);
  const header = page.locator('header').first();
  if (await header.count() > 0) await header.screenshot({ path: `${SHOTS}/B3-toolbar.png` });
  else await page.screenshot({ path: `${SHOTS}/B3-toolbar.png` });
});

await step('B4 mesh nodes via browser cookies', async () => {
  const res = await page.request.get(`${BASE}/api/mesh/nodes`);
  const body = await res.json();
  log(`GET /api/mesh/nodes → ${res.status()}\n${JSON.stringify(body, null, 1)}`);
  await Bun.write(`${SCRATCH}/mesh-nodes.json`, JSON.stringify(body, null, 2));
});

await browser.close();
log('\nPROBE DONE');
