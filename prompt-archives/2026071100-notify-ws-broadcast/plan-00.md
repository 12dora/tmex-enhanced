# plan：/ws 通知事件广播 + env 禁用内建通知 channel

分支：`vibex/notify-ws-broadcast`（基于 origin/main）。

## 背景与注意事项

- EventNotifier（`apps/gateway/src/events/`）持有节流后的统一通知事件流与 `NotificationChannel` 抽象（内建 webhook/telegram/weixin）。
- `/ws` 已有 S2C 广播先例：`KIND_SETTINGS_UPDATE`（`apps/gateway/src/ws/index.ts` `broadcastSettingsUpdate`，注册桥 `settings/broadcaster.ts`，`runtime.ts` 启动接线）。
- 前端全部 `onMessage` handler 的 `switch(msg.kind)` 无 default、静默忽略未知 kind（如 `packages/stores/src/tmux.ts`）——新增 kind 对旧客户端零感知，无需 HELLO 订阅位（`HelloC2SSchema` 是位置化 Borsh struct，追加字段会使旧客户端解码错位，禁止改）。
- kind `0x0803` 空闲；schema 命名避开已有 `NotificationEventSchema`。
- 生成文件（i18n resources 等）不碰；测试走 test env（`bun test`）。

## 任务清单

### 1. `/ws` 通知广播

- `packages/shared/src/ws-borsh/kind.ts`：加 `KIND_NOTIFY_EVENT = 0x0803`，进 `VALID_KINDS` 与 `kindToString`。
- `packages/shared/src/ws-borsh/schema.ts`：加 `EventNotifyS2CSchema = b.struct({ eventType: b.string(), eventJson: b.string(), timestamp: b.u64() })`（eventJson＝完整 WebhookEvent JSON）。
- `apps/gateway/src/ws/index.ts`：加 `broadcastEventNotify(eventType, event)`，仿 `broadcastSettingsUpdate` 遍历 `connectedClients` 发 envelope。
- `apps/gateway/src/events/broadcaster.ts`（新）：`registerEventNotifyBroadcaster(fn)` 注册桥，仿 `settings/broadcaster.ts`。
- `apps/gateway/src/events/channels/ws-broadcast.ts`（新）：`NotificationChannel` 实现（`id='ws-broadcast'`），经注册桥调用。
- `apps/gateway/src/events/index.ts` 构造函数注册该 channel；不受 `enableBellPush`/`enableNotificationPush` 门控（那是自托管推送开关）。
- `apps/gateway/src/runtime.ts` 启动时接线 `wsServer.broadcastEventNotify`。

### 2. env 禁用内建 channel

- `apps/gateway/src/config.ts`：`disabledNotificationChannelsEnv: getEnv('TMEX_DISABLED_NOTIFICATION_CHANNELS', '')`（CSV），仿 `themeNotify2031Enabled` kill-switch 先例。
- `events/index.ts` 构造函数：解析 CSV，命中的内建 channel 跳过注册。`ws-broadcast` 不在默认禁用语义内。
- `packages/shared/src/env/load-env.ts` 白名单补该变量。

### 3. 测试（bun test，test env）

- ws 广播：仿 `apps/gateway/src/ws/settings-broadcast.test.ts`（mock client + decodeEnvelope 断言）。
- env 禁用：仿 `events/index.test.ts` recordingChannel 范式；变异（去掉 env 过滤）须红。
- kind 常量：`packages/shared/src/ws-borsh/index.test.ts` 补 0x0803。

## 验收标准

- `bun test`（events / ws / ws-borsh 相关及全量）全绿；生成文件无 diff。
- 变异护栏逐条验红后恢复。
