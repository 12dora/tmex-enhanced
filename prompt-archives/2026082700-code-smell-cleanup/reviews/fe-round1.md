## Findings

### 1. Low · 确定：SSH 回归测试绕过了实际 hook 接线

[site-settings-form.test.ts:49](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/settings/site-settings-form.test.ts:49) 只直接测试纯函数；原缺陷真正修复于 [use-site-settings-form.ts:51](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/settings/use-site-settings-form.ts:51) 的 GET hydration 及后续 PATCH。即使删除 `setDraft(siteSettingsToDraft(loadedSettings))`，当前测试仍会全部通过，原来的“保存其他设置时覆盖 SSH 重连配置”问题也会重新出现。

验证方式：挂载 `useSiteSettingsForm`，让 GET 返回非默认 SSH 值，调用 `save`，断言 PATCH body 保留这些值。

### 2. Low · 确定：断连取消重选定时器的修复没有测试覆盖

[tmux.ts:166](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux.ts:166) 新增了 `selection.cancelReselect(deviceId)`，用于取消 [tmux-selection-actions.ts:117](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-selection-actions.ts:117) 创建的 250ms 重试定时器。但 [tmux-event-router.test.ts:143](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-event-router.test.ts:143) 完全 stub 掉 selection，并未调用 `createTmuxStore`、`handleSelectFailed` 或 `cancelReselect`。删除该修复后，新增的 store 测试仍然通过。

验证方式：使用 fake timers，触发非 `rejected` 的选择失败，调用 `disconnectDevice`，推进 250ms，断言未发送新的 `select-pane` 命令。