# EX3 审计报告

## 结论

当前 Telegram 和 Weixin 都不是“远程控制机器人”，而是：

- 聊天绑定/授权入口；
- 终端、watch、agent 事件通知出口；
- Telegram 仅支持一个严格匹配的 `/start`；
- Weixin 没有任何聊天命令；
- 两者都没有设备列表、执行命令、读取 pane、attach、agent 审批等能力；
- 两者都没有 mesh node 选择或远端转发逻辑。

因此，目前 bot 能力基本停留在单节点模型，不能利用 `/n/:nodeId/api/...`、`/api/mesh/nodes`、多 hub 或 relay uplink。

## 1. 当前能力清单

### Telegram

Telegram 在 `TelegramService.refresh()` 中为每个本地启用的 bot 建立 GramIO 长轮询，并注册唯一的 inbound handler：

[apps/gateway/src/telegram/service.ts:97](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:97)

```ts
bot.on('message', async (context) => {
  const text = context.text?.trim();
  if (text !== '/start') {
    return;
  }
```

实际聊天命令只有：

| 命令 | Handler | 行为 |
|---|---|---|
| `/start` | `TelegramService.refresh()` 内的 `bot.on('message')` 回调 | 创建或刷新 pending chat；已授权则回复成功，否则回复等待审批 |

`/start` 的解析是严格字符串比较：

[apps/gateway/src/telegram/service.ts:99](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:99)

```ts
if (text !== '/start') {
  return;
}
```

因此 `/start@bot`、`/start arg`、其他别名和自然语言都会被忽略。

授权前会重新读取 bot 配置，并检查 `allowAuthRequests`：

[apps/gateway/src/telegram/service.ts:103](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:103)

```ts
const latest = getAllTelegramBots().find((item) => item.id === config.id);
if (!latest || !latest.allowAuthRequests) {
  return;
}
```

身份只保存 `chat.id`，而不是 Telegram 用户身份：

[apps/gateway/src/telegram/service.ts:108](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:108)

```ts
const chatId = String(chat.id);
const displayName = buildChatDisplayName({
  title: chat.title,
  username: chat.username,
  firstName: from?.firstName,
  lastName: from?.lastName,
  fallback: chatId,
});
```

`from` 仅用于显示姓名，没有保存 `from.id`。数据库唯一键是 `botId + chatId`：

[apps/gateway/src/db/schema/messaging.ts:41](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/messaging.ts:41)

```ts
unique('telegram_bot_chats_bot_chat_unique').on(table.botId, table.chatId)
```

所以群组中任意成员发送 `/start` 后，授权的是整个群聊，而不是具体用户。

Telegram 的授权审批和测试不是聊天命令，而是 HTTP API：

[apps/gateway/src/api/telegram-routes.ts:253](/Users/konata/code/tmex-r25/apps/gateway/src/api/telegram-routes.ts:253)

```ts
POST /api/settings/telegram/bots/:botId/chats/:chatId/approve
POST /api/settings/telegram/bots/:botId/chats/:chatId/test
```

### Weixin / iLink

Weixin 客户端已经能够从 iLink 消息中提取文本：

[apps/gateway/src/weixin/ilink/client.ts:258](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/ilink/client.ts:258)

```ts
return {
  fromUserId: msg.from_user_id ?? '',
  contextToken: msg.context_token ?? null,
  text: WeixinClient.extractText(msg),
  raw: msg,
};
```

长轮询也会把消息传给 `WeixinService.handleInbound()`：

[apps/gateway/src/weixin/ilink/update-loop.ts:168](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/ilink/update-loop.ts:168)

```ts
const inbound = opts.toInbound(msg);
await opts.onMessage?.(inbound);
```

但 `handleInbound()` 完全不解析 `msg.text`，只落库：

[apps/gateway/src/weixin/service.ts:179](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/service.ts:179)

```ts
// 回执由 approve 端点发送；这里只落库：缓存最新 context_token、刷新 lastInboundAt、清 needsReactivation。
upsertWeixinUserOnInbound({
  accountId,
  userId,
  displayName: userId,
  contextToken: msg.contextToken,
  allowAuthRequests: account.allowAuthRequests,
  at: now,
});
```

因此 Weixin 当前聊天命令是：无。

任意 inbound 文本都可能用于发现新用户、创建 pending 用户或刷新已授权用户的 context token：

[apps/gateway/src/db/weixin.ts:190](/Users/konata/code/tmex-r25/apps/gateway/src/db/weixin.ts:190)

```ts
if (existing) {
  // 刷新 context token、lastInboundAt、needsReactivation
}
```

现有测试明确固定了“收到消息但不回执”的行为：

[apps/gateway/src/weixin/service.test.ts:135](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/service.test.ts:135)

```ts
test('inbound from new user creates pending and caches token (no ack; approve sends it)', ...)
```

Weixin 的授权是本地 `accountId + userId`，发送时依赖缓存的 `contextToken`：

[apps/gateway/src/weixin/service.ts:217](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/service.ts:217)

```ts
for (const [accountId, running] of this.runningAccounts) {
  for (const user of listAuthorizedWeixinUsersByAccount(accountId)) {
    await this.sendToUser(accountId, running, user, params.text);
  }
}
```

### 当前没有的操作能力

两套 bot 都没有以下功能：

| 能力 | 当前状态 |
|---|---|
| 列出 devices | 不存在 |
| 列出 sessions/windows/panes | 不存在 |
| 执行 shell/tmux 命令 | 不存在 |
| 读取或持续 attach pane 输出 | 不存在 |
| 创建/控制 agent session | 不存在 |
| `/approve`、`/deny` agent confirmation | 不存在 |
| node 列表和 node 选择 | 不存在 |
| 远端 node 转发 | 不存在 |

HTTP API 中存在 agent confirmation 决策接口，但它只处理本地 gateway 请求：

[apps/gateway/src/api/agent-confirmation-routes.ts:47](/Users/konata/code/tmex-r25/apps/gateway/src/api/agent-confirmation-routes.ts:47)

```ts
POST /api/agent/confirmations/:id/decide
```

这不是 Telegram 或 Weixin 能调用的聊天命令。

## 2. 外发通知清单

### 启动通知

gateway 启动时会刷新两种 bot，并分别发送上线消息：

[apps/gateway/src/runtime.ts:81](/Users/konata/code/tmex-r25/apps/gateway/src/runtime.ts:81)

```ts
await telegramService.refresh();
await weixinService.refresh();
...
await telegramService.sendGatewayOnlineMessage(settings.siteName);
await weixinService.sendGatewayOnlineMessage(settings.siteName);
```

### 终端 Bell 和 OSC 通知

tmux push 层识别 `osc9`、`osc777`、`osc1337`：

[apps/gateway/src/push/tmux-push-events.ts:22](/Users/konata/code/tmex-r25/apps/gateway/src/push/tmux-push-events.ts:22)

```ts
const NOTIFICATION_SOURCE_BY_VALUE = {
  osc9: 'osc9',
  osc777: 'osc777',
  osc1337: 'osc1337',
};
```

只处理 `bell` 和 `notification` 两类事件：

[apps/gateway/src/push/tmux-push-events.ts:80](/Users/konata/code/tmex-r25/apps/gateway/src/push/tmux-push-events.ts:80)

```ts
const TMUX_PUSH_EVENT_HANDLERS = {
  bell: handleBellPushEvent,
  notification: handleNotificationPushEvent,
};
```

`PushSupervisor` 将这些事件交给统一的 `eventNotifier`：

[apps/gateway/src/push/supervisor.ts:60](/Users/konata/code/tmex-r25/apps/gateway/src/push/supervisor.ts:60)

Telegram：

- `terminal_bell` 使用 `enableBellPush`；
- `terminal_notification` 使用 `enableNotificationPush`；
- Telegram 使用 HTML；
- 消息发送到当前进程所有本地授权 chat。

[apps/gateway/src/events/channels/telegram.ts:22](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/telegram.ts:22)

Weixin：

- `terminal_bell` 使用 `enableBellPush`；
- 其他通知使用 `enableNotificationPush`；
- 使用纯文本；
- 消息发送到当前进程所有本地授权 user。

[apps/gateway/src/events/channels/weixin.ts:19](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/weixin.ts:19)

### Agent 事件

Agent 会发出：

- `agent_turn_finished`
- `agent_confirmation_pending`
- `agent_error`

等待审批时，payload 中包含 `toolName` 和 `confirmationId`：

[apps/gateway/src/agent/run-finish.ts:88](/Users/konata/code/tmex-r25/apps/gateway/src/agent/run-finish.ts:88)

```ts
sink.notify('agent_confirmation_pending', session, {
  message: ...,
  toolName: approval.toolName,
  confirmationId: approval.approvalId,
});
```

但当前 Telegram/Weixin 只有普通文本通知，没有按钮或动作回调；generic formatter 实际只渲染 `payload.message`：

[apps/gateway/src/events/channels/notification-format.ts:109](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/notification-format.ts:109)

```ts
const message = event.payload?.message;
if (typeof message === 'string' && message.length > 0) {
  lines.push(`${t('notification.message')}：${message}`);
}
```

所以 `confirmationId` 不会变成可点击的批准操作。

### Watch 事件

watch 会通过 `safeNotify()` 发出：

- `watch_triggered`
- `watch_model_unavailable`
- `watch_rule_error`

[apps/gateway/src/watch/notifier.ts:166](/Users/konata/code/tmex-r25/apps/gateway/src/watch/notifier.ts:166)

这些事件会进入 Telegram 和 Weixin 的 generic notification。

### 设备连接错误

连接错误存在一条绕过统一 `EventNotifier` 的 Telegram 专用路径：

[apps/gateway/src/push/connection-alerts.ts:81](/Users/konata/code/tmex-r25/apps/gateway/src/push/connection-alerts.ts:81)

```ts
private telegramSender = (text) =>
  telegramService.sendToAuthorizedChats({ text });
```

[apps/gateway/src/push/connection-alerts.ts:152](/Users/konata/code/tmex-r25/apps/gateway/src/push/connection-alerts.ts:152)

```ts
if (!silentTelegram && this.shouldSendTelegram(device.id, classified.type)) {
  await this.sendTelegram(device, classified.type, friendlyMessage, rawMessage);
}
```

结果是：

- Telegram 能收到连接错误；
- Weixin 收不到同类直达告警；
- 该路径不检查 `enableNotificationPush`；
- 该路径不检查 `disabledNotificationChannels`；
- 之后产生的 lifecycle bridge event 又会被 Telegram/Weixin 跳过。

### Agent 凭证泄漏警告

凭证警告也只发送 Telegram：

[apps/gateway/src/agent/supervisor.ts:386](/Users/konata/code/tmex-r25/apps/gateway/src/agent/supervisor.ts:386)

```ts
await telegramService.sendToAuthorizedChats({ text });
```

Weixin 不会收到该告警。

### Weixin 保活消息

Weixin 每 30 分钟检查一次授权用户，距离上次 inbound 达到 8 小时后发送保活提示：

[apps/gateway/src/weixin/service.ts:263](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/service.ts:263)

```ts
const cont = await this.sendToUser(
  accountId,
  running,
  user,
  t('weixin.keepalivePrompt')
);
```

### 设备、window、pane 的地址方式

通知中的设备使用 `device.id`，显示时使用 `device.name`。window/pane 显示优先使用 index：

[apps/gateway/src/events/channels/notification-format.ts:93](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/notification-format.ts:93)

```ts
if (index !== undefined) return `${index} (${id ?? '-'})`;
return id ?? '-';
```

跳转 URL 使用 device/window/pane 的 ID：

[apps/gateway/src/events/channels/pane-url.ts:12](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/pane-url.ts:12)

```ts
return `${base}/devices/${deviceId}/windows/${windowId}/panes/${paneId}`;
```

当前没有 pane 内容输出，也没有 attach 流。消息中只有元数据和查看页面链接。

## 3. mesh、multi-hub、relay 审计

### bot 在哪里运行

`assembleTmex()` 先创建 gateway：

[packages/app/src/runtime/assemble.ts:387](/Users/konata/code/tmex-r25/packages/app/src/runtime/assemble.ts:387)

```ts
const gateway = await createGateway();
```

`createGatewayRuntime()` 在 gateway 创建期间执行 `liveStart()`：

[apps/gateway/src/runtime.ts:131](/Users/konata/code/tmex-r25/apps/gateway/src/runtime.ts:131)

```ts
const liveStart = options.liveStart ?? startLiveGatewayServices;
```

[apps/gateway/src/runtime.ts:174](/Users/konata/code/tmex-r25/apps/gateway/src/runtime.ts:174)

```ts
await liveStart();
```

而 `startLiveGatewayServices()` 无角色判断，直接启动 Telegram 和 Weixin：

[apps/gateway/src/runtime.ts:83](/Users/konata/code/tmex-r25/apps/gateway/src/runtime.ts:83)

因此，只要某个 node/hub/standalone 进程运行 gateway runtime，它就会读取自己的本地 bot 配置并启动 bot。当前没有“只在 entry node 运行”“只在 writer hub 运行”的逻辑。

### 配置、授权数据和 settings 是否复制

Telegram/Weixin 数据表都没有 `nodeId`：

[apps/gateway/src/db/schema/messaging.ts:15](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/messaging.ts:15)

```ts
export const telegramBots = sqliteTable('telegram_bots', {
```

[apps/gateway/src/db/schema/messaging.ts:52](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/messaging.ts:52)

```ts
export const weixinAccounts = sqliteTable('weixin_accounts', {
```

`getAllTelegramBots()`、`getAllWeixinAccounts()` 都是当前 SQLite 的查询。

settings broadcaster 也只是进程内回调：

[apps/gateway/src/settings/broadcaster.ts:21](/Users/konata/code/tmex-r25/apps/gateway/src/settings/broadcaster.ts:21)

```ts
export function registerSettingsBroadcaster(fn: SettingsBroadcaster | null): void {
  broadcaster = fn;
}
```

[apps/gateway/src/settings/broadcaster.ts:25](/Users/konata/code/tmex-r25/apps/gateway/src/settings/broadcaster.ts:25)

```ts
export function broadcastSettingsUpdate(namespace: SettingsNamespace): void {
  broadcaster?.(namespace);
}
```

runtime 只把它接到本地 WebSocket server：

[apps/gateway/src/runtime.ts:162](/Users/konata/code/tmex-r25/apps/gateway/src/runtime.ts:162)

```ts
registerSettingsBroadcaster((namespace) =>
  wsServer.broadcastSettingsUpdate(namespace)
);
```

没有 mesh uplink、hub replication 或远端 service refresh。

结论：

- bot 配置是 node-local；
- chat/user 授权记录是 node-local；
- site settings 是 node-local；
- `broadcastSettingsUpdate('telegram'|'weixin')` 只刷新本节点浏览器；
- entry node 修改设置不会自动更新其他 node；
- `/n/:nodeId/api/settings/...` 若被浏览器使用，会在目标 node 上执行对应设置 API，但不是复制。

### mesh 的能力目前只服务于浏览器/API

mesh node 列表接口存在：

[apps/gateway/src/mesh/mesh-routes.ts:148](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/mesh-routes.ts:148)

```ts
if (path === '/api/mesh/nodes' && req.method === 'GET') {
```

远端 HTTP 转发也存在：

[apps/gateway/src/mesh/forwarder.ts:155](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:155)

```ts
if (parsed.rest === '/api' || parsed.rest.startsWith('/api/')) {
  return this.handleRemoteHttp(req, parsed.nodeId, parsed.rest, url.search);
}
```

但 Telegram/Weixin service 没有使用 `Forwarder`、`/api/mesh/nodes` 或 `/n/:nodeId`。它们直接查本地数据库、直接调用本地 service。

### 多 hub

writer/standby 只影响 hub uplink 和 hub 选择，不影响 Telegram/Weixin。

当前 `TelegramService.refresh()` 和 `WeixinService.refresh()` 没有检查：

- `roles.hub`；
- writer/standby 状态；
- `writerEpoch`；
- 当前是否是 active hub；
- 是否已经有其他 hub 持有同一个 bot token。

因此有两种风险：

1. 只配置 writer：standby 不会自动接管 bot；
2. writer 和 standby 配置相同 Telegram token：两边都可能执行 long polling，存在 Telegram polling 冲突和重复消费风险。

这是基于当前启动路径推断出的高风险，而不是已有测试覆盖的行为。

### relay 模式

relay-only 的角色逻辑明确写着：

[packages/app/src/runtime/assemble.ts:303](/Users/konata/code/tmex-r25/packages/app/src/runtime/assemble.ts:303)

```ts
if (isRelayOnly(input.roles)) {
  // relay 单跑：没有用户、没有节点身份，不挂 auth surface
}
```

[packages/app/src/runtime/assemble.ts:329](/Users/konata/code/tmex-r25/packages/app/src/runtime/assemble.ts:329)

```ts
return roles.relay && !roles.node && !roles.hub;
```

但 gateway 已经在此前启动了 Telegram、Weixin、push、agent、watch 服务。因此：

- relay-only 没有 auth surface、node identity 和正常设备来源；
- 但仍可能读取 relay 本地数据库中的 bot 配置并尝试轮询；
- relay 本身没有中央 bot 转发逻辑；
- `relay,node` 只会让该 node 使用 relay uplink，bot 仍然只看本节点设备和授权用户；
- hub 缺失不会自动把 bot 提升为 relay 集中的控制入口。

## 4. Telegram 与 Weixin 的重复和共性

当前不存在真正重复的“命令解析”，因为只有 Telegram 有 `/start`，Weixin 没有解析器。

重复的是两边的生命周期和通知包装：

| 共性 | Telegram | Weixin |
|---|---|---|
| 读取本地配置 | `getAllTelegramBots()` | `getAllWeixinAccounts()` |
| 解密凭证 | bot token | iLink bot token |
| 启动长轮询 | GramIO `Bot.start()` | `WeixinClient.start()` |
| 授权用户存储 | `botId + chatId` | `accountId + userId` |
| 授权后群发 | `sendToAuthorizedChats()` | `sendToAuthorizedUsers()` |
| 绑定审批 | HTTP API | HTTP API |
| 测试消息 | `sendTestMessage()` | `sendTestMessageToBoundUser()` |
| 通知格式 | Telegram HTML wrapper | Weixin plain-text wrapper |

两套 channel 已经共享底层 raw view：

[apps/gateway/src/events/channels/telegram.ts:4](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/telegram.ts:4)

```ts
buildBellRawView,
buildGenericRawView,
buildNotificationRawView
```

Weixin 使用同一组 builder：

[apps/gateway/src/events/channels/weixin.ts:4](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/weixin.ts:4)

真正缺失的共性层是：

- inbound command parser；
- command registry；
- actor/auth context；
- node target resolution；
- local/remote executor；
- reply/ack；
- chunking；
- platform-specific rendering；
- agent action callback。

## 5. 建议的共享 command template 层

建议拆成两层：

```text
packages/shared/src/messaging/
  command-types.ts
  command-parser.ts
  node-target.ts
  adapter-types.ts

apps/gateway/src/messaging/
  registry.ts
  handlers/
  executor.ts
  adapters/telegram.ts
  adapters/weixin.ts
```

`packages/shared` 只放纯类型、解析器和 node target 纯函数，避免引入 DB、Bun、gateway service。

### Command registry

```ts
export interface CommandSpec<Args = unknown> {
  name: string;
  aliases: readonly string[];
  args: readonly ArgSpec[];
  descriptionKey: string;
  handler: (
    ctx: CommandContext,
    args: Args
  ) => Promise<CommandResult>;
}

export interface CommandInvocation {
  command: string;
  args: Record<string, unknown>;
  rawText: string;
  actor: {
    platform: 'telegram' | 'weixin' | 'dingtalk';
    accountId: string;
    conversationId: string;
    userId: string | null;
    authorized: boolean;
  };
  nodeTarget?: string;
  replyContext: unknown;
}
```

建议首批命令：

```text
/help
/nodes
/devices [--node <name|id>]
/sessions [--node <name|id>]
/panes <device> [--node <name|id>]
/run <device> <pane> -- <command>
/attach <device> <pane> [lines]
/approve <confirmationId>
/deny <confirmationId> [reason]
```

命令关键字应保持稳定英文；`descriptionKey`、帮助文本、错误消息通过 i18n 本地化。不要把本地化文本当作命令关键字。

### Adapter 接口

```ts
export interface MessagingAdapter<RawUpdate, ReplyContext, OutboundMessage> {
  readonly platform: 'telegram' | 'weixin' | 'dingtalk';

  parseInbound(
    raw: RawUpdate,
    registry: CommandRegistry
  ): Promise<CommandInvocation | null>;

  ack(
    ctx: ReplyContext,
    text?: string
  ): Promise<void>;

  render(
    result: CommandResult,
    ctx: ReplyContext
  ): OutboundMessage[];

  send(
    ctx: ReplyContext,
    message: OutboundMessage
  ): Promise<void>;

  chunk(
    text: string
  ): string[];

  readonly limits: {
    maxTextChars: number;
    maxButtons: number;
  };

  readonly markdownFlavor:
    | 'telegram-html'
    | 'telegram-markdown-v2'
    | 'plain'
    | 'dingtalk-markdown';
}
```

`CommandResult` 不应直接包含 Telegram HTML：

```ts
export interface CommandResult {
  text?: string;
  items?: readonly ResultItem[];
  actions?: readonly CommandAction[];
  node?: NodeTarget;
}
```

这样 Telegram、Weixin 和 DingTalk 可以各自渲染同一个结果。

### Node target resolution

```ts
export interface NodeTarget {
  nodeId: string;
  name: string;
  local: boolean;
  online: boolean;
}

export function resolveNodeTarget(
  input: string | undefined,
  options: {
    localNodeId: string;
    nodes: readonly { id: string; name: string; online: boolean }[];
  }
): NodeTarget;
```

规则：

- 未指定 node：默认当前 node；
- `self`：解析为当前 node；
- 精确匹配 node ID；
- 大小写不敏感匹配 name；
- 多个 name 匹配时返回歧义错误；
- 未知或 offline node 返回明确错误；
- 当前 `PublicAuthNode` 只有 `id/name/online`，如果要支持独立 alias，需要扩展 node 配置或增加 alias 映射表。

### 执行器

```ts
export interface CommandContext {
  actor: CommandInvocation['actor'];
  target: NodeTarget;
  executeOnNode<T>(
    target: NodeTarget,
    operation: NodeOperation<T>
  ): Promise<T>;
  requireCapability(capability: 'read' | 'execute' | 'approve'): void;
}
```

执行策略：

- local node：直接调用现有 gateway service；
- remote node：通过 mesh 内部授权转发；
- 返回结果必须携带 `nodeId`，避免不同 node 中相同 device ID 产生歧义；
- `/run` 不应拼接未经 schema 验证的字符串到 shell；
- `/approve` 必须校验 actor 的命令权限，并根据 confirmation 所属 node 转发到拥有该 session 的 node。

### Telegram 映射

现有 `/start` 应保留为绑定专用路径，不进入普通 command registry。

之后在 Telegram `bot.on('message')` 中：

1. 提取 `context.text`；
2. 提取 `chat.id`、`from.id`、botId；
3. 检查 chat/user 授权；
4. 交给 registry 解析；
5. 执行 command；
6. 通过 Telegram HTML renderer 输出；
7. 按 Telegram 限制拆分；
8. 对 callback button 做 approval action。

当前 `TelegramService.sendToAuthorizedChats()` 应拆成面向单个 `ReplyContext` 的 adapter sender，以及保留通知 fan-out 的独立 sender。

### Weixin 映射

现有 `WeixinClient.toInbound()` 已经提供：

- `fromUserId`；
- `contextToken`；
- `text`。

因此 Weixin adapter 可以直接解析文本，并把 `contextToken` 放入 `ReplyContext`。绑定流程仍然先执行：

```text
未知 user → pending
已授权 user → command dispatch
未授权 user → 不执行 command
```

Weixin renderer 使用纯文本，必须支持 chunking。执行后的回复使用：

```ts
client.sendText(userId, text, contextToken)
```

现有底层发送是单个 text item：

[apps/gateway/src/weixin/ilink/client.ts:241](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/ilink/client.ts:241)

```ts
items: [{ text }],
```

### DingTalk adapter

未来 DingTalk 至少需要实现：

- webhook 或 stream inbound；
- 签名/时间戳验证；
- conversationId、userId、robot/accountId 提取；
- access token 或 reply token 管理；
- ack/reply；
- DingTalk Markdown 渲染；
- 文本长度和卡片按钮限制；
- callback action；
- 消息去重和重放保护；
- 本地 account/user 授权表；
- 发送失败和 token 过期处理。

命令 registry 和 node executor 不应为 DingTalk 再复制一份。

## 6. 测试需要更新的位置

当前 Telegram 目录没有 `*.test.ts`；文件列表中只有 `service.ts`。因此应新增：

- `apps/gateway/src/telegram/service.test.ts`
- `apps/gateway/src/messaging/command-registry.test.ts`
- `apps/gateway/src/messaging/node-target.test.ts`
- `apps/gateway/src/messaging/adapters.test.ts`

需要更新的现有测试：

- `apps/gateway/src/weixin/service.test.ts:135`  
  当前断言“inbound 无 ack”，应改为覆盖 pending gate、授权命令、回复和 chunking。

- `apps/gateway/src/weixin/ilink/client.test.ts:57`  
  保留文本提取测试，并增加命令文本、空文本、非文本消息测试。

- `apps/gateway/src/weixin/ilink/client.test.ts:282`  
  增加长消息拆分和多段发送测试。

- `apps/gateway/src/events/channels/telegram.test.ts:39`  
  增加共享 renderer、Telegram chunking、agent action/button 测试。

- `apps/gateway/src/events/channels/weixin.test.ts:37`  
  增加共享 renderer、纯文本 chunking、context token 回复测试。

- `apps/gateway/src/events/index.test.ts:316`  
  当前固定生命周期事件不进 Telegram/Weixin；如果改为可配置订阅，需要更新该断言。

- `apps/gateway/src/push/connection-alerts.test.ts:67`  
  当前固定“发送 Telegram”，需要改为测试统一 channel 分发、Weixin 覆盖和 settings gating。

- `apps/gateway/src/agent/run.test.ts:395`  
  增加 confirmation notification 到 messaging adapter，以及 `/approve`、`/deny` 的远端 node 路由测试。

- `apps/gateway/src/api/agent.test.ts`  
  已有远端 `nodeId` session 测试，应增加远端 confirmation 决策。

- `apps/gateway/src/mesh/mesh-http.test.ts`、`mesh-routes.test.ts`  
  增加 command executor 通过 remote node 的认证转发测试。

- `packages/app/src/runtime/assemble.test.ts`  
  增加 relay-only 不启动 messaging worker，或明确验证其行为。

## 7. 具体问题和风险

### P0：不存在聊天命令能力

Telegram 只接受严格 `/start`：

[apps/gateway/src/telegram/service.ts:99](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:99)

Weixin inbound 只落库，不使用 `msg.text`：

[apps/gateway/src/weixin/service.ts:181](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/service.ts:181)

因此任务要求中的 list/run/attach/approval 当前全部不存在。

### P0：没有 node target 和远端 forwarding

Telegram 只查询本地授权 chat：

[apps/gateway/src/telegram/service.ts:173](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:173)

Weixin 只查询本地授权 user：

[apps/gateway/src/weixin/service.ts:218](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/service.ts:218)

设备列表也是当前 SQLite：

[apps/gateway/src/db/devices.ts:166](/Users/konata/code/tmex-r25/apps/gateway/src/db/devices.ts:166)

mesh 的 `Forwarder` 没有被 messaging service 调用。

### P0：多节点配置和授权数据不复制

Telegram/Weixin 表没有 `nodeId`，settings broadcaster 只通知本地 WebSocket，mesh 不会刷新其他 node 的 bot service。

### P1：standby hub 没有 bot ownership/failover

没有 active writer 判断，也没有 bot lease。writer 和 standby 同时配置同一 token 时可能重复轮询；只配置 writer 时 standby 不会接管。

### P1：relay-only 仍启动 gateway messaging 服务

relay-only 明确没有 auth surface 和 node identity，但 gateway runtime 已经在 role gate 之前启动 Telegram、Weixin、push、agent、watch。没有凭证时表现为无效空转；若本地存在配置，则可能错误地尝试运行。

### P1：Telegram 群组授权粒度过粗

当前只存 `chatId`，没有保存 `from.id`。授权一个群等于授权整个群，未来执行 `/run` 或 `/approve` 会产生权限风险。

### P1：连接告警渠道不一致

`ConnectionAlertNotifier` 直接发送 Telegram，不经过 Weixin，也不经过标准 notification channel gating：

[apps/gateway/src/push/connection-alerts.ts:232](/Users/konata/code/tmex-r25/apps/gateway/src/push/connection-alerts.ts:232)

### P1：agent confirmation 没有可执行动作

事件里有 `confirmationId`，但 Telegram/Weixin 只渲染普通文本；没有按钮、callback、`/approve` 或 `/deny`，用户仍必须回到 Web UI。

### P1：远端 agent 的通知上下文可能被错误当作本地

agent session schema 已经支持 `nodeId`，并注明远端 device 不在本机 devices 表：

[apps/gateway/src/db/schema/agent.ts:78](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/agent.ts:78)

但 `notifyAgentEvent()` 仍使用本地 `getDeviceById()`：

[apps/gateway/src/agent/run-notify.ts:18](/Users/konata/code/tmex-r25/apps/gateway/src/agent/run-notify.ts:18)

远端 session 的设备名称、site URL、pane 上下文可能因此缺失或错误。

### P1：没有消息 chunking

Telegram 直接把完整字符串传给 `sendMessage`：

[apps/gateway/src/telegram/service.ts:182](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:182)

Weixin 直接作为单个 text item 发送：

[apps/gateway/src/weixin/ilink/client.ts:247](/Users/konata/code/tmex-r25/apps/gateway/src/weixin/ilink/client.ts:247)

pane 输出、agent 错误、watch 摘要变长后可能发送失败或被平台截断。

### P2：链接没有显式 node 维度

当前 pane URL 只有：

```text
/devices/:deviceId/windows/:windowId/panes/:paneId
```

是否能访问正确 node 依赖 `event.site.url` 已经被 mesh site-link 投影为合适地址。URL builder 本身没有 node 参数：

[apps/gateway/src/events/channels/pane-url.ts:16](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/pane-url.ts:16)

消息命令结果应使用 `(nodeId, deviceId, paneId)`，并在链接生成层明确 node scope。