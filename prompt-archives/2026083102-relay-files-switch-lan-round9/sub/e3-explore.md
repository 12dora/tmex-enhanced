# Task E3：终端切换延迟调查报告

## 结论

代码确认：单 pane 视图切换时，旧 `Terminal` 会卸载，新 pane 会创建全新的 Ghostty 实例、WASM terminal handle、render state、DOM 与四层 canvas。WASM module 本身复用，但 terminal 实例不复用。

当前默认浏览器路径是 `LazyWebSocketGatewayTransport → WebSocketGatewayTransport`，能力声明为：

```ts
sequencedTerminal: false,
atomicScreen: false,
cursorHistory: false,
serverSelection: true,
```

见 [`packages/ws-client/src/websocket-transport.ts:18`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/websocket-transport.ts:18)。因此普通切换实际走旧式 `TMUX_SELECT → SWITCH_ACK → TERM_HISTORY → LIVE_RESUME`，不是 canonical screen snapshot。

已确认的固定延迟是 gateway 在发送 `TERM_HISTORY` 后无条件等待 `450ms` 才发送 `LIVE_RESUME`。这会直接推迟“进入 live output”时间。

`2.5s` 不是普通切换等待，而是 URL 指定的 pane 尚未出现在快照时的失效宽限期。普通已知 pane 切换不会主动等待 2.5s。

## 1. 完整切换链路

### 1.1 路由与选择

1. 终端 URL 使用路径参数，不使用 `?pane=` 或 `sid`：

```ts
export const PANE_ROUTE_PATH =
  '/devices/:deviceId/windows/:windowId/panes/:paneId';
```

见 [`packages/panels/src/device-tree/device-tree-navigation.ts:15`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-tree-navigation.ts:15)。`DevicePage` 通过 `useParams()` 读取 `deviceId/windowId/paneId`，见 [`apps/fe/src/pages/DevicePage.tsx:20`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/pages/DevicePage.tsx:20)。

2. 侧栏选择调用 `navigateToPane()`，以 `replace: true` 改写路由，并记录用户主动选择：

```ts
navigate(paneRoutePath(...), { replace: true });
```

见 [`packages/panels/src/device-tree/device-tree-navigation.ts:276`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-tree-navigation.ts:276)。

这是同步调用；React 路由提交和后续 effects 不被 `await`。

3. `usePaneRouteReconciliation` 观察路由变化：

- 单 pane 或跨 window：调用 `selectPane(...)`；
- split view 内同一 window 切焦点：调用 `focusPane(...)`，不重新拉 history；
- split view 切换 window：重新走 full select。

见 [`packages/panels/src/device-console/use-pane-route-reconciliation.ts:106`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/use-pane-route-reconciliation.ts:106) 和 [`packages/panels/src/device-console/use-pane-selection-dispatch.ts:138`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/use-pane-selection-dispatch.ts:138)。

4. `selectPane()` 立即更新本地 `selectedPanes`，生成 `selectToken`，启动 `SelectStateMachine` 的 `SELECT_START`，然后发送 `select-pane`：

```ts
core.transport.send({
  type: 'select-pane',
  deviceId,
  windowId,
  paneId,
  selectToken,
  wantHistory: true,
  cols,
  rows,
});
```

见 [`packages/stores/src/tmux-selection-actions.ts:84`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:84)。这一步本身同步完成；WebSocket 未 READY 时由 client 排队。

### 1.2 RuntimeProvider 是否重挂

`RuntimeProvider` 使用 `runtimeSubtreeKey(runtime)` 作为 Fragment key：

```tsx
<Fragment key={runtimeSubtreeKey(runtime)}>{children}</Fragment>
```

见 [`packages/stores/src/react.tsx:45`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/react.tsx:45)。

因此：

- 同一 node 内切 pane：runtime 不变，`RuntimeProvider` 不重挂；
- 切换 node：runtime 改变，整棵页面子树重挂，包括终端、store subscription 和 query observer；
- node runtime 本身由 `NodeRuntimeBoundary` 提供，见 [`apps/fe/src/node/node-runtime-boundary.tsx:40`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/node-runtime-boundary.tsx:40)。

### 1.3 Terminal 卸载与创建

单 pane 渲染使用 pane 作为 React key：

```tsx
<TerminalComponent key={`${deviceId}:${resolvedPaneId}`} ... />
```

见 [`packages/panels/src/device-console/terminal-stage.tsx:208`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:208)。

所以单 pane 切换必然是：

1. 旧 `Terminal` 卸载；
2. `TerminalSurface.dispose()`；
3. `TerminalRenderTarget.dispose()`；
4. Ghostty `terminal.dispose()`；
5. 新 `Terminal` 挂载并重新 boot。

资源释放路径见 [`packages/terminal-ui/src/components/TerminalSurface.ts:213`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/TerminalSurface.ts:213) 和 [`packages/terminal-ui/src/components/hooks/terminal-render-target.ts:128`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/terminal-render-target.ts:128)。Ghostty dispose 会释放 render state、mouse/key encoder 和 WASM terminal handle，见 [`packages/ghostty-terminal/src/terminal.ts:583`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/terminal.ts:583)。

split view 不同：

- `SplitTerminalArea` 的 key 是 `deviceId:windowId`；
- 每个 pane child 的 key 是 `deviceId:paneId`；
- 同一 window 内切换焦点时所有 pane terminal 保持挂载，只执行 `focusPane` 和 DOM focus。

见 [`packages/panels/src/device-console/terminal-stage.tsx:177`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:177)、[`packages/terminal-ui/src/components/SplitTerminalArea.tsx:118`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/SplitTerminalArea.tsx:118) 和 [`packages/terminal-ui/src/components/split/SplitPaneView.tsx:174`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/split/SplitPaneView.tsx:174)。

### 1.4 WebSocket subscription

新 `Terminal` 挂载后：

```ts
return runtime.paneSinks.registerPaneSink(deviceId, paneId, paneSink);
```

然后：

```ts
return mountPane(deviceId, paneId);
```

见 [`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:99`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:99)。

`mountPane()` 立即发送全量 `set-pane-subscriptions`；卸载 cleanup 也立即发送一次。见 [`packages/stores/src/pane-subscriptions.ts:58`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/pane-subscriptions.ts:58)。

当前 legacy gateway 的 `handleSubscribePanes()` 只做：

- 校验 pane ID；
- 更新 `session.borshState.subscribedPanes`；
- `syncLegacyPaneObservers()`；
- 刷新 observer 状态。

没有 subscribe ACK，也没有 `capture-pane`。见 [`apps/gateway/src/ws/tmux-command-handlers.ts:377`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/tmux-command-handlers.ts:377)。

当前 legacy 分支不会在新 Terminal mount 时发送 canonical `request-pane-screen` 或 cursor-history 请求，因为 `atomicScreen=false`、`cursorHistory=false`，见 [`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:111`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:111)。

### 1.5 Terminal boot、WASM 与 canvas

新实例的 boot 顺序是：

1. `loadResources()`；
2. 等待 `prepareResources`（普通 `DevicePage` 没有传入实际 callback，默认 `Promise.resolve()`）；
3. `loadTerminalFonts(fontId, fontSize)`；
4. `createTerminalController()`；
5. 创建隐藏 mount；
6. `terminal.open(mount)`；
7. 激活 render target；
8. legacy 模式下直接将 boot state 设为 `ready`。

见 [`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:223`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:223)、[`packages/terminal-ui/src/components/hooks/terminal-surface-lifecycle.ts:95`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/terminal-surface-lifecycle.ts:95) 和 [`packages/terminal-ui/src/components/hooks/terminal-render-target.ts:106`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/terminal-render-target.ts:106)。

Ghostty bindings 只加载一次：

```ts
if (!bindingsPromise) {
  bindingsPromise = instantiateGhosttyBindings();
}
return bindingsPromise;
```

见 [`packages/ghostty-terminal/src/ghostty-wasm.ts:1601`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/ghostty-wasm.ts:1601)。但每个 Terminal 仍重新执行：

```ts
bindings.createTerminal(...);
createKeyEncoder();
createMouseEncoder();
createRenderState();
```

见 [`packages/ghostty-terminal/src/terminal.ts:177`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/terminal.ts:177)。

每次 controller `open()` 会创建四个 canvas：

- `main`
- `link`
- `selection`
- `cursor`

见 [`packages/ghostty-terminal/src/canvas-renderer.ts:221`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/canvas-renderer.ts:221)。

首次 resize 会清空四个 canvas bitmap、重置 `fontVariants`，并执行 `measureText('Mg|qyÅ')`，见 [`packages/ghostty-terminal/src/canvas-renderer.ts:350`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/canvas-renderer.ts:350)。

代码中没有 glyph atlas；`resolveFont()` 只缓存四种 CSS font 字符串，见 [`packages/ghostty-terminal/src/canvas-renderer.ts:841`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/canvas-renderer.ts:841)。

每个 Terminal 请求 `TERMINAL_SCROLLBACK = 10000` 行，见 [`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:37`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:37)。Ghostty 按 576 KiB page、创建时列数换算字节预算，见 [`packages/ghostty-terminal/src/ghostty-wasm.ts:60`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/ghostty-wasm.ts:60)。

### 1.6 首屏、TERM_HISTORY 与 live output

`TerminalSurface.initialize()` 在 target 创建后立即 `activate()`，legacy 模式不等待 WS snapshot：

```ts
this.options.activate(target);
this.options.onSnapshotApplied?.(target, null);
```

见 [`packages/terminal-ui/src/components/TerminalSurface.ts:131`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/TerminalSurface.ts:131)。

因为 `atomicScreen=false`，`snapshotBootState()` 返回 `ready`，即使还没有 TERM_HISTORY：

```ts
return input.atomicScreen && !input.hasSnapshot ? { status: 'loading' } : { status: 'ready' };
```

见 [`packages/terminal-ui/src/components/hooks/terminal-surface-lifecycle.ts:70`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/terminal-surface-lifecycle.ts:70)。

因此首个 canvas paint 不被 history round trip 阻塞，但新 canvas 在 history 到达前可能是空的。boot 期间显示 `common.loading`，见 [`packages/terminal-ui/src/components/Terminal.tsx:223`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/Terminal.tsx:223)。

`TERM_HISTORY` 到达后：

1. decoder 将其变为 `legacy-history`，并用 `TextDecoder` 解码；
2. `tmux-event-router` 先尝试 pane history gate；
3. 普通 select 事务进入 `SelectStateMachine.HISTORY`；
4. 调用 `onResetTerminal`；
5. 调用 `onApplyHistory`；
6. `writeRestoredHistory()` resize、恢复 modes、写入 history、同步 `forceFullRepaint()`。

见 [`packages/ws-client/src/transport-message-decoder.ts:103`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/transport-message-decoder.ts:103)、[`packages/stores/src/tmux-event-router.ts:144`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-event-router.ts:144)、[`packages/stores/src/tmux.ts:87`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux.ts:87) 和 [`packages/terminal-ui/src/components/terminal-snapshot.ts:173`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/terminal-snapshot.ts:173)。

正常 live output 通过 render loop 的 `requestAnimationFrame()` 合并；history 的 `forceFullRepaint()` 是同步执行，见 [`packages/ghostty-terminal/src/terminal-render-loop.ts:9`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/terminal-render-loop.ts:9) 和 [`packages/ghostty-terminal/src/terminal-render-coordinator.ts:134`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ghostty-terminal/src/terminal-render-coordinator.ts:134)。

## 2. Gateway / tmux 侧

### 2.1 `TMUX_SELECT` 与 ACK

gateway 收到 `TMUX_SELECT` 后同步完成：

1. flush device output batcher；
2. 创建 switch barrier transaction；
3. 更新 `selectedPanes`；
4. 同步 legacy pane observers；
5. 发送 `SWITCH_ACK`；
6. 异步调用 `entry.runtime.selectPaneWithSize()`。

见 [`apps/gateway/src/ws/tmux-command-handlers.ts:89`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/tmux-command-handlers.ts:89)。

`SWITCH_ACK` 只是“服务端接受了选择”，不是 tmux 已完成。gateway 的 ACK timeout 是 `1500ms`，history timeout 也是 `1500ms`，见 [`apps/gateway/src/ws/borsh/switch-barrier.ts:16`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:16)。

### 2.2 tmux 操作序列

`selectPaneInternal()` 内部按顺序 await：

```text
select-window
select-pane
resize-window       （携带 cols/rows 时）
pane-active callback
display-message     （查询 screen info）
capture-pane        （通常一次；alternate 状态未知时两次，顺序执行）
requestSnapshotInternal()
```

见 [`apps/gateway/src/tmux-client/external/session-commands.ts:601`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/tmux-client/external/session-commands.ts:601)。

`fire()` 对整个异步操作使用 `void op().catch(...)`，WS handler 不等待 tmux 完成，见 [`apps/gateway/src/tmux-client/external/session-commands.ts:698`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/tmux-client/external/session-commands.ts:698)。

普通 gateway snapshot 使用 `requestSnapshotInternal() → requestImmediate()`，不会走普通结构刷新 150ms quiet period，见 [`apps/gateway/src/tmux-client/external-tmux-core.ts:675`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/tmux-client/external-tmux-core.ts:675)。

### 2.3 history capture 大小

当前 legacy capture 上限是：

```ts
MAX_PANE_HISTORY_LINES = 4096;
MAX_PANE_HISTORY_CAPTURE_BYTES = 4 * 1024 * 1024;
```

见 [`apps/gateway/src/tmux-client/control-mode-capture.ts:137`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/tmux-client/control-mode-capture.ts:137)。

历史未知 alternate 状态时会执行两次 `capture-pane`；已知状态时只执行一次，见 [`apps/gateway/src/tmux-client/external/session-commands.ts:357`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/tmux-client/external/session-commands.ts:357)。

history 发送前由 `broadcastTerminalHistory()` 把字符串转为 `Uint8Array`，然后通过 `sendTermHistory()` 分块发送，见 [`apps/gateway/src/ws/legacy-feed-broadcaster.ts:296`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/legacy-feed-broadcaster.ts:296)。

### 2.4 450ms barrier 延迟

发送 `TERM_HISTORY` 成功后，gateway 无条件注册：

```ts
setTimeout(() => {
  this.sendLiveResume(session, deviceId, expectedToken);
}, LIVE_RESUME_DELAY_MS);
```

其中：

```ts
const LIVE_RESUME_DELAY_MS = 450;
```

见 [`apps/gateway/src/ws/borsh/switch-barrier.ts:18`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:18) 和 [`apps/gateway/src/ws/borsh/switch-barrier.ts:236`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/borsh/switch-barrier.ts:236)。

这是当前代码中最明确的固定切换后延迟。

### 2.5 attach lock

普通 legacy pane 切换不重新 attach device。`DeviceConnectionRegistry.getOrCreate()` 会复用已有 `connections`，并对正在创建的同一 device 复用 `pendingConnectionEntries`，见 [`apps/gateway/src/ws/device-connection-registry.ts:94`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/device-connection-registry.ts:94)。

canonical feed 有独立的 per-device attach lock：

```ts
private readonly attaching = new Map<string, Promise<boolean>>();
```

并发 `attachDevice(deviceId)` 会等待同一个 Promise，见 [`apps/gateway/src/ws/canonical-feed-session.ts:159`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/canonical-feed-session.ts:159)。安装时执行 `attachPaneConsumer()`、`subscribe()` 和 metadata snapshot，见 [`apps/gateway/src/ws/canonical-feed-session.ts:215`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/canonical-feed-session.ts:215)。

该 lock 不在普通 legacy pane switch 的热路径上。

### 2.6 canonical cache / subarray

canonical 路径已有：

- `sendContentChunks()` 使用 `data.subarray(...)`；
- `PaneStream.sendPaneData()` 使用 `segment.data.subarray(...)`；
- metadata partition 按 `metadataEpoch/revision/maxFrameBytes` 缓存。

见 [`apps/gateway/src/ws/canonical/transaction-sender.ts:62`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/canonical/transaction-sender.ts:62) 和 [`apps/gateway/src/ws/canonical/transaction-sender.ts:216`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/ws/canonical/transaction-sender.ts:216)。

这些是 canonical 数据传输优化，不是当前 WebSocket legacy 切换的 history cache。当前浏览器 transport 没有启用 `atomicScreen/cursorHistory`。

## 3. 延迟、动画与定时器清单

| 项目 | 时序 | 是否阻塞普通切换 |
|---|---|---|
| `SELECT_SETTLE_GRACE_MS` | `2500ms` | 仅 URL pane 尚未出现在 metadata snapshot 时；不是普通 select 等待 |
| gateway ACK timeout | `1500ms` | 仅超时 fallback |
| gateway history timeout | `1500ms` | 仅 history 未到时 fallback |
| gateway `LIVE_RESUME_DELAY_MS` | `450ms` | 是，history 后固定等待 |
| select failure retry | `250ms` | 仅失败重选 |
| resize debounce | `150ms` | resize/sync 上报使用 |
| post-select resize retry | `60ms` | 新 Terminal mount 后额外补测 |
| post-select fonts | `document.fonts.ready` | Promise 完成后再补测，无固定时长 |
| `ResizeObserver` | 一次 `requestAnimationFrame` | 进入 resize debounce |
| terminal output | 最多 `4ms` 或 `32KiB` | live output 的合并窗口 |
| canonical history page | `16ms` | 仅 canonical cursor-history 分页 |
| Ghostty render loop | `requestAnimationFrame` | 普通 write 的 paint 调度 |
| synchronized output fallback | `150ms` | 仅 DECSET 2026 输出未结束时 |
| link overlay throttle | `150ms` | 只影响链接下划线，不阻塞终端首帧 |
| scrollbar fade | `3000ms` | 不阻塞切换 |
| editor input collapse | `200ms` | 输入模式动画，不是 pane 切换 |
| page content animation | 终端路由显式 `animateContent={false}` | 不存在终端页入场动画 |

resize 具体实现见 [`packages/terminal-ui/src/components/terminal-resize-scheduler.ts:8`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/terminal-resize-scheduler.ts:8) 和 [`packages/terminal-ui/src/components/terminal-resize-scheduler.ts:97`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/terminal-resize-scheduler.ts:97)。

终端页关闭入场动画见 [`apps/fe/src/main.tsx:257`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/main.tsx:257)。页面模块使用手写 loader，不是 React Suspense；device chunk 是 [`apps/fe/src/main.tsx:237`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/main.tsx:237)，同一 DevicePage 内 pane 切换不会重新加载该 chunk。

## 4. Loading / placeholder 的实际行为

有两类状态：

1. Terminal boot placeholder：

```tsx
data-testid="terminal-boot-placeholder"
...
t('common.loading')
```

见 [`packages/terminal-ui/src/components/Terminal.tsx:223`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/Terminal.tsx:223)。它等待字体加载、Ghostty controller 创建和 `open()`。

2. snapshot resolving overlay：

```tsx
t('terminal.connecting')
```

见 [`packages/panels/src/device-console/terminal-stage.tsx:85`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:85)。它只在已连接但 metadata snapshot 尚未找到目标 pane 时显示，判断条件见 [`packages/panels/src/device-console/terminal-stage.tsx:234`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:234)。

因此：

- 新实例创建期间会有明确 loading；
- history round trip 不会阻塞 legacy boot state；
- 但 history 未到时新 canvas 可能为空，用户会看到“空白/加载后才出现内容”；
- 旧 canvas 已经在 route key 改变时被销毁，不能保留旧画面作为视觉占位。

## 5. 已有 instrumentation 与历史优化

### 当前 instrumentation

没有找到 `performance.mark`、`performance.measure` 或 `PerformanceObserver` 形式的终端切换耗时埋点。

已有诊断系统会报告：

- `mount`
- `fonts_ready`
- `controller_ready`
- `opened`
- `content_written`
- `generation_activated`
- `sample_500ms`
- `sample_2500ms`
- `sample_8000ms`

以及 controller、renderer、font、buffer、canvas 尺寸和像素信息，见 [`packages/terminal-ui/src/components/terminal-diagnostics.tsx:7`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/terminal-diagnostics.tsx:7) 和 [`packages/terminal-ui/src/components/terminal-diagnostics.tsx:290`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/terminal-diagnostics.tsx:290)。

`window.__tmexE2eXterm`、`__tmexE2eTerminal`、`__tmexE2eTerminalEngine`、`__tmexE2eTerminalRenderer` 在 controller ready 时设置，见 [`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:75`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:75)。

注意：split view 中该 global 只指向最后一个 auto-focused pane；已有测试明确记录了这一点，见 [`apps/fe/tests/split-selection-persistence.spec.ts:55`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/tests/split-selection-persistence.spec.ts:55)。

WebSocket 当前已有通用 heartbeat latency 和 terminal progress 事件，但不是 switch-specific timing，见 [`packages/ws-client/src/websocket-transport.ts:29`](/Users/konata/code/tmex-enhanced-wt-r9/packages/ws-client/src/websocket-transport.ts:29)。

### round6 / round7 已完成事项

- round6 已处理 history 分页反复整屏重放、Ghostty dirty-row、canvas layer 和输出合并等热点；历史报告曾测得 22 页分页重复重放约 `522–542ms`，单次最终重放约 `45–46ms`，见 [`prompt-archives/2026083003-perf-smell-gates-round6/sub/X2-report.md:65`](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026083003-perf-smell-gates-round6/sub/X2-report.md:65)。
- round6 gateway 已给 legacy history 加行数/字节上限，并增加同 pane in-flight 合并；当前源码上限已经是 4096 行、4MiB，见 [`prompt-archives/2026083003-perf-smell-gates-round6/sub/R2-result.md:7`](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026083003-perf-smell-gates-round6/sub/R2-result.md:7)。
- round7 已完成 Ghostty mode cache、自动滚动空转消除、scrollbar 单 timer、canonical subarray、metadata partition cache 和 canonical attach lock，见 [`prompt-archives/2026083100-perf-smell-round7/plan-00-result.md:9`](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026083100-perf-smell-round7/plan-00-result.md:9)。
- 历史遗留仍包括 text-run batching / glyph atlas；该项在 round6 报告中仍是未实现项，见 [`prompt-archives/2026083003-perf-smell-gates-round6/sub/X2-report.md:86`](/Users/konata/code/tmex-enhanced-wt-r9/prompt-archives/2026083003-perf-smell-gates-round6/sub/X2-report.md:86)。
- 未发现已有“切换开始 → 首次内容 paint → live output”的专用测量报告；现有诊断无法区分 terminal boot 时间、TERM_HISTORY 到达时间和 450ms live barrier。

## 6. 测量计划

在临时实例中增加短期 instrumentation，不改生产服务：

1. 浏览器侧以 `selectToken` 关联以下 marks：

```text
tmex.switch.start
tmex.route.committed
tmex.select.sent
tmex.terminal.mount
tmex.fonts.ready
tmex.controller.ready
tmex.terminal.opened
tmex.history.received
tmex.history.applied
tmex.first.content.paint
tmex.live.resume
tmex.first.live.output
```

2. 在 gateway 记录同一 token 的：

```text
TMUX_SELECT received
SWITCH_ACK sent
select-window start/end
select-pane start/end
resize-window start/end
display-message start/end
capture-pane start/end
TERM_HISTORY sent
LIVE_RESUME sent
history bytes / lines / alternateScreen
```

3. 分别测量：

```text
switch.start → controller.ready
switch.start → opened
switch.start → first content paint
switch.start → live.resume
switch.start → first live output
```

“first paint”必须区分：

- canvas 已创建但内容为空；
- `TERM_HISTORY` 写入后的非空内容 paint。

4. 使用 `window.__tmexE2eXterm` 检查单 pane 切换前后对象 identity；预期单 pane identity 改变，split 同 window focus identity 不改变。split 不应依赖该 global，应按 `[data-pane-id]` 查询各实例。

5. 对比四组场景：

- warm WASM/font，单 pane 本地切换；
- cold page，单 pane 本地切换；
- split 同 window focus；
- split 跨 window 切换。

同时记录 history 字节数、是否 alternate 未知导致双 capture、canvas 尺寸和每次 resize 数量。

## 7. 优化候选排序

1. **保留最近 pane 的 Terminal/Suface 实例，切换时隐藏而不是销毁。**  
   预期影响最大，可消除 Ghostty handle、render state、canvas、font measurement 和 boot placeholder。风险是每 pane 的 WASM scrollback/canvas 内存、输入焦点、subscription 和 eviction 策略。

2. **移除或缩短 history 后固定的 `450ms LIVE_RESUME`。**  
   代码上存在明确的至少 450ms live handoff 延迟。风险是 history 与实时输出顺序、旧输出残留和 barrier race，需要保持 token/输出门控语义。

3. **将 legacy select 迁移到 atomic screen/canonical snapshot，或至少并行化/减少 tmux capture。**  
   可减少多条顺序 tmux 命令和 history 重放等待。风险最高，涉及协议能力协商、alternate screen、cursor/modes 和客户端兼容性。

4. **对最近 pane 做 history/screen 预取或短期缓存。**  
   可减少重复 `display-message + capture-pane`，尤其适合用户来回切换。风险是 stale snapshot、pane epoch/resize 后失效和内存上限。

5. **合并首次 boot resize 与 history 后 post-select resize。**  
   当前新 Terminal mount 会立即 sync，并在 `60ms`、字体 ready 后继续补测；gateway select 还可能先执行 `resize-window`。需要先用 marks 确认是否产生重复 resize，再决定合并，风险中等。

6. **字体加载缓存命中时不阻塞 Terminal controller 创建。**  
   `loadTerminalFonts()` 本身幂等且浏览器有缓存，但每次新 Terminal boot 仍 `await` 它。预期中等，风险是字体度量变化导致列数、canvas 和 tmux 尺寸暂时不一致。

7. **text-run batching / glyph atlas。**  
   可降低大面积 canvas repaint CPU，但 round6 的现有 benchmark 已显示渲染桥约 `1ms` 级，预计不是当前切换 wall-clock 的首要来源。风险是宽字符、组合字符和装饰渲染正确性。

8. **减少 subscription 发送次数。**  
   当前 subscribe 本身只是内存集合更新，没有 gateway capture 或 ACK，因此预计收益低，不应优先于实例复用和 450ms barrier。