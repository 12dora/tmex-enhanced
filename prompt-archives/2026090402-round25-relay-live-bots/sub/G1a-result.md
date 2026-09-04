# G1a 结果 — Shared messaging command template

## 做了什么

平台无关命令层已落地：解析 / 节点定位 / 分片在 `@tmex/shared/messaging`；registry / executor / adapter / handlers 在 `apps/gateway/src/messaging`。Telegram `/start` 绑定保持原语义，其余文本走命令层；微信 upsert 之后，已授权且文本非空才 dispatch。

命令只在托管 Bot 的本机节点执行。`--node` 解析到远程时返回 `messaging.error.remoteNodeUnsupported`（`CommandContext.remoteExecutor` 仅预留，当前不调用）。

## 文件

### 新增
- `packages/shared/src/messaging/**`（types / parser / node-target / chunk + 测试）
- `apps/gateway/src/messaging/**`（registry / adapter / executor / context / authorize / handlers / inbound + 测试）
- `apps/gateway/src/telegram/service.test.ts`
- `apps/gateway/drizzle/0044_messaging_commands.sql`
- `apps/gateway/src/db/messaging-commands.migration.test.ts`
- `docs/messaging/2026090402-messaging-command-template.md`

### 修改
- `packages/shared/package.json`：`exports["./messaging"]`
- `packages/shared/src/contracts/{telegram,weixin}.ts`：`allowCommands`；Telegram chat `userId`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`：顶层 `messaging`（ja_JP 为三语 key 集合一致补上）
- `apps/gateway/src/db/schema/messaging.ts`、`mappers.ts`、`telegram.ts`、`weixin.ts`
- `apps/gateway/src/db/managed-migrations.ts`（生产 embed 必须登记 0044）
- `apps/gateway/drizzle/meta/_journal.json`（idx 44，`when: 1789298400000`）
- `apps/gateway/src/api/{telegram,weixin}-routes.ts` + `messaging-routes.test.ts` / `weixin.test.ts`
- `apps/gateway/src/telegram/service.ts`、`weixin/service.ts` + `weixin/service.test.ts`
- `apps/gateway/src/api/index.routing.test.ts`（契约加字段后补 mock，否则 gateway tsc 不过）
- `apps/gateway/src/db/weixin.test.ts`（构造 `allowCommands`）

未改 `db/types.ts`：`TelegramBotConfigRecord` / `WeixinAccountConfigRecord` 继承契约，字段已从 contracts 进入。

`messaging` **未**加入 `core-keys.ts`：仅网关 `t()` 使用完整 `I18N_RESOURCES`，属 rest 包，与 `telegram`/`weixin` 同类，不像 `notification.*` 进首屏。

## 运行时挂钩（`registerMessagingRuntime`）

`apps/gateway/src/messaging/context.ts`，供 `packages/app` / `runtime.ts` 稍后注入：

| 钩子 | 未注册时 |
|---|---|
| `getUplinkStatus` | standalone → `none`；否则 `node_identity.uplink_kind`，`attached: unknown` |
| `listMeshNodes` | `node_identity` + `peer_cache`（对端 online 可能不准） |
| `getDeviceTree` / `capturePane` / `sendKeys` | 设备视为未连接 / 抛 capture-unavailable |
| `decideConfirmation` | `db/agent.decideAgentConfirmation`（**不**广播 WS；应接到 `AgentSupervisor.resolveConfirmation`） |

## 权限

- `allow_commands` 默认 0；create/update 校验布尔 `allowCommands`
- 未授权 / 待授权 / `allowCommands=false`：**静默**（微信保活场景不能对任意消息回执）
- Telegram 群聊：`/start` 写 `from.id` → `user_id`；命令仅接受同一 `from.id`；历史行 `user_id` 为空须再 `/start`

## 验证

```
cd packages/shared && bun test src/messaging     # 34 pass / 0 fail
cd packages/shared && bunx tsc --noEmit -p .     # 0
cd apps/gateway && bun test src/messaging src/telegram src/weixin \
  src/api/telegram-routes src/api/weixin-routes src/db
  # 179 pass / 0 fail（33 files）
cd apps/gateway && bun test src/api/messaging-routes.test.ts \
  src/api/weixin.test.ts src/api/index.routing.test.ts
  # 17 pass / 0 fail
bunx biome check <G1a 文件>                      # 通过
bun scripts/complexity/gate.ts                    # 全仓 ok（本任务文件无违规）
```

`bun run lint`：biome 全仓通过；complexity 在 **`packages/panels/src/settings/weixin-account-row.tsx:WeixinAccountRow` 187>178** 失败——该文件不在 G1a 范围（任务禁止碰 panels）。

gateway `bunx tsc --noEmit -p .`：本任务文件 0 错；全仓余 **1** 条：`packages/app/src/lib/native-datachannel.ts` TS5097（`.ts` 扩展名 import），属并行 agent / 既有引用链，未改。

## 留给指挥官

1. **必须** `bun run build:i18n`：locale 已改，未跑生成，`I18N_RESOURCES` 与源 JSON 暂时不同步；跑完前网关 `t('messaging.*')` 会回退成 key 本身。
2. runtime / packages/app 注入 `registerMessagingRuntime`（尤其 `decideConfirmation` → supervisor、tmux 快照/capture/sendKeys、mesh 节点列表与 uplink 状态）。
3. FE 设置页开关（panels 后续任务）。
