# plan-00 执行结果

行为保持拆分已完成。公开 API 未改名；`CanonicalFeedSession` / `PaneRetention` 仍从原路径导出。

## Canonical

`canonical-feed-session.ts` 1201 → 553 行。抽出：

- `CanonicalFrameSizer`：`eventFits`、变长字段二分
- `CanonicalTransactionSender`：send / 错误、screen/history 分片事务、metadata 分块
- `CanonicalPaneStream`：合帧、flush-before-gap、pane/stream gap、baseSeq 切分
- `CanonicalSubscriptionCoordinator`：收集校验、apply 全部已 attach device、generation、rejected、retainedKeys

Session 保留命令路由、attach/detach、input 去重、screen job、`onDrain` 协调。

## Retention

`pane-retention.ts` 1030 → 228 行。抽出：

- `PaneReplayStore`：epoch 旋转、ingest 缓存、checkpoint、history、`buildReplayPlan`
- `PaneSubscriptionCoordinator`：fingerprint / generation、容量、apply、replay 顺序
- `RetentionPolicyScheduler`：hot/grace/cold、LRU、字节上限、timer、stats
- `RetentionKernel`：共享 panes/consumers/limits/计数器

## Bug 修复

1. **lost gap**：`handlePaneGap` 在 `sendPaneGap` 失败时忽略返回值，背压下 gap 丢失。现改为 `queuePaneGap`。
2. **pending sweep 未启动 / 早退不续约**：`schedulePendingSweep` 原先只在 `onDrain` 成功路径末尾调用；queue 后若 drain 永不到来（或 stream gap send 失败提前 return）则永久挂起。现 queue / metadata rebase 即调度，`onDrain` 失败也续约。

## 验证

- 表征测试先锁 replay 序、LRU、checkpoint-before-replay eviction、timer dispose、合帧与 flush-before-gap。
- 范围内 `bun test`：29 pass / 0 fail。
- `apps/gateway` 全量：1267 pass / 0 fail。
- tsc：基线 37，结束后 34（范围内无新增）。
- biome check 改动文件：clean。
