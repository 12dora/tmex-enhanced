# Task BD 结果：mesh forwarder 队列上限、node.list 单次 persist、key_log_head 广播、send Promise

## 证据核对

四条探索主张均成立，已对照源码后实施。第 2 条的「emit 只通知」示例**不能原样采用**（见设计决策）。

### 1. Forwarder failover 队列无界 — 成立

- `forwarder.ts` `handleForwardSocketMessage`：`failingOver || !stream` 时 `queue.push(bytes.slice())`，无帧数/字节上限。
- failover 最多 `STREAM_FAILOVER_BACKOFF_MS` 7 档（0…1600ms）+ `RESUME_WAIT_MS=8s`，大粘贴可在断链窗口堆积数 MiB。
- 泵关闭路径：浏览器 WS close → `handleForwardSocketClose` 关上游；failover 耗尽 → `closeBrowser(1011, 'failover-exhausted')`。消费者把 stream/browser close 当致命失败，而不是丢帧续传。

### 2. node.list catch-up 对 peer 双重 persist — 成立（修复方向需改）

- `uplink-key-log-sync.ts` `ingestNodeList` 立刻 `persistList`，catch-up 成功后再 `emitNodeList`。
- `uplink-client.ts` 两者都曾调用 `persistAdmittedPeers`（逐 node `getCert` + `upsertPeer`）。
- **消费者依赖 catch-up 完成后的 persist**：`node.list catch-up persists a newly admitted peer after key.log apply` — applyMany 期间才 `admitPeer`，ingest 时无 cert，必须在 emit 时再 upsert。`handleUplinkNodeList`（mesh-runtime）也只在 emit 后跑，不依赖 catch-up 中途的 peer_cache。

### 3. 本地 key-log append 不触发 key_log_head 广播 — 成立

- `UplinkStatus` 无 head；`sendPeerStatus` 用 `jsonStable(status)` 做变更检测，**先 skip 再异步挂 head**。
- 周期 `PEER_UPGRADE_SCAN_MS=15s` 的 `refreshAdvertisedStatus` 同样因 status JSON 不变而直接 return。
- 本地 append 走 `keyLogService.apply` + `publisher.publish(AndAck)`，不经过 `sendPeerStatus` 的 head 路径。

### 4. send() Promise 被忽略 — 成立

- `OpenedWsStream.send` 标注 `void`；`openWsStream` 实际返回 `stream.write` 的 `Promise<void>`（mux 在 dead/sendClosed 时 reject）。
- `mesh-runtime.openAdaptedWsStream` 用 `void opened.send(bytes)`；forwarder 热路径同样忽略。
- 写失败既可能 unhandled rejection，也可能静默丢帧且不进入 failover。

`packages/shared/src/link/mux.ts` 的 `write()` 已是 `Promise<void>`，无需改 typing（按任务要求只报告、不改 shared）。

## 改动

范围：`apps/gateway/src/mesh/**` 及其测试。未改 `ws/**`、`hub/**`、`agent/**`、`tmux-client/**`、`packages/shared/**`。

### 1. 泵队列上限 + 溢出关连接

- 常量（`mesh-deps.ts`）：`STREAM_QUEUE_MAX_FRAMES=256`、`STREAM_QUEUE_MAX_BYTES=4MiB`、`STREAM_QUEUE_OVERFLOW_REASON='forward-queue-overflow'`。
- `enqueueFrame`：超帧或超字节返回 false，**不入队**。
- `failPump`：abort failover、关 inflight/stream、`closeBrowser(1011, forward-queue-overflow)`。与 `failover-exhausted` 同属致命关闭，浏览器侧看到 1011。
- 上限内的 queued frames 仍由 `flushQueue` 在 resume 后原样重放。

### 2. 每个 accepted list：hub meta 一次 + peer persist 一次 + publish 一次

- `persistList`：只 `upsertHubMeta`（不依赖 cert，ingest 即可）。
- `emitNodeList`：`persistAdmittedPeers` + `onNodeListCb`（catch-up 完成后，含 apply 期间新 admit 的节点）。
- 已 admit 的 peer 在 catch-up 期间**不再**提前写入 peer_cache；list 对外生效仍以 emit 为准（与 `handleUplinkNodeList` 一致）。

### 3. key_log_head 进入变更键 + 防抖广播

- `sendPeerStatus` 先 `head()`，指纹为 `jsonStable(status) + seq:hash`；未变 skip。
- 新增 `PeerManager.notifyKeyLogHeadChanged()`，`KEY_LOG_STATUS_DEBOUNCE_MS=100`，burst 合并为一次 `refreshAdvertisedStatus`。
- 接线：`createKeyLogApplier.applyMany`（hub catch-up / peer `key.log.res`，`applied>0`）以及 `publisher.publish` / `publishAndAck`（本地 apply 后的上行）。

### 4. send 契约改为 Promise<void>，拒绝走 failover

- `OpenedWsStream.send: Promise<void>`（`mesh-deps.ts`）。
- `openAdaptedWsStream` 原样返回 write promise，不再 `void`。
- forwarder `sendToStream` 捕获 throw/reject → `onSendFailed`：关死流（让既有 `onClose` 进 failover），若 close 未触发则自己 `failover` 一次。`failingOver` 守卫避免双开。

## 设计决策

1. **溢出策略 = 关逻辑连接，不丢帧续跑**。泵消费者今天没有「缺帧仍可用」的语义；静默 drop 会让 replay/cursor 错位。1011 + 明确 reason，浏览器可重连。
2. **peer persist 放在 emit 而非 ingest**。探索示例「emit 只通知」会让 catch-up 中新 admit 的节点永远进不了 peer_cache。ingest 双写对已 admit 节点是纯浪费；emit 单次同时覆盖晚 admit。
3. **head 必须进指纹，不能只靠 15s 扫描**。扫描用的是不含 head 的 status JSON。防抖避免 enroll 突发刷爆 ctl。
4. **写失败优先 close→onClose→failover**，与现有 stream 死亡路径合一；`onSendFailed` 末尾的 failover 只补「close 不回调」的 Fake/死流。
5. **队列上限取 256 帧 / 4MiB**：覆盖正常 failover 重放，挡住大粘贴 OOM。未做成可配置注入，避免扩大 ForwarderDeps。

## 导出接口（请指挥官注意）

`OpenedWsStream.send` 从 `void` 改为 `Promise<void>`。该类型经 `StreamOpener` / `MeshHttpRuntimeOptions` 从 `mesh/` 导出。仓库内实现者只有 mesh 测试的 `FakeWs`；`packages/app` 从 `mesh-deps` 只取常量/WS kind，未实现 `OpenedWsStream`。

未改 `UplinkStatus` 形状（head 仍只挂在 wire payload 上）。`notifyKeyLogHeadChanged` 是 `PeerManager` 新公开方法。

## 风险

- **catch-up 期间 peer_cache 不含本轮新节点**：生产路径本来也要等 emit 才 `notifyPeerEndpointsChanged`。若有 mesh 外代码在 catch-up 中途读 `listPeers()` 期待新节点，会空窗；范围内未发现。
- **队列溢出关连接**：粘贴超过 4MiB/256 帧会踢浏览器 WS（1011），需重连。优于撑爆内存。
- **send 失败立即 failover**：写 reject 且 onClose 已在飞时，靠 `failingOver` 去重；未发现双 close 测试失败。
- **publishAndAck 在 hub ack 失败时仍 notify**：本地 head 已前进，广播是对的；head 未变则 fingerprint skip。
- **`OpenedWsStream` 签名变化**：mesh 外若有未入库实现，编译会断。

## 测试

新增/调整：

- forwarder：帧帽溢出关连接、字节帽溢出关连接、帽内 queued 帧 failover 后各重放一次、write reject → failover 一次且无 unhandledRejection。
- uplink-client：accepted list `upsertPeer` 恰好 1 次；首测改为先完成 catch-up 再断言 peer_cache（配合 emit 时 persist）。
- peer-manager：append → 带新 head 的 node.status；burst 合并为 1 次；status+head 未变 skip。

```
cd apps/gateway && bun test src/mesh/forwarder.test.ts \
  src/mesh/uplink-client.test.ts src/mesh/peer-manager.test.ts
→ 157 pass / 0 fail
```

全量 `cd apps/gateway && bun test`：

- 任务基线：2800 pass / 0 fail
- 本次：**2841 pass / 0 fail**（292 files）

`bunx tsc --noEmit -p .`（apps/gateway）：**21** 条，与任务所述预存错误数一致（未新增）。曾因 `process.on('unhandledRejection')` 多 1 条，已改为与现有测试相同的 `process as unknown as { on/off }` 转型。

`bunx biome check`：已改 mesh 文件通过。

`bun scripts/complexity/gate.ts`：通过。`peer-manager.ts` 2296 行（allowlist 2323），`mesh-runtime.ts` 1312 行（allowlist 1347），`forwarder.ts` 829 行（<900）。未改 allowlist。
