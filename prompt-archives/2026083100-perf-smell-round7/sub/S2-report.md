静态探索已完成。`bun scripts/complexity/gate.ts` 通过：1061 files、8824 functions。

由于当前环境是只读沙箱，报告无法写入目标路径：`prompt-archives/2026083100-perf-smell-round7/sub/S2-report.md`。以下为完整报告正文。

# 前端代码坏味道探索报告（round 7，phase 2）

## 结论

没有发现 HIGH 项。建议跟进：

- MED：三个设置页 status hook 重复维护同一套受保护 React Query 生命周期。
- LOW：`useSessionKey` 是仓库内无消费者的 dead export，并带着一套无消费者的响应式 session-key 订阅层。
- LOW：`setSharedMeshEvents` 是仓库内无调用者的全局 singleton 替换 setter。

scope 内没有未 allowlist 且超过 900 行的文件。近期接近阈值但不构成坏味道的函数包括：

- `apps/fe/src/pages/settings/remote-access/wizard.tsx:226` `InstallStep`：CC 15，72 行。
- `packages/panels/src/device-console/terminal-stage.tsx:126` `StageContent`：CC 14，107 行。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:57` `NodeRowView`：CC 14，82 行。

这些函数分别承担单一的步骤、阶段和表格行条件渲染职责；`NodeRowView` 还是近期已拆分后的实现，因此不列为问题。

## 排名

### [MED] 1. 三个设置页 status hook 重复维护受保护查询生命周期

证据：

- `apps/fe/src/pages/settings/nodes/use-local-status.ts:22-51`：定义 401 判定、`failureCount < 2` 的 retry、`invalidateQueries`、`status/loading/loginRequired/error` 投影。
- `apps/fe/src/pages/settings/nodes/https/use-tls-status.ts:25-71`：重复同一套逻辑，另加 `enabled`、ACME pending 轮询和 `setStatus`。
- `apps/fe/src/pages/settings/remote-access/use-tunnel-status.ts:26-73`：再次重复同一套逻辑，另加 `enabled`、`tunnelPollInterval` 和 `setStatus`。

为什么有害：

401 不重试、错误投影、disabled 时的 loading 语义和缓存刷新属于跨功能行为契约。现在这些契约分散在三个文件中，后续修复登录拦截、重试次数或错误归一化时必须同步编辑三处，容易产生行为漂移。

具体重构：

新增一个小型通用 hook，例如：

`apps/fe/src/pages/settings/use-protected-status-query.ts`

参数只覆盖公共部分：`queryKey`、`queryFn`、`isUnauthorized`、可选 `enabled`、可选 `refetchInterval`，以及可选缓存写入能力。保留三个 domain hook 作为薄 wrapper，继续负责 API 类型、错误类、query key、ACME/tunnel 轮询和对外类型。

补充以下 focused tests：

- 401 不重试；
- disabled 时不显示 loading；
- 错误信息投影；
- `refresh` / `setStatus`；
- 动态轮询间隔。

风险：

低到中。主要风险是 React Query 泛型、`refetchInterval` callback 类型，以及 Local hook 当前没有 `enabled` / `setStatus`。保留现有 wrapper 并原样传递 query key、轮询策略，可以避免行为变化。

### [LOW] 2. `useSessionKey` 及其响应式订阅层是 dead code

证据：

- `apps/fe/src/auth/use-session-key.ts:5-10` 只定义 `useSessionKey`，并使用 `useSyncExternalStore`、`getSessionKeySnapshot`、`subscribeSessionKey`。
- `apps/fe/src/auth/index.ts:7` 通过 wildcard export 暴露该函数，但全仓搜索 `useSessionKey` 只有声明处。
- 当前真实调用者使用的是同文件中的 `useAuthMode`，例如：
  - `apps/fe/src/components/side-panels/account-security-panel.tsx:47`
  - `apps/fe/src/pages/LoginPage.tsx:43`
- `apps/fe/src/auth/session-key-store.ts:59-76` 的 `stateListeners`、`notifyState`、`subscribeSessionKey`、`getSessionKeySnapshot` 只服务于该无消费者 hook。
- `clearSessionKey:99` 和 `adoptSessionSecrets:120` 当前只会通知空集合。

具体重构：

删除 `useSessionKey` 函数及其 React/store snapshot 导入；从 `session-key-store.ts` 删除对应的 listener、notify、subscribe、snapshot 代码，保留：

- `getSessionKey`
- `hasSessionKey`
- `clearSessionKey`
- `adoptSessionSecrets`
- 其它真正用于登录的 secrets API

`use-session-key.ts` 文件和 `auth/index.ts` 的 export 仍需保留，因为 `useAuthMode` 仍在使用。

风险：

低。实施时需再次确认 `apps/fe` 没有被仓库外代码作为公共库导入。若存在外部消费者，应先迁移到命令式 `getSessionKey`，或明确恢复订阅需求。

### [LOW] 3. `setSharedMeshEvents` 是无调用者的全局 singleton 替换 API

证据：

- `apps/fe/src/node/mesh-events.ts:460-473`：创建共享实例，并导出 `setSharedMeshEvents(source)` 替换或清空实例。
- 运行时代码只使用 `sharedMeshEvents()`：
  - `apps/fe/src/node/mesh-nodes.ts:372`
  - `apps/fe/src/node/node-runtimes.ts:91`
  - `apps/fe/src/node/enrollment-watch.ts:121`
- `setSharedMeshEvents` 只有声明处：`apps/fe/src/node/mesh-events.ts:471`。
- 注释标明“仅测试使用”，但现有测试没有导入或调用它。

为什么有害：

替换 `sharedSource` 不会迁移已经在旧实例上的订阅者。误调用后，新调用者可能获得另一套 event source，造成静默事件分裂。当前 setter 没有测试价值，却扩大了全局状态的可变入口。

具体重构：

删除 `setSharedMeshEvents`。测试直接实例化 `MeshEventSource`；现有依赖注入点已经足够：

- `mesh-nodes.ts:372`
- `enrollment-watch.ts:121`

如未来确实需要测试 factory，应增加作用域受限的 factory，而不是替换全局 singleton。

风险：

低。全仓引用扫描没有发现消费者；实施后运行 `mesh-events`、`mesh-nodes`、`enrollment-watch` 相关测试即可。

## 未列入的问题

- 第六轮报告中的 folder tree 重复容器、device reorder optimistic 逻辑、tmux reorder 逻辑和 `loginRoute` 已修复或删除，本轮不重复报告。
- SSH/local external-connection reconnect 合并按既定结论排除。
- `ghostty-wasm`、`render-state`、`direct-carrier-controller`、`ws-client state-machine` 及设置页大组件均命中现有 allowlist，未发现足够低风险、能实际移除对应 entry 的拆分缝。
- `setup/validation.ts` 与 `tls-form.ts` 的 `isLocalHostname` 规则虽然相似，但允许的输入不同，不能安全合并。
- 未发现 scope 内其它明确 obsolete compatibility path；legacy transport/history/theme/persisted-state 分支仍有调用或测试覆盖。

## allowlist 收紧

以下按照 `gate.ts` 的当前指标统计，格式为“当前值 → allowlist 锁定值”。

### 文件级

- `packages/ghostty-terminal/src/ghostty-wasm.ts`：1620 → 1660
- `packages/ghostty-terminal/src/render-state.ts`：967 → 1007
- `packages/ws-client/src/direct/direct-carrier-controller.ts`：1118 → 1158

### apps/fe 函数级

- `apps/fe/src/components/side-panels/account-security-panel.tsx`：`PasskeySection` 154 → 162；`TotpSection` 186 → 194
- `apps/fe/src/pages/LoginPage.tsx`：`LoginForm` 218 → 226
- `apps/fe/src/pages/SettingsPage.tsx`：`SettingsPage` 124 → 131
- `apps/fe/src/pages/devices/use-device-folders.ts`：`useDeviceFolders` 198 → 206
- `apps/fe/src/pages/settings/nodes/https/acme-panel.tsx`：`AcmePanel` 216 → 224
- `apps/fe/src/pages/settings/nodes/https/selfsigned-panel.tsx`：`SelfSignedPanel` 122 → 130
- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`：`LocalMachineCard` 164 → 172
- `apps/fe/src/pages/settings/nodes/management/enrollment-section.tsx`：`EnrollmentSection` 169 → 177
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`：`NodesManagement` 151 → 159
- `apps/fe/src/pages/settings/nodes/management/use-admit-action.ts`：`useAdmitAction` 173 → 181
- `apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.ts`：`useLeaveMesh` 184 → 192
- `apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx`：`BecomeHubForm` 208 → 216
- `apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx`：`JoinHubForm` 172 → 180
- `apps/fe/src/pages/settings/notification-settings-tab.tsx`：`NotificationSettingsTab` 140 → 148
- `apps/fe/src/pages/settings/remote-access/access-step.tsx`：`AccessAppStatus` 143 → 151
- `apps/fe/src/pages/settings/remote-access/external-card.tsx`：`ExternalTunnelCard` 124 → 132
- `apps/fe/src/pages/settings/remote-access/named-step.tsx`：`HostnameStep` 137 → 145
- `apps/fe/src/pages/settings/remote-access/status-card.tsx`：`TunnelStatusCard` 216 → 224

### packages/panels 函数级

- `packages/panels/src/agent/chat-thread.tsx`：`ChatThread` 134 → 142
- `packages/panels/src/device-console/device-console.tsx`：`DeviceConsole` 128 → 136
- `packages/panels/src/device-console/use-editor-input.ts`：`useEditorInput` 135 → 143
- `packages/panels/src/device-console/use-pane-active-follow.ts`：`usePaneActiveFollow` 206 → 214
- `packages/panels/src/device-console/use-pane-route-reconciliation.ts`：`usePaneRouteReconciliation` 138 → 146
- `packages/panels/src/device-console/use-pane-selection-dispatch.ts`：`usePaneSelectionDispatch` 157 → 165
- `packages/panels/src/device-console/use-pane-selection-state.ts`：`usePaneSelectionState` 140 → 148
- `packages/panels/src/device-console/use-pane-size-sync.ts`：`usePaneSizeSync` 124 → 132
- `packages/panels/src/device-folders/device-folder-tree.tsx`：`DeviceFolderTree` 240 → 248
- `packages/panels/src/device-folders/folder-section.tsx`：`FolderSection` 174 → 182
- `packages/panels/src/device-management/device-card.tsx`：`<anon>` CC 15 → 17，lines 160 → 177
- `packages/panels/src/device-management/use-device-management-state.ts`：`useDeviceManagementState` 122 → 130
- `packages/panels/src/device-tree/sidebar-device-list.tsx`：`SideBarDeviceList` 261 → 269
- `packages/panels/src/files/files-tab.tsx`：`FilesTabInner` 136 → 144
- `packages/panels/src/settings/directory-picker-modal.tsx`：`DirectoryPickerModal` 178 → 186
- `packages/panels/src/settings/llm-provider-form-modal.tsx`：`LlmProviderFormModal` 204 → 212
- `packages/panels/src/settings/llm-provider-row.tsx`：`LlmProviderRow` 170 → 178
- `packages/panels/src/settings/llm-providers-tab.tsx`：`LlmDefaultsCard` 134 → 142
- `packages/panels/src/settings/search-tab.tsx`：`SearchTab` 202 → 210
- `packages/panels/src/settings/telegram-bot-chats-modal.tsx`：`TelegramBotChatsModal` 148 → 156
- `packages/panels/src/settings/telegram-bot-form-modal.tsx`：`TelegramBotFormModal` 164 → 172
- `packages/panels/src/settings/terminal-settings-panel.tsx`：`TerminalSettingsPanel` 180 → 188
- `packages/panels/src/settings/use-version-tab.ts`：`useVersionTab` 136 → 144
- `packages/panels/src/settings/webhooks-tab.tsx`：`WebhooksTab` 199 → 207
- `packages/panels/src/settings/weixin-account-form-modal.tsx`：`WeixinAccountFormModal` 165 → 173
- `packages/panels/src/settings/weixin-account-login-modal.tsx`：`WeixinAccountLoginModal` 254 → 262
- `packages/panels/src/settings/weixin-account-row.tsx`：`WeixinAccountRow` 178 → 186
- `packages/panels/src/watch/regex-trigger-fields.tsx`：`RegexTriggerFields` 165 → 173
- `packages/panels/src/watch/watch-rule-form.tsx`：`WatchRuleForm` 150 → 158

### packages/stores 函数级

- `packages/stores/src/agent-session-crud-actions.ts`：`createAgentSessionCrudActions` 175 → 183
- `packages/stores/src/site.ts`：`createSiteStore` 145 → 201
- `packages/stores/src/tmux-selection-actions.ts`：`createTmuxSelectionActions` 127 → 135
- `packages/stores/src/tmux.ts`：`createTmuxStore` 358 → 363
- `packages/stores/src/ui.ts`：`createUIStore` 144 → 152

### packages/terminal-ui、packages/ui、packages/ws-client 函数级

- `packages/terminal-ui/src/components/SplitTerminalArea.tsx`：`SplitTerminalArea` 211 → 219
- `packages/terminal-ui/src/components/Terminal.tsx`：`<anon>` 245 → 253
- `packages/terminal-ui/src/components/TerminalPreview.tsx`：`TerminalPreview` 162 → 170
- `packages/terminal-ui/src/components/split/SplitPaneView.tsx`：`SplitPaneView` 127 → 135
- `packages/terminal-ui/src/components/split/useSplitDragInteractions.ts`：`useSplitDragInteractions` 162 → 170
- `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts`：`<anon>` 190 → 198；`useKeyboardAvoidance` 199 → 207
- `packages/ui/src/components/sidebar/sidebar-provider.tsx`：`SidebarProvider` 143 → 151

以下指标当前与锁定值相等，不列入收紧：

- `packages/ghostty-terminal/src/ghostty-wasm.ts:encodeMouseEvent`：CC 33
- `apps/fe/src/pages/settings/remote-access/status-card.tsx:TunnelStatusCard`：CC 34
- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts:wizardStepState`：CC 27
- `packages/panels/src/device-folders/folder-tree-model.ts:resolveDrop`：CC 19