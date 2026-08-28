# ws-client 解码器缺口调查与修复：KIND_SETTINGS_UPDATE / KIND_NOTIFY_EVENT

## 结论速览

| kind | 客户端是否真的被丢弃 | 处理 |
| --- | --- | --- |
| `KIND_SETTINGS_UPDATE` (0x0802) | **是**，全仓无任何消费方，是真实功能缺口 | 已修：解码器分支 + `settings-update` transport 事件 + site store 缓存失效 + 测试 |
| `KIND_NOTIFY_EVENT` (0x0803) | **是**（无消费方），但**不是缺陷**：它承载的每一种 eventType 在浏览器端都已有独立到达路径，接到 toast 上会**双重通知** | 有意不接线，见下方论证；未加任何代码 |

## 一、排查过程（全仓 grep 验证）

对 `KIND_NOTIFY_EVENT` / `KIND_SETTINGS_UPDATE` / `SettingsUpdate` / `notify-event` / `settings-update` /
`notifyEvent` 做全仓 grep（`packages/**`、`apps/**`，排除 `node_modules`、`dist`）：

- 命中全部集中在 `packages/shared/src/ws-borsh/*`（常量与 schema 定义）与 `apps/gateway/**`（服务端广播与其测试）。
- `packages/ws-client`、`packages/stores`、`packages/notifications`、`apps/fe`、`packages/panels` **零命中**。
- 另外核对了两条绕过 transport 解码器的「原始 `onMessage`」旁路，确认它们都按 kind 过滤、不会兜底这两个 kind：
  - `packages/panels/src/watch/watch-events-init.tsx:140-143` — `if (msg.kind !== wsBorsh.KIND_WATCH_EVENT) return;`
  - `packages/stores/src/agent.ts:82` → agent event 路由，只认 `KIND_AGENT_EVENT`。
- `packages/ws-client/src/websocket-transport.ts:40-42` 是唯一把 `client.onMessage` 接到
  `decodeGatewayTransportMessage()` 的地方；未登记的 kind 在
  `packages/ws-client/src/transport-message-decoder.ts:135` 直接 `return false` 被忽略。

结论：两个 kind 在客户端确实无人消费。

## 二、`KIND_SETTINGS_UPDATE`：真实缺口，已修

### 设计意图与缺口

`prompt-archives/2026070500-capabilities-settings-bindhost/plan-prompt.md` 明确写着「任何设置变更向全部 WS 客户端
推送变更事件（**缓存失效信号**）」，`packages/shared/src/ws-borsh/schema.ts:438-444` 的注释同样写着
「客户端按需重拉对应 REST」。但当时的计划只覆盖 gateway 侧，**客户端消费从未实现**。

实际后果：`PATCH /api/settings/site` 后（`apps/gateway/src/api/settings-routes.ts:29`
→ `broadcastSettingsUpdate('site')`），其它标签页/设备缓存在 `useSiteStore.settings` 里的
`SiteSettings`（`enableBellSound`、`enableBrowserNotificationToast`、`bellThrottleSeconds`、
`siteName`、`language` 等）保持陈旧直到整页刷新。仓库里 `refreshSettings()` 唯一调用点是
`apps/fe/src/pages/settings/use-site-settings-form.ts:71`，即**只有本地写入者自己**会刷新。

### 改动

1. `packages/ws-client/src/transport-types.ts` — `GatewayTransportEvent` 新增
   `{ type: 'settings-update'; namespace: string }`。`namespace` 保留 wire 原样字符串而不收敛成联合类型：
   服务端 `SettingsNamespace`（`apps/gateway/src/settings/broadcaster.ts:4-14`）在 gateway 包内，
   客户端复制一份必然漂移，且新服务端追加取值时不能被旧客户端吞掉。
   与既有 `site-theme-update` 一致，不透出 `serverTimestamp`（无消费方，不留未用字段）。
2. `packages/ws-client/src/transport-message-decoder.ts` — 新增 `KIND_SETTINGS_UPDATE` 分支，
   `decodePayload(SettingsUpdateS2CSchema)` 后 emit。
3. `packages/stores/src/site.ts` — `SiteState` 新增 `handleSettingsUpdate(namespace)`：仅
   `namespace === 'site'` 时 `void refreshSettings().catch(...)`（失败已在 `refreshSettings` 内部
   `console.error`，此处吞掉避免 unhandled rejection）。
   刻意**不**处理 `'theme'`：`apps/gateway/src/api/theme.ts:47-49` 与
   `apps/gateway/src/ws/theme-settings-broadcaster.ts:55-56` 每次都同时发 `SITE_THEME_UPDATE` 专用帧，
   已由 `setThemeFromS2C` 覆盖；再补一次 REST 只是给每个连接的客户端白加一次往返。
4. `packages/stores/src/tmux-event-router.ts` — `handlers` 新增 `'settings-update'` 分支转发给 site store。
   该 map 是 `[T in GatewayTransportEvent['type']]` 的穷尽映射，新增事件类型由 tsc 强制接线，
   全仓也只有这一处消费 `GatewayTransportEvent`（已 grep 确认）。

### 测试

- `packages/ws-client/src/transport-message-decoder.test.ts` — 新增「settings-update 透出 namespace 原样」，
  对 `site` / `llm` / `tree-order` 三个 namespace 用 `SettingsUpdateS2CSchema` 编码后断言事件形状，
  与服务端 `apps/gateway/src/ws/settings-broadcast.test.ts` 的编解码路径对称。
- `packages/stores/src/tmux-event-router.test.ts` — 新增 harness 桩 `handleSettingsUpdate` +
  「settings-update is forwarded to the site store with its namespace」。
- `packages/stores/src/site-theme.test.ts` — 新增 `describe('useSiteStore handleSettingsUpdate')` 三例：
  `'site'` 触发重拉并覆盖旧缓存 / 其它 namespace 不发 REST / 重拉失败静默保留旧缓存不抛。
- 变异护栏：把 `if (namespace !== 'site')` 改成恒真 → `site-theme.test.ts` 1 fail，恢复后 0 fail。

## 三、`KIND_NOTIFY_EVENT`：无消费方，但不应接线

它确实没有客户端消费方，但接到通知出口上会**对每一条事件产生第二份 toast**。逐条核对
`EventType`（`packages/shared/src/contracts/notifications.ts:5-19`）在浏览器端的既有到达路径：

| eventType | 浏览器端既有路径 |
| --- | --- |
| `terminal_bell` | `KIND_TMUX_EVENT` type=`bell` → `packages/stores/src/tmux-device-events.ts:73-86`（bell store + 声音） |
| `terminal_notification` | `KIND_TMUX_EVENT` type=`notification` → `tmux-device-events.ts:88-113`（toast） |
| `watch_triggered` / `watch_model_unavailable` / `watch_rule_error` | `KIND_WATCH_EVENT` → `packages/panels/src/watch/watch-events-init.tsx:169-196`（toast + 浏览器通知 + react-query 失效） |
| `agent_confirmation_pending` / `agent_turn_finished` / `agent_error` / `session_created` / `session_closed` | `KIND_AGENT_EVENT` → `packages/stores/src/agent-event-router.ts` |
| `device_disconnect` / `device_tmux_missing` | `KIND_DEVICE_EVENT` → `tmux-device-events.ts:16-70` |
| `tmux_window_close` / `tmux_pane_close` | 快照/差分更新，当前**有意**不出 toast |

且 `KIND_NOTIFY_EVENT` 是无条件全量广播（`theme-settings-broadcaster.ts:115-125` 遍历
`connectedClients`），而 push supervisor 维持自己的 tmux 连接（`apps/gateway/src/push/supervisor.ts:59-113`），
**不管浏览器是否在线都会发**——不存在「浏览器不在线才发」的互补关系，接线即重复。

架构上它是与 webhook / telegram / weixin 并列的一个 `NotificationChannel`
（`apps/gateway/src/events/channels/ws-broadcast.ts`），面向**外部 WS 订阅方**（CLI / 原生壳），
`prompt-archives/2026071100-notify-ws-broadcast/plan-00.md` 也把「新增 kind 对旧客户端零感知」写进了设计。
Web 客户端不消费它是正确状态，不是 bug。

因此**没有**为它增加解码分支：`GatewayTransportEvent` 的穷尽 handler map 会逼出一个空 handler，
那才是真正的死代码；而给它接 toast 属于未经请求的 UX 变更（每次 bell 双响）。
若后续要做「通知中心 / 事件流水」这类真正需要全量事件的功能，再补解码分支即可，
届时需同时给 `terminal_bell` 等做与 `KIND_TMUX_EVENT` 路径的去重。

## 四、遗留（未做，需指挥官决策）

`settings-update` 的其余 9 个 namespace（`llm` / `webhooks` / `telegram` / `weixin` / `devices` /
`file-roots` / `terminal-shortcuts` / `tree-order` / `theme`）对应的缓存都在 panels 的 react-query 里
（`['llm-providers']`、`['llm-settings']`、`['webhooks']`、`['telegram-bots']`、`['weixin-accounts']`、
`['devices']`、`['file-roots']`、`['terminal-shortcuts']` 等）。要让它们跨端失效，需要一个仿
`WatchEventsInit` 的 `SettingsEventsInit`（`runtime.transport.onEvent` 订阅 → namespace 映射 queryKey →
`invalidateQueries`）并挂到 `apps/fe/src/main.tsx`。

本次未做，原因：超出本任务给定的文件范围，且 `apps/fe/src/main.tsx` 与多个 panels 文件正被并行 agent
（F1 files-tab / F2 watch-dialog / F4 page-loader）改动，冲突风险高。
**本次改动已把这条路打通**——`settings-update` 事件带原始 namespace 从 transport 流出，
panels 侧新增一个订阅组件即可，无需再动 ws-client / stores。

## 五、改动文件与验证

改动（6 个文件，均在给定 scope 内；未碰 `pane-sink-registry.ts` / `state-machine.ts` /
`agent-session-actions*.ts` / `agent-thread.ts` / `tmux.ts`，未碰 panels 与 apps/fe）：

- `packages/ws-client/src/transport-types.ts`
- `packages/ws-client/src/transport-message-decoder.ts`
- `packages/ws-client/src/transport-message-decoder.test.ts`
- `packages/stores/src/site.ts`
- `packages/stores/src/site-theme.test.ts`
- `packages/stores/src/tmux-event-router.ts`
- `packages/stores/src/tmux-event-router.test.ts`

验证：

- `bun test`：ws-client 76 pass / 0 fail（基线 75，+1 为新增用例）；stores 121 pass / 0 fail；
  notifications 15 pass / 0 fail（未改动）。
- `bunx tsc --noEmit -p .`：ws-client 0、notifications 0、stores 1（既有 `src/host-services.test.ts(93,23)`，
  与本次无关）、panels 1（`src/watch/spike.test.tsx` 缺 `react-dom/server` 类型，是并行 agent 的**未跟踪新文件**，
  与本次无关）。
- `bunx biome check --write <上述 7 个文件>`：Checked 7 files, no fixes applied。
