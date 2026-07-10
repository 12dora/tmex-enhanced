# prompt 存档：/ws 通知事件广播与内建通知 channel 的 env 禁用

## 背景

EventNotifier 已有统一的事件节流与通知面（webhook/telegram/weixin 等内建 channel），但 `/ws` 客户端无法消费这份统一事件流——前端 bell 目前是自己从 tmux 原始事件推算的。同时，托管/嵌入 tmex 的宿主需要在启动时整体禁用内建推送 channel（由宿主自身的通知面接管），运行时 `disabledNotificationChannels` site setting 属于用户面开关，不适合这个场景。

## 需求 prompt（2026-07-11）

> 为 gateway 增加两个中性机制：
> 1. `/ws` envelope 新增 `KIND_NOTIFY_EVENT`（0x0803）：EventNotifier 注册一个内置 ws 广播 channel，把节流后的通知事件（eventType + WebhookEvent payload JSON）广播给全部 `/ws` 客户端（与 `KIND_SETTINGS_UPDATE` 广播先例一致，未知 kind 被旧客户端静默忽略，零订阅机制、完全向后兼容）。
> 2. 启动 env `TMEX_DISABLED_NOTIFICATION_CHANNELS`（CSV）：命中的内建通知 channel 在构造时跳过注册（比运行时过滤强：channel 不存在）；ws 广播 channel 不在默认禁用语义内。
>
> 计划见 plan-00.md。测试参照 settings-broadcast / events recordingChannel 既有范式，变异（去掉 env 过滤）须红。
