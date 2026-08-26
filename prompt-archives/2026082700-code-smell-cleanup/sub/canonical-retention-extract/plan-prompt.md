# 2026082700 canonical-feed-session / pane-retention 行为保持拆分

工作目录：`/Users/konata/code/tmex-enhanced-wt-smell`（git worktree）。

行为保持重构。禁止 `git commit/stash/checkout/add`。只改范围内文件。用 bun。

## TASK 1

`apps/gateway/src/ws/canonical-feed-session.ts` 拆出：

- `CanonicalSubscriptionCoordinator`（订阅集合、校验、容量、generation）
- `CanonicalPaneStream`（合帧、gap、排序）
- `CanonicalTransactionSender`（screen/history 事务、编码、发送背压）
- `CanonicalFrameSizer`（帧大小决策）

新文件放 `apps/gateway/src/ws/canonical/`。`CanonicalFeedSession` 保留命令路由、attach/detach 与协调。generation、gap、事件序、发送背压、错误响应语义必须完全一致。

## TASK 2

`apps/gateway/src/tmux-client/pane-retention.ts` 拆出：

- `PaneReplayStore`（history/checkpoint/replay）
- `PaneSubscriptionCoordinator`（generation/fingerprint、订阅应用、replay 顺序）
- `RetentionPolicyScheduler`（hot/grace/cold、LRU、eviction、timers、stats）

新文件放 `apps/gateway/src/tmux-client/retention/`。`PaneRetention` 保持公开 API。先用测试锁 replay 序、LRU、eviction 边界、timer cleanup。

若发现真实 bug（timer 未清、generation 竞态、lost gap），用测试覆盖后修复并明确写出。
