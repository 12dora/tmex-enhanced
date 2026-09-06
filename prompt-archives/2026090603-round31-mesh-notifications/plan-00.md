# Round 31 计划：多节点通知汇聚（A）+ 范围加固（C）

## 设计
### 汇聚声明（sink）
- 汇聚机在「设置 → 通知」新卡片「多节点通知」打开开关「接收其它节点的通知」。
- 开关状态作为 mesh 配置广播：走现有 key-log 签名记录机制（参考 `rename-node` 记录）新增记录类型 `notification-sink`（`{nodeId, enabled, at}`），所有节点据此维护 sink 集合（可多台）。standalone 不显示卡片。
### 节点侧转发
- `EventNotifier.notify()` 之后（或作为一个内置 channel `mesh-forward`）把事件投递给每个 sink（排除自身）：`POST /n/<sinkId>/api/mesh-internal/notifications`（经现有 Forwarder + 对端标记，仿 `mesh-internal-tmux-routes.ts` 的 `requirePeerMarker`），body = 序列化的事件 + `origin: {nodeId, nodeName}`。
- 离线/失败：每个 sink 一条有界队列，上限 20 条、3 分钟；入队按 `nodeId+deviceId+paneId+eventType` 合并只留最新；指数退避重试（1/2/4/8 s，封顶 15 s）；超限/过期丢弃并记日志 `[notify] forward dropped`。
- 本地行为不变：节点自身通道照常发。不转发 `ws-broadcast`（浏览器）之外的任何变化；转发的是原始事件。
### 汇聚机侧
- 路由校验对端标记 + 节点在线集合成员 + 限流（复用 uplink 限流思路，每来源节点每分钟 60 条）。
- 收到后调用本机 `eventNotifier.notify(eventType, event)`，payload 打上 `nodeId/nodeName`（已有 `pane-url.ts` 深链 `/n/<id>` 与「节点：」行支持），节流键改为 `nodeId:deviceId:paneId`。`agent_*` 远程事件已在发起机上报，若来源节点自身也转发会重复：来源节点对 `agent_*` 且 `payload.nodeId` 非空的事件不转发。
- 浏览器：ws-broadcast 照常广播给连着汇聚机的浏览器；前端 toast 订阅固定挂在入口机（self）运行时，不随路由节点切换（`WatchEventsInit` 从 `NodeSessionInit` 下移到入口层）。
### C 加固
- 通知 tab 顶部横幅：非 self 路由时提示「当前编辑的是 <节点名> 的通知通道」；self 且非 standalone 时提示「这些通道只属于本机；其它节点的事件由汇聚开关决定」。
- 节点管理 → 节点详情增「通知设置」链接到 `/n/<id>/settings?tab=notifications`。
### 文案（zh 源，简洁专业）
- 卡片标题「多节点通知」；开关「接收其它节点的通知」；说明「其它节点的事件将通过本机的通道发送。」；状态行「汇聚节点：<名>、<名>」/「未启用汇聚，各节点仅通知自身事件。」
## 分工
- N1（Opus，后端）：key-log 记录类型、sink 集合、节点侧转发队列、汇聚机路由、节流键、测试、文档 `docs/notify/2026090603-mesh-notification-sink.md`。
- N2（Opus，前端）：多节点通知卡片、横幅、节点详情入口、toast 订阅上移、i18n、单测；e2e `mesh-notify.spec.ts`（由指挥官运行）。
- 指挥官：契约先落 `packages/shared`，codex 审查，实测，发版 1.1.36。
## 验收
- 节点 B 的 bell/watch 触发在 A（sink）的 webhook 与浏览器 toast 出现，带节点名与 `/n/B` 深链；A 离线 2 分钟内恢复可补发合并后的事件；纯 standalone 无 UI 变化。
