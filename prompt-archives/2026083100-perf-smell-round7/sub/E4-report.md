# E4 Round 7 报告

本轮没有确认达到 HIGH 的项目，最高为 MED。以下均为新的候选项。

## 排名发现

### [MED] Forwarder failover 队列没有容量上限

- 证据：`apps/gateway/src/mesh/forwarder.ts:156-167` 在 `failingOver` 或无 stream 时持续执行 `pump.queue.push(bytes.slice())`；队列定义见 `apps/gateway/src/mesh/forwarder.ts:72-90`。Failover 可能持续重试并等待恢复，见 `apps/gateway/src/mesh/forwarder.ts:296-320`、`377-415`；退避和恢复等待配置见 `apps/gateway/src/mesh/mesh-deps.ts:14-18`。
- 为什么热：远端连接故障期间，浏览器仍可持续发送帧；每帧都会复制，队列按帧增长且没有字节或数量限制。单次故障窗口最长可覆盖数秒到十余秒。
- 估计影响：大段粘贴或高频终端输入时，单个 pump 可能积累数 MiB 甚至更多，引发 GC、延迟和进程内存压力。
- 修复方式：增加队列字节数和帧数上限；超限时明确关闭连接或返回背压错误。需要区分可重放状态消息与不可丢失的终端输入，不能静默丢弃。
- 风险：中。需要重新定义 failover 期间的丢弃、重试和顺序语义。

### [MED] key-log 响应分页存在 O(n²) 重复编码

- 证据：`apps/gateway/src/hub/uplink-server.ts:649-679` 逐条缩减 page，并在每次循环中重新调用 `encodeUplinkCtl`。编码器在 `packages/shared/src/uplink/codec.ts:453-465` 为每条记录重新进行 Base64 编码；Base64 实现见 `packages/shared/src/auth/encoding.ts:398-415`。
- 为什么热：当一页记录超过大小限制时，最多会重复编码数百次，且最终发送前还会再次完整编码。
- 估计影响：大型 key-log catch-up 请求会产生大量临时字符串、Uint8Array 和 JSON 分配，增加 CPU、GC 和响应延迟。
- 修复方式：先一次性生成 wire records，使用累计大小或二分查找确定最大前缀，最终只序列化一次。
- 风险：中。需要严格保持 `has_more`、分页边界和协议字节大小语义。

### [MED] uplink node.list 在 catch-up 流程中重复持久化

- 证据：`apps/gateway/src/mesh/uplink-key-log-sync.ts:158-183` 中先调用 `persistList`，完成 key-log catch-up 后再调用 `emitNodeList`。而 `apps/gateway/src/mesh/uplink-client.ts:555-589` 中两个回调都会执行 `persistAdmittedPeers`。
- 为什么热：每次成功接收 node.list 都会对所有节点执行证书查询和数据库 upsert，两条路径重复执行，复杂度约为 O(2N)。
- 估计影响：拓扑变化、重连或 catch-up 时会造成重复 SQLite 写入和 JSON 序列化，放大延迟与写放大。
- 修复方式：让 `emitNodeList` 仅负责事件通知；或在同步流程中引入明确的“一次持久化、一次发布”阶段。
- 风险：低至中。需确认消费者是否依赖 catch-up 完成前的持久化状态。

### [MED] 远端 mesh WebSocket 入站路径重复解码并复制完整帧

- 证据：`apps/gateway/src/mesh/stream-targets.ts:523-548` 先调用 `wsBorsh.decodeEnvelope` 校验，再把原始字节传给 `attached.onMessage`。随后 `apps/gateway/src/ws/index.ts:204-209` 执行 `Buffer.from(bytes)`，并在 `apps/gateway/src/ws/index.ts:216-279` 再次调用 `decodeEnvelope`。共享层已有可复用 view 解码接口，见 `packages/shared/src/ws-borsh/codec.ts:61-110`。
- 为什么热：每个经 mesh 转发的浏览器帧都会多一次 envelope 解析和一次完整 Buffer 复制；大粘贴帧会按 payload 大小放大成本。
- 估计影响：增加 CPU、内存带宽和 GC 压力，主要影响远端终端输入和大帧控制消息。
- 修复方式：引入 `handleDecodedEnvelope`，让校验结果直接传递到 WS handler；仅在异步持有数据确有必要时复制。
- 风险：中至高。需要确认 stream buffer 生命周期，避免复用底层缓冲区导致数据被覆盖。

## Bugs

### [MED] node.list 广播存在异步快照乱序风险

- 证据：`apps/gateway/src/hub/uplink-server.ts:293-317` 异步构建 node.list 后再递增版本、更新 fingerprint 并发送；状态更新和连接关闭都可并发触发，见 `apps/gateway/src/hub/uplink-server.ts:626`、`987`。
- 问题：较旧的 `buildNodeList` 可能晚于较新的构建完成，随后以更高的 `listVersion` 覆盖缓存并发送过期拓扑。客户端可能接受该旧快照，并以版本水位抑制后续更新。
- 修复方式：按 userId 对广播进行串行化或合并；为构建任务绑定状态 generation，完成时丢弃过期结果。
- 风险：中至高，涉及拓扑同步协议顺序。

### [MED] Peer key-log 变化不会触发新的 key_log_head 广播

- 证据：`apps/gateway/src/mesh/peer-manager.ts:403-409`、`615-619` 定期刷新状态；`apps/gateway/src/mesh/peer-manager.ts:1838-1865` 先基于 `statusProvider()` 的 JSON 判断状态是否变化，只有变化时才读取并附加 `key_log_head`。`UplinkStatus` 定义见 `apps/gateway/src/mesh/types.ts:15-21`，不包含 key-log 头信息。
- 问题：本地 key-log 新增记录时，status JSON 不变，`sendPeerStatus` 会提前返回，因此远端不会获知新的 key-log head，增量同步可能一直等到连接重建或其他状态变化。
- 修复方式：将 key-log head 的 seq/hash 纳入状态缓存键；或 key-log 追加时主动触发一次状态广播。
- 风险：中。需要控制追加高峰时的广播频率。

### [MED] Forwarder 忽略发送 Promise，连接关闭时可能产生未处理拒绝并丢帧

- 证据：接口将发送声明为无返回值，见 `apps/gateway/src/mesh/mesh-deps.ts:97-103`；实际实现返回 `stream.write(bytes)` 的 Promise，见 `apps/gateway/src/mesh/stream-targets.ts:554-583`。`apps/gateway/src/mesh/mesh-runtime.ts:415-450` 使用 `void opened.send(bytes)`，而 `packages/shared/src/link/mux.ts:135-145` 明确可能 reject。Forwarder 多处也直接忽略返回值，见 `apps/gateway/src/mesh/forwarder.ts:156-167`、`377-415`。
- 问题：对端关闭或发送失败时，拒绝可能变成 unhandled rejection；同时当前帧没有可靠的失败通知或重试路径。
- 修复方式：统一将 `send` 改为 `Promise<void>`，由 forward pump 集中捕获并触发 failover/关闭策略。
- 风险：中，需要避免与现有 failover 状态机形成重复关闭或竞态。

### [MED] ws-client 重连期间超过 100 条消息后静默丢失

- 证据：`packages/ws-client/src/client.ts:131-134` 设置 `maxPendingMessages = 100`；`packages/ws-client/src/client.ts:392-404` 在未 ready 时只缓存前 100 条，队列满后仍返回 `false`。文档同时声称调用方无需重发，见 `packages/ws-client/src/client.ts:392-395`。队列刷新见 `packages/ws-client/src/client.ts:445-450`。
- 问题：HELLO、重连或短暂断线期间，超过 100 条的终端输入/粘贴分片会被丢弃，调用方无法区分“已排队”和“因满载被丢弃”。
- 修复方式：返回明确的 overflow 状态或抛出可识别错误；改为字节预算，并对可合并的状态消息做合并，对终端输入施加明确背压。
- 风险：中，可能需要调整 `packages/ws-client/src/transport-types.ts:216-229` 的公共 API 语义。