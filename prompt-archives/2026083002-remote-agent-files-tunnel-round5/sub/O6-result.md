# O6 结果 — 全量 i18n 扫描：未翻译字符串 + 「pane」→「terminal」措辞

## 一、做了什么

### 1. 系统性对比脚本
在 scratch 目录写了三个脚本（不入库）：
- `cmp.ts`：拍平三份 locale JSON，输出 (a) 键不对齐项，(b) zh_CN / ja_JP 与 en_US 完全相同的值，(c) 目标语言里不含任何 CJK 字符的可疑值。
- `pane.ts`：按正则抽取三语同一 key 的三个值，用于逐条判断 pane / panel / agent / 端末 等词的语境。
- `eng.ts`：剥掉 `{{插值}}` 与标签后，找 zh/ja 值里仍存在「连续两个英文单词」的条目。

结论：仓库 i18n 结构本身很干净，**键完全对齐**（唯一差异见「五、遗留观察」），真正未翻译的只有下面表里那几条；其余「与英文相同」的值全是专有名词 / 技术 token（`SSH`、`tmux`、`Hub`、`WebSocket`、`Cloudflare`、`HTTPS`、`API Key`、`Bot Token`、`Let's Encrypt`、`macOS`、示例 URL、示例主机名、语言自称等），按任务要求保留。

### 2. 措辞统一
- **pane → terminal（仅文案）**：en `pane/panes/Pane` → `terminal/terminals/Terminal`；zh `Pane/pane/面板（指 pane 时）` → `终端`；ja `ペイン` → `ターミナル`。
  代码标识符、路由、`paneId`、`data-testid`、插值变量名（`{{pane}}`、`{{paneId}}`、`{{paneLabel}}`）**一律未动**。
  歧义处逐条读过：`nodes.https.acme.pendingHint` 里的「面板 / panel」是真正的页面面板，保留；`sidebar.tab.panes` 本来就是「终端 / Terminals」，只把 ja 的「端末」统一成「ターミナル」。
- **agent → 智能体 / エージェント（作普通名词时）**：`Agent 会话` → `智能体会话` 等。
  **SSH agent 相关一律保留英文**（`device.authAgent`、`device.authAuto`、`sshError.agent*`、`deviceStatus.errorBadge.agent*`、`files.error.auth_unsupported` 里的 `ssh-agent`），en_US 侧 `Agent` 作产品词也保留（与既有 `sidebar.tab.agent` 的 en=Agent / zh=智能体 一致）。
- ja 侧顺手统一了 `端末` → `ターミナル`（原本 22 处 ターミナル vs 8 处 端末 混用）。
- zh `agent.toast.errorTitle` 的直角引号从 `“”` 改成中文书名号 `「」`，与其余文案一致。

### 3. 组件里的硬编码字符串
按 `title=` / `placeholder=` / `aria-label=` / `alt=` / JSX 文本 / toast / throw 全量 grep 了 `apps/fe/src`、`packages/panels/src`、`packages/terminal-ui/src`、`packages/ui/src`。命中的用户可见字面量已全部改为 `t()`（见「三、文件清单」）。`throw new Error('...')` 一类是开发者错误、不进 UI，未动；`<code>npx tmex-cli restart</code>` 是要照抄的 shell 命令，未动。

## 二、改动明细（key / before / after）

（`settings.remoteAccess.*` 的新增键是并行的 tunnel agent 写的，不在下表内。）

| locale | key | before | after |
| --- | --- | --- | --- |
| en_US | `common.mermaidRenderFailed` | *(新增)* | Mermaid failed to render: {{message}} |
| en_US | `nav.toggleSubmenu` | *(新增)* | Toggle submenu |
| en_US | `terminal.paneClosed` | Current pane has been closed, please select a pane from the sidebar. | The current terminal has been closed. Select another one from the sidebar. |
| en_US | `terminal.paneTitle` | Pane {{index}} | Terminal {{index}} |
| en_US | `terminal.activePane` | Current Pane | Current terminal |
| en_US | `terminal.closePane` | Close Pane | Close terminal |
| en_US | `webhook.urlPlaceholder` | *(新增)* | https://example.com/webhook |
| en_US | `apiError.agentPaneRequired` | Terminal pane is required | A terminal is required |
| en_US | `notification.clickToJump` | Click to jump to corresponding pane | Click to jump to the corresponding terminal |
| en_US | `notification.eventType.tmux_pane_close` | 📱 Pane Closed | 📱 Terminal Closed |
| en_US | `notification.pane` | Pane | Terminal |
| en_US | `notification.telegramBell.terminalTopbarLabel` | Window {{window}} · Pane {{pane}} @ {{device}} | Window {{window}} · Terminal {{pane}} @ {{device}} |
| en_US | `notification.watch.paneGone` | Watch "{{name}}" pane ({{paneId}}) was destroyed; the rule has been removed | Watch "{{name}}" terminal ({{paneId}}) was destroyed; the rule has been removed |
| en_US | `sidebar.currentPane` | Current Pane | Current terminal |
| en_US | `sidebar.closePane` | Close Pane | Close terminal |
| en_US | `agent.session.createDisabledNoPane` | Open a terminal pane to create a session | Open a terminal to create a session |
| en_US | `agent.binding.invalid` | Pane unavailable | Terminal unavailable |
| en_US | `agent.binding.mismatchTitle` | This session is bound to a different pane | This session is bound to a different terminal |
| en_US | `agent.binding.goTo` | Go to pane | Go to terminal |
| en_US | `agent.tool.get_pane_info` | Get pane info | Get terminal info |
| en_US | `agent.tool.imageAlt` | *(新增)* | Generated image |
| en_US | `window.closePane` | Close pane | Close terminal |
| en_US | `window.closePaneConfirmTitle` | Close this pane? | Close this terminal? |
| en_US | `window.paneMenu` | Pane actions | Terminal actions |
| en_US | `window.dragHandlePane` | Drag to reorder pane | Drag to reorder terminals |
| en_US | `window.switchPane` | Switch pane | Switch terminal |
| en_US | `window.paneCount` | {{count}} panes | {{count}} terminals |
| en_US | `window.pane` | Pane | Terminal |
| en_US | `watch.dialogDesc` | Monitor this pane's screen and get notified when conditions are met | Monitor this terminal's screen and get notified when conditions are met |
| en_US | `watch.openMonitor` | Watch this pane | Watch this terminal |
| en_US | `watch.rules.empty` | No watch rules for this pane yet | No watch rules for this terminal yet |
| en_US | `files.symlink` | *(新增)* | Symbolic link |
| en_US | `nodes.setup.fields.urlPlaceholder` | *(新增)* | https://tmex.example.com |
| zh_CN | `common.mermaidRenderFailed` | *(新增)* | Mermaid 渲染失败：{{message}} |
| zh_CN | `nav.toggleSubmenu` | *(新增)* | 展开或收起子菜单 |
| zh_CN | `terminal.paneClosed` | 当前 Pane 已关闭，请在侧边栏重新选择 Pane。 | 当前终端已关闭，请在侧边栏重新选择。 |
| zh_CN | `terminal.paneTitle` | Pane {{index}} | 终端 {{index}} |
| zh_CN | `terminal.activePane` | 当前 pane | 当前终端 |
| zh_CN | `terminal.closePane` | 关闭 pane | 关闭终端 |
| zh_CN | `settings.terminal.shortcuts.action.newAgentSession` | 新建 Agent 会话 | 新建智能体会话 |
| zh_CN | `telegram.chatId` | chatId | Chat ID |
| zh_CN | `telegram.gatewayOnline` | 🟢 Gateway online @ {{siteName}} | 🟢 网关已上线 @ {{siteName}} |
| zh_CN | `telegram.agentCredentialWarning` | ⚠️ {{siteName}}：Agent 会话「{{sessionTitle}}」的一条消息疑似包含凭证（{{types}}）。该内容将发送至 LLM 并存储，存在泄露风险。 | ⚠️ {{siteName}}：智能体会话「{{sessionTitle}}」的一条消息疑似包含凭证（{{types}}）。该内容将发送至 LLM 并存储，存在泄露风险。 |
| zh_CN | `webhook.urlPlaceholder` | *(新增)* | https://example.com/webhook |
| zh_CN | `websocket.upgradeFailed` | Upgrade failed | 升级失败 |
| zh_CN | `websocket.invalidMessage` | Invalid message format | 消息格式无效 |
| zh_CN | `apiError.deviceNotFound` | Device not found | 设备不存在 |
| zh_CN | `apiError.urlAndSecretRequired` | URL and secret required | URL 与密钥不能为空 |
| zh_CN | `apiError.notFound` | Not found | 未找到 |
| zh_CN | `apiError.agentSessionNotFound` | Agent 会话不存在 | 智能体会话不存在 |
| zh_CN | `apiError.agentSessionBusy` | Agent 会话正在运行中，请先停止或等待完成 | 智能体会话正在运行中，请先停止或等待完成 |
| zh_CN | `apiError.agentSessionAwaitingConfirmation` | Agent 会话有待处理的确认请求，请先处理 | 智能体会话有待处理的确认请求，请先处理 |
| zh_CN | `apiError.agentPaneRequired` | 必须指定终端 pane | 必须指定终端 |
| zh_CN | `apiError.agentHostedToolRequiresResponses` | Provider hosted 工具仅支持 openai-responses 协议 | 服务商托管工具仅支持 openai-responses 协议 |
| zh_CN | `apiError.agentSessionOrphaned` | 该 Agent 会话已孤立（绑定终端已不存在），仅可只读查看 | 该智能体会话已孤立（绑定终端已不存在），仅可只读查看 |
| zh_CN | `notification.clickToJump` | 点击跳转到对应 Pane | 点击跳转到对应终端 |
| zh_CN | `notification.eventType.tmux_pane_close` | 📱 Pane 关闭 | 📱 终端关闭 |
| zh_CN | `notification.eventType.agent_confirmation_pending` | 🤖 Agent 等待确认 | 🤖 智能体等待确认 |
| zh_CN | `notification.eventType.agent_turn_finished` | 🤖 Agent 回合完成 | 🤖 智能体回合完成 |
| zh_CN | `notification.eventType.agent_error` | 🤖 Agent 错误 | 🤖 智能体错误 |
| zh_CN | `notification.pane` | Pane | 终端 |
| zh_CN | `notification.telegramBell.terminalTopbarLabel` | 窗口 {{window}} · Pane {{pane}} @ {{device}} | 窗口 {{window}} · 终端 {{pane}} @ {{device}} |
| zh_CN | `notification.agent.confirmationPending` | Agent「{{title}}」请求执行工具 {{toolName}}，等待确认 | 智能体「{{title}}」请求执行工具 {{toolName}}，等待确认 |
| zh_CN | `notification.agent.turnFinished` | Agent「{{title}}」回合完成 | 智能体「{{title}}」回合完成 |
| zh_CN | `notification.agent.error` | Agent「{{title}}」出错：{{message}} | 智能体「{{title}}」出错：{{message}} |
| zh_CN | `notification.watch.paneGone` | 监控「{{name}}」的 Pane（{{paneId}}）已销毁，规则已自动删除 | 监控「{{name}}」的终端（{{paneId}}）已销毁，规则已自动删除 |
| zh_CN | `sidebar.currentPane` | 当前 pane | 当前终端 |
| zh_CN | `sidebar.closePane` | 关闭 pane | 关闭终端 |
| zh_CN | `agent.files.comingSoon` | Coming Soon | 即将推出 |
| zh_CN | `agent.panel.title` | Agent | 智能体 |
| zh_CN | `agent.welcome.title` | 新建 Agent 对话 | 新建智能体对话 |
| zh_CN | `agent.welcome.subtitle` | 向 Agent 描述你的需求，在所选终端中协作 | 向智能体描述你的需求，在所选终端中协作 |
| zh_CN | `agent.session.new` | 新建 Agent 会话 | 新建智能体会话 |
| zh_CN | `agent.session.createDisabledNoPane` | 请先打开一个终端 Pane 再创建会话 | 请先打开一个终端再创建会话 |
| zh_CN | `agent.binding.mismatchTitle` | 此会话绑定的 Pane 与当前终端不一致 | 此会话绑定的终端与当前所选终端不一致 |
| zh_CN | `agent.tool.get_pane_info` | 获取面板信息 | 获取终端信息 |
| zh_CN | `agent.tool.imageAlt` | *(新增)* | 生成的图片 |
| zh_CN | `agent.paneBadge.bound` | Agent 已绑定 | 智能体已绑定 |
| zh_CN | `agent.paneBadge.generating` | Agent 输出中 | 智能体输出中 |
| zh_CN | `agent.controlChars.hint` | 允许 agent 通过 send_input 发送原始控制字符（C0）。默认关闭；仅在必要时开启。 | 允许智能体通过 send_input 发送原始控制字符（C0）。默认关闭；仅在必要时开启。 |
| zh_CN | `agent.toast.errorTitle` | Agent“{{title}}”出错 | 智能体「{{title}}」出错 |
| zh_CN | `window.closePane` | 关闭面板 | 关闭终端 |
| zh_CN | `window.closePaneConfirmTitle` | 关闭此面板？ | 关闭此终端？ |
| zh_CN | `window.paneMenu` | 面板操作 | 终端操作 |
| zh_CN | `window.dragHandlePane` | 拖动以调整 pane 顺序 | 拖动以调整终端顺序 |
| zh_CN | `window.switchPane` | 切换 Pane | 切换终端 |
| zh_CN | `window.paneCount` | {{count}} 个 pane | {{count}} 个终端 |
| zh_CN | `window.pane` | Pane | 终端 |
| zh_CN | `files.menu.sendToAgent` | 发送到 Agent | 发送到智能体 |
| zh_CN | `files.symlink` | *(新增)* | 符号链接 |
| zh_CN | `nodes.setup.fields.urlPlaceholder` | *(新增)* | https://tmex.example.com |
| ja_JP | `common.mermaidRenderFailed` | *(新增)* | Mermaid のレンダリングに失敗しました：{{message}} |
| ja_JP | `nav.toggleSubmenu` | *(新增)* | サブメニューの開閉 |
| ja_JP | `device.namePlaceholder` | 例：My Server | 例：マイサーバー |
| ja_JP | `terminal.keyboardBehavior.modeLiftDesc` | キーボード表示時にページ全体を上に移動（端末サイズは不変） | キーボード表示時にページ全体を上に移動（ターミナルサイズは不変） |
| ja_JP | `terminal.keyboardBehavior.modeResize` | 端末リサイズ | ターミナルをリサイズ |
| ja_JP | `terminal.keyboardBehavior.modeResizeDesc` | キーボード上の領域に合わせて端末を縮小（リモートの行数が変わります） | キーボード上の領域に合わせてターミナルを縮小（リモートの行数が変わります） |
| ja_JP | `terminal.keyboardBehavior.modeFollowDesc` | カーソルがキーボードの真上に来るよう移動（端末サイズは不変） | カーソルがキーボードの真上に来るよう移動（ターミナルサイズは不変） |
| ja_JP | `terminal.paneClosed` | 現在のペインは閉じられました。サイドバーからペインを選択してください。 | 現在のターミナルは閉じられました。サイドバーから選択してください。 |
| ja_JP | `terminal.paneTitle` | ペイン {{index}} | ターミナル {{index}} |
| ja_JP | `terminal.activePane` | 現在のペイン | 現在のターミナル |
| ja_JP | `terminal.closePane` | ペインを閉じる | ターミナルを閉じる |
| ja_JP | `settings.terminal.shortcuts.action.newAgentSession` | 新しい Agent セッション | 新しいエージェントセッション |
| ja_JP | `telegram.gatewayOnline` | 🟢 Gateway online @ {{siteName}} | 🟢 ゲートウェイがオンラインになりました @ {{siteName}} |
| ja_JP | `telegram.agentCredentialWarning` | ⚠️ {{siteName}}：Agent セッション「{{sessionTitle}}」のメッセージに認証情報が含まれている可能性があります（{{types}}）。LLM に送信され保存されるため、漏洩のリスクがあります。 | ⚠️ {{siteName}}：エージェントセッション「{{sessionTitle}}」のメッセージに認証情報が含まれている可能性があります（{{types}}）。LLM に送信され保存されるため、漏洩のリスクがあります。 |
| ja_JP | `webhook.urlPlaceholder` | *(新增)* | https://example.com/webhook |
| ja_JP | `apiError.agentSessionNotFound` | Agent セッションが存在しません | エージェントセッションが存在しません |
| ja_JP | `apiError.agentSessionBusy` | Agent セッションは実行中です。停止するか完了をお待ちください | エージェントセッションは実行中です。停止するか完了をお待ちください |
| ja_JP | `apiError.agentSessionAwaitingConfirmation` | Agent セッションに未処理の確認リクエストがあります。先に処理してください | エージェントセッションに未処理の確認リクエストがあります。先に処理してください |
| ja_JP | `apiError.agentPaneRequired` | ターミナル pane を指定してください | ターミナルを指定してください |
| ja_JP | `apiError.agentSessionOrphaned` | この Agent セッションは孤立しており（端末が存在しません）、読み取り専用です | このエージェントセッションは孤立しており（ターミナルが存在しません）、読み取り専用です |
| ja_JP | `notification.clickToJump` | 対応するペインにジャンプ | 対応するターミナルにジャンプ |
| ja_JP | `notification.eventType.tmux_pane_close` | 📱 ペイン閉じる | 📱 ターミナルを閉じました |
| ja_JP | `notification.pane` | ペイン | ターミナル |
| ja_JP | `notification.telegramBell.terminalTopbarLabel` | ウィンドウ {{window}} · ペイン {{pane}} @ {{device}} | ウィンドウ {{window}} · ターミナル {{pane}} @ {{device}} |
| ja_JP | `notification.agent.confirmationPending` | Agent「{{title}}」がツール {{toolName}} の実行確認を求めています | エージェント「{{title}}」がツール {{toolName}} の実行確認を求めています |
| ja_JP | `notification.agent.turnFinished` | Agent「{{title}}」のターンが完了しました | エージェント「{{title}}」のターンが完了しました |
| ja_JP | `notification.agent.error` | Agent「{{title}}」でエラーが発生しました：{{message}} | エージェント「{{title}}」でエラーが発生しました：{{message}} |
| ja_JP | `notification.watch.paneGone` | Watch「{{name}}」のペイン（{{paneId}}）が破棄されたため、ルールを削除しました | Watch「{{name}}」のターミナル（{{paneId}}）が破棄されたため、ルールを削除しました |
| ja_JP | `sidebar.currentPane` | 現在のペイン | 現在のターミナル |
| ja_JP | `sidebar.closePane` | ペインを閉じる | ターミナルを閉じる |
| ja_JP | `sidebar.tab.panes` | 端末 | ターミナル |
| ja_JP | `agent.orphan.readonly` | このセッションは孤立しており（端末が存在しません）、読み取り専用です | このセッションは孤立しており（ターミナルが存在しません）、読み取り専用です |
| ja_JP | `agent.files.comingSoon` | Coming Soon | 近日公開 |
| ja_JP | `agent.panel.title` | Agent | エージェント |
| ja_JP | `agent.welcome.title` | 新しい Agent チャット | 新しいエージェントチャット |
| ja_JP | `agent.welcome.subtitle` | タスクを入力して、選択した端末での作業を始めましょう | タスクを入力して、選択したターミナルでの作業を始めましょう |
| ja_JP | `agent.session.createDisabledNoPane` | ターミナルのペインを開いてからセッションを作成してください | ターミナルを開いてからセッションを作成してください |
| ja_JP | `agent.binding.mismatchTitle` | このセッションは別のペインにバインドされています | このセッションは別のターミナルにバインドされています |
| ja_JP | `agent.binding.rebind` | 現在のペインに再バインド | 現在のターミナルに再バインド |
| ja_JP | `agent.tool.get_pane_info` | ペイン情報を取得 | ターミナル情報を取得 |
| ja_JP | `agent.tool.imageAlt` | *(新增)* | 生成された画像 |
| ja_JP | `agent.paneBadge.bound` | Agent バインド中 | エージェントバインド済み |
| ja_JP | `agent.paneBadge.generating` | Agent 出力中 | エージェント出力中 |
| ja_JP | `agent.toast.errorTitle` | Agent「{{title}}」でエラー | エージェント「{{title}}」でエラー |
| ja_JP | `window.closePane` | ペインを閉じる | ターミナルを閉じる |
| ja_JP | `window.closePaneConfirmTitle` | このペインを閉じますか？ | このターミナルを閉じますか？ |
| ja_JP | `window.paneMenu` | ペイン操作 | ターミナル操作 |
| ja_JP | `window.dragHandlePane` | ドラッグしてペインを並べ替え | ドラッグしてターミナルを並べ替え |
| ja_JP | `window.switchPane` | ペイン切替 | ターミナル切替 |
| ja_JP | `window.paneCount` | {{count}} ペイン | {{count}} 個のターミナル |
| ja_JP | `window.pane` | ペイン | ターミナル |
| ja_JP | `watch.dialogDesc` | このペインの画面を監視し、条件を満たしたら通知します | このターミナルの画面を監視し、条件を満たしたら通知します |
| ja_JP | `watch.rules.empty` | このペインにはまだ監視ルールがありません | このターミナルにはまだ監視ルールがありません |
| ja_JP | `files.menu.sendToAgent` | Agent に送る | エージェントに送る |
| ja_JP | `files.symlink` | *(新增)* | シンボリックリンク |
| ja_JP | `nodes.setup.fields.urlPlaceholder` | *(新增)* | https://tmex.example.com |

## 三、文件清单

### locale 源（生成物由 `bun run build:i18n` 重建，未手改）
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/ja_JP.json`
- （生成物：`packages/shared/src/i18n/resources.ts`、`packages/shared/src/i18n/types.ts` — 跑 `bun run build:i18n` 产生）

### 组件：硬编码字符串改 `t()`
- `packages/panels/src/markdown/mermaid-block.tsx` — `Mermaid 渲染失败：{error}` → `t('common.mermaidRenderFailed', { message: error })`（新增 `useTranslation`）
- `packages/panels/src/files/files-tab.tsx` — 软链角标 `title="symlink"` → `t('files.symlink')`（`FileLeaf` 里新增 `useTranslation`）
- `packages/panels/src/agent/messages/tool-call-card.tsx` — 工具产出图片 `alt="generated"` → `t('agent.tool.imageAlt')`（`ToolImages` 里新增 `useTranslation`）
- `packages/panels/src/settings/webhooks-tab.tsx` — `placeholder="https://example.com/webhook"` → `t('webhook.urlPlaceholder')`
- `apps/fe/src/components/page-layouts/components/nav-main.tsx` — 子菜单展开按钮 sr-only `Toggle` → `t('nav.toggleSubmenu')`
- `apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx` — `placeholder="https://tmex.example.com"` → `t('nodes.setup.fields.urlPlaceholder')`
- `apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx` — 同上

### 测试：断言旧文案，已随改
- `apps/gateway/src/events/channels/notification-format.test.ts` — `Window 7 · Pane 3 @ mac` → `Window 7 · Terminal 3 @ mac`
- `apps/gateway/src/events/index.test.ts` — 两处 `Window 7 · Pane 3` → `Window 7 · Terminal 3`

## 四、验证结果

| 项目 | 结果 | 基线 |
| --- | --- | --- |
| `packages/shared` `bun test` | 365 pass / 0 fail | 365 / 0 ✓ |
| `packages/shared` `tsc --noEmit` | 0 error | 0 ✓ |
| `packages/panels` `bun test` | 562 pass / 0 fail | 507 / 0（数量增加是并行 agent 新增测试）|
| `packages/panels` `tsc --noEmit` | 0 error | 0 ✓ |
| `packages/terminal-ui` `bun test` | 315 pass / 0 fail | — |
| `packages/terminal-ui` `tsc --noEmit` | 0 error | — |
| `apps/fe` `bun test src/` | 我改完时 764 pass / 0 fail；收尾复跑 777 pass / 5 fail —— 5 条全在 `src/node/node-offline.test.ts`，是并行 agent 把 `isNodeOffline` 改成 `(snapshot, nodeId)` 双参后测试还没跟上（与 i18n 无关，不是我的文件）| 671 / 0（同上）|
| `apps/fe` `tsc --noEmit` | 3 error | 0 —— **全部是 tunnel agent 的 `remote-access` fixture**（`TunnelStatusResponse.configuredTrustProxy` 可选性），与本任务无关 |
| `apps/gateway` `bun test` | **2581 pass / 0 fail**（改文案后先出现 3 条 fail，全部是断言旧 `terminalTopbarLabel` 的用例，已同步改测试）| 2500 pass |
| `apps/gateway` `tsc --noEmit` | 22 error | 21 —— 多出的 1 条在 `src/tunnel/manager.ts`，属 tunnel agent；我改的 `src/events/*` 无 error |
| `packages/stores` `bun test` | 299 pass / 0 fail | 282 / 1 tsc（未动该包）|
| `packages/ui` `bun test` | 47 pass / 0 fail | 47 / 0 ✓ |
| `packages/api-client` `bun test` | 132 pass / 0 fail | 132 ✓ |
| `bunx biome check <改动文件>` | 10 + 2 文件，No fixes applied | ✓ |

`bun run build:i18n` 在全部编辑之后又跑了一次，确保 `resources.ts` / `types.ts` 与当前 JSON（含并行 agent 写入的 `settings.remoteAccess.*`）一致。

## 五、遗留 / 风险

### 1. `packages/ui` 里 4 处英文 sr-only / aria-label 未处理（**需要后续决策**）
`@tmex/ui` 是纯 primitives 包，**没有 `react-i18next` 依赖**（`Bun.resolveSync('react-i18next', 'packages/ui/src')` 直接报 `Cannot find package`；react-i18next 实际装在 `apps/fe/node_modules`，靠 `terminal-ui` 的 peerDependencies 才软链过去）。给它加 i18n 必须改 `packages/ui/package.json` + 跑 `bun install`（动 `bun.lock` 与 node_modules），这既超出「只改字符串行、不重构」的范围，也不在我的文件 scope 里，而且并行有 5~6 个 agent 在同一 worktree 跑测试，install 期间会互相干扰。因此**未改，列在这里**：

| 文件 | 行 | 字面量 | 用途 |
| --- | --- | --- | --- |
| `packages/ui/src/components/dialog.tsx` | 72 | `Close` | 关闭按钮 sr-only |
| `packages/ui/src/components/sheet.tsx` | 73 | `Close` | 关闭按钮 sr-only |
| `packages/ui/src/components/sidebar/sidebar-layout.tsx` | 62 / 63 | `Sidebar` / `Displays the mobile sidebar.` | 移动端 Sheet 的 sr-only 标题与描述 |
| `packages/ui/src/components/sidebar/sidebar-layout.tsx` | 211 / 223 / 226 | `Toggle Sidebar` | `SidebarTrigger` sr-only、`SidebarRail` 的 `aria-label` + `title` |

两条可选路线（建议由 commander 拍板）：
- **A（推荐，符合现有约定）**：像 O7 新加的 `packages/ui/src/components/icon-tooltip.tsx` 那样，把文案作为 prop 从消费方传进来（`@tmex/ui` 保持无 i18n）。需要给 `DialogContent` / `SheetContent` 加 `closeLabel`，给 `Sidebar` 加 `mobileTitle` / `mobileDescription`，`SidebarTrigger` / `SidebarRail` 加 `toggleLabel`，再由 `apps/fe` 传 `t(...)`。
- **B**：给 `@tmex/ui` 加 `react-i18next` peerDependency 并 `bun install`，直接在包内 `useTranslation()`。改动最小但会动依赖图与 lockfile。

注意：`apps/fe/tests/sidebar-resize.spec.ts:42` 用 `getByRole('button', { name: 'Toggle Sidebar' })` 定位移动端侧栏按钮。**任一路线落地后这条 e2e 必须同步改**，建议换成已存在的 `page.getByTestId('mobile-sidebar-open')`（`apps/fe/src/page-wrapper.tsx` 上已经有这个 testid，语言无关）。现在没改文案，所以这条 spec 仍然是绿的。

顺带：`apps/fe/src/components/side-panels/side-panel-host.tsx:54` 的注释已经写明「自带的那个是绝对定位 + 未翻译的 sr-only 文案」，说明这个坑之前就被绕开过，值得一并收掉。

### 2. `devices.folders.itemCount` 的复数键不对齐（既有，未动）
en_US 用 `itemCount_one` / `itemCount_other`，zh_CN / ja_JP 只有 `itemCount`。中日只有一种复数形式，i18next 查不到 `itemCount_other` 会回退到基础键，目前渲染正常、`packages/panels` 测试全绿。属既有约定而非未翻译问题，不在本轮扫描判据内，故保留；若要彻底规整，应把中日的键改名为 `itemCount_other`。

### 3. 刻意保留为英文/原样的值
`SSH` / `SSH Agent` / `SSH Config` / `tmux` / `Hub` / `WebSocket` / `WebRTC` / `Cloudflare` / `HTTPS` / `HTTP-01` / `DNS-01` / `Let's Encrypt` / `Webhooks` / `Bot Token` / `Chat ID` / `API Key` / `Base URL` / `LLM` / `macOS` / `iOS / iPadOS` / `Windows` / `Android` / `Linux` / 各类示例 URL 与主机名占位符 / 语言自称（English、简体中文、日本語）/ `—`。
特别地：`device.authAgent`、`device.authAuto`、`sshError.agent*`、`deviceStatus.errorBadge.agent*` 里的 `Agent` 指的是 **SSH agent**，没有改成「智能体」。

### 4. 收尾复跑时观察到的、**非本任务**的失败
- `apps/fe/src/node/node-offline.test.ts` 5 fail：`isNodeOffline` 的签名被并行 agent 从 `(nodes, entryNodeId, nodeId)` 改成 `(snapshot, nodeId)`，测试仍按旧签名调用，返回 `undefined`。属该 agent 的收尾工作。
- `apps/fe` tsc 3 error：`remote-access` 的 `TunnelStatusResponse` fixture 缺 `configuredTrustProxy`，属 tunnel agent。
- `apps/gateway` tsc 第 22 条 error 在 `src/tunnel/manager.ts`，同属 tunnel agent。

### 5. 与并行 agent 的交叉
locale JSON 的写入全部走「精确整行字符串替换 + 出现次数断言」，不重排、不重写整份文件的格式，因此 O7 之后往 `header` 子对象加键不会冲突；`settings.remoteAccess.*`（tunnel agent 在我工作期间写入）在我改完后仍完整存在，已核对。生成物 `resources.ts` / `types.ts` 我最后重建过一次，但若 O7 / tunnel agent 之后还会改 JSON，**commander 收尾时需要再跑一次 `bun run build:i18n`**。
