## 优先级清单

1. **P0｜设置文件根查询错误被伪装为空列表**

   - 位置/规模：[files-tab.tsx:108–203](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/settings/files-tab.tsx:108)，文件 555 行；`FileRootFormModal` 336–555 行、约 220 行、CC≈14。
   - 问题：`rootsQuery.data ?? []` 配合 174–178 行条件，查询失败时直接显示“暂无文件根”，没有错误提示或重试。
   - 建议：拆出 `file-root-query.ts`、`file-root-row.tsx`、`file-root-form-modal.tsx`、`use-file-root-form.ts`；统一 create/update mutation 的失效缓存、toast、关闭逻辑，并增加错误态。
   - 风险：中。
   - 测试：`apps/fe/tests/settings-files.spec.ts:3–14` 仅覆盖成功空列表，未覆盖失败/重试。

2. **P0｜Watch 查询错误被伪装为空/无状态，且列表存在 N+1 请求**

   - 位置/规模：[watch-dialog.tsx:51–250](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/watch/watch-dialog.tsx:51)，文件 429 行；主组件约 200 行、CC≈13；状态视图 336–429 行、约 94 行、CC≈7。
   - 问题：`throwOnError:false` 后，规则查询失败会走空列表，状态查询失败会渲染全部 `none`。此外每个 `WatchRuleRow` 都在 260–269 行请求一次状态，详情视图 341–346 行又重复请求。
   - 建议：拆出 `use-watch-rules.ts`、`watch-rule-list.tsx`、`watch-rule-row.tsx`、`watch-rule-state-view.tsx`；统一错误态/重试；优先让规则列表携带 `lastTriggeredAt`，否则改为只在详情视图请求状态。
   - 风险：中高。
   - 测试：`apps/fe/tests/watch.spec.ts`、`mobile-agent-watch.spec.ts`、`watch-rule-draft.test.ts` 仅覆盖成功流程，无错误态和请求数量断言。

3. **P0｜会话列表刷新会覆盖刷新期间的本地/事件更新**

   - 位置/规模：[agent-session-actions.ts:68–493](/Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/agent-session-actions.ts:68)，工厂函数约 426 行、CC≈1，但包含 20+ 个互不相关动作。
   - 问题：`loadSessionsRequest` 150–168 行收到列表后无条件替换整个 `sessions`。请求期间完成的创建、重命名、删除或 WS 更新可能被旧快照回滚；83–85 行注释本身已承认旧响应会覆盖本地更新。
   - 建议：拆为 `agent-session-crud-actions.ts`、`agent-session-message-actions.ts`、`agent-session-draft-actions.ts`、`agent-session-confirmation-actions.ts`，由薄工厂组合；列表刷新采用 revision/事件序号或按 session 合并，保留请求期间的新本地写入。
   - 风险：高。
   - 测试：`packages/stores/src/agent-session-actions.test.ts:307–337` 仅验证 single-flight，未覆盖刷新与 mutation 并发。

4. **P1｜动态页面加载没有失败态，也没有防止旧 Promise 回写**

   - 位置/规模：[apps/fe/src/main.tsx:188–228](/Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/main.tsx:188)，文件 291 行；`PageWrapper` 约 41 行、CC≈3。
   - 问题：192–194 行只调用 `moduleLoader().then(setModule)`；动态 import 失败会产生未处理 rejection 并长期保持空白，组件复用时旧模块也可能覆盖新路由模块。
   - 建议：抽出 `use-page-module.ts`，加入 request generation/cancel guard、`error` 状态和 `PageLoadFallback.tsx`。
   - 风险：中。
   - 测试：无直接测试；`apps/fe/tests/devices.spec.ts:5–10` 只覆盖成功加载。

5. **P1｜设备页操作栏同时承担选择模型、查询、导航和全部 JSX**

   - 位置/规模：[page-actions.tsx:111–323](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-console/page-actions.tsx:111)，文件 323 行；`DeviceConsoleActions` 213 行、CC≈18。
   - 建议：拆出 `use-device-console-actions.ts`、`device-console-toolbar.tsx`、`deferred-terminal-settings-sheet.tsx`、`refresh-confirm-dialog.tsx`；组件只负责组合视图。
   - 风险：中。
   - 测试：`terminal-shortcuts.spec.ts`、`watch.spec.ts` 间接覆盖入口；无操作栏单测。

6. **P1｜终端快捷键编辑器仍是 306 行状态与视图巨型组件**

   - 位置/规模：[TerminalShortcutsEditor.tsx:207–512](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/settings/TerminalShortcutsEditor.tsx:207)，文件 512 行；主组件 306 行、CC≈9。
   - 建议：提取 `use-terminal-shortcuts-editor.ts`、`shortcut-preview.tsx`、`shortcut-list.tsx`、`shortcut-add-panel.tsx`；保留编辑器作为布局壳。
   - 风险：中。
   - 测试：`apps/fe/tests/terminal-shortcuts.spec.ts:24–75`；`packages/terminal-ui/src/utils/terminalKeySequence.test.ts` 覆盖解析器，但无组件单测。

7. **P1｜终端 resize hook 混合测量、调度、焦点恢复和字体重试**

   - 位置/规模：[useTerminalResize.ts:31–349](/Users/konata/code/tmex-enhanced-wt-tabs/packages/terminal-ui/src/components/useTerminalResize.ts:31)，hook 319 行；`reportSize` 105–155 行、CC≈16。
   - 建议：拆出 `terminal-resize-reporter.ts`、`terminal-resize-scheduler.ts`、`terminal-viewport-restore.ts`；主 hook 只编排 refs 和生命周期。
   - 风险：高，涉及 RAF、timer、ResizeObserver 及 tmux 尺寸同步。
   - 测试：`terminalMetrics.test.ts`、`resizeSyncGuards.test.ts` 覆盖纯函数；无 hook 级 timer/生命周期测试。

8. **P1｜终端启动 hook 内嵌完整资源加载、render target 生命周期和恢复状态机**

   - 位置/规模：[useTerminalBootSurface.ts:97–378](/Users/konata/code/tmex-enhanced-wt-tabs/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:97)，hook 282 行；主 effect 136–348 行、约 213 行。
   - 建议：拆出 `terminal-render-target.ts`（创建、open、dispose）和 `terminal-surface-lifecycle.ts`（manager callbacks、恢复、boot state）；顶层 hook 只连接 runtime 与 React state。
   - 风险：高，需保持取消、双缓冲和 recovery 顺序。
   - 测试：`terminalBootDiagnostics.test.ts`、`terminal-snapshot.test.ts` 只覆盖辅助逻辑，无启动生命周期测试。

9. **P1｜设备对话框把基本字段、SSH 连接、四种认证方式和提交逻辑全部塞在一个组件**

   - 位置/规模：[device-dialog.tsx:38–405](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-management/device-dialog.tsx:38)，组件 368 行、CC≈13。
   - 建议：拆出 `device-basic-fields.tsx`、`device-ssh-connection-fields.tsx`、`device-auth-fields.tsx`、`use-device-dialog-submit.ts`；对话框只保留模式和 mutation 组合。
   - 风险：中高。
   - 测试：`apps/fe/tests/devices.spec.ts:5–29`、`:31–78` 覆盖主要 UI 流程；`device-form.ts` 无直接单测。

10. **P1｜持久化 Agent 消息解析器分支密集且不可直接测试**

    - 位置/规模：[agent-thread.ts:102–183](/Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/agent-thread.ts:102)，82 行、CC≈18。
    - 建议：提取 `agent-message-parser.ts`，分为 `parseUserMessage`、`parseAssistantParts`、`applyToolResult`；导出纯解析函数并覆盖 role/content 组合。
    - 风险：中。
    - 测试：`packages/stores/src/agent-thread.test.ts:57–121` 通过 `buildThreadBlocks` 间接覆盖部分 tool 结果，未覆盖完整输入矩阵。

11. **P1｜WindowRow/PaneRow 的拖拽、菜单、响应式样式和内容分支复杂度过高**

    - 位置/规模：[window-row.tsx:40–196](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/window-row.tsx:40)：157 行、CC≈20；[pane-row.tsx:33–147](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/pane-row.tsx:33)：115 行、CC≈17。
    - 建议：抽出 `device-tree-row-shell.tsx` 统一拖拽 handle/active 样式/菜单槽位，再拆 `window-row-header.tsx`、`window-pane-list.tsx`、`pane-row-content.tsx`。
    - 风险：中。
    - 测试：`device-tree-actions.test.ts` 只覆盖菜单模型；行组件无直接单测。

12. **P2｜GlobalDeviceProvider 混合持久化工具、状态派生和连接生命周期**

    - 位置/规模：[global-device-provider.tsx:18–286](/Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/global-device-provider.tsx:18)，文件 286 行；Provider 134–286 行、153 行。
    - 建议：拆出 `device-connection-persistence.ts`、`device-connection-status.ts`，Provider 只保留 query、订阅和 context 组装；保留兼容 re-export。
    - 风险：中。
    - 测试：`global-device-provider.test.ts` 覆盖纯状态/存储函数；无 Provider 生命周期集成测试。

13. **P2｜历史页校验逻辑 CC 高但未被直接测试**

    - 位置/规模：[TerminalSurface.ts:169–211](/Users/konata/code/tmex-enhanced-wt-tabs/packages/terminal-ui/src/components/TerminalSurface.ts:169)，43 行、CC≈18。
    - 建议：提取 `terminal-history-validation.ts`，让 `validateHistoryPage()` 返回明确失败原因；`applyHistoryPage` 只负责校验后提交状态。
    - 风险：高，涉及 pane/history epoch 一致性。
    - 测试：`terminal-snapshot.test.ts` 只覆盖快照写入；当前没有 `TerminalSurface.applyHistoryPage` 直接测试。

## 真实 Bug

- **设置文件根错误态**：[files-tab.tsx:143–178](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/settings/files-tab.tsx:143)：请求失败时 `entries=[]`，最终显示空列表。
- **Watch 列表和详情错误态**：[watch-dialog.tsx:67–72,165–178,341–426](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/watch/watch-dialog.tsx:67)：失败分别显示“无规则”和所有字段 `none`。
- **会话列表竞态回滚**：[agent-session-actions.ts:150–168](/Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/agent-session-actions.ts:150)：全量替换 `sessions`，会抹掉请求期间的本地更新。
- **页面动态 import 失败后空白**：[apps/fe/src/main.tsx:192–194](/Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/main.tsx:192)：没有 rejection handler 或错误 UI。
- **终端设置加载提示未国际化**：[page-actions.tsx:90–103](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-console/page-actions.tsx:90)：`Loading terminal settings…`、`Retry`、`Close` 为硬编码英文，忽略当前 locale。

## Deliberately skipped

- `tool-call-card.tsx`：488 行但已按工具类型拆分 Body，剩余部分是注册表和统一详情壳，继续拆分会降低内聚性。
- `gesture-machine.ts`：显式有限状态机，事件处理分支共同维护同一手势状态，拆文件收益有限。
- `terminalKeySequence.ts`：转义序列表本身是紧凑协议映射，拆分会增加跳转成本。
- `tmux.ts`、`agent-event-router.ts`、`packages/ui` 基础组件：分别是命令门面、事件分发器和共享 UI 原语，当前结构与职责一致。
- `weixin-account-login-modal.tsx`、`files/files-tab.tsx`：分别是单一登录状态机和递归文件树；前者流程内聚，后者拆分收益低。