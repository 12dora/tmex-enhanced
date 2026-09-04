# F4 结果：设置页「允许聊天指令」开关（Telegram Bot / 微信账号）

## 改动清单

- `packages/panels/src/settings/integration-account-form-modal.tsx`
  - `IntegrationFieldBase` 新增可选 `descriptionKey`，开关字段可在标签下渲染一行说明（`data-testid="<testId>-help"`）。
  - 开关渲染从 `renderField` 拆出 `renderToggleField`（保持函数复杂度低），有说明时容器改 `items-start` 并给 Switch 加 `mt-0.5`。
- `packages/panels/src/settings/telegram-bot-form-modal.tsx`
  - 新增 toggle 字段 `allowCommands`（testId/inputId `telegram-bot-allow-commands`，labelKey `telegram.allowCommands`，descriptionKey `telegram.allowCommandsHelp`），缺省 `false`，编辑态回填 `bot.allowCommands`。
  - 新增与编辑载荷都带 `allowCommands`（`telegramUpdatePayload` 增参）。
- `packages/panels/src/settings/weixin-account-form-modal.tsx`
  - 同上，字段 `weixin-account-allow-commands`，缺省 `false`；新增与编辑载荷都带 `allowCommands`（编辑载荷此前只有 name/enabled）。
- `packages/panels/src/settings/chat-commands-badge.tsx`（新增）
  - `ChatCommandsBadge`：`allowCommands` 为真才渲染的小徽标，amber 配色（对齐 `device-status-badge` 的告警色），`title` 挂说明文案，命名空间参数区分 telegram/weixin。抽出来避免两个 row 重复，也让徽标可脱离 react-query/runtime provider 单测。
- `packages/panels/src/settings/telegram-bot-row.tsx`
  - bot 名称行改为 `flex flex-wrap`，名称后挂 `ChatCommandsBadge`（testId `telegram-bot-commands-<id>`）。
- `packages/panels/src/settings/weixin-account-row.tsx`
  - 在登录状态徽标之后、「会话已过期」之前插入 `ChatCommandsBadge`（testId `weixin-account-commands-<id>`）。
- `packages/panels/src/settings/integration-account-form-modal.test.tsx`
  - 更新 telegram/weixin 载荷断言以覆盖 `allowCommands`；新增「缺省关闭 + 编辑态回填」两条；新增 describe「开关字段的补充说明」（有 `descriptionKey` 才出说明行；两个渠道的 allowCommands 开关都配了说明）。
- `packages/panels/src/settings/chat-commands-badge.test.tsx`（新增）
  - 关闭时渲染为空、开启时出 testId + 文案 + title、微信命名空间取 `weixin.*`、源 locale 文案齐备。
  - 该测试的 i18n 实例直接读 `@tmex/shared/i18n/locales/zh_CN.json`（源 locale），**不依赖生成的 `resources.ts`**，因此在总控重新生成 i18n 之前也能断言真实文案。
- i18n（三语，只动 telegram/weixin 两个命名空间，插在 `allowAuthRequests` 之后）
  - `telegram.allowCommands` / `telegram.allowCommandsHelp` / `telegram.commandsBadge`
  - `weixin.allowCommands` / `weixin.allowCommandsHelp` / `weixin.commandsBadge`
  - zh_CN：「允许聊天指令」/「已授权会话可在本机终端输入指令并批准智能体操作。」/「聊天指令」
  - en_US：`Allow Chat Commands` / `Authorized chats can type into terminals on this machine and approve agent actions.` / `Chat Commands`
  - ja_JP：「チャットコマンドを許可」/「承認済みのチャットが本機のターミナルにコマンドを入力し、エージェント操作を承認できます。」/「チャットコマンド」

## 验证

- `cd packages/panels && bun test src/settings`
  - 改前基线：`109 pass / 0 fail`（9 个文件）
  - 改后：`117 pass / 0 fail`（10 个文件，251 expect）
- `cd packages/panels && bunx tsc --noEmit -p .` → 无输出（0 error，对齐基线）
- `bunx biome check`（我改的 8 个 tsx + 3 个 locale JSON）→ `No fixes applied`，无告警

## 说明与遗留

- 后端契约已落地：`packages/shared/src/contracts/{telegram,weixin}.ts` 的 `allowCommands: boolean` 与 `apps/gateway/src/api/{telegram,weixin}-routes.ts` 的 create/update 字段（缺省 false）在我开工时已在工作区，前端按此编码，tsc 无报错。未改 shared / gateway 任何文件。
- **i18n 生成文件未重建**：`packages/shared/src/i18n/resources.ts`、`locales/generated/*.rest.json`、`i18n/types.ts` 仍是旧的，需总控统一跑 `bun run --filter @tmex/shared build:i18n`。在此之前界面上新键会退化成 key 文本（我的单测不受影响，见上）。
- `packages/api-client` 内没有 telegram/weixin 的请求/响应类型（grep 无命中），故未改。
- `apps/fe/tests/{settings,mobile-settings}.spec.ts` 的 Playwright mock bot 对象没有 `allowCommands` 字段，读到 `undefined` 时徽标不渲染，不会让现有 e2e 失败；若后续要 e2e 覆盖徽标，需另有人在这两个 stub 里补字段（不在本任务范围）。
- 未在开发实例中截图核对换行（并行改同一 worktree，不便起临时实例）；说明行为单行 xs 文案，中文 22 字、英文 83 字符，弹窗宽度 `sm:max-w-lg`（512px）下预计折成 1–2 行，建议总控在整合后统一截图核对。
