#!/usr/bin/env bun
/**
 * M1：终端 pane 切换延迟的可重复测量脚本。
 *
 * 做的事：
 *   1. 在**独立 tmux socket**（默认 tmex-r9-perf）上建一个 2 window / 3 pane 的会话，
 *      每个 pane 用带唯一标记的 PS1（MK_<nonce>_<i>）+ 若干填充行做种子；
 *   2. 从 GATEWAY_SRC_DIR 起一个 NODE_ENV=test 的临时 tmex runtime
 *      （packages/app/src/runtime/server.ts，静态资源指向 FE_DIST_DIR）；
 *   3. 用 Playwright(chromium) 打开设备页，反复点击侧栏 pane/window 行做切换，
 *      在页面内用 rAF 循环 + WebSocket 包装器采集时间戳；
 *   4. 输出每次切换的原始行到 CSV，并打印各区间的 median / p90。
 *
 * 测量口径（全部相对 t0；t0 = 页面内 capture 阶段收到目标侧栏行的 click 事件那一刻）：
 *   ph_gone        终端 boot placeholder 消失（若整轮未出现则记 0，ph_appeared=0）
 *   route          location.pathname 变成目标 pane 路由
 *   remount        __tmexE2eXterm 换成了另一个终端实例（0 表示没换 = 复用）
 *   first_content  首个 rAF 帧：可见 buffer 含目标 pane 标记且不含其它 pane 标记
 *                  （canvas 存在且有尺寸；不做像素级 readback，见 README 说明）
 *   switch_ack     收到 SWITCH_ACK(0x0401) 且 paneId == 目标
 *   history        收到 TERM_HISTORY(0x0306) 且 paneId == 目标
 *   live_resume    收到 LIVE_RESUME(0x0402) 且 paneId == 目标
 *   first_output   切换后第一帧 TERM_OUTPUT(0x0305) 且 paneId == 目标
 *   live           点击后立刻向目标 pane send-keys `echo LIVE_<n>`，该文本首次出现在可见 buffer
 *   live_after_keys  live 减去 send-keys 实际发出的时刻（更贴近“实时输出往返”）
 *   want_history   出向 TMUX_SELECT(0x0201) 帧里的 wantHistory 标志（同窗 FOCUS_PANE 路径为空）
 *   keepalive_panes 切换刚结束时 [data-testid="terminal-keep-alive-pane"] 的元素个数（基线恒为 0）
 *
 * 用法见同目录 README.md。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ───────────────────────── 配置 ─────────────────────────

const SCRATCH = '/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad';

const cfg = {
  label: process.env.LABEL ?? 'baseline',
  gatewaySrcDir: resolve(process.env.GATEWAY_SRC_DIR ?? `${SCRATCH}/src-base`),
  feDistDir: resolve(process.env.FE_DIST_DIR ?? `${SCRATCH}/fe-dist-base`),
  port: Number(process.env.PORT ?? 19765),
  /** 每一类切换（cross / same）的总次数；前 WARMUP 次丢弃 */
  runs: Number(process.env.RUNS ?? 16),
  warmup: Number(process.env.WARMUP ?? 2),
  /** single 场景的 pool 有 3 个 window，至少预热 3 次才算全热 */
  singleWarmup: Number(process.env.SINGLE_WARMUP ?? 3),
  tmuxSocket: process.env.TMUX_SOCKET ?? 'tmex-r9-perf',
  session: process.env.SESSION ?? 'm1perf',
  seedLines: Number(process.env.SEED_LINES ?? 300),
  settleMs: Number(process.env.SETTLE_MS ?? 500),
  switchTimeoutMs: Number(process.env.SWITCH_TIMEOUT_MS ?? 20_000),
  lingerMs: Number(process.env.LINGER_MS ?? 700),
  headless: process.env.HEADLESS !== '0',
  viewport: {
    width: Number(process.env.VIEWPORT_W ?? 1440),
    height: Number(process.env.VIEWPORT_H ?? 900),
  },
  out: resolve(
    process.env.OUT ?? `${dirname(Bun.fileURLToPath(import.meta.url))}/${process.env.LABEL ?? 'baseline'}.csv`
  ),
  dbPath: process.env.DB_PATH ?? `${SCRATCH}/measure/m1-${process.env.LABEL ?? 'baseline'}.db`,
  gatewayLog: process.env.GATEWAY_LOG ?? `${SCRATCH}/measure/gw-${process.env.LABEL ?? 'baseline'}.log`,
};

// ───────────────────────── 安全护栏 ─────────────────────────
// 绝不允许打到生产 tmex（9883 / 9663）或默认 tmux socket / 生产 tmex 会话。

if ([9883, 9663, 19883].includes(cfg.port)) {
  throw new Error(`[m1] 拒绝使用端口 ${cfg.port}：与生产/开发实例冲突`);
}
if (!cfg.tmuxSocket || cfg.tmuxSocket === 'default' || cfg.tmuxSocket === 'tmex') {
  throw new Error(`[m1] 拒绝使用 tmux socket "${cfg.tmuxSocket}"：必须是专用 socket`);
}
if (cfg.session === 'tmex') {
  throw new Error('[m1] 拒绝使用名为 tmex 的会话名');
}
if (!existsSync(cfg.feDistDir) || !existsSync(`${cfg.feDistDir}/index.html`)) {
  throw new Error(`[m1] FE_DIST_DIR 不是有效的前端产物目录：${cfg.feDistDir}`);
}
if (!existsSync(`${cfg.gatewaySrcDir}/packages/app/src/runtime/server.ts`)) {
  throw new Error(`[m1] GATEWAY_SRC_DIR 不是 tmex 仓库根：${cfg.gatewaySrcDir}`);
}

// ───────────────────────── 小工具 ─────────────────────────

function tmux(args: string): string {
  const res = spawnSync('tmux', ['-L', cfg.tmuxSocket, ...splitArgs(args)], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`tmux ${args} failed: ${res.stderr?.trim()}`);
  }
  return (res.stdout ?? '').trim();
}

function tmuxQuiet(args: string): void {
  spawnSync('tmux', ['-L', cfg.tmuxSocket, ...splitArgs(args)], { encoding: 'utf8' });
}

/** 极简的 shell 风格分词：只处理单引号包裹（本文件全部调用都在此范围内） */
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function quantile(values: number[], q: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return Number.NaN;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo] as number;
  return (xs[lo] as number) + ((xs[hi] as number) - (xs[lo] as number)) * (pos - lo);
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : 'n/a';
}

// ───────────────────────── tmux 会话 ─────────────────────────

const SEED_SCRIPT = `${SCRATCH}/measure/seed-lines.sh`;
const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
const markerOf = (i: number): string => `MK${nonce}P${i}`;

interface PaneInfo {
  windowId: string;
  paneId: string;
  index: number;
  marker: string;
}

async function setupSession(): Promise<PaneInfo[]> {
  tmuxQuiet(`kill-session -t ${cfg.session}`);
  tmux(`new-session -d -s ${cfg.session} -n w0 -x 200 -y 50 sh`);
  tmux(`split-window -h -t ${cfg.session}:0 sh`);
  // w1/w2/w3 各一个 pane：single 场景专用（路由窗口只有一个 pane 时才会走 keep-alive 路径）
  tmux(`new-window -t ${cfg.session} -n w1 sh`);
  tmux(`new-window -t ${cfg.session} -n w2 sh`);
  tmux(`new-window -t ${cfg.session} -n w3 sh`);
  tmux(`select-window -t ${cfg.session}:0`);

  const rows = tmux(`list-panes -s -t ${cfg.session} -F #{window_id}\t#{pane_id}`)
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length === 2);

  const panes: PaneInfo[] = rows.map((parts, index) => ({
    windowId: parts[0] as string,
    paneId: parts[1] as string,
    index,
    marker: markerOf(index),
  }));

  // 每个 pane：唯一 PS1（标记进提示符，永远不会滚出屏幕）+ 宽填充行
  // （让 TERM_HISTORY 的体量贴近真实终端：满屏 120 列文本，而非几十字节的稀疏屏）
  mkdirSync(dirname(SEED_SCRIPT), { recursive: true });
  writeFileSync(
    SEED_SCRIPT,
    `#!/bin/sh\ni=1\nwhile [ $i -le ${cfg.seedLines} ]; do\n  printf '%04d  abcdefghijklmnopqrstuvwxyz0123456789 abcdefghijklmnopqrstuvwxyz0123456789 abcdefghijklmnopqrstuvwxyz\\n' $i\n  i=$((i+1))\ndone\n`
  );
  await sleep(800);
  for (const pane of panes) {
    tmux(`send-keys -t ${pane.paneId} PS1=${pane.marker}: Enter`);
  }
  await sleep(400);
  return panes;
}

/** 页面已把 pane resize 到真实视口尺寸之后再灌填充行，保证 TERM_HISTORY 是一屏满字符 */
async function seedPaneContent(panes: PaneInfo[]): Promise<void> {
  for (const pane of panes) {
    tmux(`send-keys -t ${pane.paneId} 'sh ${SEED_SCRIPT}' Enter`);
  }
  await sleep(2000);
  logCaptureSizes('after-seed');
}

/** 诊断：打印各 pane 当前尺寸与 capture-pane 字节数（TERM_HISTORY 的上游体量） */
function logCaptureSizes(tag: string): void {
  if (process.env.DEBUG_CAPTURE !== '1') return;
  const info = tmux(`list-panes -s -t ${cfg.session} -F #{pane_id}=#{pane_width}x#{pane_height}`)
    .split(/\r?\n/)
    .map((line) => {
      const paneId = line.split('=')[0] as string;
      const bytes = spawnSync('tmux', ['-L', cfg.tmuxSocket, 'capture-pane', '-p', '-e', '-J', '-N', '-t', paneId], { encoding: 'utf8' }).stdout?.length ?? 0;
      return `${line}/${bytes}B`;
    });
  console.log(`[m1][capture:${tag}] ${info.join('  ')}`);
}

// ───────────────────────── gateway ─────────────────────────

let gateway: Bun.Subprocess | null = null;

async function startGateway(): Promise<void> {
  rmSync(cfg.dbPath, { force: true });
  rmSync(`${cfg.dbPath}-wal`, { force: true });
  rmSync(`${cfg.dbPath}-shm`, { force: true });
  mkdirSync(dirname(cfg.dbPath), { recursive: true });

  const logFile = Bun.file(cfg.gatewayLog);
  gateway = Bun.spawn(
    [process.execPath, `${cfg.gatewaySrcDir}/packages/app/src/runtime/server.ts`],
    {
      cwd: cfg.gatewaySrcDir,
      // 显式白名单 env：不继承 shell 里可能来自安装版 app.env 的毒变量
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
      stdout: logFile,
      stderr: logFile,
    }
  );

  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`);
      const body = (await res.json()) as { env?: string };
      if (body.env === 'test') return;
      throw new Error(`[m1] 拒绝继续：healthz env=${body.env}，不是 test 实例`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[m1]')) throw error;
      await sleep(250);
    }
  }
  throw new Error('[m1] gateway 启动超时');
}

function stopGateway(): void {
  gateway?.kill('SIGTERM');
}

const api = {
  async list(): Promise<Array<{ id: string; session: string }>> {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/devices`);
    return ((await res.json()) as { devices: Array<{ id: string; session: string }> }).devices;
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
    const body = (await res.json()) as { device: { id: string } };
    return body.device.id;
  },
};

// ───────────────────────── 页面内探针 ─────────────────────────
// 注意：这段函数体会被序列化注入页面，不能引用外部作用域。

function pageProbe(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__m1) return;

  interface Frame {
    kind: number;
    dir: 'in' | 'out';
    paneId: string | null;
    originalKind: number | null;
    /** 仅 TMUX_SELECT(0x0201) 出向帧：本次 select 是否要求 gateway 回放 history */
    wantHistory: boolean | null;
    bytes: number;
    t: number;
  }
  interface State {
    frames: Frame[];
    timeOrigin: number;
    armedTestId: string | null;
    t0: number | null;
    target: string;
    others: string[];
    liveMarker: string | null;
    targetPaneId: string;
    lastTerm: unknown;
    out: Record<string, number | boolean | null>;
    done: boolean;
  }

  const state: State = {
    frames: [],
    timeOrigin: performance.timeOrigin,
    armedTestId: null,
    t0: null,
    target: '',
    others: [],
    liveMarker: null,
    targetPaneId: '',
    lastTerm: null,
    out: {},
    done: false,
  };

  // ── WebSocket 帧时间戳 ──
  const decoder = new TextDecoder();
  function readStr(p: Uint8Array, dv: DataView, off: number): [string, number] {
    const len = dv.getUint32(off, true);
    const text = decoder.decode(p.subarray(off + 4, off + 4 + len));
    return [text, off + 4 + len];
  }
  function readOptStr(p: Uint8Array, dv: DataView, off: number): [string | null, number] {
    const disc = p[off] ?? 0;
    if (disc === 0) return [null, off + 1];
    return readStr(p, dv, off + 1);
  }
  function parseFrame(buf: ArrayBuffer, dir: 'in' | 'out'): Frame | null {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 16 || bytes[0] !== 0x54 || bytes[1] !== 0x58) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = dv.getUint16(4, true);
    const plen = dv.getUint32(12, true);
    const p = bytes.subarray(16, 16 + plen);
    const pdv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    let paneId: string | null = null;
    let originalKind: number | null = null;
    let wantHistory: boolean | null = null;
    try {
      if (kind === 0x0201) {
        // TMUX_SELECT（出向）: deviceId, Option<windowId>, Option<paneId>, token[16], wantHistory
        let off = 0;
        [, off] = readStr(p, pdv, off);
        [, off] = readOptStr(p, pdv, off);
        [paneId, off] = readOptStr(p, pdv, off);
        off += 16;
        wantHistory = (p[off] ?? 0) !== 0;
      } else if (kind === 0x0212) {
        // TMUX_FOCUS_PANE（出向，轻量路径）: deviceId, windowId, paneId
        let off = 0;
        [, off] = readStr(p, pdv, off);
        [, off] = readStr(p, pdv, off);
        [paneId] = readStr(p, pdv, off);
      } else if (kind === 0x0401) {
        // SWITCH_ACK: deviceId, windowId, paneId, token
        let off = 0;
        [, off] = readStr(p, pdv, off);
        [, off] = readStr(p, pdv, off);
        [paneId] = readStr(p, pdv, off);
      } else if (kind === 0x0402 || kind === 0x0306 || kind === 0x0305) {
        // LIVE_RESUME / TERM_HISTORY / TERM_OUTPUT: deviceId, paneId, ...
        let off = 0;
        [, off] = readStr(p, pdv, off);
        [paneId] = readStr(p, pdv, off);
      } else if (kind === 0x0501) {
        // CHUNK: chunkStreamId u32, originalKind u16, ...
        originalKind = pdv.getUint16(4, true);
      }
    } catch {
      /* 解析失败只丢 paneId，时间戳仍然有效 */
    }
    return { kind, dir, paneId, originalKind, wantHistory, bytes: plen, t: performance.now() };
  }

  const NativeWebSocket = window.WebSocket;
  class InstrumentedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url as string, protocols as string[]);
      let isGateway = false;
      try {
        isGateway = new URL(String(url), location.href).pathname.endsWith('/ws');
      } catch {
        isGateway = false;
      }
      if (!isGateway) return;
      this.addEventListener('message', (event: MessageEvent) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const frame = parseFrame(event.data, 'in');
        if (!frame) return;
        if (state.frames.length < 200_000) state.frames.push(frame);
      });
      this.__m1Instrumented = true;
    }

    __m1Instrumented = false;

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.__m1Instrumented) {
        let buffer: ArrayBuffer | null = null;
        if (data instanceof ArrayBuffer) buffer = data;
        else if (ArrayBuffer.isView(data)) {
          buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        }
        if (buffer) {
          const frame = parseFrame(buffer, 'out');
          if (frame && state.frames.length < 200_000) state.frames.push(frame);
        }
      }
      super.send(data as ArrayBufferLike);
    }
  }
  window.WebSocket = InstrumentedWebSocket as unknown as typeof WebSocket;

  const liveProbe: { marker: string | null; t0: number | null; seen: number | null } = {
    marker: null,
    t0: null,
    seen: null,
  };

  // ── 可见 buffer 文本 ──
  function visibleText(): string | null {
    const term = (g.__tmexE2eXterm ?? null) as {
      rows: number;
      buffer: { active: { baseY: number; getLine: (y: number) => { translateToString: (t: boolean) => string } | undefined } };
    } | null;
    if (!term) return null;
    const buffer = term.buffer.active;
    const start = buffer.baseY;
    let text = '';
    for (let y = start; y < start + term.rows; y += 1) {
      const line = buffer.getLine(y);
      if (line) text += `${line.translateToString(true)}\n`;
    }
    return text;
  }

  function canvasReady(): boolean {
    const canvas = document.querySelector('.xterm canvas') as HTMLCanvasElement | null;
    return Boolean(canvas && canvas.width > 0 && canvas.height > 0 && canvas.clientWidth > 0);
  }

  function tick(): void {
    const t0 = state.t0;
    if (t0 === null) return;
    const now = performance.now();
    const out = state.out;

    const placeholder = document.querySelector('[data-testid="terminal-boot-placeholder"]');
    if (placeholder) {
      out.ph_appeared = true;
      if (out.ph_seen_ms == null) out.ph_seen_ms = now - t0;
    } else if (out.ph_appeared === true && out.ph_gone_ms == null) {
      out.ph_gone_ms = now - t0;
    }

    if (out.route_ms == null && location.pathname.includes(encodeURIComponent(state.targetPaneId))) {
      out.route_ms = now - t0;
    }

    const term = g.__tmexE2eXterm ?? null;
    if (out.remount_ms == null && term && term !== state.lastTerm) {
      out.remount_ms = now - t0;
    }

    const text = visibleText();
    if (text) {
      if (
        out.first_content_ms == null &&
        canvasReady() &&
        text.includes(state.target) &&
        !state.others.some((marker) => text.includes(marker))
      ) {
        out.first_content_ms = now - t0;
      }
      if (out.live_ms == null && state.liveMarker && text.includes(state.liveMarker)) {
        out.live_ms = now - t0;
      }
    }

    const contentDone = out.first_content_ms != null;
    const liveDone = !state.liveMarker || out.live_ms != null;
    if (contentDone && liveDone) {
      // 再多跑两帧，等 placeholder 状态收敛
      if ((out._settle as number | undefined) === undefined) out._settle = 2;
      else out._settle = (out._settle as number) - 1;
      if ((out._settle as number) <= 0) {
        out.keepalive_panes = document.querySelectorAll(
          '[data-testid="terminal-keep-alive-pane"]'
        ).length;
        state.done = true;
        return;
      }
    }
    if (now - t0 > 25_000) {
      out.timeout = true;
      state.done = true;
      return;
    }
    requestAnimationFrame(tick);
  }

  document.addEventListener(
    'click',
    (event) => {
      if (!state.armedTestId) return;
      const el = event.target as Element | null;
      if (!el?.closest?.(`[data-testid="${state.armedTestId}"]`)) return;
      state.armedTestId = null;
      state.t0 = performance.now();
      state.lastTerm = g.__tmexE2eXterm ?? null;
      requestAnimationFrame(tick);
    },
    true
  );

  g.__m1 = {
    arm(args: {
      testId: string;
      target: string;
      others: string[];
      liveMarker: string | null;
      targetPaneId: string;
    }): number {
      state.armedTestId = args.testId;
      state.target = args.target;
      state.others = args.others;
      state.liveMarker = args.liveMarker;
      state.targetPaneId = args.targetPaneId;
      state.t0 = null;
      state.done = false;
      state.out = {};
      state.frames.length = 0;
      return performance.timeOrigin;
    },
    armLive(marker: string): number {
      liveProbe.marker = marker;
      liveProbe.seen = null;
      liveProbe.t0 = performance.now();
      const step = (): void => {
        if (liveProbe.marker !== marker) return;
        const text = visibleText();
        if (text && text.includes(marker)) {
          liveProbe.seen = performance.now();
          return;
        }
        if (performance.now() - (liveProbe.t0 as number) > 15_000) return;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return state.timeOrigin + liveProbe.t0;
    },
    pollLive(): number | null {
      return liveProbe.seen == null ? null : state.timeOrigin + liveProbe.seen;
    },
    poll(): Record<string, unknown> | null {
      if (state.t0 === null) return null;
      if (!state.done) return null;
      const t0 = state.t0;
      const rel = (t: number): number => t - t0;
      const pick = (kind: number, paneOnly: boolean): number | null => {
        const frame = state.frames.find(
          (f) =>
            f.dir === 'in' &&
            f.kind === kind &&
            f.t >= t0 &&
            (!paneOnly || f.paneId === state.targetPaneId)
        );
        return frame ? rel(frame.t) : null;
      };
      const historyFrame = state.frames.find(
        (f) => f.dir === 'in' && f.kind === 0x0306 && f.t >= t0 && f.paneId === state.targetPaneId
      );
      const chunkFrames = state.frames.filter(
        (f) => f.dir === 'in' && f.kind === 0x0501 && f.t >= t0
      );
      return {
        ...state.out,
        t0_epoch: state.timeOrigin + t0,
        switch_ack_ms: pick(0x0401, true),
        history_ms: pick(0x0306, true),
        history_bytes: historyFrame ? historyFrame.bytes : null,
        live_resume_ms: pick(0x0402, true),
        first_output_ms: pick(0x0305, true),
        chunk_frames: chunkFrames.length,
        chunk_first_ms: chunkFrames.length > 0 ? rel((chunkFrames[0] as Frame).t) : null,
        chunk_last_ms:
          chunkFrames.length > 0 ? rel((chunkFrames[chunkFrames.length - 1] as Frame).t) : null,
        ws_frames: state.frames.filter((f) => f.t >= t0).length,
        want_history: (() => {
          const select = state.frames.find(
            (f) =>
              f.dir === 'out' &&
              f.kind === 0x0201 &&
              f.t >= t0 &&
              f.paneId === state.targetPaneId
          );
          return select ? (select.wantHistory ? 1 : 0) : null;
        })(),
      };
    },
  };
}

// ───────────────────────── 主流程 ─────────────────────────

type PlanKind = 'cross' | 'same' | 'single';

interface Row {
  label: string;
  idx: number;
  kind: PlanKind;
  from: string;
  to: string;
  warmup: boolean;
  keys_at_ms: number | null;
  [key: string]: unknown;
}

const CSV_COLUMNS = [
  'label',
  'idx',
  'kind',
  'from',
  'to',
  'warmup',
  'ph_appeared',
  'ph_seen_ms',
  'ph_gone_ms',
  'route_ms',
  'remounted',
  'remount_ms',
  'first_content_ms',
  'switch_ack_ms',
  'history_ms',
  'history_bytes',
  'live_resume_ms',
  'first_output_ms',
  'chunk_frames',
  'chunk_first_ms',
  'chunk_last_ms',
  'ws_frames',
  'want_history',
  'keepalive_panes',
  'keys_at_ms',
  'live_ms',
  'live_after_keys_ms',
  'post_live_after_keys_ms',
  'timeout',
] as const;

async function main(): Promise<void> {
  console.log(`[m1] label=${cfg.label} src=${cfg.gatewaySrcDir}`);
  console.log(`[m1] dist=${cfg.feDistDir} port=${cfg.port} socket=${cfg.tmuxSocket}`);

  const panes = await setupSession();
  console.log(`[m1] panes: ${panes.map((p) => `${p.windowId}/${p.paneId}(${p.marker})`).join(' ')}`);
  if (panes.length !== 5) throw new Error(`[m1] 期望 5 个 pane，实际 ${panes.length}`);

  await startGateway();
  console.log('[m1] gateway ready');

  // 清掉新库自动播种的默认设备（session=tmex），避免侧栏出现无关设备
  for (const device of await api.list()) {
    await api.remove(device.id);
  }
  tmuxQuiet('kill-session -t tmex');

  const deviceId = await api.create(`m1-${cfg.label}`, cfg.session);
  console.log(`[m1] device=${deviceId}`);

  const { chromium } = (await import(
    Bun.resolveSync('@playwright/test', `${cfg.gatewaySrcDir}/apps/fe`)
  )) as typeof import('@playwright/test');

  const browser = await chromium.launch({ headless: cfg.headless });
  const page = await browser.newPage({ viewport: cfg.viewport });
  await page.addInitScript(pageProbe);

  const rows: Row[] = [];
  try {
    await page.goto(`http://127.0.0.1:${cfg.port}/devices/${deviceId}`);
    await page.waitForSelector('[data-testid="device-page"]', { timeout: 30_000 });
    await page.waitForFunction(() => Boolean((window as never as Record<string, unknown>).__tmexE2eXterm), null, {
      timeout: 30_000,
    });
    for (const pane of panes) {
      await page.waitForSelector(`[data-testid="pane-item-${pane.paneId}"], [data-testid="window-item-${pane.windowId}"]`, {
        timeout: 30_000,
      });
    }
    await sleep(1500);
    await seedPaneContent(panes);

    // 顺序：cross = 每次都跨 window（用满 3 个 pane）；same = 同 window 内切 pane
    const [p0, p1, p2, p3, p4] = panes as [PaneInfo, PaneInfo, PaneInfo, PaneInfo, PaneInfo];

    const plans: Array<{ kind: PlanKind; cycle: PaneInfo[]; warmup: number }> = [
      // cross：w0(2 pane，走分屏视图) ↔ w1，每一步都跨 window
      { kind: 'cross', cycle: [p0, p2, p1, p2], warmup: cfg.warmup },
      // same：同一个 window 内切 pane，走轻量 FOCUS_PANE
      { kind: 'same', cycle: [p0, p1], warmup: cfg.warmup },
      // single：三个「单 pane window」轮转，这才是 keep-alive 路径覆盖到的场景
      { kind: 'single', cycle: [p2, p3, p4], warmup: cfg.singleWarmup },
    ];

    let liveSeq = 0;
    for (const plan of plans) {
      // 归位到序列的起点（不计入统计）
      await doSwitch(page, panes, plan.cycle[0] as PaneInfo, null, -1);
      await sleep(cfg.settleMs);
      logCaptureSizes(`after-home-${plan.kind}`);

      for (let i = 0; i < cfg.runs; i += 1) {
        const from = plan.cycle[i % plan.cycle.length] as PaneInfo;
        const to = plan.cycle[(i + 1) % plan.cycle.length] as PaneInfo;
        liveSeq += 1;
        const result = await doSwitch(page, panes, to, `LIVE${nonce}N${liveSeq}`, i);
        rows.push({
          label: cfg.label,
          idx: i,
          kind: plan.kind,
          from: from.paneId,
          to: to.paneId,
          warmup: i < plan.warmup,
          ...result,
        } as Row);
        await sleep(cfg.settleMs);
        process.stdout.write(
          `\r[m1] ${plan.kind} ${i + 1}/${cfg.runs} content=${fmt(result.first_content_ms as number)}ms live=${fmt(result.live_ms as number)}ms      `
        );
      }
      process.stdout.write('\n');
    }
  } finally {
    await browser.close().catch(() => {});
  }

  writeCsv(rows);
  report(rows);
}

async function doSwitch(
  page: import('@playwright/test').Page,
  panes: PaneInfo[],
  to: PaneInfo,
  liveMarker: string | null,
  idx: number
): Promise<Record<string, unknown>> {
  // 单 pane 的 window 只渲染 window 行；多 pane 的 window 每个 pane 有 pane 行
  const paneRow = page.locator(`[data-testid="pane-item-${to.paneId}"]`);
  const useePaneRow = (await paneRow.count()) > 0;
  const testId = useePaneRow ? `pane-item-${to.paneId}` : `window-item-${to.windowId}`;
  const locator = page.locator(`[data-testid="${testId}"]`);

  const others = panes.filter((p) => p.paneId !== to.paneId).map((p) => p.marker);
  await page.evaluate(
    (args) => (globalThis as never as { __m1: { arm: (a: unknown) => number } }).__m1.arm(args),
    { testId, target: to.marker, others, liveMarker, targetPaneId: to.paneId }
  );

  await locator.click();

  let keysAt: number | null = null;
  if (liveMarker) {
    tmux(`send-keys -t ${to.paneId} 'echo ${liveMarker}' Enter`);
    // tmux send-keys 是同步的：返回时按键已投递，取返回时刻作为“按键送达”的保守上界
    keysAt = Date.now();
  }

  const deadline = Date.now() + cfg.switchTimeoutMs;
  let result: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    result = (await page.evaluate(() =>
      (globalThis as never as { __m1: { poll: () => unknown } }).__m1.poll()
    )) as Record<string, unknown> | null;
    if (result) break;
    await sleep(20);
  }
  if (!result) {
    if (idx < 0) return {};
    throw new Error(`[m1] 切换到 ${to.paneId} 超时（idx=${idx}）`);
  }

  // 屏障后半段（LIVE_RESUME / 首个 TERM_OUTPUT）可能晚于「首帧内容」到达，
  // 停一会儿再重新读一次帧表，避免把它们统计成 n/a。
  await sleep(cfg.lingerMs);
  result = (await page.evaluate(() =>
    (globalThis as never as { __m1: { poll: () => unknown } }).__m1.poll()
  )) as Record<string, unknown>;

  // 切换稳定后再打一次实时输出：cross 场景里第一发 LIVE 往往被 tmux capture 卷进
  // TERM_HISTORY，量不到「实时通道恢复后」的往返；这一发才是稳态 live 延迟。
  let postLive: number | null = null;
  if (liveMarker) {
    const postMarker = `${liveMarker}B`;
    await page.evaluate(
      (m) => (globalThis as never as { __m1: { armLive: (x: string) => number } }).__m1.armLive(m),
      postMarker
    );
    tmux(`send-keys -t ${to.paneId} 'echo ${postMarker}' Enter`);
    const postKeysAt = Date.now();
    const postDeadline = Date.now() + 10_000;
    while (Date.now() < postDeadline) {
      const seen = (await page.evaluate(() =>
        (globalThis as never as { __m1: { pollLive: () => number | null } }).__m1.pollLive()
      )) as number | null;
      if (seen != null) {
        postLive = Math.round((seen - postKeysAt) * 10) / 10;
        break;
      }
      await sleep(10);
    }
  }

  const t0Epoch = Number(result.t0_epoch);
  const liveAfterKeys =
    keysAt != null && result.live_ms != null ? Number(result.live_ms) - (keysAt - t0Epoch) : null;

  return {
    ...result,
    ph_appeared: result.ph_appeared === true ? 1 : 0,
    ph_gone_ms: result.ph_appeared === true ? (result.ph_gone_ms ?? null) : 0,
    remounted: result.remount_ms == null ? 0 : 1,
    remount_ms: result.remount_ms ?? null,
    keys_at_ms: keysAt == null ? null : Math.round((keysAt - t0Epoch) * 10) / 10,
    live_after_keys_ms: liveAfterKeys == null ? null : Math.round(liveAfterKeys * 10) / 10,
    post_live_after_keys_ms: postLive,
    timeout: result.timeout === true ? 1 : 0,
  };
}

function writeCsv(rows: Row[]): void {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => {
      const value = (row as Record<string, unknown>)[col];
      if (value === null || value === undefined) return '';
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '';
      return String(value);
    }).join(',')
  );
  mkdirSync(dirname(cfg.out), { recursive: true });
  writeFileSync(cfg.out, `${header}\n${lines.join('\n')}\n`);
  console.log(`[m1] CSV -> ${cfg.out} (${rows.length} rows)`);
}

const REPORTED = [
  ['ph_gone_ms', 'placeholder 消失'],
  ['route_ms', '路由切到目标 pane'],
  ['remount_ms', '终端实例重挂载'],
  ['first_content_ms', '首帧目标内容'],
  ['switch_ack_ms', 'SWITCH_ACK 到达'],
  ['history_ms', 'TERM_HISTORY 到达'],
  ['live_resume_ms', 'LIVE_RESUME 到达'],
  ['first_output_ms', '首个 TERM_OUTPUT'],
  ['live_ms', 'LIVE 标记可见'],
  ['live_after_keys_ms', 'LIVE 标记可见（自按键发出起）'],
  ['post_live_after_keys_ms', '稳态实时输出往返（切换完成后再打一发）'],
] as const;

function report(rows: Row[]): void {
  for (const kind of ['cross', 'same', 'single'] as const) {
    const sample = rows.filter((r) => r.kind === kind && !r.warmup);
    if (sample.length === 0) continue;
    const dropped = rows.filter((r) => r.kind === kind && r.warmup).length;
    console.log(`\n=== ${cfg.label} / ${kind}（n=${sample.length}，已丢弃前 ${dropped} 次）===`);
    console.log('interval                          | median |    p90 |  n');
    console.log('----------------------------------|--------|--------|---');
    for (const [col, name] of REPORTED) {
      const values = sample
        .map((r) => (r as Record<string, unknown>)[col])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const label = `${col} (${name})`.padEnd(33).slice(0, 33);
      console.log(
        `${label} | ${fmt(quantile(values, 0.5)).padStart(6)} | ${fmt(quantile(values, 0.9)).padStart(6)} | ${String(values.length).padStart(2)}`
      );
    }
    const wantHistory = sample.map((r) => (r as Record<string, unknown>).want_history);
    console.log(
      `want_history: 1×${wantHistory.filter((v) => v === 1).length} 0×${wantHistory.filter((v) => v === 0).length} n/a×${wantHistory.filter((v) => v == null).length}` +
        `  |  keepalive_panes median: ${quantile(sample.map((r) => Number((r as Record<string, unknown>).keepalive_panes ?? 0)), 0.5)}` +
        `  |  placeholder 出现: ${sample.filter((r) => (r as Record<string, unknown>).ph_appeared === 1).length}/${sample.length}` +
        `  |  remounted: ${sample.filter((r) => (r as Record<string, unknown>).remounted === 1).length}/${sample.length}`
    );
    const historyBytes = sample
      .map((r) => (r as Record<string, unknown>).history_bytes)
      .filter((v): v is number => typeof v === 'number');
    if (historyBytes.length > 0) {
      console.log(`history_bytes median: ${quantile(historyBytes, 0.5)}`);
    }
  }
}

try {
  await main();
} finally {
  stopGateway();
  if (process.env.KEEP_SESSION !== '1') {
    tmuxQuiet(`kill-session -t ${cfg.session}`);
  }
}
