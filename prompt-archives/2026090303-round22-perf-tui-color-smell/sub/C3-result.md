# C3 结果：隐藏终端挂起渲染与元数据补丁隔离

## 完成内容

### T1：隐藏 keep-alive pane 挂起渲染

- `GhosttyTerminalController`、`TerminalRenderCoordinator`、`TerminalRenderLoop` 新增 `setRenderSuspended(boolean)`。
- 挂起期间 `write()` 仍执行 `writeVt`，保留 WASM 终端热状态；普通渲染、同步输出兜底帧、选区帧、链接 overlay 任务和光标 settle 帧均不再调度，已有待执行任务会被取消。
- 恢复时同步执行 `requestFullRepaint()` + `renderNow()`；`rowsPendingOutput` 跨挂起期保留，因此恢复全画不会错误启用 shift reuse。
- `terminal-stage.tsx` 按 `visible` 传入 `renderSuspended`；`useTerminalBootSurface` 在新 surface 绑定及后续可见性 layout effect 中下发状态，保证浏览器绘制前恢复画布。
- 回归测试覆盖：隐藏期输出不丢失、隐藏期 resize 后恢复最新几何、选区与滚动位置保留、无 rAF/链接/光标任务、恢复强制全画，以及 `rowsPendingOutput` 门禁。

### U4(a)(b)：窄订阅与 memo

- keep-alive 存活 pane 订阅改为排序后的 pane-id 字符串键，元数据对象换引用不再重建集合。
- `useConsoleTargets` 拆分结构签名与当前窗口展示签名：其他窗口的 title/cwd/command 补丁不再唤醒控制台；当前窗口仍能更新标题、路径和命令，结构变化仍更新布局、尺寸与 active 状态。
- `Terminal` 与 `SplitPaneView` 均使用 `React.memo`；分屏传入的 `onResize`/`onSync` 空函数提升为模块常量。
- 新增 memo 回归测试，元数据-only 快照补丁下 `Terminal` render count 保持为 1；渲染相关 prop 变化仍会穿透 memo。
- 未修改 `DEFAULT_FLUSH_INTERVAL_MS`。

## 改动文件

- `packages/ghostty-terminal/src/terminal.ts`
- `packages/ghostty-terminal/src/terminal-render-coordinator.ts`
- `packages/ghostty-terminal/src/terminal-render-loop.ts`
- `packages/ghostty-terminal/src/terminal-render-loop.test.ts`（新增）
- `packages/ghostty-terminal/src/terminal-render-coordinator.performance.test.ts`
- `packages/ghostty-terminal/src/terminal-render-coordinator.force-repaint-shift.test.ts`
- `packages/ghostty-terminal/src/terminal.canvas.test.ts`
- `packages/panels/src/device-console/terminal-stage.tsx`
- `packages/panels/src/device-console/terminal-keep-alive.ts`
- `packages/panels/src/device-console/terminal-keep-alive.test.ts`
- `packages/panels/src/device-console/use-console-targets.ts`
- `packages/panels/src/device-console/use-console-targets.test.ts`（新增）
- `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts`
- `packages/terminal-ui/src/components/Terminal.tsx`
- `packages/terminal-ui/src/components/Terminal.memo.test.ts`（新增）
- `packages/terminal-ui/src/components/split/SplitPaneView.tsx`

## 性能估算

依据 EX1 同机实测：单个整屏更新为 write 0.143 ms + bridge 1.061 ms + canvas 1.477 ms，共 2.681 ms。挂起后隐藏 pane 仅保留 write，故每个隐藏 pane 约节省 **2.538 ms/整屏帧**；保活池满载时两个隐藏 pane 合计约节省 **5.076 ms/帧**。三个 pane 同时输出时，总终端主线程成本估算由 8.043 ms 降至 2.967 ms，约下降 **63%**；只计算渲染阶段则下降 **67%**。链接扫描、光标与 rAF 唤醒的额外节省未计入。

## 验证结果

- 基线：ghostty-terminal 280 pass / 0 fail；panels device-console 177 pass / 0 fail；terminal-ui 379 pass / 0 fail。
- 最终：
  - `cd packages/ghostty-terminal && bun test`：**329 pass / 0 fail**。
  - `cd packages/panels && bun test src/device-console`：**181 pass / 0 fail**。
  - `cd packages/terminal-ui && bun test`：**398 pass / 0 fail**。
- `bunx tsc --noEmit -p .`：ghostty-terminal、panels、terminal-ui 均 **0 error**，未高于基线。
- `bunx biome check <C3 files>`：通过，16 个文件无问题。
- `bun scripts/complexity/gate.ts`：通过，`complexity gate ok (1284 files, 11868 functions)`；未修改 allowlist。

## 未完成项

无。
