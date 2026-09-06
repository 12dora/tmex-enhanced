# N1 结果（Opus 子代理）：多节点通知后端

- 设计偏离（指挥官已接受）：key-log 仅 root/passkey 可签，节点无法自签；汇聚声明改走节点状态 `inventory { version, notifySink?: true }`（hub node.list / 中继密封 status / 直连 peer.status 三路），无新协议帧、无迁移。代价：被攻破的 hub 可伪造 sink 标记（中继模式免疫）；文档已明示。
- 新增：`mesh/notification-sink-state.ts`（gateway_kv 开关）、`notification-sink-set.ts`、`notification-mesh-bridge.ts`、`notification-bridge-wiring.ts`、`mesh-internal-notifications-routes.ts`（对端标记、未知节点 403、关闭 404、60/min 429、事件类型白名单、以标记覆盖 payload.nodeId/nodeName、替换为 sink 自身 site 以生成深链）、`events/mesh-forward-queue.ts`（合并键 nodeId:deviceId:paneId:eventType、上限 20、TTL 3 min）、`events/mesh-forwarder.ts`（每 sink 单在途、退避 1/2/4/8→15 s、非 429 的 4xx 直接丢弃）、`events/channels/mesh-forward.ts`、`api/notifications-mesh-routes.ts`。
- 契约 `packages/shared/src/contracts/mesh-notifications.ts`；`EVENT_TYPES/isEventType`；节流键 `<nodeId|local>:<deviceId>:<paneId>`；带 `payload.nodeId` 的事件一律不转发（覆盖远程 agent 重复与多 sink 环路）。
- 文档 `docs/notify/2026090603-mesh-notification-sink.md`。验证：六包 tsc 0；gateway 4879/10（9 环境性 + 1 负载抖动）；shared 795/0；api-client 246/0；门禁 ok；新测试 40。
