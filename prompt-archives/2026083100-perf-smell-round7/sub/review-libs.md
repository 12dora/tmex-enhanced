因当前工作区为只读沙箱，写入 [review-libs.md](/Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/review-libs.md) 被拒绝，文件尚未创建。审查结论如下：

- [P1] [browser-clipboard.ts:94](/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/browser-clipboard.ts:94)：并发写入乱序完成时，旧请求可清除新 pending 或重新挂起旧文本，破坏 latest-wins。建议为逻辑写入增加代次，只允许最新代次处理完成结果。
- [P1] [browser-clipboard.ts:106](/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/browser-clipboard.ts:106)、[tmux-event-router.ts:33](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/tmux-event-router.ts:33)：`dispose()` 无法阻止在途失败重新注册全局监听，runtime 销毁链也未释放 writer；卸载后仍可能写剪贴板或弹通知。建议增加 disposed/代次守卫，并将 writer 注册到 runtime disposers。
- [P1] [site-settings-loader.ts:99](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/site-settings-loader.ts:99)：`invalidate()` 后旧请求仍可被 `ensureFreshSettings()` 搭车，并以新 generation 提交陈旧设置，从而回滚乐观主题更新。建议将 generation 绑定到物理请求，并让失效请求不可再 join。
- [P1] [site-settings-loader.ts:86](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/site-settings-loader.ts:86)：boot 与表单共享的请求失败时，后加入者会夺走 generation；`fetchSettings()` 虽返回 fallback，却不会提交到 store，最终 `settings` 仍为 `null`。建议让共享请求统一负责 generation、提交及失败收尾。
- [P2] [terminal-meta.ts:110](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/terminal-meta.ts:110)、[use-device-console-effects.ts:94](/Users/konata/code/tmex-enhanced-wt-r7/packages/panels/src/device-console/use-device-console-effects.ts:94)：无终端标签及 effect 清理路径仍直接使用原始 `siteName`，FE0E 归一覆盖不完整。建议这些分支也复用 `forceTextPresentation()`。

无 P0。pane 徽标索引的不可变引用假设与当前生产写入路径一致，未发现额外问题。