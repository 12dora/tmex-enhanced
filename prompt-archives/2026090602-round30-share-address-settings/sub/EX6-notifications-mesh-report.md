# EX6 — 通知触发多节点适配审计（Opus 子代理，要点）

## 结论：按节点各自通知，无跨节点汇聚
- `EventNotifier`（`apps/gateway/src/events/index.ts`）进程单例；webhook/telegram/weixin/ws 四通道均读**本机**表（`db/schema/messaging.ts`），`watch_rules.device_id` 外键指向本机 `devices`，无 nodeId 列。
- 事件生产者（bell/OSC-9 `push/supervisor.ts`、设备连接 `push/connection-alerts.ts`、watch `watch/service.ts`）只遍历本机设备；uplink/peer 协议无通知帧；hub 复制只同步节点表/证书/key log，不复制通知配置。
- 唯一例外：远程 agent 会话由发起机 `AgentSupervisor` 拥有，`agent_*` 事件走**发起机**通道并带 `nodeId/nodeName`（`agent/run-notify.ts`，`events/channels/pane-url.ts` 对远程事件加 `/n/<id>` 前缀）。
- 节点自身事件的深链依赖 site URL overlay（`<hub>/n/<self>`），文案带「节点：<名>」行。

## 拓扑行为
- (a) standalone：全本地。(b) hub A + 节点 B/C：三套独立通知；`/n/B/settings?tab=notifications` 编辑并由 **B** 自己发送，B 需各自配置 bot/webhook；仅配置 A 的 webhook 收不到 B/C 事件。(c) 经中继访问 B：同 (b)。
- UI 隐患：侧栏「设置」写死 `/settings`（入口机），通知 tab 无节点范围提示（远程访问 tab 有），用户无法分辨在编辑谁的 bot；浏览器 toast 也仅当前路由节点。
- round25 文档已明示消息指令「只在本机执行」（`docs/messaging/2026090402-messaging-command-template.md`，`messaging/executor.ts:67-79`）。
- 无任何跨节点通知测试。

## 方案
- A 入口侧汇聚（节点→入口推事件，新增 mesh-internal 路由或 uplink 帧，节点侧 opt-in + 事件白名单，需处理离线队列/限流/节流键；中等偏大）。**推荐作为真正修复。**
- B 配置复制到各节点（分发 bot 密钥、getUpdates 冲突、重复消息；不建议）。
- C 最小加固（通知 tab 加节点范围横幅、节点详情加「通知设置」入口、可选覆盖率概览；前端小改）。**建议先做。**
