# Task BB 结果：canonical feed 零拷贝分块、metadata 增量分块、attach 竞态

## 证据核对

三项 exploration 主张均成立，已对照源码后再改。

### 1. PaneData / ScreenChunk / HistoryChunk 的 `.slice()` 双拷

- `pane-stream.ts` `sendPaneData`：按 `maxPaneDataBytes` 切段时 `segment.data.slice(...)`，得到新 `Uint8Array`。
- `transaction-sender.ts` `sendContentChunks`：screen/history 同样 `data.slice(...)`。
- 随后 `ws/index.ts` `sendCanonicalEvent` → `encodeCanonicalEvent` → `encodeCanonicalEventPayload`（zorsh `serialize`）再拷进 payload，`encodeEnvelope` 再拷进 frame。

生产者：

- live `PaneData`：`replay-store.append` 已 `copyBytes(data)` 得到 `ownedData`，fan-out 与 replay 缓冲共享同一份；evict 只 `shift()` 数组，不改写字节。
- screen/history：checkpoint / page 持有独立 buffer；`sendContentChunks` 在同步 `sendFitted` 循环内切完。
- 生产路径 `sendEvent` **同步**完成 serialize+send。Borsh 产出独立 `Uint8Array`，之后改源缓冲不会污染已发出的 frame。
- 因此用 `subarray` 替代 `slice` 是安全的：省掉切段这一次 copy，wire 拷贝仍由 serialize 负责。
- **未改** `packages/shared`：现有 serializer 已拷字节，不需要 view-based 入口。

### 2. metadata snapshot 分块成本

- `partitionMetadataRecords` 每条 `candidate = [...current, record]`，再 `eventFits` → `canonicalEventPayloadBytes` 整段 walk records。
- `sendMetadataSnapshot` 每次 `getMetadataSnapshot()` 后重新 partition。
- 超大 patch / `onMetadataRebaseRequired` / `onDrain` 都会再走一遍（`canonical-feed-session.ts`）。

### 3. 并发 `attachDevice` 泄漏

- `ws/index.ts` inbound 无 per-session 串行化；`handleCommand` / `attachDevice` 都是独立 await。
- `attachDevice` 在 `await resolveRuntime` **之前**检查 `this.devices`；两个同 `deviceId` 的调用都能通过，各自 `attachPaneConsumer` + `subscribe`，后写 `this.devices` 覆盖前者，败者 lease/listener 永不 `close`。

## 改动

仅触及声明范围：`apps/gateway/src/ws/canonical/**`、`canonical-feed-session.ts` 及其测试。未改 `ws/index.ts` 任何导出签名，未碰 mesh / hub / agent / tmux-client。

### 零拷贝切段

- `pane-stream.ts`、`transaction-sender.ts`：`.slice` → `.subarray`。
- 测试：切段结果拼回原字节；`event.data.buffer === source.buffer`；serialize 当时的 frame 在源缓冲 `fill` 之后仍能 decode 出原始内容。

### metadata 增量分块 + 缓存 + rebase 合并

- 导出 `sourceMetadataRecordBytes`（`encoded-size.ts`），与 snapshot 空 records 的 payload 相加即完整事件大小。
- `partitionMetadataRecords`：先算 records 字节预算，再累加 size，不再复制 candidate 数组、不再每条 `eventFits`。
- `cachedOrPartitionMetadata`：key = `(metadataEpoch, revision, maxFrameBytes)`；拥塞重发复用 chunks；revision/epoch/帧长变化失效。`snapshotId` 每次仍新生成（固定 16 字节，不影响分块）。
- `requestMetadataRebase`：`metadataNeedsRebase` 已为 true 时只 `schedulePendingSweep`，不再立刻再发一份 snapshot。

### attach 串行化与清理

- per-`deviceId` in-flight Promise：后来者 await 先行者，完成后 re-check。
- `await resolveRuntime` 之后若 `closed` / 已有相同 runtime，不建 lease。
- 安装过程中 session 已 close：`lease.close()` + `detachListener()`，不写入 `devices`。
- `subscribe` 抛错时关闭已创建的 lease。

## 设计决策

1. **不引入 shared 侧 view serializer**：生产 send 路径已经同步拷进 frame；再加一套 API 收益为零、协议面增大。
2. **分块预算用空 snapshot 的 `canonicalEventPayloadBytes`**：header 与真实 Borsh 一致（`chunkIndex`/`totalChunks` 都是 u16，dummy `0xffff` 与真实值同宽）。
3. **缓存按 revision 而不是 records 深比较**：revision 未变则 metadata 不应变；测试故意用同 revision 不同 records 证明命中缓存。
4. **rebase 合并只覆盖「已 pending」**：成功发出的 snapshot 会把 `metadataNeedsRebase` 清回 false，下一次真正的 rebase 仍立即发送。
5. **attach 锁 + 安装期 close 双保险**：JS 单线程下 await 之后到 `devices.set` 是同步的，锁主要消灭双 `resolveRuntime`；close 插入 `attachPaneConsumer` 的路径仍会清 lease。

## 风险

- **subarray 视图**：若未来有人把 `CanonicalEvent` 异步扣下再 serialize，源缓冲突变会污染。当前唯一生产消费者同步编码；测试用「先 encode 再 mutate」锁住这个契约。
- **partition 缓存持有 record 对象引用**：同 revision 下 `getMetadataSnapshot()` 若返回新对象，发出的仍是缓存里的旧引用。依赖 revision 单调递增，与现有 metadata 投影一致。
- **同 revision 内容被原地改写**：chunk 边界不重算，发出的是改写后的字段值。这是「revision 即版本」的既有假设，不是新引入的。
- **in-flight attach 失败后后来者会再试 exclusive**：`resolveRuntime` 返回 null 时第二个调用会再打一次 runtime。比泄漏安全，多一次 resolve。
- **tsc 22 vs 任务所述 21**：多出的错误全在 BB 范围外（`push/`、`tmux-client/`、`ws/index.test.ts` 的既有 `unhandledRejection` 等），范围内文件 0 条。

## 测试

新增/扩展：

- `pane-stream.test.ts`：大段 PaneData 切成 subarray，mutate 源后已编码 frame 仍正确。
- `transaction-sender.test.ts`：ScreenChunk 同上；分块边界与旧 candidate-copy 算法一致；缓存命中/revision 失效。
- `encoded-size.test.ts`：`sourceMetadataRecordBytes` 与空 snapshot payload 之和等于完整事件。
- `canonical-feed-session.test.ts`：pending rebase 合并；并发 attach 只留一个 consumer；resolve 失败 / close-during-resolve / close-during-install 都清零 lease 与 listener。

范围内：

```
bun test src/ws/canonical/pane-stream.test.ts \
  src/ws/canonical/transaction-sender.test.ts \
  src/ws/canonical/encoded-size.test.ts \
  src/ws/canonical-feed-session.test.ts
→ 25 pass / 0 fail
```

全量 `cd apps/gateway && bun test`：

- 任务基线：2800 pass / 0 fail
- 本次：**2842 pass / 0 fail**（292 files）

`bunx tsc --noEmit -p .`（apps/gateway）：22 条，**范围内 0 条新增**。

`bunx biome check`（8 个改动文件）：通过。

未跑 `packages/shared` 测试：未修改 shared。
