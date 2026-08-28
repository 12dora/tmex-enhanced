# 选择自动滚动 interval 泄漏修复结果

## 结论

Bug 属实，且比报告描述更严重：泄漏并不需要「销毁终端」这一前提。**只要调用一次 `begin()`（`startTouchSelection` / 本地选择 mousedown），就可能起一个永不停止的 48ms `setInterval`**，它会持续调用 WASM 绑定滚动视口并触发整帧渲染。

## 复现（已实测）

在 `packages/ghostty-terminal/src/terminal.canvas.test.ts` 的选择用例里插入探针：

```
scrollDeltaCalls = 4 dragging = true   // startTouchSelection(4, 4) 之后什么都不做，等 200ms
```

再在同一个进程里把 `render-state` 还原成真实模块（等价于 `afterAll(restoreRealTerminalModules)` 之后又有测试文件跑超过 48ms），立刻拿到报告里那条报错：

```
TypeError: undefined is not an object (evaluating 'resources.bindings.updateRenderState')
      at updateRenderState (render-state.ts:843:13)
      at renderNow (terminal-render-coordinator.ts:199:5)
      at render (terminal.ts:159:32)
      at stepAutoScroll (terminal-selection.ts:226:18)
      at <anonymous> (terminal-selection.ts:197:12)
```

## 根因

1. `begin()` 末尾调用 `updateAutoScroll()`。判定「是否在视口外」用的是 `getScreenBounds()`；当选择表面尺寸退化（隐藏面板、测试里的 fake DOM 未设 rect，`bottom = 0`）时，按下点 `clientY = 4` 被判成「视口外」，于是起了 interval。此后**没有任何后续指针输入**能把它喂停（`stepAutoScroll` 每拍的条件都恒真），interval 永久运行。测试里 `resize with unchanged cols/rows should preserve selection` 就是这样漏出去一个 interval，之后跨文件炸掉整个 `bun test` 进程。
2. `dispose()` 里虽然已经有 `selection.stopAutoScroll()`，但 `TerminalSelection` 本身没有 disposed 概念：任何一次残留回调（或销毁后到达的事件）仍会打到已释放的 WASM 句柄 / render-state 上。
3. 鼠标拖到浏览器窗口外松开时 `mouseup` 不会派发，`dragActive` 与自动滚动会一直挂着——即报告里说的「drag ends abnormally」。

## 改动

- `packages/ghostty-terminal/src/terminal-selection.ts`
  - 新增 `disposed` 标志与 `dispose()`：置位、结束拖拽、清 interval。
  - `begin()` / `update()` / `finishPointerDrag()` / `updateAutoScroll()` / `stepAutoScroll()` 全部在 disposed 时短路（`stepAutoScroll` 顺带清掉自己的 interval），保证销毁后没有任何回调能碰到悬空资源。
  - `begin()` 不再调用 `updateAutoScroll()`。按下点必然落在选择表面内，正常路径下这行本就是 no-op；退化尺寸下它是唯一的泄漏来源。自动滚动改为只由 `update()`（指针移动）驱动，行为无损。
  - `stopAutoScroll()` 改为 private（外部唯一调用点已换成 `dispose()`）。
- `packages/ghostty-terminal/src/terminal.ts`：`dispose()` 中 `selection.stopAutoScroll()` → `selection.dispose()`。
- `packages/ghostty-terminal/src/terminal-pointer-handlers.ts`：`dragMove` 在本地选择分支里，遇到 `event.buttons === 0`（说明 mouseup 丢了）时收尾拖拽 —— 清 `mouse.dragActive` 并走 `finishPointerSelection`，从而停掉自动滚动。上报（mouse reporting）分支不受影响。

## 回归测试（`terminal.canvas.test.ts`，均已验证 RED → GREEN）

1. `starting a selection should not leave an auto-scroll interval running`：`startTouchSelection` 后等两拍，`scrollDeltaCalls` 必须为 0。改前 fail（=4）。
2. `dispose during drag auto-scroll should clear the interval`：设好 screen rect，拖到视口下方触发自动滚动，确认在滚；`dispose()` 后计数不再增长，且 `startTouchSelection` 返回 false。
3. `drag auto-scroll stops when the mouse button is released outside the window`：mousedown 在内、window mousemove 到视口外（buttons=1）起自动滚动，随后一次 `buttons=0` 的 mousemove 必须终止它。改前 fail（一直滚）。

新增共享 helper `waitForAutoScrollTicks()`（等 160ms ≈ 两拍）。

## 验证

- `cd packages/ghostty-terminal && bun test` → **188 pass / 0 fail**（基线 185，新增 3 个用例）。
- `bunx tsc --noEmit -p .` → 0 报错。
- `bunx biome check` 四个改动文件 → 只剩 3 条**改动前就存在**的 `noNonNullAssertion`（`setupTerminal` 里原有的 `dom!`，与本次改动无关，未触碰）。
- 顺带 `packages/terminal-ui && bun test` → 301 pass / 0 fail（触摸手势走 `startTouchSelection`，确认未受影响）。

## 备注 / 残留风险

- 若指针在窗口外松开后再也不移动，`buttons === 0` 的兜底不会触发；这与 xterm.js 的行为一致，且此时 `stepAutoScroll` 仍会在选择表面消失（`getScreenBounds()` 返回 null）时自行停下，不会打到悬空资源。
- 测试里那些不 `dispose()` 终端的用例没有改动——修复后它们不再泄漏 interval，无需额外的测试卫生改造。
