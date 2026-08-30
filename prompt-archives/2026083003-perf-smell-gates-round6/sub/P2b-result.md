# P2b 执行结果 — Ghostty 渲染器：行 dirty 短路 + 选区拖拽不再全渲染

## 1. 行 dirty 短路（X2「Dirty-row tracking happens after a full cell walk」）

### 关键发现：内核的行 dirty 位不是坏的，是没人清

X2 报告与代码注释都写着「WASM 侧的行 dirty 位在当前 ghostty 构建里恒为 true」。实测确认了现象，
但也确认了根因：ghostty 的 render-state 行 dirty 遵循 **renderer「消费即清」契约** ——
读到 `true` 之后必须用 `ghostty_render_state_row_set(DIRTY, false)` 写回；旧实现只读不写，
于是标志位从第一帧起就一直是 `true`。

用 `ghostty_render_state_row_set` 回写后，标志位立刻变得完全可用（探针实测）：

| 操作 | 行 dirty |
| --- | --- |
| 初次填充 | 全 1 |
| 无输入的下一帧 | 全 0 |
| 只写第 2 行 | 只有第 2 行 + 光标离开的行是 1 |
| 内容滚动 / 视口滚动（±1、top、bottom） | 全 1 |
| resize | 全 1 |

### 改动（`src/render-state.ts`，+23/−5）

- `readReportedRowDirty` → `consumeReportedRowDirty`：读到 true 后立即写回 false。
- `readRow()` **先读 dirty**：内核报未脏且上一帧可比（几何一致、配色未变、有上一帧行对象）时
  直接沿用上一帧的行对象（脏标记换成 false 的同结构外壳，`cells` / `text` 仍是同一批引用），
  **一个 cell 都不读**。其余情况完全保持原有的逐 cell 全扫 + 比对路径。
- `iterateRows()` 进入循环前先把 `previousRows` 置空、走完整轮才写回：dirty 位在迭代中被逐行
  消费，生成器一旦被中途丢弃（`break` / `.return()`）就不能再拿这一帧当基线，下一帧强制全扫。
  （原来的「中断不写缓存」写法对 `.return()` 无效——循环后的语句根本不执行。）

短路的安全前提沿用既有的 `comparable`：`settled.length === meta.rows && previousCols === meta.cols
&& !colorsChanged`，即 resize / 主题换色 / 首帧一律走全扫。`forceFullRepaint` 不受影响
（复用的行对象仍带完整 cell 数据，renderer 按 `dirty='full'` 全画）。

### 测量（`bench/render-bridge.bench.ts`，新增 clean 场景，120×40 / 120 帧 mean）

| 场景 | before | after | 倍数 |
| --- | --- | --- | --- |
| full update (40/40 行) | 1.123–1.146 ms | 1.118–1.140 ms | 持平 |
| single dirty row (1/40) | 1.016–1.033 ms | 0.072 ms | **14×** |
| clean frames (0/40) | 0.902 ms（p95 0.951） | 0.008 ms（p95 0.014） | **110×** |
| 20% dirty rows (8/40) | 0.935 ms | 0.259–0.272 ms | **3.5×** |

bench 里的 `[sink]` 校验值（行模型内容摘要）before/after 完全一致：`660800 / 16520 / 4720 / 135818`。

## 2. 选区拖拽（X2「Local selection drag synchronously runs the full render path」）

### 改动

- `canvas-renderer.ts`（+5）：新增 `drawSelectionOnly(rects, color)`，直接走已有的独立选区层
  `drawSelection(..., wiped=false)`——渲染器本来就把选区画在单独 canvas 上并自带矩形去重，
  只缺一个对外入口。
- `terminal-selection.ts`（+17/−3）：
  - `PointerDragState` 增加 `lastPoint`；`update()` 命中同一个 cell 时**整体跳过**（不改 state、
    不重绘）；`drag.moved` 的语义保持不变（同 cell 抖动仍算「拖拽过」，松手仍判 `keep`）。
  - 跨 cell 的 `update()` 改调 `context.renderSelection()`（rAF 合并的选区层重绘），不再同步
    `context.render()`。`begin()`、`stepAutoScroll()` 仍走全渲染。
- `terminal-render-coordinator.ts`（+38）：新增 `scheduleSelectionRepaint()`——rAF 合并，回调里
  用**上一次全渲染缓存的 `viewportOffset` / `viewportRows` / `lineCache`** 投影选区矩形并只重画
  选区层，不碰 WASM、不重扫任何 cell；同时把选区文本通过新的 `host.onSelectionText` 推给宿主
  （每帧最多一次，替代原来的「每个 mousemove 一次」）。`renderNow()` / `cancelPending()` /
  `dispose()` 都会取消排队中的选区帧。
- `terminal.ts`（+4）：接线 `renderSelection` → `scheduleSelectionRepaint`，
  `onSelectionText` → `updateSelectionTextProbe`（e2e 全局探针与 `onSelectionChange` 监听器行为
  不变，只是延后到下一帧）。

输出、自动滚动、resize 依旧强制全渲染（前两者本来就走 `schedule()` / `render()`，resize 走
`forceFullRepaint()`）。

### 测量（scratchpad `drag-bench.ts`：120×40 真实 ghostty 终端，600 次 mousemove，
每 cell 3 个亚像素事件，60fps 下每 2 个事件一帧）

| 配置 | 每次 mousemove |
| --- | --- |
| 本轮之前（每次 mousemove 一次全渲染，全扫成本 = clean 帧 0.902 ms） | ≈ 900 µs |
| 仅 item 1 之后（每次 mousemove 仍全渲染，但全扫已被短路） | 3.0–3.5 µs |
| item 1 + item 2 | **1.1–1.2 µs**（600 次移动只产生 119 次选区层重绘） |

X2 报告估算的「120 事件/秒 ≈ 96–120 ms CPU/秒/终端」在改动后降到 **< 0.2 ms/秒**。

## 文件清单

生产代码（净 +79 行）：
- `packages/ghostty-terminal/src/render-state.ts` (+23/−5)
- `packages/ghostty-terminal/src/terminal-render-coordinator.ts` (+38)
- `packages/ghostty-terminal/src/terminal-selection.ts` (+17/−3)
- `packages/ghostty-terminal/src/canvas-renderer.ts` (+5)
- `packages/ghostty-terminal/src/terminal.ts` (+4)

测试 / bench：
- `packages/ghostty-terminal/src/render-state.dirty.test.ts`（新增，4 个用例）
- `packages/ghostty-terminal/src/terminal-selection.drag.test.ts`（新增，6 个用例）
- `packages/ghostty-terminal/src/canvas-renderer.layers.test.ts`（+1 用例）
- `packages/ghostty-terminal/src/terminal.canvas.test.ts`（+1 集成用例）
- `packages/ghostty-terminal/src/render-state.cache.test.ts`（只改过期的文件头注释）
- `packages/ghostty-terminal/bench/render-bridge.bench.ts`（+clean 场景，5 行）

## 测试设计要点

- **差分测试**（`render-state.dirty.test.ts` 第一例）是 item 1 的正确性主锚：同一批字节喂两台
  终端，一台跨帧复用、一台**每步换一个全新 render state**（无上一帧 ⇒ 必然逐 cell 全扫，作为
  基准真值），逐 cell（text / codepoints / widthKind / hasText / style / fg / bg）比对必须完全
  一致。26 个步骤覆盖写入、擦除、光标移动、SGR、宽字符与组合字符、内容滚动、视口滚动
  （±1 / top / bottom）、软换行、resize 变窄变宽（含重排）、主题换色、清屏、备用屏往返。
- 另有：脏行计数（截 `bindRenderStateRowCells` 统计「本行走了全扫」）、视口滚动一行后行文本
  正确、迭代中断后下一帧全扫重建。
- item 2 的集成用例经**变异验证**：把 `renderSelection` 改回 `renderNow` 后该用例即失败
  （全渲染计数 2 → 5）。

## 验证

- `cd packages/ghostty-terminal && bun test` → **201 pass / 0 fail**（基线 189/0，新增 12 个用例）
- `bunx tsc --noEmit -p .` → **0 error**（基线 0）
- `bunx biome check <改动文件>` → 我改动/新增的文件全部 clean。
  `src/terminal.canvas.test.ts` 仍报 3 处 `noNonNullAssertion`，位于我未触碰的 `setupTerminal`
  辅助函数（`git diff` 确认我新增的行里 `dom!` 出现 0 次），属既有问题。
- 回归确认依赖方：`cd packages/terminal-ui && bun test` → 323 pass / 0 fail。

## 风险与遗留

1. **item 1 的正确性押在内核标脏的完备性上**。实测覆盖到的所有内容变化来源都会正确标脏，
   差分测试把这个前提钉住了；若将来升级 `ghostty-vt.wasm`（asset 有 sha256 pin），差分测试是
   第一道闸。没有为「ABI 不支持写 DIRTY」加降级分支——wasm 产物在仓库内 pin 死只有一个 ABI，
   加分支属于为将来做抽象。
2. **每个终端句柄只能挂一个 render state**：清 dirty 是破坏性的，第二个 render state 会看不到
   变化。当前每个 `GhosttyTerminalController` 恰好一个（全仓库检索确认 `createRenderState` /
   `iterateRows` 只在 ghostty-terminal 内部使用）。差分测试里两个 render state 特意挂在两台
   不同终端上，就是因为这个约束。
3. **选区文本延后一帧**：拖拽中 `onSelectionChange` 监听器与 e2e 探针
   `__tmexE2eTerminalSelectionText` 从「每个 mousemove 更新」变成「每帧更新」。松手
   (`finishPointerDrag → keep`) 仍走同步全渲染，终态即时提交；触屏拖拽 (`endTouchSelection`)
   依赖已排队的那一帧收尾（浏览器里 ≈16 ms）。`getSelection()` / 复制路径是同步直读，不受影响。
4. **没有给选区文本加记忆化缓存**。任务提到「文本按需惰性计算」——拖拽路径上已经做到（不再
   per-move，只 per-frame）。再加一层按 state 身份的缓存需要在每次全渲染时失效，收益（缓存的
   行模型上做字符串拼接）远小于引入过期风险，故未做。
