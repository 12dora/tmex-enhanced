# OE：ghostty-terminal 四项性能修复结果

任务范围：`packages/ghostty-terminal/src/**`（未触碰 `selection-clipboard.ts` / `terminal-input.ts`，也未改 WASM 二进制与
`scripts/complexity/allowlist.json`）。

## 一、claim 逐条核对

| # | claim | 核对结论 |
| --- | --- | --- |
| 1 | 写入路径重复查模式：`terminal.ts:329-337` 每次 write 先查 alt-screen（1047/1049 最多 2 次）→ writeVt → 再查 alt-screen（最多 2 次）→ 查 2026（1 次），退出 alt-screen 时最多 5 次探测 | 属实 |
| 2 | 悬停/滚轮重复查模式：`terminal-input-bridge.ts:126 routingState()` 最多 7 次（9/1000/1002/1003 + 1047/1049 + 1007）；`terminal-pointer-handlers.ts:106` 每个非拖拽 mousemove 调一次，wheel 亦然（`terminal-input-bridge.ts:274`，上报分支内 `isDuplicateMotion` 再查 1016）。每次查询 = 一次 WASM 导出调用 + `allocU8/freeU8`（`ghostty-wasm.ts:856-867`） | 属实 |
| 3 | 选区自动滚动每 48ms 一拍跑两次全渲染（`terminal-selection.ts:16,223,257-268`），`render` 即 `renderNow`（`terminal.ts:167`）；贴顶/贴底时 `scrollViewportBy` 是空操作但两次全渲染照跑 | 属实 |
| 4 | 悬停抖动滚动条淡出定时器：`terminal-dom.ts:302-317` 每次 mousemove 都重写 opacity + clearTimeout + setTimeout（120Hz 悬停 = 每秒 120 只定时器） | 属实 |

补充审计（决定失效点的完整集合）：全仓（`packages` + `apps`）内会改终端模式的调用只有
`terminal.ts` 的 `writeVt` / `resetTerminal` / `resizeTerminal` 与 bridge 的
`restoreModeSnapshot` / `clearMouseTrackingModes`；`headless.ts` 用的是独立 terminal handle，
ghostty-wasm.ts 内部的模式查询是只读的。ghostty-terminal 之外没有任何 `setTerminalMode` 调用点。

## 二、改动

### 1+2. 按「代」失效的模式缓存（`terminal-input-bridge.ts`、`terminal.ts`）

- `TerminalInputBridge` 新增 `modeCache: Map<number, boolean>` + `modeGeneration`，`isModeEnabled()`
  先查缓存、miss 才打 WASM；`invalidateModeCache()` bump 代号并清表；`modeCacheGeneration` getter 供测试/诊断。
- 查询抛错（旧内核不认 2026）时**不写缓存**，`isSynchronizedOutputActive()` 的
  `syncOutputModeSupported=false` 一次性降级逻辑原样保留，兼容路径不受影响。
- 失效点：`terminal.ts` 的 `write()`（writeVt 之后立即失效）、`reset()`、`resize()`；bridge 的
  `restoreModeSnapshot()`、`clearMouseTrackingModes()`。
- 写路径新语义：写前 alt-screen 读缓存（上一次写入后已填好）→ writeVt → 失效 → 写后的 alt-screen 与 2026
  查询填充新一代缓存。两次写入之间的悬停/滚轮 `routingState()` 全部命中缓存，零 WASM 调用。

### 3. 自动滚动空转不再渲染（`terminal-selection.ts`、`terminal.ts`）

- `SelectionHostContext.scrollViewportBy` 改为返回 `boolean`（视口偏移是否真的变了）；宿主实现比较
  `readScrollbar().offset` 前后值（每拍 2 次 readScrollbar，远比一次全渲染便宜）。
- `stepAutoScroll()` 拆成 `autoScrollDelta()` + `trackAutoScrollFocus()`：只有真滚动了才跑一次全渲染；
  焦点更新改走 `renderSelection()`（即已有的 `scheduleSelectionRepaint`，rAF 合并、复用行模型、不读 WASM），
  且焦点未跨 cell 时连选区层重绘都省掉。
- 顺序契约保留：命中测试仍排在渲染之后，滚动后一定看得到新的视口偏移。`drag.moved` 的置位时机与旧实现一致
  （只要命中到 point 就置 true），松手判 keep/clear 的行为不变。

### 4. 滚动条淡出改 deadline（`terminal-dom.ts`）

- 新增 `scrollbarFadeDeadline` + 私有 `armScrollbarFade(delay)`。`showScrollbarTransient()` 在滚动条已可见且
  定时器在途时**只推后 deadline**，不重写 style、不销毁重建定时器；定时器到点自己比对 deadline，未过则按剩余
  时间续期，过了才隐藏。可见性语义与旧实现完全一致（每次调用都把消失时间推到「现在 + 3000ms」）。
- deadline 用单调时钟（`performance.now()`，无则退回 `Date.now()`），墙钟回拨不会让滚动条提前消失或长期挂着。
- `cancelScrollbarFade()` 连带清零 deadline，失焦路径行为不变。

## 三、决策与取舍

- **缓存粒度用 Map + 代号，而非按模式号逐个记 generation**：模式集合很小（≤ 11 个），整表清空最简单且不会漏。
- **`scrollViewportBy` 用两次 `readScrollbar` 判空操作**，而不是读渲染协调器缓存的 `viewportOffset`：后者在
  「write 已发生、rAF 尚未渲染」的窗口里是陈旧值，会误判成没滚动。20Hz 下两次结构体读取的代价可忽略。
- **没有改 `ghostty-wasm.ts` 内部的模式查询**：`encodeMouseEvent` 每次上报仍会查 ~8 个模式
  （`ghostty-wasm.ts:1308-1366`）。1003 any-event tracking 下每个悬停 motion 都会走到这里，是本包剩余的最大
  模式查询热点。修它要改 bindings 签名（由 bridge 把已缓存的模式标志传进去），超出本次范围，作为后续项记录。
- 未触碰 `selection-clipboard.ts` / `terminal-input.ts`，本次修复也不需要它们。

## 四、验证

- `packages/ghostty-terminal`：`bun test` **211 pass / 0 fail**（基线 202，新增 9 条）。
  - `terminal.canvas.test.ts` 新增 4 条：两次写入之间的 30 次悬停零额外 WASM 模式查询（对 binding 计数）、
    写入 VT 改模式后缓存立即作废、退出 alt-screen 仍清掉鼠标上报模式、resize 与 reset 都会作废缓存。
  - `terminal-selection.drag.test.ts` 新增 2 条：滚不动的一拍 render/renderSelection 均为 0；滚动生效的一拍
    恰好一次全渲染 + 一次选区层重绘。
  - 新增 `terminal-dom.scrollbar.test.ts` 3 条：120 次连续悬停只建 1 只定时器且 0 次 clearTimeout；到点时
    deadline 未过则按剩余时间续期、过了才隐藏；失焦立即隐藏并取消续期。
- `bunx tsc --noEmit -p .`：0 errors。
- `bunx biome check <改动文件>`：clean。（`terminal.canvas.test.ts:2133/2135/2138` 的 3 处
  `noNonNullAssertion` 属既有 `setupTerminal` 代码，非本次改动，未动它。）
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1060 files, 8799 functions)`。
- `packages/terminal-ui`：`bun test` **325 pass / 0 fail**（基线 323；多出的 2 条来自同 worktree 其他 agent 的改动，
  不在本次范围内）。
