# 重复与代码异味审查报告

只读扫描，已排除测试、生成文件、依赖目录，并参考 `main..HEAD` 已完成的拆分。未修改任何文件；工作区已有的 `prompt-archives/2026082700-code-smell-cleanup/plan-prompt.md` 修改未触碰。

以下“行数变化”按仓库净变化估算；复杂度拆分项会同时标注主文件减少量。

## P0

### 1. BUG：`parseApiError` 有 12 份不完整副本

- 位置：
  - Canonical：[packages/api-client/src/client.ts:29-43](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/client.ts:29)
  - 副本：[packages/panels/src/settings/search-tab.tsx:34-41](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/search-tab.tsx:34)、[telegram-bot-chats-modal.tsx:23-30](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-chats-modal.tsx:23)、[telegram-bot-form-modal.tsx:16-23](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-form-modal.tsx:16)、[telegram-bot-row.tsx:14-21](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-row.tsx:14)
  - 副本：[telegram-bots-tab.tsx:18-25](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bots-tab.tsx:18)、[version-tab.tsx:24-31](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/version-tab.tsx:24)、[webhooks-tab.tsx:36-43](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/webhooks-tab.tsx:36)、[weixin-account-form-modal.tsx:18-25](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-account-form-modal.tsx:18)
  - 副本：[weixin-account-login-modal.tsx:26-33](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-account-login-modal.tsx:26)、[weixin-account-row.tsx:15-22](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-account-row.tsx:15)、[weixin-accounts-tab.tsx:18-25](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-accounts-tab.tsx:18)、[apps/fe/src/pages/settings/parse-api-error.ts:1-8](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/settings/parse-api-error.ts:1)
- 证据：canonical 处理了 `{ error: { message } }`；副本统一是 `as { error?: string }` 和 `return payload.error ?? fallback`。
- `BUG:` 当后端返回对象错误信封时，副本会在运行时返回对象，后续 `new Error(...)` 可能产生 `[object Object]`，且各副本不会读取真正的错误消息。
- 建议/删除：统一从 `@tmex/api-client` 导入 canonical `parseApiError`，删除上述 12 个本地函数及 `apps/fe/src/pages/settings/parse-api-error.ts`。
- 预估：减少约 80–95 行。
- 风险：低。
- 优先级：P0。

### 2. BUG：Markdown 图片默认 URL 缺少 `rootId`

- 位置：
  - [packages/panels/src/markdown/markdown-preview.tsx:37-62](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/markdown/markdown-preview.tsx:37)
  - [packages/api-client/src/file-urls.ts:13-17](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/file-urls.ts:13)
  - [apps/fe/src/pages/FilePage.tsx:141-184](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/FilePage.tsx:141)
  - 后端契约：[apps/gateway/src/api/files.ts:197-213](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/files.ts:197)
- 证据：Markdown 使用 `'/api/files/raw?path=...'`；canonical `fileRawUrl` 使用 `rootId` 和 `path`；后端明确要求 `if (!rootId || !path) ... 400`。
- `BUG:` `FilePage` 调用 `MarkdownPreview` 时只传入 `basePath`，未传 `rootId` 或自定义 resolver，因此 Markdown 中的本地图片请求会缺少 `rootId` 并返回 400。
- 建议/删除：让 `FilePage` 通过 `urlResolver={(path) => fileRawUrl(rootId, path)}` 传入授权根，或让 `MarkdownPreview` 显式接收 `rootId`；删除当前不安全的 `defaultRawUrlResolver`。
- 预估：增加约 5–10 行。
- 风险：中。
- 优先级：P0。

### 3. 重复定义共享 API response envelope，且存在契约变弱

- 位置：
  - Canonical：[packages/shared/src/contracts/telegram.ts:33-35](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/telegram.ts:33)、[telegram.ts:51-53](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/telegram.ts:51)、[weixin.ts:39-41](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/weixin.ts:39)、[weixin.ts:55-57](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/weixin.ts:55)
  - Canonical：[packages/shared/src/contracts/llm.ts:39-41](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/llm.ts:39)、[llm.ts:87-90](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/llm.ts:87)、[site-settings.ts:25-27](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/contracts/site-settings.ts:25)
  - 副本：[telegram-bots-tab.tsx:14-16](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bots-tab.tsx:14)、[telegram-bot-chats-modal.tsx:19-21](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-chats-modal.tsx:19)、[weixin-accounts-tab.tsx:14-16](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-accounts-tab.tsx:14)
  - 副本：[weixin-account-login-modal.tsx:35-37](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-account-login-modal.tsx:35)、[llm-providers-tab.tsx:22-28](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/llm-providers-tab.tsx:22)、[search-tab.tsx:29-32](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/search-tab.tsx:29)、[use-site-settings-form.ts:16-18](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/settings/use-site-settings-form.ts:16)
- 证据：本地类型重复 `interface TelegramBotsResponse { bots: ... }`；`search-tab` 却把 canonical 中必需的 `searchProviders` 定义成可选。
- 建议/删除：删除本地 response interfaces，改用 `ListTelegramBotsResponse`、`ListTelegramBotChatsResponse`、`ListWeixinAccountsResponse`、`ListWeixinAccountUsersResponse`、`ListLlmProvidersResponse`、`GetAgentLlmSettingsResponse`、`GetSiteSettingsResponse`。设备 response 使用 [packages/api-client/src/devices.ts:21-23](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/devices.ts:21)。
- 预估：减少约 35–50 行。
- 风险：低。
- 优先级：P0。

## P1

### 4. 设备、LLM provider、LLM settings 的 GET wrapper 重复

- 位置：
  - Canonical 设备 wrapper：[packages/api-client/src/devices.ts:11-32](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/devices.ts:11)
  - 原始设备请求：[packages/panels/src/files/files-tab.tsx:75-82](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/files/files-tab.tsx:75)、[settings/files-tab.tsx:139-150](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/files-tab.tsx:139)、[agent/use-agent-tab-model.ts:138-146](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/agent/use-agent-tab-model.ts:138)
  - 原始 provider/settings 请求：[model-picker.tsx:44-62](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/agent/model-picker.tsx:44)、[watch-rule-form.tsx:49-59](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/watch/watch-rule-form.tsx:49)、[llm-providers-tab.tsx:37-46](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/llm-providers-tab.tsx:37)、[llm-providers-tab.tsx:112-121](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/llm-providers-tab.tsx:112)、[search-tab.tsx:55-64](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/search-tab.tsx:55)
- 证据：canonical 使用 `parseApiError`；副本使用 `throw new Error('devices')`、`throw new Error('providers')` 或各自硬编码错误文本，并重复 response cast。
- 建议/删除：在 `packages/api-client/src/llm-providers.ts` 增加 `fetchLlmProviders`、`fetchAgentLlmSettings`，并从 index 导出；所有设备 queryFn 改用 `fetchDevices`。删除上述 raw `apiClient.fetch`、错误处理和类型 cast，保留调用方的 `enabled`、`throwOnError` 等 React Query 配置。
- 预估：减少约 65–90 行。
- 风险：低至中。
- 优先级：P1。

### 5. LLM provider 创建、更新 mutation 重复 raw fetch

- 位置：
  - [packages/panels/src/settings/llm-provider-form-modal.tsx:62-80](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/llm-provider-form-modal.tsx:62)
  - [packages/panels/src/settings/llm-provider-form-modal.tsx:95-117](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/llm-provider-form-modal.tsx:95)
  - [packages/panels/src/settings/llm-provider-models-modal.tsx:57-70](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/llm-provider-models-modal.tsx:57)
- 证据：三个位置都重复 `method: 'PATCH'/'POST'`、JSON headers、`parseApiError` 和 response cast；两个更新 mutation 还重复 invalidate/toast/close 流程。
- 建议/删除：在 `packages/api-client/src/llm-providers.ts` 增加 typed `createLlmProvider`、`updateLlmProvider`；删除组件中的 raw fetch、错误解析和 response cast。保留 payload 组装以及各 modal 的成功提示和关闭行为。
- 预估：减少约 45–60 行。
- 风险：中。
- 优先级：P1。

### 6. Clipboard fallback 在 ghostty-terminal 与 stores 完整复制

- 位置：
  - [packages/ghostty-terminal/src/selection-clipboard.ts:57-98](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/selection-clipboard.ts:57)
  - [packages/stores/src/runtime.ts:173-207](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/runtime.ts:173)
  - wrapper 调用：[packages/ghostty-terminal/src/terminal-input.ts:4-5](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal-input.ts:4)、[terminal-input.ts:79](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal-input.ts:79)
- 证据：两处都实现 `navigator.clipboard.writeText`，失败后创建 textarea，再调用 `document.execCommand('copy')` 并 finally 移除。
- 建议/删除：新增 browser-safe canonical，例如 `packages/shared/src/browser-clipboard.ts`；`stores/runtime.ts` 和 `ghostty-terminal` 都调用它。ghostty 保留公开 API 的 re-export；删除 `browserWriteClipboard`、`writeTextToClipboard` 中的重复实现，以及只转发调用的 `writeSelectionToClipboard`。
- 预估：减少约 30–40 行。
- 风险：中。
- 优先级：P1。

### 7. `packages/ui` 中两个未使用的 shadcn-style 组件

- 位置：
  - [packages/ui/src/components/alert.tsx:1-59](/Users/konata/code/tmex-enhanced-wt-smell/packages/ui/src/components/alert.tsx:1)
  - [packages/ui/src/components/tooltip.tsx:1-64](/Users/konata/code/tmex-enhanced-wt-smell/packages/ui/src/components/tooltip.tsx:1)
  - [packages/ui/package.json:9-12](/Users/konata/code/tmex-enhanced-wt-smell/packages/ui/package.json:9)
- 证据：组件完整导出 `Alert/AlertTitle/AlertDescription`、`Tooltip/TooltipTrigger/TooltipContent`，但仓库内没有对应精确 import 或 JSX 使用；package 通过 wildcard export 暴露了它们。
- 建议/删除：删除 `alert.tsx` 和 `tooltip.tsx`。当前实际使用的是 `alert-dialog` 等其他 primitive，没有需要迁移的 canonical consumer。
- 预估：减少约 123 行。
- 风险：低。
- 优先级：P1。

### 8. Terminal 尺寸计算重复

- 位置：
  - Canonical：[packages/terminal-ui/src/components/terminalMetrics.ts:16-41](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/terminalMetrics.ts:16)
  - 副本：[packages/terminal-ui/src/components/useTerminalResize.ts:74-108](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/useTerminalResize.ts:74)
  - 已使用 canonical 的调用：[packages/terminal-ui/src/components/Terminal.tsx:187-198](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/Terminal.tsx:187)
- 证据：两处都使用 `Math.max(2, ...)`、cell 宽度 fallback `9`、cell 高度 fallback `17`，并根据容器 rect 计算 rows/cols。
- 建议/删除：让 `measureTerminalSize` 只负责获取 terminal、fitAddon 和 rect，然后调用 `computeContainerSize`；删除 `useTerminalResize.ts:81-107` 的本地计算。
- 预估：减少约 30–35 行。
- 风险：低。
- 优先级：P1。

### 9. 日期格式化分叉，并导致站点语言失效

- 位置：
  - [packages/panels/src/watch/watch-dialog.tsx:50-59](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/watch/watch-dialog.tsx:50)
  - [packages/panels/src/settings/webhooks-tab.tsx:220-224](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/webhooks-tab.tsx:220)
  - [packages/panels/src/settings/telegram-bot-chats-modal.tsx:196-209](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-chats-modal.tsx:196)
  - [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:360-368](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:360)
  - [packages/panels/src/settings/version-tab.tsx:209-212](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/version-tab.tsx:209)
  - 共享 locale export：[packages/shared/src/index.ts:18-24](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/index.ts:18)
- 证据：多数位置使用 `toLocaleString(toBCP47(language))`；`WatchDialog` 的 `formatTime` 使用无参数 `date.toLocaleString()`。
- `BUG:` WatchDialog 日期显示使用浏览器 locale，而不是配置的站点语言；空值和非法日期处理也与其他页面不一致。
- 建议/删除：新增非生成文件 `packages/shared/src/format-date.ts`，统一处理 locale、空值和非法日期；替换这些 inline `new Date(...).toLocale*`，删除 `formatTime`，并让 WatchDialog 读取站点语言。
- 预估：净减少约 5–15 行；主要收益是消除行为分叉。
- 风险：低至中。
- 优先级：P1。

### 10. Telegram / Weixin 设置列表页近重复

- 位置：
  - [packages/panels/src/settings/telegram-bots-tab.tsx:27-85](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bots-tab.tsx:27)
  - [packages/panels/src/settings/weixin-accounts-tab.tsx:27-98](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-accounts-tab.tsx:27)
- 证据：两者都包含 `useTranslation`、modal state、`useQuery`、loading/empty 分支、Card/Header/Add Button/CardContent 和 item map。
- 建议/删除：新增 `packages/panels/src/settings/channel-settings-list.tsx`，提供 `title`、可选 subtitle、items、renderItem、loading/empty 文案和 add action。删除两个 tab 中重复的 Card/loading/empty/add 外壳；保留各自 query、row 和 modal。
- 预估：减少约 35–50 行。
- 风险：中。
- 优先级：P1。

### 11. Telegram / Weixin 设置 row 共享 shell 和 mutation 模式

- 位置：
  - [packages/panels/src/settings/telegram-bot-row.tsx:28-124](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-row.tsx:28)
  - [packages/panels/src/settings/weixin-account-row.tsx:29-206](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-account-row.tsx:29)
- 证据：两处都实现相同的 enabled PATCH、delete mutation、query invalidate、`Switch`、卡片容器和 edit/delete action 布局。
- 建议/删除：新增 `packages/panels/src/settings/channel-settings-row.tsx`，用 slots/props 注入名称、状态、额外 action 和 channel-specific content。删除两个 row 的公共卡片 shell、Switch 布局和公共操作区；保留 Telegram chats、Weixin test/login/status 等特有逻辑。
- 预估：减少约 45–65 行。
- 风险：中。
- 优先级：P1。

## P2

### 12. POSIX path、basename、dirname 工具分散

- 位置：
  - 现有 canonical：[packages/ghostty-terminal/src/file-path.ts:11-25](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/file-path.ts:11)
  - 近重复：[packages/panels/src/markdown/markdown-preview.tsx:12-35](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/markdown/markdown-preview.tsx:12)
  - basename/dirname：[apps/fe/src/pages/FilePage.tsx:40-48](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/FilePage.tsx:40)
  - tree helpers：[packages/panels/src/files/file-tree-logic.ts:5-15](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/files/file-tree-logic.ts:5)
- 证据：多个实现都手动 `lastIndexOf('/')`；两个 normalize 实现都遍历 `path.split('/')` 并处理 `.`、`..`、连续斜杠。
- 建议/删除：新增纯函数 canonical `packages/shared/src/posix-path.ts`，明确提供 absolute 与 relative 两种语义，以及 `basename`、`dirname`、`parent`。删除 Markdown 的 `normalizePosix`、FilePage 的 `baseName/dirName` 和 file-tree 的 `parentOf/nodeBasename`。不要直接复用当前 absolute-only helper，需保留相对路径的 `..` 语义。
- 预估：减少约 30–45 行。
- 风险：中。
- 优先级：P2。

### 13. Telegram / Weixin 表单 modal 生命周期和 Dialog 外壳近重复

- 位置：
  - [packages/panels/src/settings/telegram-bot-form-modal.tsx:32-195](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/telegram-bot-form-modal.tsx:32)
  - [packages/panels/src/settings/weixin-account-form-modal.tsx:39-203](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/weixin-account-form-modal.tsx:39)
- 证据：两处都有相同的 open effect、create/update mutation、invalidate、toast、pending/canSubmit、submit handler、Dialog header/footer。
- 建议/删除：新增 `channel-form-dialog.tsx` 或共享 hook，抽取公共生命周期和 Dialog shell；删除两个 modal 中对应重复块。保留 Telegram token 字段、Weixin enabled 字段和创建成功后打开登录 modal 等领域逻辑。
- 预估：减少约 50–70 行。
- 风险：中至高。
- 优先级：P2。

### 14. `TerminalShortcutsEditor` 仍是超过 300 行的复合组件

- 位置：[packages/panels/src/settings/TerminalShortcutsEditor.tsx:207-511](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/TerminalShortcutsEditor.tsx:207)
- 证据：同一组件同时负责 query/baseline 同步、dirty 判断、DnD sensors（`260-264`）、mutation（`266-285`）、快捷键录入和完整编辑 UI（`287-510`）。
- 建议/删除：提取 `use-terminal-shortcuts-editor.ts` 处理数据与 mutation，提取 `ShortcutAddPanel.tsx` 处理新增/捕获区域；将主组件保留为列表、状态和保存外壳。删除原文件中搬迁后的对应 blocks。
- 预估：主文件减少约 180–220 行，仓库净变化约 0。
- 风险：中。
- 优先级：P2。

### 15. `FileRootFormModal` 约 220 行，混合表单状态、设备选择和全部 JSX

- 位置：[packages/panels/src/settings/files-tab.tsx:333-564](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/settings/files-tab.tsx:333)
- 证据：`FileRootFormModal` 内同时包含 device group 展开、create/update mutation、路径校验、设备 Select、enabled Switch 和 Dialog footer。
- 建议/删除：移动为 `packages/panels/src/settings/file-root-form-modal.tsx`，从 `files-tab.tsx` 删除 `FileRootFormModalProps`、组件实现及对应 imports；列表 tab 只保留 roots/device query 和 row。
- 预估：主文件减少约 230 行，仓库净变化约 0。
- 风险：中。
- 优先级：P2。

### 16. `WatchDialog` 仍包含约 200 行列表、删除和视图切换逻辑

- 位置：[packages/panels/src/watch/watch-dialog.tsx:61-260](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/watch/watch-dialog.tsx:61)
- 证据：同一组件包含 query、toggle/delete mutation、通知权限 banner、列表渲染、form/state 分支和删除确认 Dialog。
- 建议/删除：提取 `WatchDialogList` 或 `use-watch-dialog-controller`，将列表/banner/delete-confirmation 搬出；保留现有已拆出的 `WatchRuleForm`，不要再次拆分它。删除原文件中搬迁后的 `WatchDialog` 大段 JSX。
- 预估：主文件减少约 170–200 行，仓库净变化约 0。
- 风险：低至中。
- 优先级：P2。