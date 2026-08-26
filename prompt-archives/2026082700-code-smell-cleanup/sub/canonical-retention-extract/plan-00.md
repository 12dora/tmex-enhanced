# Canonical feed / pane retention 拆分计划

## 背景

`CanonicalFeedSession`（约 1200 行）和 `PaneRetention`（约 1030 行）各自承担过多职责。本次只做行为保持拆分，不改公开 API，不改协议语义。其它 agent 同时改 worktree 里其它文件，本任务只动范围内文件与新建的 sibling 模块。

参考：现有测试 `canonical-feed-session.test.ts`、`pane-retention.test.ts`；合帧参数与 legacy `TerminalOutputBatcher` 一致（16ms / 64KiB）。

## 注意事项

- 工作目录是 git worktree，禁止改 git 状态，禁止动生产 tmex / 名为 `tmex` 的 tmux session。
- `handleSetPaneSubscriptions` 必须对**所有已 attach 的 device** 调用 `applySubscriptions`（未出现在本次请求里的 device 会收到空列表从而退订）。
- replay 结果在 canonical 层当前不发送（首屏由客户端 `RequestScreen` 驱动），拆分后仍不得开始发送 replay。
- pending sweep 原本只在 `onDrain` 末尾调度；若确认 queue 后不调度会导致非背压失败永久挂起，则作为 bug 修，并补测试。
- `handlePaneGap` 当前忽略 `sendPaneGap` 失败；若确认是 lost gap，修并补测试。

## Canonical 拆分

| 类 | 职责 | 从 session 迁出的逻辑 |
| --- | --- | --- |
| `CanonicalFrameSizer` | `eventFits` / 变长字段二分最大字节 | frame 决策 |
| `CanonicalTransactionSender` | `send`/`sendError`、screen/history 分片事务、metadata snapshot 分块 | 编码与背压 |
| `CanonicalPaneStream` | seq 连续合帧、flush-before-gap、pending pane/stream gap、baseSeq 切分 | 流与 gap |
| `CanonicalSubscriptionCoordinator` | 收集校验、apply、generation、rejected、retainedKeys | 订阅 |

Session 保留：`handleCommand` 路由、attach/detach、input 去重、resize、screen job 生命周期、`onDrain` 协调。

## Retention 拆分

| 类 | 职责 |
| --- | --- |
| `PaneReplayStore` | pane 创建/epoch 旋转、ingest 缓存、checkpoint、history 读、`buildReplayPlan` |
| `PaneSubscriptionCoordinator` | fingerprint/generation 冲突、容量、apply、replay 顺序 |
| `RetentionPolicyScheduler` | mode 转换、sweep、LRU、retention 字节上限、timer、stats |

共享状态放 `RetentionKernel`（panes/consumers/limits/计数器）。`PaneRetention` 做门面，公开导出不变。

## 测试

先在现有 `*.test.ts` 补表征：replay 顺序、LRU、eviction 边界、timer dispose、合帧与 flush-before-gap。抽取件再补廉价单测。tsc 错误数不得高于基线；`bun test` 范围内无新增失败；biome 只 check 改动文件。
