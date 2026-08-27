# 渲染热路径三个高复杂度函数拆分结果

## 目标与范围

把今日性能改造遗留的三个高复杂度函数降到 CC ≤ 12、≤ 60 行，行为、缓存语义（行复用、dirty 推导、图层跳过）完全不变。

改动文件：

- `packages/ghostty-terminal/src/canvas-renderer.ts`
- `packages/ghostty-terminal/src/render-state.ts`
- 新增 `packages/ghostty-terminal/src/render-state.row-reuse.test.ts`（仅覆盖新拆出的纯函数）

## canvas-renderer.ts

### `drawCursor`（94 行 / CC≈27 → 29 行 / CC≈9）

按「解析 → 判定 → 落笔 → 记账」拆成四个私有方法：

| 方法 | 行数 | CC | 职责 |
| --- | --- | --- | --- |
| `drawCursor` | 29 | 9 | 编排：不可见早退、算色/宽、跳过判定、落笔、闪烁开关、记账 |
| `hideCursor` | 8 | 3 | 光标不可见/无坐标时清层并复位三个 last* 状态 |
| `cursorAlreadyDrawn` | 17 | 8 | 「位置/形状/闪烁/颜色/宽度是否与上次落笔一致」的纯判定 |
| `paintCursorShape` | 38 | 4 | bar / underline / block-hollow / block 四种形状的实际绘制 |
| `commitCursorState` | 29 | 5 | 写回 `lastCursor` / `lastCursorRect` / `lastCursorColor`，并把光标离开的旧行推进 `lastDrawnRows` |

要点：`wiped` 不再混进跳过判定的长合取式，改为 `!wiped && this.cursorAlreadyDrawn(...)`；`commitCursorState` 只收原始值（网格坐标、style、blinking、宽、色），不接对象，语义与原先逐字段比较完全一致。

### `drawRowForeground`（71 行 / CC≈16 → 20 行 / CC≈3）

- 模块级纯函数：`isSpacerCell` / `hasVisibleGlyph` / `cellForegroundColor` / `cellBackgroundColor` / `blockElementCodepoint`（返回码位或 `-1`，避免 `number | null` 装箱语义上的歧义，也不分配）。
- 私有方法：`drawCellGlyph`（10 行，块元素自绘 vs `fillText` 二选一）、`drawCellDecorations`（40 行 / CC 4，下划线/删除线/上划线）、`cellDeviceWidth`（wide 判定，背景遍与前景遍共用）。
- `drawRowBackground` 顺带复用 `isSpacerCell` / `cellBackgroundColor` / `cellDeviceWidth`，消掉与前景遍的重复表达式，行为不变。

## render-state.ts

### `readRow`（128 行 / CC≈19 → 33 行 / CC≈5）

拆成三层：

| 函数 | 行数 | CC | 职责 |
| --- | --- | --- | --- |
| `readRow` | 33 | 5 | 读 raw row、绑定 cells、调 `readRowCells`、读 wrap/wrapContinuation/reportedDirty、做行级缓存决策 |
| `readRowCells` | 45 | 5 | 逐 cell 解码 + 复用判定，`cells` 由调用方传入就地填充，返回 `changed` 布尔 |
| `isCellUnchanged`（导出） | 20 | 7 | 纯函数：text/码位数/宽度类型/hasText 值比较 + style/fg/bg 引用比较 |
| `reuseUnchangedRow`（导出） | 29 | 6 | 纯函数：行级复用决策，返回原行 / 只换 `dirty=false` 外壳的新行 / `null` |

同时把 cell 级读取从「回调 + 通用 read*」改成直读常驻暂存区的专用函数，新增
`readRowRaw` / `readCellRaw` / `readRawRowBool` / `readRawCellBool` / `readRawCellEnum` /
`readReportedRowDirty` / `readCellColor` / `readGraphemeLen`，删掉因此失去调用方的
`readU64` / `readU32` / `readOptionalColor`。这消除了原先**每 cell 7 个箭头闭包**的分配
（`readRowCells` 现在每 cell 零分配，只有真正变化的 cell 才 new 一个 `GhosttyRenderCell`）。

顺带把 `readBool` / `readU16` / `readEnumI32` 的形参类型 `(ptr) => number | void` 收成
`(ptr) => number`（剩余调用方只有 `readState*` 三个包装），消掉 3 个此前就存在的
`lint/suspicious/noConfusingVoidType` 报错。

## 验证

- `bun test`（包内）：**185 pass / 0 fail**，`render-state.cache.test.ts`、`canvas-renderer.layers.test.ts` 等既有测试一字未改。
  （开工时基线为 159 pass / 0 fail + 1 个 terminal-selection 的异步 error；期间另一 agent 的 ghostty-wasm.ts 改动合入，测试数涨到 179，那个 error 也随之消失。185 = 179 + 本次新增 6 个纯函数测试。）
- `bunx tsc --noEmit -p .`：0 错误。
- `bunx biome check`（三个改动文件）：0 错误、无待修复项。

### 性能：`bun bench/render-bridge.bench.ts`

期间另一 agent 在改 `ghostty-wasm.ts`，为排除干扰，用 `git show HEAD:...render-state.ts` 取改前版本放进临时模块做同进程 A/B（同一份 ghostty-wasm.ts、同机连测两轮，测完已删除临时文件）：

| 场景 | 改前 mean / p95 | 改后 mean / p95 |
| --- | --- | --- |
| full update (40/40) | 1.275 / 1.855 ms、1.278 / 1.907 ms | 1.077 / 1.301 ms、1.071 / 1.278 ms |
| single dirty row (1/40) | 1.059 / 1.337 ms、1.090 / 1.380 ms | 0.969 / 1.014 ms、0.973 / 1.008 ms |
| 20% dirty rows (8/40) | 1.078 / 1.500 ms、1.122 / 1.548 ms | 0.871 / 0.893 ms、0.883 / 0.931 ms |

三个场景 mean 降 8%~21%，p95 降幅更大（每 cell 闭包分配消失后 GC 抖动明显减少）。
`dirtyRows/frame`、`non-full frames`、校验和三列在改前后完全一致，说明脏行推导与降级逻辑没有变化。
canvas-renderer 不进这个 bench（无 DOM），其改动只做等价重排，不涉及每 cell 分配。

## 注意事项

- `isCellUnchanged` / `reuseUnchangedRow` 为测试而 `export`，`src/index.ts` 未再导出，不进包公共 API。
- 颜色/style 比对仍严格依赖内插实例的引用相等，新测试里专门固定了「值相等但非同一实例 → 判定已变」这条语义，防止后续有人把它改成深比较。
