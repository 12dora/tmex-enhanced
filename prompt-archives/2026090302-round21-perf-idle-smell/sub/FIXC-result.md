# FIX-C：canonical 状态流 review 修复

## 背景

接手 round 21 已合入的 canonical 客户端迁移，修复独立 review 发现的六项确定问题，并核实 metadata recovery 期间 PaneData 的排序保证。改动仅限用户授权的 canonical 客户端、WebSocket transport、canonical 网关会话及相应测试。

## 输入问题

1. `epoch_changed` 可能形成无退避、无上限的订阅重发循环。
2. canonical retry 定时器在降级到 legacy 后可能吞掉 screen 请求。
3. 永久性 `resource_exhausted` 会让隐藏页持续周期性重试。
4. metadata snapshot assembly 缺少总字节预算与存活超时。
5. metadata overlay 未随设备移除、断开或 dispose 清理。
6. cursor miss 产生的 pane gap 在背压时可能永久丢失。
7. 核实 metadata gap 到 snapshot commit 期间 PaneData 的跨流排序；若无明确保证，在 commit 时强制重订阅。

## 执行计划

1. 阅读 canonical 客户端、重试器、snapshot helper、overlay、transport 和网关 feed session 及其测试，梳理现有不变量。
2. 先补能稳定复现各问题的定向测试，再做最小状态机修复。
3. 对第 7 项沿网关 metadata 事务、pane stream 和客户端恢复路径确认排序证据，并按结论实现或记录。
4. 运行 ws-client 与 gateway 定向测试，随后运行要求的包级测试、TypeScript、Biome 与 complexity gate。
5. 将实现、验证数据、风险与第 7 项结论补充到本文档。

## 当前状态

实现完成，定向与要求的包级测试均已通过。本任务改动未产生 TypeScript、Biome 或 complexity 新违规。

## 实现结果

### 1. `epoch_changed` 重试风暴

- `CanonicalSubscriptionRetry` 改为有上限的指数退避，默认最多重试 4 次，间隔从 250 ms 起按倍数增长。
- `epoch_changed` 不再同步重发；首次重试前会移除 terminal cursor，随后走统一退避。
- 达到上限后，将对应设备加入 epoch recovery barrier，触发既有 metadata recovery，并在新 metadata snapshot 到达前从 replacement set 中排除该设备，避免继续携带旧 `serverEpoch`。
- 新 snapshot 提交后解除 barrier、重置重试状态并强制发送包含新 epoch 的订阅。

### 2. canonical retry 在 legacy 降级时丢请求

- `CanonicalContentRetry` 现在同时保存 timer 与请求副本，并提供原子 `takeScheduled()`。
- `suspend()` 会先取消并取出所有已排 retry，再与 content transaction 中的在途请求一起迁移到 pending command 队列。
- feed epoch 改变也使用同一路径，避免旧 retry timer 跨 epoch 触发。
- legacy READY 分支原有的 `takePendingCommands()` 因此可以正常 drain 这批请求。

### 3. 永久性 `resource_exhausted` 周期唤醒

- subscription retry 达到默认 4 次后进入稳定失败状态，不再创建 timer。
- 实际订阅集合变化、连接重新 activate 时会重置失败状态。
- `WebSocketGatewayTransport` 监听页面重新可见事件，并仅在 canonical subscription 曾失败时触发一次恢复发送；对不完整 `document` 宿主做了 DOM 能力检测。

### 4. metadata snapshot assembly 资源上限

- 新增 `CanonicalMetadataAssemblies`，集中管理 assembly 生命周期。
- 所有并发 assembly 共用 8 MiB 编码字节预算，而不是按 8 × 4096 个 chunk 各自增长。
- 每个 assembly 从首 chunk 起最多存活 15 秒；超时会清空所有未完成 assembly，并走既有 `metadata_gap` recovery。
- 编码失败、预算超限、重复 chunk、identity 不一致仍显式触发 gap，不提交部分状态。

### 5. metadata overlay 生命周期

- overlay 新增设备级 `remove()` 与全量 `clear()`。
- `disconnect-device`、`removeDevice()`、`dispose()` 均清理对应状态。
- legacy 空 session snapshot 也会删除该设备的旧 overlay。

### 6. cursor miss gap 背压丢失

- subscription replay 的 cursor miss 不再直接调用 `sendPaneGap()`，改走 `handlePaneGap()`。
- ACK 触发背压、后续 `SourceGap` 发送失败时，gap 会进入既有 pending 队列，并在 drain 或 pending sweep 后补发。

### 7. metadata recovery 与 PaneData 排序结论

结论：**不存在“metadata gap 到对应 snapshot commit 之间绝不交错 PaneData”的保证。**

证据如下：

- `canonical-feed-session.ts` 的 pane consumer `onData` 直接调用 `stream.handlePaneData()`；metadata listener 则独立发送 `SourceMetadataPatch`。
- metadata 发送失败时只设置 `metadataNeedsRebase`，到后续 `onDrain()` 才重新调用 `sendMetadataSnapshot()`。
- `CanonicalTransactionSender.sendMetadataSnapshot()` 可在任意 chunk 背压或发送失败后中断；此期间没有 gate 阻止 pane consumer 继续接收并发送数据。
- carrier fallback 虽优先排 stream gap，但新 pane output 与后续 metadata snapshot 仍没有共同事务屏障。

因此客户端在同 `serverEpoch` 的 recovery snapshot commit 时也会强制用保留 cursor 重订阅。recovery 期间丢弃的 PaneData 会由 replay 补回；若 pane/server epoch 已变化，则沿既有 gap/screen rebase 路径恢复。

## 新增回归测试

1. `backs off epoch-changed retries and waits for fresh metadata after exhaustion`。
2. `moves a scheduled content retry back to the transport queue when suspended`。
3. `stops permanent resource-exhausted retries until a recovery condition occurs`，并补页面 visible 传递测试。
4. `bounds buffered metadata bytes and expires incomplete snapshot assemblies`。
5. `drops device overlays on removal, empty snapshots, and disposal cleanup`。
6. `queues a cursor-miss gap when the subscription acknowledgement starts backpressure`。
7. `force-resubscribes from the retained cursor after metadata recovery drops pane data`。

## 验证结果

- `packages/ws-client && bun test`：381 pass，0 fail。
- gateway canonical/failover 定向套件：235 pass，0 fail。
- `packages/stores && bun test`：435 pass，0 fail。
- `packages/shared && bun test`：451 pass，0 fail。
- `apps/fe && bun test src/`：1744 pass，0 fail。
- gateway 全量：3827 pass，4 fail。4 条均为并行全量执行时的既有全局 SQLite 隔离问题，失败堆栈为 `Cannot use a closed database`，不涉及 canonical 文件；三个失败文件在新进程定向复跑为 41 pass，0 fail。
- TypeScript：ws-client、gateway、shared、fe 均 0 error；stores 保持基线 1 条 `host-services.test.ts` 既有错误。
- Biome：本任务改动文件通过。
- complexity：全仓通过，`complexity gate ok (1243 files, 11640 functions)`。

## 风险与注意事项

- metadata recovery 完成时会额外发送一代 replacement subscription，这是补回 recovery 窗口 PaneData 的必要流量，且只在设备确实处于 awaiting metadata 时发生。
- 无数据迁移、配置迁移或发布步骤。
