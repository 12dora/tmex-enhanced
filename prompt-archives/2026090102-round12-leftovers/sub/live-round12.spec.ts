import { type Page, expect, test } from '@playwright/test';
import { createSinglePaneSession, createTwoWindowSession, ensureCleanSession, tmux } from './helpers/tmux';
import { KIND, decodeEnvelope, isGatewayWsUrl } from './helpers/ws-borsh';

test.setTimeout(300_000);

function attachFrameMeter(page: Page) {
  const counts = { outputBytes: 0, outputFrames: 0, historyFrames: 0, pings: 0 };
  page.on('websocket', (ws) => {
    if (!isGatewayWsUrl(ws.url())) return;
    ws.on('framesent', ({ payload }) => {
      const env = decodeEnvelope(payload as Buffer);
      if (env?.kind === KIND.PING) counts.pings += 1;
    });
    ws.on('framereceived', ({ payload }) => {
      const env = decodeEnvelope(payload as Buffer);
      if (!env) return;
      if (env.kind === KIND.TERM_OUTPUT) {
        counts.outputFrames += 1;
        counts.outputBytes += (payload as Buffer).length;
      }
      if (env.kind === KIND.TERM_HISTORY) counts.historyFrames += 1;
    });
  });
  return {
    reset() {
      counts.outputBytes = 0;
      counts.outputFrames = 0;
      counts.historyFrames = 0;
      counts.pings = 0;
    },
    read() {
      return { ...counts };
    },
  };
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return '';
    const lines: string[] = [];
    for (let i = 0; i < term.rows; i += 1) {
      lines.push(term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  });
}

test('live: hidden keep-alive pane stops receiving output after grace and replays history on re-show', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-live-keepalive-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  const [paneA, paneB] = paneIds as [string, string];
  const meter = attachFrameMeter(page);
  const createRes = await request.post('/api/devices', {
    data: { name: `live-keepalive-${Date.now()}`, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const deviceId = ((await createRes.json()) as { device: { id: string } }).device.id;
  const log: string[] = [];
  try {
    tmux(`send-keys -t ${paneA} -l 'while :; do echo TICK_$RANDOM; sleep 0.2; done'`);
    tmux(`send-keys -t ${paneA} C-m`);

    await page.goto(`/devices/${deviceId}/windows/${windowIds[0]}/panes/${encodeURIComponent(paneA)}`);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => visibleText(page), { timeout: 20_000 }).toContain('TICK_');

    await page.getByTestId(`window-item-${windowIds[1]}`).click({ timeout: 10_000 });
    await expect.poll(() => visibleText(page), { timeout: 20_000 }).not.toContain('TICK_');
    const switchedAt = Date.now();

    meter.reset();
    await page.waitForTimeout(10_000);
    const withinGrace = meter.read();
    log.push(`within grace (10s): output frames=${withinGrace.outputFrames} bytes=${withinGrace.outputBytes}`);
    expect(withinGrace.outputFrames).toBeGreaterThan(5);

    await page.waitForTimeout(Math.max(0, switchedAt + 68_000 - Date.now()));
    meter.reset();
    await page.waitForTimeout(10_000);
    const afterGrace = meter.read();
    log.push(`after grace (10s): output frames=${afterGrace.outputFrames} bytes=${afterGrace.outputBytes}`);
    expect(afterGrace.outputFrames).toBeLessThanOrEqual(1);

    meter.reset();
    await page.getByTestId(`window-item-${windowIds[0]}`).click({ timeout: 10_000 });
    await expect.poll(() => visibleText(page), { timeout: 20_000 }).toContain('TICK_');
    await page.waitForTimeout(5_000);
    const reshown = meter.read();
    log.push(`re-show (5s): history frames=${reshown.historyFrames} output frames=${reshown.outputFrames}`);
    expect(reshown.historyFrames).toBeGreaterThanOrEqual(1);
    expect(reshown.outputFrames).toBeGreaterThan(5);
    const text = await visibleText(page);
    const ticks = text.split('\n').filter((l) => l.includes('TICK_'));
    log.push(`visible TICK lines=${ticks.length}, unique=${new Set(ticks).size}`);
    expect(new Set(ticks).size).toBe(ticks.length);
  } finally {
    console.log(`[live-keepalive] ${log.join(' | ')}`);
    tmux(`send-keys -t ${paneA} C-c`);
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

async function setVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('live: gateway heartbeat slows to 30s while hidden and resumes 5s on visible', async ({ page, request }) => {
  const sessionName = `tmex-e2e-live-heartbeat-${Date.now()}`;
  createSinglePaneSession(sessionName);
  const meter = attachFrameMeter(page);
  const createRes = await request.post('/api/devices', {
    data: { name: `live-heartbeat-${Date.now()}`, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const deviceId = ((await createRes.json()) as { device: { id: string } }).device.id;
  const log: string[] = [];
  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000);

    meter.reset();
    await page.waitForTimeout(20_000);
    const visiblePings = meter.read().pings;
    log.push(`visible 20s pings=${visiblePings}`);
    expect(visiblePings).toBeGreaterThanOrEqual(3);

    await setVisibility(page, 'hidden');
    meter.reset();
    await page.waitForTimeout(35_000);
    const hiddenPings = meter.read().pings;
    log.push(`hidden 35s pings=${hiddenPings}`);
    expect(hiddenPings).toBeLessThanOrEqual(2);
    expect(hiddenPings).toBeGreaterThanOrEqual(1);

    meter.reset();
    await setVisibility(page, 'visible');
    await expect.poll(() => meter.read().pings, { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
    meter.reset();
    await page.waitForTimeout(20_000);
    const backPings = meter.read().pings;
    log.push(`visible again 20s pings=${backPings}`);
    expect(backPings).toBeGreaterThanOrEqual(3);
  } finally {
    console.log(`[live-heartbeat] ${log.join(' | ')}`);
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
