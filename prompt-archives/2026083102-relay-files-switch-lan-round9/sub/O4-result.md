# O4：终端光标「疯狂闪烁」根因与修复

工作区：`/Users/konata/code/tmex-enhanced-wt-r9`（未做任何 git 操作）。

## 结论速览

- 根因不是闪烁定时器、也不是焦点/可见性状态分叉，而是**光标层跟着「中间态」渲染帧走**：
  应用一次整屏重绘的字节会分多个 `write()` 到达（tmux `%output` 分片 + websocket 分帧），
  rAF 到点渲染时终端状态可能停在这次重绘的**中途**，此刻的光标位置只是「笔尖刚写完的
  那个字符后面那一格」，不是应用这一帧的最终落点。渲染器把它当成光标画上去，下一帧再挪
  回真正的落点 —— 于是光标块以应用刷新频率（10–30Hz）在两格之间来回跳，正好就是用户描述的
  「`12 s` 的 `s` 后面那一格 / `Thinking` 前面的空格在快速闪」。
- 同一机制的第二种表现：ratatui 类应用每帧 `ESC[?25l … ESC[?25h`，中间态帧读到 DECTCEM=隐藏，
  光标层被**清空一整帧**，下一帧再画回来 —— 视觉上是同频率的「熄灭/点亮」。
- 修复：光标层引入**落定（settled）语义** —— 由输出字节触发的渲染帧不再移动光标层，只把状态
  挂起；渲染协调器在「输出静默的下一帧」把它落笔。非输出触发的帧（主题/尺寸/滚动/
  `forceFullRepaint`）与位图被清空（wiped）的帧一律立刻落笔，首帧、光标刚从隐藏转可见的帧
  也立刻落笔（不会出现光标缺一帧）。
- 实测：20Hz × 2s 的合成 TUI 流下，光标层落笔次数 **78 → 0**（首帧之后再无落笔）；
  每帧 hide/show 的 ratatui 语义下清空/重画次数 **40 → 0**。

## 排查过程（测量，不是猜测）

1. **真实 wasm 探针**确认 `cursor.visible/blinking/x/y` 的来源与语义：
   `visible` 精确跟随 DECTCEM（`ESC[?25l/h`）；`blinking` 只在 DECSCUSR 1/3/5 或 `ESC[?12h`
   时为 true，**默认是 false**——也就是说日常根本没有闪烁定时器在跑，
   「闪烁定时器被输出重置」这条假设（prompt 假设 1/3）在实际数据下不成立。
2. **真实 TUI 字节流采样**（独立 socket `tmux -L tmex-r9-o4` + `pipe-pane`，全程未碰默认 socket
   与生产 tmex）：
   - `top`：完全不发 `?25l/?25h`（4s 输出 838KB）。
   - `claude`（ink）：启动时 `?25l` 一次、`?25h` 一次，之后**不再切换**；SIGWINCH 也不重发。
     即 claude 场景下光标是**真可见**的，它每帧把光标停在渲染完的位置。
   - `codex`（ratatui）：`?25l` + `ESC[?2026h/l`（同步输出）。
   - `grok`：`?1004h`（焦点上报）+ `?25l` + `ESC[6n`。
   结论：ink 类应用的「闪烁格」就是**真实光标**在中间态被采样到的位置。
3. **端到端复现**：用真实 wasm + 真实 `CanvasRenderer` + 真实 `TerminalRenderCoordinator`
   驱动一个可控 rAF 时钟，把一个应用帧拆成两块字节（中间过一次 rAF），跑 40 个应用帧（20Hz×2s）：

   | 场景 | 光标层落笔帧数 | 落笔/清空交替次数 |
   | --- | --- | --- |
   | ink 语义（每帧两段字节） | 80 | 79 |
   | ratatui 语义（每帧 hide/show） | 40 | 80 |
   | 应用已隐藏光标且状态未丢 | 0 | 0 |

   落笔位置在 `(16,0)`（`… (12 s` 的 `s` 后面那一格）与 `(2,1)`（输入行的真实落点）之间交替，
   与用户描述逐字吻合。

## 根因（file:line，修改前的位置）

- `packages/ghostty-terminal/src/terminal.ts:352`（`write()`）：每次写入都 `renderCoordinator.schedule()`，
  渲染帧因此可能落在一次应用重绘的中途。
- `packages/ghostty-terminal/src/terminal-render-coordinator.ts:renderNow()`：把该中间态快照
  （含 `meta.cursor`）原样交给渲染器。
- `packages/ghostty-terminal/src/canvas-renderer.ts:713 `drawCursor()`：无条件按当帧 `meta.cursor`
  擦旧格、画新格；`hideCursor()`（原 784）在读到 DECTCEM=隐藏时把光标层清空，
  下一帧再画回来 —— 输出频率即闪烁频率。

值得注意的是 `write()` 里已有的 DECSET 2026（同步输出）挂起逻辑，注释写的就是同一个问题
（「一次原子重绘的字节可能分多个 write 到达，rAF 到点就画会把中间态刷上屏」）；本次修复把
这条结论推广到**不使用 2026 的应用**上，且只针对最敏感的光标层（内容层的撕裂是各终端共有的、
可接受的行为，强行缓冲会增加输入延迟）。

## 修复内容

### 1. 光标层抽成独立模块并引入落定语义
`packages/ghostty-terminal/src/cursor-layer.ts`（新增）：把光标 canvas 的全部状态
（上次落笔的 cell/矩形/颜色、闪烁定时器、挂起状态）搬进 `CursorLayer`。
- `update(cursor, cssColor, wiped, settled)`：`settled=false` 且屏幕上**已有**一支画好的光标时
  只挂起、不动像素；否则立刻落笔。返回光标离开的旧行（供 `lastDrawnRows` 使用）。
- `commit()`：把挂起状态落笔。
- 顺带把 `canvas-renderer.ts` 从 913 行降到 730 行（改动本身会顶破复杂度门禁的 900 行上限，抽模块解决）。

### 2. 协调器决定「这一帧的光标状态可不可信」
`packages/ghostty-terminal/src/terminal-render-coordinator.ts`
- `scheduleFromOutput()`（:125）：输出触发的渲染，打上「可能是中间态」标记。
- `consumeCursorSettled()`（:299）：非输出触发的帧恒可信；输出触发的帧不落笔，
  并在被压过 `CURSOR_SETTLE_MAX_MS = 250ms`（:37）时兜底放行（防「流永不静默」时光标长期过期；
  正常 10–30Hz TUI 每帧之间有几十毫秒静默，走不到这条兜底）。
- `scheduleCursorSettle()`（:323）：下一帧若仍无新输出就 `renderer.commitCursor()`；
  有新输出则什么都不做（那次 write 已排了新渲染帧，落定判定重来）。rAF 注册顺序保证
  settle 回调永远晚于触发它的渲染帧，不会出现「同一帧内先挂起后立刻提交」。
- `forceFullRepaint()`：显式清掉挂起标记 → 立刻按当刻状态落笔。
- `cancelPending()` / `dispose()` 一并取消 settle 帧。

### 3. 写入路径接线
`packages/ghostty-terminal/src/terminal.ts:346,352`：`write()`（含 DECSET 2026 兜底定时器）
改走 `scheduleFromOutput()`。其余调用点（主题、resize、滚动、reset、refresh、链接层）保持
`schedule()`/`renderNow()`，语义不变 —— 它们本来就是落定状态。

### 4. 拖拽期几何失效的整帧重画
`canvas-renderer.ts:446` `drawSelectionOnly()` 的补画帧显式传 `cursorSettled: true`，
否则新网格下光标会停在旧坐标上。

### 三个入口的覆盖情况
- **初次进入/初次聚焦**：首帧 `lastCursor === null` → 立刻落笔（无延迟）；此后的移动全部走落定路径。
- **失焦 → 重新聚焦**：焦点状态在渲染链路上不参与任何决策（`setFocused` 只影响滚动条），
  修复与焦点无关，因此三种状态下行为一致（见下「残留风险」对用户那条焦点观察的说明）。
- **隐藏 → 可见 / 切 tab 回来**：`terminal-viewport-restore` 走 `forceFullRepaint()` → 立刻落笔；
  若走 resize-sync 路径则由 `resize()` 的 `schedule()`（落定）落笔；tab 隐藏期间积压的
  写入在回来后一帧渲染完，再由 settle 帧落笔。

## 前后对比证据

新增回归测试 `packages/ghostty-terminal/src/canvas-renderer.cursor-settle.test.ts`
（真实 wasm + 真实渲染器 + 可控 rAF，20Hz × 2s）：

```
修复前（临时把 consumeCursorSettled 短路成恒 true 复现）：
  20Hz 重绘 2 秒            期望 <= 1，实际 78 次落笔
  每帧 hide/show            期望 <= 2，实际 40 次清空/重画
修复后：
  4 pass 0 fail（落笔 0 次；落笔位置只可能是应用的最终落点 '2,1'）
```

## 验证

| 项目 | 结果 |
| --- | --- |
| `bun test`（ghostty-terminal） | 220 pass / 0 fail（基线 216，新增 4） |
| `bun test`（terminal-ui） | 337 pass / 0 fail（未改动该包） |
| `bunx tsc --noEmit -p .`（两个包） | 通过 |
| `bunx biome check`（ghostty-terminal/src、terminal-ui/src） | 通过 |
| `bun scripts/complexity/gate.ts` | ok（1119 files, 9380 functions） |

改动文件：
- `packages/ghostty-terminal/src/cursor-layer.ts`（新增）
- `packages/ghostty-terminal/src/canvas-renderer.cursor-settle.test.ts`（新增）
- `packages/ghostty-terminal/src/canvas-renderer.ts`
- `packages/ghostty-terminal/src/terminal-render-coordinator.ts`
- `packages/ghostty-terminal/src/terminal.ts`

`packages/terminal-ui` **未改动**（读过 `Terminal.tsx` / `useTerminalInput` / `useTerminalResize` /
`terminal-viewport-restore` 后确认焦点与可见性接线本身没有问题，无需改动）。

## 残留风险与未覆盖项

1. **用户那条「点输入框失焦就好、切 tab 回来又闪」的观察，在客户端代码里找不到对应机制。**
   `setFocused()` 只关滚动条（`terminal-dom.ts:341`），焦点上报（DECSET 1004）前端根本没实现，
   helper textarea 的 `caret-color` 是 transparent（无原生光标）。最可能的解释是：失焦时页面
   布局变化触发了终端 resize → tmux 让应用整屏重绘，重绘的字节恰好一次到齐，中间态帧消失。
   本修复让光标层不再依赖「字节是否一次到齐」，因此三种状态下都不会再闪 —— 但我没有在真实浏览器里
   复现那条焦点相关的时序（未起 dev server / e2e），这是唯一未被直接验证的环节。
2. **光标移动延迟 +1 帧（≈16ms）**：输入回显后光标要等下一帧静默才移动。人眼不可察，且
   `forceFullRepaint`/resize/滚动路径无延迟。
3. **兜底阈值 250ms**：应用若持续不间断地写（流永不静默），光标最多按 250ms 一次的节奏更新。
   这类流（`cat` 大文件、`yes`）光标本来就钉在底行，不会造成跳动。
4. **DECTCEM 在 `reset()` 里被丢掉（另一个真实缺陷，本次未改，不在本 agent 的改动面内）**：
   `writeCanonicalSnapshot`（terminal-ui）先 `terminal.reset()` 再回放 capture-pane 文本，
   而 `resetTerminal` 会把 DECTCEM 恢复成「可见」，capture 文本里又没有 `?25l`。已实测确认：
   写 `?25l` 后 `resetTerminal` → `isTerminalModeEnabled(t, 25)` 回到 `true`。
   于是 ink/ratatui 这类启动时隐藏光标的应用，在首屏/切 tab 回来重放快照后会多出一支**幻影光标**。
   修复后它不再闪（会稳定停在应用的最终落点），但依然是多余的。
   真正的修法需要权威来源：tmux 有 `#{cursor_flag}`，应由 gateway 随 canonical 快照的 modes 位图
   下发（`packages/shared/src/ws-borsh/pane-modes.ts` 加一位），前端在 `restoreModeSnapshot` 里恢复。
   **不建议只在客户端「让 `reset()` 保留 DECTCEM」**：同一个终端控制器会跨 pane 复用
   （`useTerminalBootSurface` 的 boot effect 不以 paneId 为依赖），会把上一个 pane 的「隐藏」
   泄漏给新 pane，导致 shell 里光标消失 —— 比幻影光标更糟。建议作为独立任务交给 gateway 侧。
5. 未跑 Playwright e2e（按约束，非必要不起 dev server / e2e）；ghostty-terminal 与 terminal-ui
   的单测基线均保持全绿。
