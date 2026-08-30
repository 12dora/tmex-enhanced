当前沙箱为只读，写入 `prompt-archives/2026083100-perf-smell-round7/sub/review-fe.md` 被拒绝，文件未创建。报告内容如下：

# FE diff 代码审查（round 7 / wave 1）

未发现 P0 阻断问题。

- [P1] `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:160`：`lastPaneIdsByDevice` / `lastKnownPaneIds` 是模块级唯一缓存，但侧栏会同时挂载多个独立 tmux store。多个 node 的 selector 交替执行时会互相覆盖缓存，使高频 metadata patch 仍返回新 `Map` 并触发孤立会话区重渲染，核心性能优化失效。建议将缓存放入每个 `AgentOrphanSessions` 的稳定 selector 闭包，或按 tmux store 身份分桶。

- [P2] `apps/fe/src/components/global-device-provider.tsx:303`：`offline` 只将 React Query observer 的 `enabled` 设为 false；TanStack Query 5.90 不会因此取消已开始的 fetch/retry，且 `fetchDevices` 未消费 `AbortSignal`。因此 node 在请求途中离线时，本次请求和配置的重试仍会继续，仅“初始即离线”场景得到门控。建议离线时显式取消查询并让 `fetchDevices` 透传 signal，同时避免取消仍有在线 observer 的共享查询。