# F-term 结果：drawSelectionOnly 绕过 DPR/cell 同步（review-term should-fix）

## 问题
`packages/ghostty-terminal/src/canvas-renderer.ts` 的 `drawSelectionOnly()` 直接调 `drawSelection(rects, color, false)`，完全跳过 `resize()` 里的 dpr / 设备 cell 尺寸 / 位图尺寸同步。浏览器缩放或换屏后 dpr 变了、但网格（cols/rows）没变时，拖拽期间不会有新的整帧进来，于是选区一直按旧的 `deviceCellWidth/Height` 落笔，位图也保持旧尺寸，直到下一次全渲染才纠正。

## 改动
`canvas-renderer.ts`：
- 新增 `private lastFrame: CanvasRendererFrame | null`，`render()` 入口记下本帧输入，`dispose()` 清空。
- `drawSelectionOnly()` 先判 `layoutStale()`（当前 `devicePixelRatio`、由当前 cell 尺寸算出的设备 cell 宽高、主画布 backing size 与上一帧所用值比对）；命中则用上一帧数据 `render({ ...frame, selectionRects, selectionColor, forceFull: true })` 整帧重画（`resize()` 会重建位图，`wiped=true` 让选区层绕过去重），否则走原来的选区快路径。
- 抽出模块级 `toDeviceCell(size, dpr)`，`resize()` 与 `layoutStale()` 共用，避免两处重复 `Math.max(1, Math.round(...))`。

`canvas-renderer.layers.test.ts`：新增用例「dpr 变化后 drawSelectionOnly 退回整帧重画并按新尺寸落笔」——dpr 1 下整帧（cols/rows=4、CELL 10×20，主画布 40×80），改 dpr=2 后只调 `drawSelectionOnly(同一批 rects, 同一颜色)`，断言 `frameCount` +1、主画布变 80×160、选区 fillRect 按新 cell 20×40 落在 (20,40,40,40)。用同一批 rects 是为了同时覆盖「位图被清空时不能被选区去重吞掉」。

## 验证
- 反向验证：临时短路 `layoutStale()` 分支后新用例失败（frameCount 仍为 1，尺寸不变），恢复后通过。
- `bun test`：202 pass / 0 fail（基线 201 + 新增 1）。
- `bunx tsc --noEmit -p .`：0 error。
- `bunx biome check src/canvas-renderer.ts src/canvas-renderer.layers.test.ts`：clean。

## 备注
`lastFrame` 只持有协调器已经持有的 `rows` 引用（`TerminalRenderCoordinator.renderedRows`），不引入额外常驻内存；`dispose()` 里已置空。常态拖拽路径（布局未变）判断只多一次 5 项数值比较，不影响每帧开销。
