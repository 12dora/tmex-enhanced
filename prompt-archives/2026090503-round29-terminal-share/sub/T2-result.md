# T2 结果：后端 ws 分享隔离

范围：`apps/gateway/src/ws/**`（未改动任何其他目录的文件）。

## 一、新增文件

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/ws/share-scope.ts` | 从 `@tmex/shared/share` 再导出 `ShareScope`；按快照对象身份缓存的 pane→window 索引（`paneWindowId` / `isPaneInShareScope`）；`SharePaneOracle` 类型。快照未就绪一律判越权（fail-closed）。 |
| `apps/gateway/src/ws/share-gate.ts` | 入站白名单（`shareKindPolicy` / `shareDecodedInScope`）、`SHARE_FORBIDDEN_CODE=1501` + `SHARE_FORBIDDEN_MESSAGE='SHARE_FORBIDDEN'`、输入录制分发（`recordShareCommand`）、设备侧广播的可见性过滤（`shareVisibleClients`）。 |
| `apps/gateway/src/ws/share-metadata-filter.ts` | 纯函数出站过滤：`filterMetadataRecordsForShare` / `filterSnapshotForShare` / `filterMetadataForShare` / `filterCanonicalEventForShare`。 |
| `apps/gateway/src/ws/share-session-index.ts` | 按 shareId 索引分享连接：`add/remove/count/closeAll`、scope 判定（`paneInScope`/`paneOracle`/`visibleClients`/`filterEvent`）、与分享服务的 `onEnded`/`setViewerCounter` 挂钩。关闭码 4410 / `SHARE_ENDED`。 |
| `apps/gateway/src/ws/share-hooks.ts` | 分享服务接线口：默认走 `apps/gateway/src/share/share-service` 的 `getShareService()`（T1 已落地，已切成真实 import），测试可用 `setShareWsServiceResolver` 顶替。 |
| `apps/gateway/src/ws/canonical/share-guard.ts` | canonical 会话内的 scope 守卫：`allowsDevice` / `allowsPane` / `partitionSubscriptions`。 |
| 测试 | `share-gate.test.ts`、`share-metadata-filter.test.ts`、`share-session.test.ts`、`share-canonical.test.ts` |

## 二、改动的既有文件（均在 ws/ 内）

- `gateway-session.ts`：`shareScope?: ShareScope`。
- `types.ts`：`GatewaySocketData.shareScope?: ShareScope`（升级时带 scope 的零改动通道）。
- `index.ts`：`handleOpen(ws, { shareScope? })` / `attachStreamSession(carrier, { shareScope? })`；`closeShareSessions(shareId, code=4410, reason='SHARE_ENDED')`、`countShareSessions(shareId)`、`sharePaneOracle(session)`；canonical 会话注入 `shareScope`/`isPaneInShareScope`，出站事件统一过 `shareIndex.filterEvent`；`closeSession` 摘除索引；HELLO 时分享连接**不**注册 agent ws hub。
- `borsh-dispatcher.ts`：解码前按 kind 拒绝，解码后按 scope 判定；越权回 `KIND_ERROR`（code 1501 / message `SHARE_FORBIDDEN`）**不断开**；通过后调用 `recordShareCommand` 记录输入/尺寸。新增导出类型 `BorshDispatchGateHost`。
- `canonical-feed-session.ts`：`attachDevice` / `ensureDevice` 只认 scope 设备（`bootstrapInitialDevices` 因此自动收敛）；`resolveTarget` 增加 pane-in-window 判定，失败回既有 `ERROR_TMUX_TARGET_NOT_FOUND`；`handleSetPaneSubscriptions` 先按 scope 分流，越权 pane 以 `SUBSCRIPTION_REJECTED_NOT_FOUND` 出现在 `SubscriptionApplied.rejected`。
- `canonical/types.ts`：`CanonicalFeedSessionOptions` 增加 `shareScope` / `isPaneInShareScope`。
- `theme-settings-broadcaster.ts`：`SITE_THEME_UPDATE` / `SETTINGS_UPDATE` / `NOTIFY_EVENT` 三处广播跳过分享连接（保留在 `connectedClients` 里以免影响指标与关闭簿记）。
- `device-feed-broadcaster.ts`：`DeviceFeedHost` 增加 `shareIndex`；tmux 事件（bell/notification/generic）、`CLIPBOARD_WRITE`、`DEVICE_EVENT` 只在事件 pane 属于 scope window 时投递给分享连接，无 pane 归属的一律不发。
- `device-feed-broadcaster.test.ts`：fake host 补 `shareIndex` 字段。

## 三、白名单（分享连接）

放行：HELLO / PING / PONG / ERROR / CHUNK（分发前处理）；`DEVICE_CONNECT`、`DEVICE_DISCONNECT`（仅 scope.deviceId）；`TERM_INPUT`、`TERM_PASTE`、`RESIZE_PANE`、`TERM_VIEWPORT`（scope 设备 + scope window 内 pane）；`TMUX_SELECT`、`FOCUS_PANE`（**按指挥官指示新增**，windowId 必须是 scope.windowId、paneId 必须在 scope window 内）；`CANONICAL_COMMAND`（订阅命令只按设备判定，pane 级由 canonical 会话回 NOT_FOUND；其余变体要求 pane target 在 scope 内）。
其余全部拒绝，含 `SET_WINDOW_STYLE`、`SPLIT/CLOSE/MOVE/BREAK/RENAME/REORDER_*`、`APPLY_STACKED_LAYOUT`、`AGENT_*`、`SITE_THEME_UPDATE`。

出站：`SourceMetadataSnapshot/Patch` 只留 device/server/session 骨架（剥掉设备名、会话名）+ scope window + 其 pane（保留 layout / 几何 / pane_epoch / tree_order，分屏可正常渲染）；pane 被移出 window 的 upsert 转成 removal，移入的随 upsert 下发；scope 外 pane 的 `PaneData` 直接丢弃；`WATCH_EVENT` / `AGENT_EVENT` 靠不注册 agent hub 阻断，`NODE_EVENT` 只发给 mesh socket（与 gateway session 无关），主题/设置/通知广播已排除。

## 四、给其他 agent 的接线点

- **T3**：本机升级路径可在 `server.upgrade(req, { data: { ..., shareScope } })` 里带上 scope，`gw.open(ws)` 无需改签名即可登记；Hub 转发路径用 `wsServer.attachStreamSession(carrier, { shareScope })`。也可显式调 `wsServer.handleOpen(ws, { shareScope })`（`GatewayRuntime['websocket'].open` 的签名未动，需要透传参数时请自行加可选形参）。
- **T5**：越权回的是 `KIND_ERROR`，`code = 1501`、`message = 'SHARE_FORBIDDEN'`、`retryable = false`，socket 不断开；分享终止/到期的关闭码是 `4410`、reason `SHARE_ENDED`。
- **T1**：`onEnded` / `setViewerCounter` 在**第一条分享连接接入时**才挂钩（ws 层早于分享服务装配，且避免每个 `new WebSocketServer()` 都构造 ShareService 触库）；没有分享连接时 viewer 计数保持 0，语义一致。

## 五、验证

- `cd apps/gateway && bun test src/ws`：**344 pass / 0 fail**（1941 expect，37 文件）。
- `cd apps/gateway && bunx tsc --noEmit -p .`：`src/ws/**` 0 错（仓库其余报错来自 T1/T3 在写的 `src/share/**`、`src/mesh/**`，不属本任务）。
- `bunx biome check apps/gateway/src/ws`：clean（86 文件）。
- `bun scripts/complexity/gate.ts`：`apps/gateway/src/ws/**` 0 违规，**未新增/未放宽任何 allowlist 条目**。剩余违规全部在 mesh / assemble-routes / fe share-tab（其他 agent 范围）。
- 旁证回归：`bun test src/tmux-client src/agent` 1016 pass / 0 fail；`bun test src/mesh` 1330 pass / 0 fail。

## 六、与契约的偏差 / 遗留

1. **`DEVICE_CONNECTED` 快照过滤无对象**：现网 `DeviceConnectedSchema` 只有 `{ deviceId }`，状态快照早已不随该帧下发（`device-feed-broadcaster.ts` 注释「快照只作为网关内部状态…不再下发给客户端」）。因此该项落在 `SourceMetadataSnapshot/Patch` 上实现，未新增 DEVICE_CONNECTED 过滤。
2. **「撤销订阅」的实现方式**：`PaneRetentionConsumerLease` 只有整集合 `applySubscriptions`，服务端自行重放会与客户端的 generation 契约冲突（`PaneSubscriptionGenerationConflictError`）。因此 pane 离开 window 时采用「出站 `PaneData` 直接丢弃 + 向客户端下发该 pane 的 removal」，效果等价且更严格（数据不会外流），但 retention 侧的订阅条目会保留到客户端下一次 `SetPaneSubscriptions`。
3. **`SHARE_FORBIDDEN` 错误码**：`packages/shared/src/ws-borsh/errors.ts` 属本任务禁改范围，故在 `share-gate.ts` 内定义网关私有码 `1501` 并固定 message；若后续要收进共享错误码表，只需把常量改成引用。
4. **Screen / History 事务不做出站 pane 过滤**：其请求已在 `resolveTarget` 处按 scope 拦截，中途丢 `ScreenBegin` 会留下悬空的 chunk/commit，故不在出站再过滤一次。
5. **无 pane 归属的设备事件（disconnected / reconnecting / error）不发给分享连接**（按契约「只放行 scope 内 pane 的事件」执行）。若产品上希望被分享人能看到「设备已断开」，需要单独定义一条不含设备信息的提示帧。
6. **文件行数余量吃紧**：`canonical-feed-session.ts` 680 行（allowlist 上限 682）、`index.ts` 847 行（上限 871）。后续再往这两个文件加代码前需要先拆分。
