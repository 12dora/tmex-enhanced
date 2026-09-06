# N2 结果（Opus 子代理）：多节点通知前端

- 新增 `apps/fe/src/pages/settings/notifications/{mesh-api.ts,mesh-notification-card.tsx,notify-scope-banner.tsx,site-notification-card.tsx}`（+测试 15 个）；通知 tab 顶部横幅 + 「多节点通知」卡片（开关/汇聚节点列表/队列提示）。
- 节点详情对话框增「通知设置」链接 `/n/<id>/settings?tab=notifications`。
- 入口 toast：发现转发事件以 `KIND_NOTIFY_EVENT` 广播而 Web 前端此前没有消费者；新增 `apps/fe/src/notifications/entry-notify-toasts.tsx` 固定订阅入口机 ws（过滤自身/当前路由节点/agent_*），并在非 self 路由时于 self 作用域挂 `WatchEventsInit` + `SettingsEventsInit` 保持入口 ws 连接。
- `settings-events-init.tsx` 增 `notifications-mesh` 查询键失效映射。
- e2e `apps/fe/tests/mesh-notify.spec.ts`（未运行）。
- 验证：fe 2649/0、panels 1023/0、门禁 ok；fe tsc 仅剩 N1 的 `Object.hasOwn` 一处（已转告）。
