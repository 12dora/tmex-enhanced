# useTerminalResize 拆分结果

## 范围

- 改动：`packages/terminal-ui/src/components/useTerminalResize.ts`
- 新增实现：`terminal-resize-reporter.ts`、`terminal-resize-scheduler.ts`、`terminal-viewport-restore.ts`
- 新增测试：三者同名 `*.test.ts`（41 个用例）
- 未触碰：`hooks/useTerminalBootSurface.ts`、`TerminalSurface.ts`、`Terminal.tsx`、`terminalMetrics.ts`、`resizeSyncGuards.ts`

## 拆分结果

### `terminal-resize-reporter.ts`（无 React）

- `shouldAttemptResizeReport()`：把原 `reportSize` 前 20 行的准入判断抽成纯函数（follow 模式 / deviceId+paneId+连接 / `isSelectionInvalid` 仅放行 sync / 抑制窗口内拒绝非 force）。
- `TerminalResizeReporter`：持有 `lastReportedSize`、`pendingLocalSize`、`suppressLocalResizeUntil` 三个可变盒子（结构上与 `RefObject` 等价，hook 直接把它们透传给调用方，公开 API 形状不变），提供 `measure()` / `report()`。依赖全部以 getter 注入（terminal、fitAddon、容器 rect、回调、`now`），所以可脱离 DOM 单测。
- 去重逻辑等价化简：原来两个分支都先调 `applyTerminalSize(cols, rows)`，现在提到分支前统一调用一次，语义不变。

### `terminal-resize-scheduler.ts`（无 React）

- `ResizeSchedulerTimers` 接口 + `browserResizeSchedulerTimers` 浏览器实现，定时器可注入。
- `RafCoalescer`：单帧合并（原 window resize 监听里那段自建 RAF 合并逻辑）。
- `TerminalResizeScheduler`：150ms 防抖 → RAF → 执行；`immediate` 跳过防抖；`runPostSelect()` 承载「立即一次 + 60ms 重试 + `document.fonts.ready` 重试」三轮补测；`clearPostSelectTimers()` / `dispose()`。
- `readDocumentFontsReady()`：把 `typeof document !== 'undefined' && 'fonts' in document && document.fonts?.ready` 的浏览器探测收在这里。
- **`dispose()` 只取消在途回调，不设永久失效标志**。这是刻意的：`apps/fe/src/main.tsx` 开了 `StrictMode`，hook 用 `useRef` 懒建调度器实例，双挂载会在同一实例上先 dispose 再复用；加 `disposed` 短路会让 StrictMode 下第二次挂载的终端彻底不再上报尺寸。已有用例锁住这一点。

### `terminal-viewport-restore.ts`（无 React）

- `createViewportRestoreController()`：`restore()` 返回 `'skipped' | 'repainted' | 'synced'`（对应原来的「无终端/无法测量直接返回」「尺寸一致则 `forceFullRepaint()`」「尺寸不一致则 force sync」），加上 visibilitychange / blur / focus 的挂起状态机。
- 挂起标记 `pending` 由 hook 侧的 ref 持有并注入，而不是控制器内部私有状态——原实现里 `viewportRestorePendingRef` 是 hook 级 ref，能跨监听器 effect 重建存活；控制器每次 effect 重建，如果状态放在控制器内部，「失焦期间 deviceConnected 变化 → effect 重建 → 挂起标记丢失 → 回到前台不再 sync」就是一个真实回归。已有用例锁住这一点。

### hook 本体

只剩接线：refs → reporter/scheduler → gate → actions → lifecycle → handles → 对外表面。拆出 6 个文件内私有小 hook（`useConstant`、`useResizeCallbacksRef`、`useResizeReporter`、`useResizeActions`、`useWindowResizeListener`/`useViewportRestoreListeners`/`useResizeLifecycle`、`useTerminalHandles`），主 hook 48 行，所有函数 ≤ 48 行、CC 远低于 12（原 hook 319 行、`reportSize` CC≈16）。

## 行为等价性（重点核对项）

公开返回值形状、字段名、稳定性全部不变；调用方 `Terminal.tsx` 未改。

**回调 identity 抖动被刻意保留**。原实现里 `reportSize` 依赖 `[deviceConnected, deviceId, isSelectionInvalid, paneId, sizingMode]`，`scheduleResize`、`runPostSelectResize` 顺着往下抖；`Terminal.tsx` 的 ResizeObserver effect 依赖 `scheduleResize`、fitAddon 创建 effect 依赖 `runPostSelectResize`，所以这五个值一变就会**重建 ResizeObserver（`observe()` 会立刻回调一次）并重新走一遍 post-select 补测**。这是当前线上语义的一部分（例如断线重连触发一轮尺寸重测），不是可有可无的抖动。新实现用 `useMemo` 的 `gate` 对象承接这五个值，让 `reportSize` 的依赖仍然是真依赖，抖动时机与原来逐位一致；`clearPostSelectResizeTimers`、`setFitAddon`、`setTerminal`、`clearPendingLocalSize` 仍然全程稳定。

逐条核对过且保持一致的还有：测量顺序与 `null` 短路条件、`Date.now()` 的两次取值点、`scheduleResize` 先清 timeout 再清 RAF 的顺序、`runPostSelectResize` 三轮补测的次序与 60ms 常量、字体 Promise 用 `.then().catch()` 吞错（不改微任务节奏）、卸载清理覆盖的三类在途回调、窗口 resize 的 RAF 合并 + 复用防抖。

## 特征测试（41 例，先写后重构）

无法在 bun test 里渲染 hook（仓库没有 happy-dom / react 测试渲染器），所以特征测试打在抽出的模块与「reporter + scheduler 组合成的流水线」上，用 FakeClock（可控 setTimeout/RAF）记录上报序列。任务要求的五个场景在 `terminal-resize-scheduler.test.ts` 的 `resize 流水线特征行为` 里：

- 初次挂载：`runPostSelect` 产出三次 force sync（每次都带 settled），因为 force 会绕过尺寸去重；
- 快速连续 resize：三次调度只落一次上报；
- 字体加载重试：尺寸没变也照样 force 上报三次；
- RAF 待执行时 dispose：零上报；
- 容器隐藏（0×0）：整链静默，恢复尺寸后立即恢复上报。

另有 reporter 门禁/去重/抑制窗口、scheduler 防抖与合并、viewport 状态机等用例。

## 验证

- `cd packages/terminal-ui && bun test`：**301 pass / 0 fail**（起始基线 233；其中 41 例为本次新增，其余增量来自并行 agent 在同 worktree 的新测试）。
- `bunx tsc --noEmit -p packages/terminal-ui`：0 错误。
- `bunx tsc --noEmit -p apps/fe`：0 错误（顺带确认返回值结构变化未影响下游）。
- `bunx biome check --write <7 个文件>`：clean。
- e2e 未跑（按分工由 commander 执行）。`window.__tmexE2eXterm` 相关文件未触碰；`ws-borsh-theme-resize.spec.ts` 断言的是 TERM_RESIZE / SYNC / windowStyle 的消息条数，去重与 force 语义未变，条数应保持一致。

## 遗留说明

任务描述里提到的 ResizeObserver 协调实际在 `Terminal.tsx`（第 138–158 行），属于他人 scope，未改。那段逻辑与本次抽出的 `RafCoalescer` 完全同构，后续可直接替换掉重复实现。
