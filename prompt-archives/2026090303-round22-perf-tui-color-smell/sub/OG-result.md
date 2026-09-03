# OG 结果：ghostty-terminal canvas 渲染器（G1 拆分 + faint + T8 共享 scratch + fake-dom blit 覆盖 + T14）

worktree `/Users/konata/code/tmex-r22`，包 `packages/ghostty-terminal`。五项全部落地，无遗留。

## 0. 结论

| 项 | 结果 |
|---|---|
| G1 `canvas-renderer.ts` 拆分 | 897 → **738 行**（目标 ≤750）✓ |
| faint（SGR 2） | 已实现，前景色朝该 cell 实际背景 50% 混合；run 批绘仍按解析后的颜色串聚合 ✓ |
| T8 scratch canvas 单例 | 已实现，每实例 5 张 canvas → **4 张 + 全模块共享 1 张**；保活 N 个终端省 N−1 张 ✓ |
| fake-dom blit 覆盖 | `drawImage` / `insertBefore` 已补，blit 路径在 fake DOM 上被真正执行并断言 ✓ |
| T14 `clearTextarea()` 守卫 | 已实现 ✓ |
| `bun test`（包内） | 基线 280 pass / 0 fail（36 文件）→ **324 pass / 0 fail（42 文件）**，本任务新增 39 个用例 |
| `bunx tsc --noEmit -p .` | 基线 9 error（全在他人文件 `terminal-render-coordinator.force-repaint-shift.test.ts`）→ **0 error** |
| `bunx biome check`（本任务 11 个文件） | 干净 |
| `bun scripts/complexity/gate.ts` | 本任务文件 **0 违规**；仓库整体有 7 条违规 + 1 条 stale，全部落在他人正在改的文件（见 §6） |

## 1. 文件清单

新增生产代码：

- `packages/ghostty-terminal/src/canvas-cell-style.ts`（160 行）
  纯颜色/样式判定 + `CellStyleResolver`（颜色缓存、faint 混合缓存、四种字形变体缓存）。
  导出：`colorKey` / `fontVariantIndex` / `isSpacerCell` / `hasVisibleGlyph` / `hasDecorations` /
  `cellForegroundColor` / `cellBackgroundColor` / `blendFaint` / `blockElementCodepoint` / `CellStyleResolver`。
- `packages/ghostty-terminal/src/canvas-block-elements.ts`（133 行）
  `isBlockElement` / `drawBlockElement`（含 `QUADRANT_FLAGS`、`SHADE_ALPHA`）/ `drawCellDecorations`。
  两者只依赖 `Pick<CanvasRenderingContext2D, 'fillRect'> & { globalAlpha }`，可脱离 canvas 单测。

改动生产代码：

- `packages/ghostty-terminal/src/canvas-renderer.ts`（897 → 738）
- `packages/ghostty-terminal/src/terminal-dom.ts`（T14）
- `packages/ghostty-terminal/src/test-support/fake-dom.ts`（`FakeCanvasContext2D.drawImage` +
  `globalCompositeOperation` 字段、`FakeElement.insertBefore`；`appendChild` 补 `child.remove()` 以支持节点搬移）

新增测试：

- `canvas-cell-style.test.ts`（16 例）
- `canvas-block-elements.test.ts`（14 例）
- `canvas-renderer.faint.test.ts`（4 例，真 WASM 内核 → canvas 落笔全链路）
- `canvas-renderer.scratch-pool.test.ts`（3 例，跑在 fake DOM 上）
- `terminal-dom.clear-textarea.test.ts`（2 例）

改动测试：

- `canvas-renderer.scroll-runs.test.ts`：只改了 DPR 那一例的 1 行断言（见 §3.1），其余 542 行原样跑通。

## 2. G1：拆分

`canvas-renderer.ts` 剩下的只有「表面/层管理 + 绘制编排」。搬出去的是：

- 9 个纯 cell 判定函数 + `toCss`（颜色缓存）+ `resolveFont`（字形变体缓存）→ `canvas-cell-style.ts`；
  渲染器改为持有一个 `CellStyleResolver`，`setTheme` → `clearColors()`、`resize` → `resetFonts(deviceFontSize)`、
  `dispose` → `dispose()`。原来散在渲染器上的 `colorCache` / `fontVariants` / `fontFamily` 三个字段全部收进该类
  （`fontFamily` 只剩度量用途，由 `resolver.regularFont()` 提供）。
- `drawBlockElement`（CC 15，距门禁 0）与 `drawCellDecorations` → `canvas-block-elements.ts`，
  变成不含 `this` 的自由函数。`drawBlockElement` 现在也不在 allowlist 的压力区里。

行为零变化：`canvas-renderer.{scroll-runs,cursor,layers,vcenter,cursor-settle,recolor}.test.ts`、
`canvas-renderer-draw-plan.test.ts`、`terminal.canvas.test.ts`（含像素 oracle 与 run 批绘计数）全部原样通过。

## 3. T8：共享 scratch canvas

**模型**：模块级 `sharedScratch: { canvas, context } | null` + `liveRenderers` 计数。

- 构造函数不再创建 scratch（原来 5 张 → 现在 4 张）；第一次 blit 才 `acquireScratchSurface()` 分配。
- blit 交换后，「让位」的旧主画布立刻 `parkScratchSurface()` 成为新的共享中转 —— 池里永远至多一张，
  实例数 N 时全局 canvas 总量 = 4N + 1（原来 5N）。iPhone DPR3 / 390×740 / 保活 3 个：**15 张 → 13 张，约 156 MB → 135 MB**。
- ping-pong 策略本身一个字没动（self-blit 的 100× 陷阱未被触碰）。
- 复用判据是 `sharedScratch.canvas.ownerDocument === this.mainCanvas.ownerDocument`：跨 document 的位图不能共用，
  生产只有一个 document 恒成立；测试里每次装 fake DOM 都换 document，天然隔离，不会串台。
- `dispose()`：先把停在本实例层栈里的共享画布摘出 DOM，再 `liveRenderers -= 1`；归零时整张释放
  （`remove()` + `width/height = 0`）。加了 `disposed` 幂等标志，重复 dispose 不会把计数压穿。

**与任务描述的一处偏差（有意）**：任务写的是「按 live 实例的最大需求尺寸分配」，实际实现是
**每次 blit 按当前主画布尺寸精确对齐**。原因：交换后这张 scratch 会变成主画布，若它比 `cols×deviceCellWidth`
大，下一帧 `canvasSurfaceUnchanged()` 立刻判定尺寸失配 → 重设 `canvas.width` → 位图被清空 → 每帧强制全画，
比省下的内存代价大得多。代价是「两个不同尺寸的终端交替滚动」时每次 blit 会重分配一次位图；
常态（同设备同窗口的保活池、单终端滚动）尺寸一致，零重分配。

**测试**（`canvas-renderer.scratch-pool.test.ts`，跑在补齐后的 fake DOM 上）：

1. blit 在 fake DOM 上真的执行（`drawImage` 参数、`copy` 合成模式、`lastDrawnRows` 只补一行），
   且交换后 `assignedMainFillStyle` / `assignedMainFont` 确实被重置 —— 断言换到新画布后落笔的
   `fillRect` / `fillText` 都带着正确的非空 `fillStyle` / `font`（若不重置，去重缓存会让它们带空样式落笔）。
2. 两个实例交替 blit：构造后共 8 张，第一次 blit 后 9 张，之后无论谁 blit 都恒为 9 张，
   且第二个实例拿到的正是第一个实例让出的那张。
3. dispose 其中一个后，另一个仍能正常 blit；两个都 dispose 后各自的 screen 子节点清零。

### 3.1 改到的既有断言（1 行）

`canvas-renderer.scroll-runs.test.ts` 的 `DPR changes bypass scroll blitting` 一例原本断言
`harness.created[4].context.drawImageCalls === 0`（第 5 张 = 构造期分配的 scratch）。scratch 改成懒分配后
第 5 张根本不存在，断言会 `TypeError`。改为语义更强的写法，未削弱：

```ts
// blit 被 dpr 变化绕过，共享中转画布因此从未被分配（只有四张层画布）。
expect(harness.created).toHaveLength(4);
expect(harness.created[0].context.drawImageCalls).toBe(0);
```

同文件里 `created[4].drawImageCalls === 1`、`created[0].drawImageCalls === 1`（第二次 blit 换回去）、
`scratch 层子节点数 === 1`、`dispose 后 screen.children 为 0` 四条原样保留并通过 —— 也就是
ping-pong 的交替语义仍被逐条钉死。

## 4. faint（SGR 2）

`GhosttyRenderCellStyle.faint` 原来在 `canvas-renderer.ts` 里 0 次出现。现在：

- `CellStyleResolver.foregroundCss(cell, colors)` 是唯一的前景取色入口。非 faint 走原来的
  `toCss(cellForegroundColor(...))`；faint 时取该 cell 的**实际**背景（inverse 已换过手），
  按 `blendFaint` 做 50% 线性混合，结果按 `(fgKey, bgKey)` 复合键缓存成 CSS 串。
- 选 50% 混合而不是降 `globalAlpha`：run 批绘的分组键是「解析出来的颜色串」，混合后 faint 段与
  普通段自然分成两个 run，批绘逻辑一行都不用改；alpha 方案会让同色不同 alpha 的 cell 错误合批。
- 混合口径与 ghostty / xterm 的 half-bright 一致（仓库 `vendor/ghostty` 是空的 submodule，未能读到上游源码，
  按通行实现取 0.5）。
- faint 同时作用于块元素、装饰线（下划线/删除线/上划线），因为它们共用同一个 `fillStyle`。
- 主题切换时 `clearColors()` 同时清普通色表与 faint 混合表（faint 结果依赖默认前/背景色）。

**测试**：`canvas-renderer.faint.test.ts` 用真 `ghostty-vt.wasm` 写真 VT 序列，验到 `fillText` 的落笔色：

| 场景 | 序列 | 断言 |
|---|---|---|
| faint + 缺省前景 | `\x1b[2mab\x1b[0mcd` | `rgb(128 128 128)` vs `rgb(238 238 238)` |
| faint + 调色板前景 | `\x1b[32mab\x1b[2mcd` | `rgb(0 170 0)` → `rgb(9 94 9)` |
| faint + inverse | `\x1b[7mab\x1b[2mcd` | inverse 前景 `rgb(17 17 17)` → 朝换手后的背景混合成 `rgb(128 128 128)` |
| faint + bold | `\x1b[1mab\x1b[2mcd` | 颜色变暗，`font` 仍是 `700 13px monospace` |

另在 `canvas-cell-style.test.ts` 里钉了「faint 结果与等价显式色同键（可合批）、与原色不同键（会拆 run）」。

## 5. fake-dom 覆盖（EX2 §六 顺带发现 1）

- `FakeCanvasContext2D` 补 `drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)`：记录全部九个参数、
  源画布引用与当时的 `globalCompositeOperation`（新增该字段，默认 `'source-over'`）。
  没有复制像素缓冲 —— `FakeCanvasContext2D` 本来就只记指令、不存位图，像素级 oracle 由
  `canvas-renderer.scroll-runs.test.ts` 自带的 `RasterContext` 负责（那套已有真 `Uint32Array` 缓冲）。
- `FakeElement` 补 `insertBefore(child, reference)`，并让 `appendChild` 先 `child.remove()`，
  这样节点在两棵树之间搬移的语义与真实 DOM 一致（共享 scratch 会在实例之间搬）。
- 补齐后 `blitRows()` 在 fake DOM 上确实执行（原来因为缺 `drawImage` 恒返回 false，所有 fake-dom
  canvas 测试都退回整屏重画）。`terminal.canvas.test.ts` 等既有 fake-dom 测试未受影响，全部通过。

## 6. 未能做 / 需要指挥官知悉

1. **`bun scripts/complexity/gate.ts` 当前整仓不绿**，7 条违规 + 1 条 stale，**全部不在我负责的文件里**，
   都是并行 agent 正在改的文件：`packages/panels/src/markdown/streaming-markdown.tsx:111 openFenceTail`（CC 17）、
   `packages/terminal-ui/src/components/split/SplitPaneView.tsx:77`（127 行）与配套的 stale allowlist 条目
   `SplitPaneView`、`packages/terminal-ui/src/components/Terminal.tsx:33`（216 行）、
   `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:57`（124 行）、
   `packages/ghostty-terminal/src/ghostty-wasm.ts`（1664 行）、
   `packages/ghostty-terminal/src/render-state-read.ts:386 readRowCells`（CC 20）、
   `packages/ghostty-terminal/src/terminal-render-coordinator.ts:278 renderNow`（CC 16）。按规则未越界修改。
2. **`bunx biome check packages/ghostty-terminal/src/` 有 1 条格式错**，在
   `src/terminal-render-coordinator.force-repaint-shift.test.ts`（他人文件），未动。
3. **canvas 基准没有可比的数字**：`bench/render-bridge.bench.ts` 完全不碰 canvas（跑的是
   `updateRenderState` / `iterateRows` / `buildLineModel`，且这些文件此刻正被别的 agent 改）；
   `bench/canvas.bench.mjs` 是一个 Playwright 里的裸 canvas 微基准，不 import `CanvasRenderer`。
   本轮改动没有引入新的每帧工作量：faint 走缓存查表（非 faint 路径与改前完全相同的一次 Map 查找），
   共享 scratch 只是把「构造期分配」改成「首次 blit 时分配」，blit 内的指令序列逐条一致。
