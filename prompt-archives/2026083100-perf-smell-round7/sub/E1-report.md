结论：本轮未确认达到 `[HIGH]` 的新问题。最值得处理的是 agent 持久化、canonical 数据拷贝，以及 tmux snapshot 无变化时仍进行全量投影。

## Ranked findings

### 1. [MED] Agent step 边界逐条同步写 SQLite，未批量事务化

证据：

- [`run.ts:216`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/run.ts:216) 每条消息回调一次 `appendAgentMessage`。
- [`run.ts:319`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/run.ts:319) 每个 model step 调用 `persistNewMessages`。
- [`step-persister.ts:6`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/step-persister.ts:6) 对新增消息逐条循环持久化。
- [`agent.ts:225`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/db/agent.ts:225) 每条消息执行同步 `.insert().returning().get()`；[`agent.ts:230`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/db/agent.ts:230) 还为每条记录执行 `max(seq)` 子查询。
- [`client.ts:13`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/db/client.ts:13) 使用 `bun:sqlite` 同步 API；默认每轮最多 25 steps，见 [`schema.ts:231`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/db/schema.ts:231)。

为什么热：工具密集型 turn 可能产生数十条 assistant/tool 消息；每条都同步阻塞 gateway event loop，并可能携带较大的 JSON `content`，见 [`schema.ts:254`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/db/schema.ts:254)。多 agent 并发时会放大 SQLite 和 WS 延迟。

估计影响：将每轮多次同步写入降为一次事务，预期可明显减少 event-loop 停顿、SQLite statement 开销和广播抖动；具体收益需用真实 tool payload profile 测量。

修复方向：增加 `appendAgentMessages(sessionId, messages)`，在单个事务中顺序分配 `seq`、批量插入并返回记录；事务提交后再广播 persisted 事件。保留崩溃恢复、消息顺序和同 session 并发约束。

风险：中高。涉及序号分配、事务失败语义和重放一致性。

### 2. [MED] Canonical terminal bytes 在 Borsh 编码前存在额外拷贝

证据：

- [`pane-stream.ts:177`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/pane-stream.ts:177) 对每个 PaneData 分片调用 `segment.data.slice(...)`。
- [`transaction-sender.ts:55`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/transaction-sender.ts:55)、[`transaction-sender.ts:59`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/transaction-sender.ts:59) 对 screen/history 分片同样调用 `slice`。
- [`index.ts:341`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/index.ts:341) 随后调用 [`codec-borsh.ts:69`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/borsh/codec-borsh.ts:69) 进行完整 payload 序列化。
- Shared codec 最终创建新的序列化 payload，见 [`canonical-state.ts:338`](/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/ws-borsh/canonical-state.ts:338)。

为什么热：这是 canonical PaneData 的逐字节热路径，也影响 screen/history。协议帧上限只有 32 KiB，见 [`canonical-state.ts:13`](/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/ws-borsh/canonical-state.ts:13)，较大的 segment 会被切成多个分片；每个分片先复制，再被 serializer 复制到最终 frame。

估计影响：增加一轮完整 payload 的内存带宽和临时分配。例如持续 10 MB/s 的 canonical 输出，理论上可能额外产生约 10 MB/s 的复制流量，并增加 GC 压力。

修复方向：将分片改为 `subarray` view，并确认底层 `segment.data` 在同步 `sendEvent` 返回前不会被修改；必要时为 serializer 增加基于 view 的接口。

风险：中。主要风险是底层 buffer 生命周期和可变性假设。

### 3. [MED] Snapshot 未变化时仍重复执行全量 metadata、retention 和 history 处理

证据：

- [`event-bridge.ts:74`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/runtime/event-bridge.ts:74) 计算 `changed`，但 [`event-bridge.ts:76`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/runtime/event-bridge.ts:76) 无条件调用 `metadata.reconcile`。
- [`event-bridge.ts:84`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/runtime/event-bridge.ts:84) 无条件执行 `paneRetention.reconcilePanes`；[`event-bridge.ts:87`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/runtime/event-bridge.ts:87) 对每个 pane 使 history session 失效。
- `changed` 只用于是否广播，见 [`event-bridge.ts:93`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/runtime/event-bridge.ts:93)。
- metadata reconcile 会重新构造 desired map，见 [`metadata-projection.ts:156`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/metadata-projection.ts:156) 和 [`hierarchy-builder.ts:42`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/metadata/hierarchy-builder.ts:42)。
- retention 会重新扫描所有 pane 并刷新 modes，见 [`pane-retention.ts:106`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/pane-retention.ts:106) 和 [`policy-scheduler.ts:104`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/tmux-client/retention/policy-scheduler.ts:104)。

为什么热：tmux structure refresh 虽已有 coordinator，但每次成功 snapshot 都会进入这条路径。即使状态完全相同，仍会产生大量 Map、record 和 Set，并扫描所有 pane。

估计影响：当前函数的合成基准中，仅 `MetadataProjection.reconcile` 在 5000 panes 规模下约 10.9 ms/次；这是非生产 profile，只用于说明量级。正常小拓扑影响较小，大拓扑或 structure churn 时会增加 CPU、GC，并延迟 tmux 事件处理。

修复方向：拆分 topology、pane epoch、metadata field 的 dirty 维度。只有 pane 集合或 epoch 变化时才执行 retention/history reconcile；snapshot fingerprint 和 `baseRevision` 均未变化时跳过 metadata rebuild，同时保留现有 conflict/rebase 语义。

风险：中高。不能简单以 `changed === false` 全部跳过，需要处理 metadata revision 和并发 source event。

### 4. [MED] Metadata snapshot 分片采用候选数组复制加全量 size scan，拥塞时会重复执行

证据：

- [`transaction-sender.ts:148`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/transaction-sender.ts:148) 每次发送 snapshot 都重新获取完整 metadata snapshot。
- [`transaction-sender.ts:184`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/transaction-sender.ts:184) 对每条 record 创建 `candidate = [...current, record]`。
- [`transaction-sender.ts:196`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/transaction-sender.ts:196) 每次候选都重新调用 `eventFits`。
- [`encoded-size.ts:52`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/encoded-size.ts:52) 遍历整个 records vector；[`encoded-size.ts:198`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical/encoded-size.ts:198) 计算 snapshot 全量大小。
- oversized patch 和 drain retry 都会再次发送 snapshot，见 [`canonical-feed-session.ts:177`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical-feed-session.ts:177)、[`canonical-feed-session.ts:189`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical-feed-session.ts:189)、[`canonical-feed-session.ts:258`](/Users/konata/code/tmex-enhanced-wt-r7/apps/canonical-feed-session.ts:258)。

为什么热：初次 attach、rebase 或 backpressure 恢复时触发，不是每个普通事件都触发；但大拓扑下成本很高。当前代码合成测量约为 1000 条 record 23 ms、5000 条 record 100 ms/次，实际生产耗时取决于字段长度和 chunk 分布。

估计影响：大 metadata snapshot 拥塞时可能重复占用几十至上百毫秒 CPU，并制造大量短命数组；会延迟同一 gateway 上其他连接的处理。

修复方向：

- 对 `metadataEpoch + revision + maxFrameBytes` 缓存分片结果。
- `metadataNeedsRebase` 已为 true 时合并重复 rebase 请求。
- 用累计 record bytes 或 `fitsWithRecord` 替代 `[...current]` 和全量重新计算。

风险：中。需要保持 snapshot ID、chunk 数量及 frame overhead 的精确语义。

## Bugs

### [MED] 不存在的 Agent session 订阅会永久留在 hub 中

证据：

- [`ws-hub.ts:60`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/ws-hub.ts:60) 维护 `sessionId -> Set<GatewaySession>`。
- [`ws-hub.ts:85`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/ws-hub.ts:85) 在 sync 前就写入订阅表。
- [`ws-hub.ts:95`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/ws-hub.ts:95) 对不存在 session 直接 `return`，没有删除；异常路径 [`ws-hub.ts:98`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/ws-hub.ts:98) 也没有清理。
- `sessionId` 仅为无长度限制的 string，见 [`schema.ts:335`](/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/ws-borsh/schema.ts:335)。

影响：客户端可持续提交随机 session ID，形成大量永不广播但持续占用内存的 Map/Set；断开时 [`ws-hub.ts:75`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/agent/ws-hub.ts:75) 还会扫描全部订阅。

修复方向：先完成 session 校验/sync，再提交订阅；`null` 或异常时显式清理；增加 session ID 长度和单客户端订阅数量上限。

### [MED] Canonical `attachDevice` 并发调用会泄漏旧 consumer/listener

证据：

- [`index.ts:279`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/index.ts:279) 对每个入站 frame 异步执行 handler，没有按 session 串行化。
- [`canonical-kind-handlers.ts:13`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical-kind-handlers.ts:13) 会等待 canonical command。
- [`canonical-feed-session.ts:161`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical-feed-session.ts:161) 检查已有 device 后，在 [`canonical-feed-session.ts:164`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical-feed-session.ts:164) `await resolveRuntime`。
- 两个并发调用都可能通过检查并创建自己的 lease/listener，随后在 [`canonical-feed-session.ts:206`](/Users/konata/code/tmex-enhanced-wt-r7/apps/gateway/src/ws/canonical-feed-session.ts:206) 互相覆盖 `this.devices`。被覆盖的 lease 和 listener 无法再通过 `detachDevice` 回收。

影响：重复 PaneData fan-out、重复 metadata 回调和 retention consumer 泄漏；快速重连或连续订阅更新时可触发。

修复方向：为每个 `deviceId` 增加 in-flight attach promise/mutex；完成 await 后重新检查当前 attached 状态，失败的竞争者必须主动关闭 lease 和 listener。

风险：中。需要处理 runtime 替换、session close 和 attach 失败之间的竞态。