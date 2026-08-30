# 终端分屏关闭后“连接设备中”卡顿诊断

## 结论先行

最可能的根因不是设备真的断线，而是：

1. 关闭当前焦点 pane 后，URL 仍指向已删除的 pane。
2. 新快照已经删除该 pane，但前端有固定 `2500ms` 的选择稳定宽限期。
3. 宽限期内 `isSelectionInvalid` 仍为 `false`，而 `selectedPane` 已不存在，于是 `TerminalStage` 显示 `terminal.connecting`。
4. 两 pane 场景下，分屏切成单 pane 后甚至可能暂时重新挂载“已被 kill 的 pane”，再次触发该 pane 的订阅。
5. 如果后端快照、选择流或 WebSocket/SSH 恰好变慢，卡顿可从约 2.5 秒扩大到 5～10 秒甚至更久。

另外，代码显示顶部右侧按钮实际发送的是 `split-pane`，创建的是当前 tmux window 内的新 pane，不是 `create-window`。

---

## 1. 分屏按钮与布局模型

### 分屏按钮

`packages/panels/src/device-console/device-console-toolbar.tsx:40-58,110-116` 创建 right/down 两个按钮，最终调用：

```ts
model.onSplitPane('right' | 'down');
```

`packages/panels/src/device-console/use-device-console-actions.ts:108-114`：

```ts
const onSplitPane = useCallback(
  (direction: SplitDirection) => {
    if (!deviceId || !resolvedPaneId) return;
    runtime.stores.tmux.getState().splitPane(
      deviceId,
      resolvedPaneId,
      direction,
      currentPath
    );
  },
  [deviceId, resolvedPaneId, currentPath, runtime]
);
```

`packages/stores/src/tmux.ts:315-318`：

```ts
splitPane(deviceId, paneId, direction, cwd) {
  if (!deviceId || !paneId) return;
  core.transport.send({ type: 'split-pane', deviceId, paneId, direction, cwd });
}
```

`packages/ws-client/src/message-builder.ts:263-275` 把 `right/down` 编码为方向值；网关最终调用 tmux `split-window`，见 `apps/gateway/src/tmux-client/external/session-commands.ts:545-552`。

真正的 `create-window` 是另一条路径：

```ts
// packages/stores/src/tmux.ts:241-246
core.transport.send({ type: 'create-window', deviceId, name, cwd });
set(...pendingCreateWindowAt...);
```

因此，顶部右侧 split 按钮没有：

- 创建 tmux window；
- 本地新增布局 slot；
- 本地导航；
- 本地修改 snapshot。

### 布局与 pane slot

`packages/terminal-ui/src/components/SplitTerminalArea.tsx:1-12` 明确说明 tmux layout 是真相源。

`packages/terminal-ui/src/components/split/useSplitGeometry.ts:32-50`：

```ts
const layout = useMemo(
  () => (tmuxWindow.layout ? parseWindowLayout(tmuxWindow.layout) : null),
  [tmuxWindow.layout]
);

const geometry = useMemo(() => {
  if (!layout) return null;
  return computeSplitLayoutGeometry(layout.root, { width: 1, height: 1 });
}, [layout]);
```

`SplitTerminalArea` 根据 `geometry.panes` 渲染 pane，见 `packages/terminal-ui/src/components/SplitTerminalArea.tsx:105-115`。

没有独立的本地 split-layout slot store。pane slot 的生命周期是：

```text
tmux snapshot.window.panes
    → layout geometry
    → React SplitPaneView
```

`knownPaneIdsKey` 也直接来自当前 window 的 pane 列表，见 `useSplitGeometry.ts:66-74`。

---

## 2. 关闭路径与执行顺序

### 分屏内关闭 pane

分屏标题栏的 close 控件只有这一条逻辑：

`packages/terminal-ui/src/components/split/SplitPaneView.tsx:147-157`

```tsx
onClick={(event) => {
  event.stopPropagation();
  closePane(deviceId, paneId);
}}
```

`packages/stores/src/tmux.ts:264-267`：

```ts
closePane(deviceId, paneId) {
  if (!deviceId || !paneId) return;
  core.transport.send({ type: 'close-pane', deviceId, paneId });
}
```

网关收到后进入：

- `apps/gateway/src/ws/tmux-kind-handlers.ts:43-52`
- `apps/gateway/src/ws/tmux-command-handlers.ts:208-228`
- `apps/gateway/src/tmux-client/external/session-commands.ts:159-161`

```ts
closePane(paneId: string): void {
  this.fire(() => this.runAndRefresh(['kill-pane', '-t', paneId], true));
}
```

`runAndRefresh` 的顺序是：

`apps/gateway/src/tmux-client/external/session-commands.ts:470-473`

```ts
await this.runTmux(argv, allowTargetMissing);
await this.host.requestSnapshotInternal();
```

所以实际顺序为：

```text
点击 close
  → 发送 close-pane
  → tmux kill-pane
  → 请求完整 snapshot
  → 广播新 snapshot
  → React 依据新 pane 列表移除 pane
  → React unmount 后 unregister sink / release mount subscription
```

重要的是：

- close 按钮没有先导航到其他 pane；
- 没有本地删除 pane slot；
- 没有显式 unsubscribe；
- unsubscribe 是 React 看到 snapshot 删除 pane 后的 unmount 副作用；
- `fire()` 是 fire-and-forget，调用方不等待异步完成，见 `session-commands.ts:665-672`。

### 关闭 window

分屏区域本身没有 `close-window` 控件；侧边栏关闭 window 使用：

`packages/panels/src/device-tree/sidebar-device-list.tsx:100-107`

```ts
if (deviceId === selectedDeviceId && windowId === selectedWindowId) {
  handleNavigate(hostAppPath(host, '/devices'));
}
closeWindow(deviceId, windowId);
```

也就是当前 window 关闭时：

```text
先导航到 /devices
  → 再发送 close-window
```

后端关闭 window 时，如果这是最后一个 window，会先创建替代 window，再 kill 原 window：

`apps/gateway/src/tmux-client/external/session-commands.ts:475-500`

```ts
const count = await ... '#{session_windows}';

if (count <= 1) {
  await this.runTmux(['new-window', '-d', ...]);
}

await this.runAndRefresh(['kill-window', '-t', windowId], true);
```

这种侧边栏路径已经提前离开旧路由；但外部 tmux 删除 window、其他入口关闭当前 window，则仍可能经过前端的 2.5 秒路由宽限逻辑。

---

## 3. “连接设备中”状态来源

### 终端中心的直接来源

`packages/panels/src/device-console/use-console-targets.ts:34-69` 从 tmux store 得到：

```ts
const deviceConnected = state.deviceConnected[deviceId] ?? false;
const windows = snapshot?.session?.windows;
const selectedWindow = windows?.find((win) => win.id === windowId);
const selectedPane = selectedWindow?.panes.find(
  (pane) => pane.id === resolvedPaneId
);
```

`packages/panels/src/device-console/terminal-stage.tsx:227-234`：

```ts
const isResolvingSnapshot =
  props.deviceConnected &&
  Boolean(props.resolvedPaneId) &&
  !props.selection.isSelectionInvalid &&
  !props.selectedPane;
```

为 `true` 时渲染 `ResolvingOverlay`：

`terminal-stage.tsx:25-34,85-100`：

```tsx
<Loader2 ... />
<h3>{t('terminal.connecting')}</h3>
```

因此，关闭当前 pane 后最典型的状态是：

```text
deviceConnected = true
resolvedPaneId = 已被 kill 的 pane
selectedPane = undefined
isSelectionInvalid = false（宽限期内）
```

这会直接显示“连接设备中”。

### 2.5 秒宽限期

`packages/panels/src/device-console/use-pane-selection-state.ts:81-109`：

```ts
const { missingSelectionKey } = resolveMissingSelection(...);

useEffect(() => {
  setSettledMissingKey(null);
  if (!missingSelectionKey) return;

  const timer = window.setTimeout(
    () => setSettledMissingKey(missingSelectionKey),
    SELECT_SETTLE_GRACE_MS
  );

  return () => window.clearTimeout(timer);
}, [missingSelectionKey]);

const isSelectionInvalid =
  missingSelectionKey !== null &&
  settledMissingKey === missingSelectionKey;
```

`SELECT_SETTLE_GRACE_MS` 为 `2500ms`，见同文件 `:15-16`。

宽限期结束后，`use-pane-route-reconciliation.ts:43-73` 才会调用 `resolveRouteTarget` 并导航到剩余 pane：

```ts
if (action.kind === 'navigate') {
  navigateToPane(deviceId, action.windowId, action.paneId);
}
```

`selection-recovery.ts:53-107` 的规则是：

- 快照尚未稳定时 stay；
- pane 确认消失后回落到同 window 的 active/第一个 pane；
- 没有 window 时离开设备页。

### 一个额外的危险状态

如果原来只有两个 pane，关闭当前焦点 pane 后，剩余 window 只有一个 pane：

- `resolveSplitView` 不再进入 split；
- `TerminalStage` 可能进入单 pane分支；
- 但 URL 仍然是已删除的 pane；
- 在 2.5 秒宽限期内，仍可能挂载：

```tsx
<TerminalComponent
  paneId={resolvedPaneId}
/>
```

见 `terminal-stage.tsx:201-222`。

这会暂时把已删除 pane 再次注册为活动 terminal，进一步产生无效订阅或历史请求。

### deviceConnected 的真实变更路径

`packages/stores/src/tmux-event-router.ts:51-69`：

- `device-connected` 设置 `deviceConnected[id] = true`；
- `device-disconnected` 设置 `false`，并清理 terminal sink。

`packages/stores/src/tmux-device-events.ts:86-99`：

- 设备事件 `disconnected` 设置 `false`；
- `reconnected` 设置 `true`；
- `errorType === 'reconnecting'` 只设置 `deviceReconnecting`，不会直接把 `deviceConnected` 改成 `false`，见 `:35-45,67-74`。

kill pane/window 本身没有调用 `disconnectDevice`。因此，“关闭 pane 导致设备连接状态真的变 false”不是默认路径。

### 其他连接 UI

`packages/panels/src/device-connection.ts:1-7` 只是连接状态类型定义，不负责终端状态推导。

设备列表连接状态：

`apps/fe/src/components/device-connection-status.ts:46-67`

```ts
if (isDeviceConnected(...)) return 'connected';
if (snapshot.connectedDevices.has(deviceId)) return 'connecting';
return 'disconnected';
```

pending connect 最长等待 `8000ms`，见 `:90-104`。这属于设备列表/连接意图 UI，不是 terminal-stage 中心 overlay。

`packages/panels/src/device-status-badge.tsx:26-67` 只显示 reconnecting/error，不显示普通 connecting。

`packages/panels/src/connection-indicator.tsx:10-16` 显示的是整个 WebSocket 的连接阶段，不是 pane 快照解析状态。

### Stream、unsubscribe、resubscribe

pane 的订阅集合是：

`packages/stores/src/pane-subscriptions.ts:10-18,30-46`

```ts
当前订阅 = manual subscriptions ∪ mounted panes
```

pane mount 时发送全量订阅；unmount release 时再次发送全量订阅：

`pane-subscriptions.ts:58-75`。

terminal 的 React cleanup 负责：

- `registerPaneSink` / unregister；
- `mountPane` / release。

见 `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:99-109`。

`packages/stores/src/tmux-event-router.ts:161-177` 收到 subscription rejected 时会对 pane 做 rebase，但不会把设备标记为 disconnected，也不会自动改 URL。

默认浏览器传输是非 atomic screen：

`packages/ws-client/src/websocket-transport.ts:15-23`

```ts
atomicScreen: false,
serverSelection: true,
```

因此默认路径主要是旧的 pane subscription/select 流程；canonical `NOT_FOUND` 路径只在 shared transport 场景更相关。

### 快照刷新与定时器

关闭 pane 后快照会并发执行：

`apps/gateway/src/tmux-client/external/snapshot-projector.ts:242-267`

```ts
Promise.all([
  display-message,
  list-windows,
  list-panes,
]);
```

快照成功后替换 window/pane 集合并广播：

`snapshot-projector.ts:293-307`。

`SnapshotRefreshCoordinator` 只做并发刷新合并，不做退避：

`apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts:1-29`。

当前没有针对 active pane 的 per-client snapshot polling；已有测试明确验证：

`apps/gateway/src/ws/index.test.ts:293-325`。

可能造成延迟的现有时间参数：

- 选择 settle grace：`2500ms`；
- select ACK timeout：`1500ms`；
- select progress timeout：`5000ms`；
- select reselect retry：`250ms`；
- WebSocket heartbeat：每 `5000ms`；
- PONG timeout：`10000ms`；
- WebSocket 重连：`1s, 2s, 4s...`，上限 `30s`；
- SSH 重连：站点配置的 `sshReconnectDelaySeconds`，见 `apps/gateway/src/ws/device-connection-registry.ts:278-349`。

---

## 4. 根因排行与确认方式

### 1）最可能：关闭当前 pane 后 URL 指向 stale pane

证据：

- close 没有导航：`SplitPaneView.tsx:147-157`；
- snapshot 删除 pane 后 `selectedPane` 变成 `undefined`：`use-console-targets.ts:59-69`；
- 2.5 秒内 `isSelectionInvalid` 仍为 `false`：`use-pane-selection-state.ts:95-109`；
- `TerminalStage` 对“已连接但 snapshot 中没有 selectedPane”显示 connecting：`terminal-stage.tsx:227-257`；
- 2.5 秒后才由 route reconciliation 回落：`use-pane-route-reconciliation.ts:43-73`。

确认方法：

记录以下时间点：

```text
close click
→ outbound close-pane
→ gateway kill-pane 完成
→ metadata-snapshot 到达
→ terminal-status-overlay 出现/消失
→ URL 改为剩余 pane
```

如果出现：

```text
deviceConnected 始终为 true
selectedPane 短暂为 undefined
URL 仍为旧 pane
overlay 约 2500ms 后消失
```

即可确认。

### 2）较可能：后端快照延迟与 React unmount/订阅竞态

证据：

- close 是异步 fire-and-forget：`session-commands.ts:665-672`；
- kill 后还要等待完整 snapshot：`session-commands.ts:470-473`；
- snapshot 同时执行多条 tmux 查询：`snapshot-projector.ts:242-267`；
- 没有客户端轮询兜底：`apps/gateway/src/ws/index.test.ts:293-325`；
- 两 pane 变单 pane时，stale route 可能重新挂载已删除 pane，触发 `mountPane`：`terminal-stage.tsx:201-222`、`usePaneSinkRegistration.ts:106-109`。

确认方法：

在 gateway 记录 `kill-pane`、snapshot 开始、snapshot 广播的耗时。若 overlay 出现时间主要来自 snapshot 未更新，而不是固定 2.5 秒，则属于该候选。

### 3）次可能：stale selectedPanes 触发 select 超时/重试

证据：

`packages/stores/src/tmux-selection-actions.ts:67-103` 会先乐观写入：

```ts
selectedPanes[deviceId] = { windowId, paneId };
```

网关发现 pane 已不存在时只拒绝并请求 snapshot：

`apps/gateway/src/ws/tmux-command-handlers.ts:61-83`。

非 atomic select 流会等待：

- ACK `1500ms`；
- progress `5000ms`；

见 `packages/ws-client/src/state-machine.ts:177-203,288-345`。

失败后部分 reason 会在 `250ms` 后重选：

`packages/stores/src/tmux-selection-actions.ts:120-132`。

确认方法：

查找：

```text
[ws] rejecting missing tmux pane id
[select-sm] Timeout at ack
[select-sm] Timeout at live
```

并确认是否在关闭之后又发送了同一 stale pane 的 `select-pane`。

### 4）条件性候选：canonical transport 的 NOT_FOUND/rebase

`apps/gateway/src/ws/canonical/subscription-coordinator.ts:37-55` 会把不存在的 pane 标记为 `SUBSCRIPTION_REJECTED_NOT_FOUND`。

但客户端当前将 rejected pane 统一映射为 `resource_exhausted` rebase：

`packages/stores/src/tmux-event-router.ts:161-165`。

这更可能造成 terminal 内容重新 rebase，而不是设备连接状态变 false。且默认 WebSocket transport 是 `atomicScreen: false`，所以不是首要嫌疑。

确认方法：

检查当前运行时是否使用 `transport.kind === 'shared'`，以及是否出现：

```text
SubscriptionApplied.rejectedPaneIds
ERROR_TMUX_TARGET_NOT_FOUND
```

### 5）较低可能：真实 WebSocket/SSH/control reconnect

关闭 pane 本身没有设备断开调用，因此只有同时出现下列证据时才应提升该候选：

- `deviceConnected` 变成 `false`；
- `device-disconnected` 事件；
- `deviceReconnecting` 出现；
- WebSocket 进入 `RECONNECT_BACKOFF`；
- heartbeat PONG timeout；
- gateway control/SSH connection close。

否则，设备连接本身不是根因。

---

## 5. 最小稳健修复建议

### 候选 1：关闭当前 pane 前立即选择 fallback

建议修改：

- `packages/terminal-ui/src/components/split/SplitPaneView.tsx`
- `packages/panels/src/device-console/use-device-console-actions.ts` 或新增 panel 层 close action
- `packages/panels/src/device-console/use-pane-route-reconciliation.ts`
- `packages/panels/src/device-console/selection-recovery.ts`

策略：

1. 如果关闭的不是当前 URL pane，只发送 `close-pane`。
2. 如果关闭的是当前 URL pane，先根据当前 snapshot 选择同 window 的 active/第一个剩余 pane，并立即导航。
3. 若 window 没有剩余 pane，导航到其他 window；没有其他 window 则导航 `/devices`。
4. 再发送 `close-pane`。
5. 对外部删除仍保留 2.5 秒 grace，避免深链在快照传播期间被误改写。

这能直接消除“URL 指向已删除 pane + connecting overlay”的主路径。

### 候选 2：避免 stale route 期间重新订阅已删除 pane

建议修改：

- `packages/panels/src/device-console/terminal-stage.tsx`
- `packages/stores/src/pane-subscriptions.ts`
- `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts`

在明确收到 snapshot 且确认当前 pane 消失后，不要继续挂载 stale `Terminal`；应进入 invalid/recovery 分支，等待或导航到 fallback。

不要伪造本地 snapshot。tmux snapshot 仍应保持唯一真相源。

### 候选 3：snapshot 删除 pane 时取消 stale selection transaction

建议修改：

- `packages/stores/src/tmux-selection-actions.ts`
- `packages/stores/src/tmux-event-router.ts`
- `packages/ws-client/src/state-machine.ts`
- 必要时 `apps/gateway/src/ws/tmux-command-handlers.ts`

当 metadata snapshot 删除当前 selected pane 时：

- 取消该 pane 的 select transaction；
- 清除或 rebasing `selectedPanes`；
- `NOT_FOUND` 不进入普通 retry；
- 直接交给 route recovery 选择 fallback。

### 候选 4：保留 NOT_FOUND 原因，不统一转成 resource_exhausted

建议修改：

- canonical transport event/type；
- `packages/stores/src/tmux-event-router.ts`；
- `packages/ws-client/src/pane-sink-registry.ts`。

`NOT_FOUND` 应表示目标已被删除并触发路由恢复；`resource_exhausted` 才表示流量/资源问题。两者不应共用同一 rebase 语义。

### 候选 5：仅在日志确认后处理 reconnect

若确实观察到 heartbeat 或 SSH reconnect，修改范围应集中在：

- `packages/ws-client/src/client.ts`
- `packages/ws-client/src/heartbeat-controller.ts`
- `packages/ws-client/src/reconnect-controller.ts`
- `apps/gateway/src/ws/device-connection-registry.ts`

不建议为关闭 pane 单独绕过这些定时器；应先确认是 tmux command failure 误触发了设备 reconnect。

---

## 6. 现有测试覆盖情况

已有相关测试：

- 分屏创建/选中：`apps/fe/tests/split-screen-desktop.spec.ts:61-87,159-198`
- 选择恢复与 2.5 秒宽限：`packages/panels/src/device-console/selection-recovery.test.ts:105-201`
- 分屏选择规则：`packages/panels/src/device-console/pane-selection-rules.test.ts`
- pane mount/release 全量订阅：`packages/stores/src/tmux-shared-transport.test.ts:77-109`
- device connect/disconnect 清理：`packages/stores/src/tmux-event-router.test.ts:185-240`
- select retry 与 rejected 行为：`packages/stores/src/tmux-reselect-retry.test.ts:125-197`
- kill-window / split-pane：`apps/gateway/src/tmux-client/external/session-commands.test.ts:267-324`
- snapshot pane/window closure：`apps/gateway/src/tmux-client/local-external-connection.test.ts:1604-1674`
- canonical unknown pane：`apps/gateway/src/ws/canonical-feed-session.test.ts:458-490`
- WebSocket heartbeat/reconnect：`packages/ws-client/src/heartbeat-controller.test.ts`、`reconnect-controller.test.ts`、`connection.test.ts`

目前缺少最关键的回归测试：

```text
分屏中关闭当前焦点 pane
→ 快照删除该 pane
→ URL 自动切换到剩余 pane
→ 不出现 terminal-status-overlay
→ 不发送 stale pane 的再次订阅/select
```

建议优先补充该 E2E 测试。