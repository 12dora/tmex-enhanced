#!/usr/bin/env bun
/**
 * 1.1.4 线上问题复现：「左侧切换终端 tab，右侧终端有概率不刷新，依旧留在旧的终端」。
 *
 * 做法（沿用 ../measure/measure-switch.ts 的基础设施）：
 *   1. 独立 tmux socket 上建 1 个 2-pane window + 3 个单 pane window（共 5 个 pane），
 *      每个 pane 一个唯一 PS1 标记；
 *   2. 从源码树起一个 NODE_ENV=test 的临时 gateway（静态资源指向单独 build 的 dist）；
 *   3. Playwright 随机顺序点击侧栏条目，间隔随机 50~400ms，跑 N 轮；
 *   4. 每次点击后 2s 内轮询三条断言：
 *        A. data-visible="true" 的保活槽的 data-pane-id == 路由 pane
 *        B. 终端区域正中的**最顶层命中元素**属于路由 pane 的槽（用户真正看到/点到的那一个）
 *        C. 可见终端 buffer 含路由 pane 的标记，且不含其它 pane 的标记
 *      任一不满足即记一次 mismatch，并 dump 全部槽的 data 属性与计算样式 + 路由 + 终端实例身份。
 *
 * 用法：
 *   GATEWAY_SRC_DIR=/Users/konata/code/tmex-enhanced-wt-r9 \
 *   FE_DIST_DIR=<scratch>/fe-dist-bug \
 *   ITERATIONS=200 bun repro-stale-switch.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCRATCH =
  '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad';

const cfg = {
  label: process.env.LABEL ?? 'repro',
  gatewaySrcDir: resolve(process.env.GATEWAY_SRC_DIR ?? '/Users/konata/code/tmex-enhanced-wt-r9'),
  feDistDir: resolve(process.env.FE_DIST_DIR ?? `${SCRATCH}/fe-dist-bug`),
  port: Number(process.env.PORT ?? 19771),
  iterations: Number(process.env.ITERATIONS ?? 200),
  minGapMs: Number(process.env.MIN_GAP_MS ?? 50),
  maxGapMs: Number(process.env.MAX_GAP_MS ?? 400),
  assertTimeoutMs: Number(process.env.ASSERT_TIMEOUT_MS ?? 4000),
  tmuxSocket: process.env.TMUX_SOCKET ?? 'tmex-r9-bug',
  session: process.env.SESSION ?? 'r9bug',
  dbPath: process.env.DB_PATH ?? `${SCRATCH}/bugfix/tmex-bug.db`,
  gatewayLog: process.env.GATEWAY_LOG ?? `${SCRATCH}/bugfix/gateway.log`,
  headless: process.env.HEADLESS !== '0',
  maxLoggedMismatches: Number(process.env.MAX_LOGGED ?? 8),
  viewport: { width: 1440, height: 900 },
};

// ── 安全护栏：绝不打到生产 tmex / 默认 tmux socket ──
if ([9883, 9663, 19883].includes(cfg.port)) throw new Error(`拒绝端口 ${cfg.port}`);
if (!cfg.tmuxSocket || cfg.tmuxSocket === 'default' || cfg.tmuxSocket === 'tmex') {
  throw new Error(`拒绝 tmux socket "${cfg.tmuxSocket}"`);
}
if (cfg.session === 'tmex') throw new Error('拒绝名为 tmex 的会话');
if (!existsSync(`${cfg.feDistDir}/index.html`)) throw new Error(`dist 无效：${cfg.feDistDir}`);
if (!existsSync(`${cfg.gatewaySrcDir}/packages/app/src/runtime/server.ts`)) {
  throw new Error(`不是 tmex 仓库根：${cfg.gatewaySrcDir}`);
}

function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of input) {
    if (ch === "'") {
      quoted = !quoted;
      has = true;
      continue;
    }
    if (ch === ' ' && !quoted) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

function tmux(args: string): string {
  const res = spawnSync('tmux', ['-L', cfg.tmuxSocket, ...splitArgs(args)], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`tmux ${args} failed: ${res.stderr?.trim()}`);
  return (res.stdout ?? '').trim();
}
function tmuxQuiet(args: string): void {
  spawnSync('tmux', ['-L', cfg.tmuxSocket, ...splitArgs(args)], { encoding: 'utf8' });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
const markerOf = (i: number): string => `MK${nonce}P${i}`;

interface PaneInfo {
  windowId: string;
  paneId: string;
  marker: string;
}

async function setupSession(): Promise<PaneInfo[]> {
  tmuxQuiet(`kill-session -t ${cfg.session}`);
  tmux(`new-session -d -s ${cfg.session} -n w0 -x 200 -y 50 sh`);
  tmux(`split-window -h -t ${cfg.session}:0 sh`);
  tmux(`new-window -t ${cfg.session} -n w1 sh`);
  tmux(`new-window -t ${cfg.session} -n w2 sh`);
  tmux(`new-window -t ${cfg.session} -n w3 sh`);
  tmux(`select-window -t ${cfg.session}:0`);

  const panes: PaneInfo[] = tmux(`list-panes -s -t ${cfg.session} -F #{window_id}\t#{pane_id}`)
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length === 2)
    .map((parts, index) => ({
      windowId: parts[0] as string,
      paneId: parts[1] as string,
      marker: markerOf(index),
    }));

  await sleep(800);
  for (const pane of panes) {
    // PS1 里带唯一标记：永远留在屏幕上，可作为「当前看到的是哪个 pane」的判据
    tmux(`send-keys -t ${pane.paneId} PS1=${pane.marker}: Enter`);
  }
  await sleep(500);
  for (const pane of panes) {
    tmux(`send-keys -t ${pane.paneId} 'echo ${pane.marker}_BODY' Enter`);
  }
  await sleep(500);
  return panes;
}

let gateway: Bun.Subprocess | null = null;

async function startGateway(): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${cfg.dbPath}${suffix}`, { force: true });
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  mkdirSync(dirname(cfg.gatewayLog), { recursive: true });

  gateway = Bun.spawn([process.execPath, `${cfg.gatewaySrcDir}/packages/app/src/runtime/server.ts`], {
    cwd: cfg.gatewaySrcDir,
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      TERM: 'xterm-256color',
      NODE_ENV: 'test',
      GATEWAY_PORT: String(cfg.port),
      TMEX_BIND_HOST: '127.0.0.1',
      DATABASE_URL: cfg.dbPath,
      TMEX_BASE_URL: `http://127.0.0.1:${cfg.port}`,
      TMEX_TMUX_SOCKET: cfg.tmuxSocket,
      TMEX_FE_DIST_DIR: cfg.feDistDir,
      TMEX_MIGRATIONS_DIR: `${cfg.gatewaySrcDir}/apps/gateway/drizzle`,
    },
    stdout: Bun.file(cfg.gatewayLog),
    stderr: Bun.file(cfg.gatewayLog),
  });

  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`);
      const body = (await res.json()) as { env?: string };
      if (body.env === 'test') return;
      throw new Error(`拒绝继续：healthz env=${body.env} 不是 test`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('拒绝')) throw error;
      await sleep(250);
    }
  }
  throw new Error('gateway 启动超时');
}

const api = {
  async list(): Promise<Array<{ id: string }>> {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/devices`);
    return ((await res.json()) as { devices: Array<{ id: string }> }).devices;
  },
  async remove(id: string): Promise<void> {
    await fetch(`http://127.0.0.1:${cfg.port}/api/devices/${id}`, { method: 'DELETE' });
  },
  async create(name: string, session: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type: 'local', session, authMode: 'auto' }),
    });
    return ((await res.json()) as { device: { id: string } }).device.id;
  },
};

/** 页面内快照：槽位 data-* + 计算样式 + 正中命中元素 + 可见 buffer 文本 */
function inspect(): unknown {
  const doc = document;
  const win = window as unknown as Record<string, unknown>;
  const slotEls = [...doc.querySelectorAll('[data-testid="terminal-keep-alive-pane"]')];
  const slots = slotEls.map((el, index) => {
    const inner = el.querySelector('.xterm');
    const style = getComputedStyle(el as Element);
    return {
      index,
      paneId: (el as HTMLElement).getAttribute('data-pane-id'),
      dataVisible: (el as HTMLElement).getAttribute('data-visible'),
      ariaHidden: (el as HTMLElement).getAttribute('aria-hidden'),
      inlineStyle: (el as HTMLElement).getAttribute('style'),
      computedVisibility: style.visibility,
      computedOpacity: style.opacity,
      zIndex: style.zIndex,
      innerVisibility: inner ? getComputedStyle(inner).visibility : null,
      innerOpacity: inner ? getComputedStyle(inner).opacity : null,
    };
  });

  let topPaneId: string | null = null;
  const first = slotEls[0] as HTMLElement | undefined;
  const box = first?.parentElement;
  if (box) {
    const rect = box.getBoundingClientRect();
    const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    topPaneId =
      (hit?.closest?.('[data-testid="terminal-keep-alive-pane"]') as HTMLElement | null)?.getAttribute(
        'data-pane-id'
      ) ?? null;
  }

  let buffer = '';
  const term = win.__tmexE2eXterm as
    | { rows: number; buffer: { active: { viewportY: number; getLine: (y: number) => unknown } } }
    | undefined;
  if (term) {
    const active = term.buffer.active;
    for (let y = active.viewportY; y < active.viewportY + term.rows; y += 1) {
      const line = active.getLine(y) as { translateToString?: (t: boolean) => string } | undefined;
      buffer += `${line?.translateToString?.(true) ?? ''}\n`;
    }
  }

  return { route: location.pathname, slots, topPaneId, buffer, hasTerm: Boolean(term) };
}

interface Snapshot {
  route: string;
  slots: Array<Record<string, unknown>>;
  topPaneId: string | null;
  buffer: string;
  hasTerm: boolean;
}

function routedPaneId(route: string): string | null {
  const match = /\/panes\/([^/?#]+)/.exec(route);
  return match ? decodeURIComponent(match[1] as string) : null;
}

function checkSnapshot(snap: Snapshot, target: PaneInfo, panes: PaneInfo[]): string[] {
  const problems: string[] = [];
  const routed = routedPaneId(snap.route);
  if (routed !== target.paneId) return ['route-not-settled'];

  // 多 pane 的 window 走分屏（SplitTerminalArea），本来就没有保活槽：只校验内容
  if (snap.slots.length > 0) {
    const visibleSlot = snap.slots.find((s) => s.dataVisible === 'true');
    if (!visibleSlot) problems.push('no-visible-slot');
    else if (visibleSlot.paneId !== target.paneId) problems.push(`visible-slot=${visibleSlot.paneId}`);

    if (snap.topPaneId !== null && snap.topPaneId !== target.paneId) {
      problems.push(`topmost-slot=${snap.topPaneId}`);
    }
  }

  // 冷启动期间 __tmexE2eXterm 会短暂为空（探针跟随可见实例，实例未就绪时清空）：
  // 这不是「看到旧 pane」，单独归类，别混进 staleness 统计
  if (!snap.hasTerm) problems.push('terminal-booting');
  else if (!snap.buffer.includes(target.marker)) problems.push('buffer-missing-target-marker');
  const strays = panes.filter((p) => p.paneId !== target.paneId && snap.buffer.includes(p.marker));
  if (strays.length > 0) problems.push(`buffer-has=${strays.map((p) => p.marker).join(',')}`);

  return problems;
}

async function main(): Promise<void> {
  console.log(`[repro] label=${cfg.label} dist=${cfg.feDistDir} port=${cfg.port}`);
  const panes = await setupSession();
  if (panes.length !== 5) throw new Error(`期望 5 个 pane，实际 ${panes.length}`);
  console.log(`[repro] panes: ${panes.map((p) => `${p.windowId}/${p.paneId}(${p.marker})`).join(' ')}`);

  await startGateway();
  for (const device of await api.list()) await api.remove(device.id);
  tmuxQuiet('kill-session -t tmex');
  const deviceId = await api.create(`bug-${cfg.label}`, cfg.session);

  const { chromium } = (await import(
    Bun.resolveSync('@playwright/test', `${cfg.gatewaySrcDir}/apps/fe`)
  )) as typeof import('@playwright/test');

  const browser = await chromium.launch({ headless: cfg.headless });
  const page = await browser.newPage({ viewport: cfg.viewport });

  let mismatches = 0;
  let logged = 0;
  const byKind = new Map<string, number>();

  try {
    await page.goto(`http://127.0.0.1:${cfg.port}/devices/${deviceId}`);
    await page.waitForSelector('[data-testid="device-page"]', { timeout: 30_000 });
    await page.waitForFunction(() => Boolean((window as never as Record<string, unknown>).__tmexE2eXterm), null, {
      timeout: 30_000,
    });
    for (const pane of panes) {
      await page.waitForSelector(
        `[data-testid="pane-item-${pane.paneId}"], [data-testid="window-item-${pane.windowId}"]`,
        { timeout: 30_000 }
      );
    }
    await sleep(2000);

    let previous: PaneInfo | null = null;
    for (let i = 0; i < cfg.iterations; i += 1) {
      const candidates = panes.filter((p) => p.paneId !== previous?.paneId);
      const target = candidates[Math.floor(Math.random() * candidates.length)] as PaneInfo;

      const paneRow = page.locator(`[data-testid="pane-item-${target.paneId}"]`);
      const testId =
        (await paneRow.count()) > 0
          ? `pane-item-${target.paneId}`
          : `window-item-${target.windowId}`;
      await page.locator(`[data-testid="${testId}"]`).click();

      const deadline = Date.now() + cfg.assertTimeoutMs;
      let problems: string[] = ['never-checked'];
      let snap: Snapshot | null = null;
      while (Date.now() < deadline) {
        snap = (await page.evaluate(inspect)) as Snapshot;
        problems = checkSnapshot(snap, target, panes);
        if (problems.length === 0) break;
        await sleep(50);
      }

      if (problems.length > 0) {
        mismatches += 1;
        for (const kind of problems) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
        if (logged < cfg.maxLoggedMismatches && snap) {
          logged += 1;
          console.log(`\n[repro][MISMATCH #${mismatches}] iter=${i} target=${target.paneId}(${target.marker})`);
          console.log(`  problems: ${problems.join(' | ')}`);
          console.log(`  route: ${snap.route}`);
          for (const slot of snap.slots) console.log(`  slot ${JSON.stringify(slot)}`);
          console.log(`  topmost-hit-slot: ${snap.topPaneId}`);
          console.log(`  buffer head: ${JSON.stringify(snap.buffer.split('\n').filter(Boolean).slice(0, 3))}`);
        }
      }

      previous = target;
      await sleep(cfg.minGapMs + Math.random() * (cfg.maxGapMs - cfg.minGapMs));
    }
  } finally {
    await browser.close();
    gateway?.kill('SIGTERM');
    tmuxQuiet(`kill-session -t ${cfg.session}`);
  }

  console.log(`\n[repro] ===== ${cfg.label} =====`);
  console.log(`[repro] iterations=${cfg.iterations} mismatches=${mismatches}`);
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`[repro]   ${kind}: ${count}`);
  }
  if (mismatches > 0) process.exitCode = 1;
}

await main();
