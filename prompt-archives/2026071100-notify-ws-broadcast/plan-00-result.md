# 执行结果：/ws 通知事件广播 + env 禁用内建通知 channel

2026-07-11 完成，分支 `vibex/notify-ws-broadcast`。

## 落地形态

- `KIND_NOTIFY_EVENT = 0x0803` 进 kind 表 / `VALID_KINDS` / `kindToString`；`EventNotifyS2CSchema = b.struct({ eventType: b.string(), eventJson: b.string(), timestamp: b.u64() })`（字段序即线序，已定格）。
- `WebSocketServer.broadcastEventNotify(eventType, event)` 仿 settings 广播先例向全体 `connectedClients` 发 envelope；timestamp 取 `Date.parse(event.timestamp)`（EventNotifier 的 ISO 事件时间），解析失败回退 `Date.now()`。
- 注册桥 `events/broadcaster.ts`（`registerEventNotifyBroadcaster`），`runtime.ts` 启动接线、`stop()` 注销，生命周期与 settings 桥对齐。
- `events/channels/ws-broadcast.ts`：`NotificationChannel` 实现（`id='ws-broadcast'`），`notify()` 内部 try/catch 自吞发送错误（对齐 webhook/telegram 的容错惯例）；桥未注册时静默 no-op。
- `TMEX_DISABLED_NOTIFICATION_CHANNELS`（CSV）：`config.ts` 以 getter 读取（避免测试进程早期 import 冻结 env 值，生产行为不变），EventNotifier 构造时命中的内建 channel 跳过注册。`ws-broadcast` 可被显式点名禁用，但不在 webhook,telegram,weixin 的默认禁用语义内。
- 计划偏差一处：`load-env.ts` 并无 env 白名单机制（loadEnv 全键透传），改为按仓库惯例在 `test.env`/`development.env` 登记该变量（空值=默认不禁用）。

## 关键语义（测试钉死）

- ws-broadcast 不受 `enableBellPush`/`enableNotificationPush` 门控（该门控在各内建 channel `notify()` 内部，非中央分发）；受中央 bell/notification 节流；受站点设置 `disabledNotificationChannels` 运行时过滤的显式点名语义。
- 旧客户端零感知：前端 `switch(msg.kind)` 无 default，未知 kind 静默忽略；HELLO schema 未动。

## 验证

- apps/gateway 853 pass / 0 fail（含新增：ws 广播 decode 断言、env 禁用矩阵、EventNotifier→channel→桥→wsServer 全链路、门控豁免、节流约束、桥注销、零 client no-op）；packages/shared 93、stores 35、ws-client 23 全绿。
- 变异验红（恢复后复绿）：env 过滤移除、广播 kind 篡改、`notify()` 置空、桥不存 fn、notify 引入 bell-push 门控早退。
- 分支已 merge `vibex/main`（零冲突，0x0803 两侧唯一），与前端拆包内容共存。
