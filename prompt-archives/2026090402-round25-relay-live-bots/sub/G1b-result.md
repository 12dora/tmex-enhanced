# G1b 结果 — Messaging channel hygiene for multi-node / relay modes

## 做了什么

### 1. relay-only 不拉起即时通讯 / watch / 上线消息
- `config.ts` 增加 `isRelayOnly` / `resolveLiveRoles`（`parseTmexRoles` 已在 gateway）。
- `startLiveGatewayServices()` 在 `relay`（无 node/hub）时跳过 Telegram/Weixin `refresh`、watch 启动、gateway online 消息；仍启动 push / agent / tunnel。
- `relay,node` / `node` / `hub,node` / standalone 行为不变。

### 2. 设备连接错误走 EventNotifier
- `ConnectionAlertNotifier` 不再直接调 `telegramService`。
- 按 device+errorType 节流后发出 `device_connection_error`（**不**在生命周期 skip 名单里），Telegram/微信都走 `enableNotificationPush` / `disabledNotificationChannels`。
- 生命周期桥（`device_disconnect` / `device_tmux_missing`）仍只给 webhook/ws，Telegram/微信继续跳过，避免双发。
- 保留 `setTelegramSender` 空实现，以免范围外的 `push/supervisor.test.ts` 编译失败。

`device_connection_error` 尚未写入 `packages/shared` 的 `EventType` 联合（contracts 归 G1a）。本任务用 `as EventType` 接入推送路径。

### 3. Agent 凭证告警走 notifier
- `pushCredentialWarning` 改为 `notifyAgentEvent` → `eventNotifier.notify('agent_error', { kind: 'credential_warning' })`。
- Telegram/微信按 kind 用原 `telegram.agentCredentialWarning` 文案发送，并受门控。

### 4. 远端 agent session 的设备名与链接
- `notifyAgentEvent`：本地 `getDeviceById` 失败时回落到 `peer_cache`/`nodes` 名与 inventory 设备名；payload 带 `nodeId`/`nodeName`。
- `buildPaneUrl`：有 `payload.nodeId` 时生成 `/n/<nodeId>/devices/...`（对齐 FE `/n/:nodeId`）；缺 window/pane 时退到设备页。

### 5. Mesh 时通知加节点行
- `notification-format` 的 bell / terminal_notification / generic 在 `hub || node` 角色下插入「节点」行：`node_identity.name` → site name。
- standalone / relay-only 不加，单机用户无变化。
- 凭证告警文案在 mesh 下同样附节点行。

## 改动文件

Gateway：
- `apps/gateway/src/config.ts`
- `apps/gateway/src/runtime.ts`、`runtime.test.ts`（新）
- `apps/gateway/src/push/connection-alerts.ts`、`connection-alerts.test.ts`
- `apps/gateway/src/agent/supervisor.ts`、`supervisor.test.ts`
- `apps/gateway/src/agent/run-notify.ts`、`run-notify.test.ts`（新）
- `apps/gateway/src/events/channels/types.ts`（常量 `DEVICE_CONNECTION_ERROR_EVENT` / `CREDENTIAL_WARNING_KIND`）
- `apps/gateway/src/events/channels/telegram.ts`、`telegram.test.ts`
- `apps/gateway/src/events/channels/weixin.ts`、`weixin.test.ts`
- `apps/gateway/src/events/channels/notification-format.ts`、`notification-format.test.ts`
- `apps/gateway/src/events/channels/pane-url.ts`、`pane-url.test.ts`（新）
- `apps/gateway/src/events/index.test.ts`
- `apps/gateway/src/events/index.ts` 未改（EventNotifier 已按渠道分发）

i18n 源（未跑 `build:i18n`）：
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/ja_JP.json`（三语同步）
- 新键：`notification.node`、`notification.eventType.device_connection_error`
- 运行时标签用了 `defaultValue: 'Node'`，等 commander 生成 `resources.ts` 后走正式译文

## 验证

```
cd apps/gateway && bun test src/push/connection-alerts src/agent src/events src/runtime
```
**414 pass / 0 fail**（44 files, 1373 expect）

```
bunx biome check <touched files>
```
通过。

```
bun scripts/complexity/gate.ts
```
通过（`notifyAgentEvent` 已拆函数，CC ≤ 15；`supervisor.ts` 704 行 < allowlist 711）。

```
cd apps/gateway && bunx tsc --noEmit -p .
```
本任务文件无报错。当前仓库仍有 **2** 条范围外错误（G1a 并行改动）：
- `src/telegram/service.ts(54,22)`：`Cannot find name 'getSiteSettings'`
- `packages/app/src/lib/native-datachannel.ts`：`.ts` 扩展名 import

基线要求 gateway 0 条；这两条不在 G1b 文件内。

## 未决 / 注意

1. **请把 `device_connection_error` 补进 `EventType`**（`packages/shared/src/contracts/notifications.ts`）并 `build:i18n`。当前用断言，webhook `eventMask` 无法订阅该类型（有意：不给存量 webhook 添意外事件）。
2. `apps/gateway/src/push/supervisor.test.ts`（范围外）若整包跑，可能因同一 `eventEmitter` 现在也会收到 `device_connection_error` 而失败；`setTelegramSender` 已保留为空操作。
3. 远端 pane 若没有 windowId，链接是 `/n/<nodeId>/devices/<deviceId>` 而不是完整 pane 路径（本机 snapshot 拿不到远端 window）。
4. 未触碰 `apps/gateway/src/telegram/**`、`weixin/**`、`messaging/**`、`db/**`、`packages/shared/src/contracts/**`。
