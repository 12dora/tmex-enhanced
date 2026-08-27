## P0：预期收益最高

### 1. Ghostty 渲染桥接仍按“全屏逐 cell”读取

- 证据：每次渲染都 `Array.from(iterateRows())`，随后为所有行重建 `LineModel`；即使 Canvas 最终只画 dirty 行，WASM 数据已经全量读取。[terminal-render-coordinator.ts:197](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/terminal-render-coordinator.ts:197) [terminal-render-coordinator.ts:204](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/terminal-render-coordinator.ts:204)
- `readRow()` 对每个 cell 多次 WASM getter、`alloc/free`，并创建 style、颜色、codepoint、字符串等对象。[render-state.ts:438](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/render-state.ts:438) [render-state.ts:219](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/render-state.ts:219)
- 每次 `updateRenderState()` 都清空 meta cache，导致 256 色 palette 每帧重建。[render-state.ts:348](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/render-state.ts:348) [render-state.ts:545](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/render-state.ts:545)
- 影响：每个输出触发的 rAF；40×120 终端即使只改一行，也会读取约 4,800 个 cell。主要消耗 CPU、WASM 边界调用和 GC。
- 修复：让 Ghostty 返回 dirty row 范围或版本号；JS 缓存未变化行。进一步新增一次性 packed row API，例如 `Uint32Array` 存 codepoint/style/颜色索引，避免逐 cell getter 和对象创建。palette 仅在颜色版本变化时读取。
- 预期：脏行较少时，桥接 CPU/GC 预计降低 50%–90%；不能直接保证 Canvas 总耗时同比下降。
- 风险：dirty 生命周期、滚动、resize、颜色变化和选择模型必须保持一致；±1 邻行重绘策略不能简单删除。

### 2. 控制模式与 Pane VT 解析存在多层全量复制

- `%output` 先调用始终分配结果缓冲的 unescape。[control-mode/notifications.ts:60](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/control-mode/notifications.ts:60) [control-mode/unescape.ts:12](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/control-mode/unescape.ts:12)
- Pane parser 再逐字节经过状态 switch、handler 调用、`number[]`，最后复制成新的 `Uint8Array`。[pane-stream-parser.ts:38](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-stream-parser.ts:38) [pane-stream-parser.ts:86](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-stream-parser.ts:86)
- tmux passthrough 还会递归逐字节重新处理，并逐字节拼接 DCS 前缀。[tmux-passthrough-handler.ts:11](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-stream/tmux-passthrough-handler.ts:11) [tmux-passthrough-handler.ts:29](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-stream/tmux-passthrough-handler.ts:29)
- 影响：每个控制输出分段，普通 ASCII 高吞吐时也会付出状态机、数组 push 和至少一次完整复制；OSC/kitty/clipboard 还会额外 decode、split、regex。
- 修复：  
  1. unescape 先查找反斜杠；无转义时直接返回原始 `subarray`。  
  2. parser 改为基于 index/range 扫描，使用预分配输出缓冲或 span。  
  3. 普通字节路径内联，控制序列才进入专门解析器。  
  4. 将 control-mode unescape 与 pane parser 合并为单次扫描。
- 预期：解析 CPU 预计降低 30%–70%，分配量降低更多；高输出设备收益最大。
- 风险：跨 chunk 的 ESC/OSC/DCS 状态、UTF-8 边界、tmux passthrough 语义容易回归，必须使用现有 golden tests 加吞吐基准。

### 3. Retention policy 在每个输出分段执行全局扫描和排序

- 每个 `ingest()` 都调用 `sweep()` 和 `enforceBounds()`。[pane-retention.ts:139](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-retention.ts:139) [pane-retention.ts:151](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-retention.ts:151)
- `enforceBounds()` 即使没有超限，也会对所有 pane `Array.from/filter/sort`；超限时还会重复排序。[policy-scheduler.ts:112](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/retention/policy-scheduler.ts:112) [policy-scheduler.ts:130](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/retention/policy-scheduler.ts:130) [policy-scheduler.ts:151](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/retention/policy-scheduler.ts:151)
- 影响：每个 pane 输出分段；复杂度通常为 `O(P log P)`，最坏是多次 `O(E·P log P)`。
- 修复：维护全局 retained bytes 计数；只对当前 pane 做 replay TTL/单 pane limit；全局 hot/retention 淘汰使用 LRU、最小堆或惰性队列；全局 sweep 只由 timer、订阅变化和超限阈值触发。
- 预期：多 pane、高吞吐时可消除大部分 retention CPU。
- 风险：淘汰顺序、TTL 和显式 hot pane 优先级必须保持完全一致。

### 4. Canonical frame sizing 重复执行 Borsh 序列化

- `eventFits()` 每次都完整序列化 Canonical event。[frame-sizer.ts:9](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/canonical/frame-sizer.ts:9)
- `maxVariableDataBytes()` 二分搜索，每次创建新的 `Uint8Array` 并重新编码；1 MiB 上限约需 20 次探测。[frame-sizer.ts:19](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/canonical/frame-sizer.ts:19)
- Pane data 每个分段重新计算最大大小，随后 `send()` 又再次 `eventFits()`，最终发送时还重新编码 envelope。[pane-stream.ts:170](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/canonical/pane-stream.ts:170) [transaction-sender.ts:31](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/canonical/transaction-sender.ts:31) [codec-borsh.ts:69](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/codec-borsh.ts:69)
- 影响：每个 canonical pane 分段；重复序列化和临时 buffer 是明显 CPU/GC 热点。
- 修复：根据 schema 固定字段大小直接计算最大 data bytes；按 `(maxFrameBytes, target, paneEpoch, eventKind)` 缓存结果；更佳方案是 sizing 与最终 encode 合并，返回已编码 frame。
- 预期：PaneData sizing 开销预计降低 80%–95%。
- 风险：Borsh 字符串长度、Option、整数宽度和 envelope overhead 计算错误会造成边界协议错误，需增加 size invariant 测试。

### 5. 选择切换输出门控只限制条数，不限制字节数

- Gateway 只限制 1,000 条，未限制总字节数。[session-state.ts:344](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/session-state.ts:344) [session-state.ts:381](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/session-state.ts:381)
- 前端同样按 1,000 条限制，并复制每个 frame。[state-machine.ts:488](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ws-client/src/state-machine.ts:488) [state-machine.ts:497](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ws-client/src/state-machine.ts:497)
- 影响：选择事务或 history 卡住时，内存上限随单条 frame 大小增长；常规 64 KiB 批次也可达到约 64 MiB/设备/连接，异常大 frame 时更高。
- 修复：同时维护 `bufferBytes`，设置 2–8 MiB 硬上限；超限立即清空并发送 gap/rebase，不能静默继续积压。
- 预期：主要收益是避免 OOM 和长时间 GC，而非平均 CPU 降低。
- 风险：必须确保客户端能触发重新快照，不得产生静默丢屏。

## P1：高收益但需结合场景

### 6. Gateway 入站 WebSocket 每帧复制完整 Buffer

- `message` 已是 `Buffer`，`new Uint8Array(message)` 会复制完整二进制帧。[ws/index.ts:161](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/index.ts:161)
- 随后 envelope 与 payload 还要继续反序列化。[codec.ts:61](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/codec.ts:61) [schema.ts:8](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/schema.ts:8)
- 影响：每个入站消息，尤其大 history/input frame。
- 修复：直接使用 `Buffer` 的 `Uint8Array` 视图；仅在确实需要独占生命周期时复制。评估增加 zero-copy envelope reader。
- 预期：减少一次完整 frame copy，入站大消息 CPU/内存带宽下降。
- 风险：不能持有会被复用的底层 buffer；需确认 Bun WebSocket message 生命周期。

### 7. History page 到达后重复重建整个终端

- 每页 history 到达后都调用 `writeSnapshot()`，传入“快照 + 所有已收页面”。[TerminalSurface.ts:203](/Users/konata/code/tmex-enhanced-wt-tabs/packages/terminal-ui/src/components/TerminalSurface.ts:203)
- `writeCanonicalSnapshot()` 每次重新 reset、写入快照，并遍历所有历史页。[terminal-snapshot.ts:65](/Users/konata/code/tmex-enhanced-wt-tabs/packages/terminal-ui/src/components/terminal-snapshot.ts:65) [terminal-snapshot.ts:90](/Users/konata/code/tmex-enhanced-wt-tabs/packages/terminal-ui/src/components/terminal-snapshot.ts:90)
- 影响：每次 history page；最多 64 页时，累计重放约为 `1+2+...+64` 页，存在近似 `O(P²)` 重复工作。
- 修复：首次 page 执行 reset + snapshot，后续页面只向终端追加；收到最后一页后再做一次必要的 full repaint。
- 预期：长 scrollback 加载可减少约 10–30 倍重复 WASM 写入。
- 风险：页顺序、CR/LF、alternate screen 和 cursor 状态必须保持一致。

### 8. 网络消息、sink、WASM write 没有按 pane 合并

- 每个 WebSocket message 都立即解码并同步回调。[protocol-dispatcher.ts:43](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ws-client/src/protocol-dispatcher.ts:43) [client.ts:230](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ws-client/src/client.ts:230)
- Terminal sink 收到后直接写入终端。[pane-sink-registry.ts:180](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ws-client/src/pane-sink-registry.ts:180)
- `writeVt()` 每次都分配 WASM buffer、复制数据、调用 WASM、释放 buffer。[ghostty-wasm.ts:518](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/ghostty-wasm.ts:518)
- 影响：高频小 frame；主线程同时承担 Borsh decode、WASM copy、VT parse 和调度。
- 修复：按 pane 在 microtask/rAF 前合并连续输出，达到 16–64 KiB 或帧边界立即 flush；交互输入不延迟。Worker 只有在长任务确认后再考虑。
- 预期：降低 WASM boundary calls 和小 buffer copy，输入卡顿明显时收益较高。
- 风险：必须保持 pane 内顺序，并避免同步输出模式被错误延迟。

### 9. Canvas 每帧清空全尺寸 selection/cursor layer

- 每次 render 都清空整张 selection canvas，即使没有选区。[canvas-renderer.ts:368](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/canvas-renderer.ts:368)
- 每次 render 都清空整张 cursor canvas。[canvas-renderer.ts:559](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/canvas-renderer.ts:559)
- 前景仍逐 cell `fillText`，并且每个 cell 都生成 font/color cache key 字符串。[canvas-renderer.ts:430](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/canvas-renderer.ts:430) [canvas-renderer.ts:632](/Users/konata/code/tmex-enhanced-wt-tabs/packages/ghostty-terminal/src/canvas-renderer.ts:632)
- 影响：每个渲染帧；大 canvas、多终端、频繁输出时明显。
- 修复：selection/cursor 仅在自身状态或尺寸变化时重绘；按旧/新矩形清理 dirty rectangle；font 用 bitmask/integer key，颜色用 packed integer；对相同 style/颜色的连续字符做 run 绘制。
- 预期：中等收益；Canvas `fillText` 本身仍是主要成本。
- 风险：必须处理光标旧位置、Unicode glyph 溢出和选区残影。

### 10. Sidebar 对整个 snapshots map 订阅，树节点没有 memo

- Sidebar 订阅整个 `snapshots` map。[sidebar-device-list.tsx:64](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/sidebar-device-list.tsx:64)
- 每次设备元数据 snapshot/patch 更新后，重新遍历所有 device/window/pane。[sidebar-device-list.tsx:218](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/sidebar-device-list.tsx:218)
- `DeviceRow`、`WindowRow` 均非 memo 组件。[device-row.tsx:36](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/device-row.tsx:36) [window-row.tsx:40](/Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/window-row.tsx:40)
- 影响：每次 metadata snapshot/patch，复杂度约为整棵树大小；不是每个 terminal byte。
- 修复：按 device selector 订阅；规范化 snapshot store；`React.memo` 包裹 Device/Window/PaneRow；保证 handler 和数组引用稳定。
- 预期：多设备、多 pane 场景减少大量无关 React render。
- 风险：selector equality、拖拽状态和选中状态需回归测试。

## P2：专项优化

### 11. Legacy metadata diff 是全量 clone + 多次线性查找

- legacy diff 先复制所有 window/pane，再逐个 removal/filter/map。[state-snapshot-diff.ts:192](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/state-snapshot-diff.ts:192) [state-snapshot-diff.ts:206](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/state-snapshot-diff.ts:206)
- pane upsert 会扫描所有窗口并对每个 pane `findIndex`。[state-snapshot-diff.ts:238](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/state-snapshot-diff.ts:238)
- 影响：metadata patch；复杂度约为 `O(removals·(W+P)+upserts·(W+P))`。
- 修复：按 window/pane ID 建索引；只 clone 被触碰的 window/pane；逐步迁移到 canonical metadata patch。
- 预期：大树 metadata churn 时明显降低 CPU/GC。
- 风险：必须保持窗口顺序、pane move 语义和不可变引用。

### 12. Canonical decode 为防止非 canonical 编码再次完整序列化

- `assertCanonicalEncoding()` 对 decoded 对象重新 serialize 并逐字节比较。[canonical-state.ts:306](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/canonical-state.ts:306)
- command/event decode 都走该路径。[canonical-state.ts:329](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/canonical-state.ts:329) [canonical-state.ts:365](/Users/konata/code/tmex-enhanced-wt-tabs/packages/shared/src/ws-borsh/canonical-state.ts:365)
- 影响：每个 canonical inbound command/event；大 metadata payload 成本较高。
- 修复：使用 reader 直接验证尾部、长度、枚举和 canonical constraints；或只在 debug/协议协商阶段启用严格重编码。
- 预期：减少一次完整 serialize，需先确认安全约束覆盖率。
- 风险：这是协议安全检查，不应在没有等价验证的情况下删除。

### 13. Snapshot projector 有重复排序和结构性全量重建

- 每次 snapshot 启动三个 tmux 请求，并将三份 stdout split 成数组。[snapshot-projector.ts:233](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external/snapshot-projector.ts:233) [snapshot-projector.ts:267](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external/snapshot-projector.ts:267)
- pane 解析后排序 pane，`getExpectedPaneIds()` 和 `emitSnapshot()` 又分别排序 windows。[snapshot-projector.ts:162](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external/snapshot-projector.ts:162) [snapshot-projector.ts:197](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external/snapshot-projector.ts:197) [snapshot-projector.ts:208](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external/snapshot-projector.ts:208)
- 影响：结构变更/轮询时；主要是 tmux/SSH latency，CPU 次之。
- 修复：复用已排序数组；若 tmux 输出顺序稳定则避免重复 sort；保留现有三命令并行，先测量再决定是否聚合命令。
- 预期：降低 snapshot CPU 和临时字符串数组，可能减少一次排序；不会消除 tmux 往返延迟。

### 14. Fan-out 为判断是否有人订阅，先扫描一次客户端

- `broadcastTerminalOutput()` 先遍历所有 client 判断 `legacyObserved`，批处理 flush 后 `sendTerminalOutput()` 再遍历一次。[legacy-feed-broadcaster.ts:187](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/legacy-feed-broadcaster.ts:187) [legacy-feed-broadcaster.ts:227](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/legacy-feed-broadcaster.ts:227)
- 影响：每个源输出分段加每个 batch 一次 `O(C)` 扫描；大量 client/高输出时才明显。
- 修复：维护 `(deviceId,paneId)` 订阅计数或索引；计数为零时跳过 batch；发送时仍按 client 检查背压。
- 预期：减少重复 client scan。
- 已经做对：payload 在 fan-out 前只编码一次。[legacy-feed-broadcaster.ts:244](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/legacy-feed-broadcaster.ts:244) slow client 有 1 MiB 上限和超时终止。[websocket-send-guard.ts:122](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/websocket-send-guard.ts:122)

### 15. SQLite 同步调用和部分查询缺少复合索引

- Bun SQLite 使用同步 `.run()/.get()`，会阻塞 gateway event loop。[client.ts:9](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/db/client.ts:9)
- agent message append 是 `max(seq)` + insert + 按 id 查询三次同步操作。[agent.ts:207](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/db/agent.ts:207) [agent.ts:226](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/db/agent.ts:226)
- `agent_queued_messages` 没有 `(session_id, seq)` 索引，pending confirmations 没有 `(session_id,status,created_at)` 索引。[schema.ts:247](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/db/schema.ts:247) [schema.ts:257](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/db/schema.ts:257) [agent.ts:363](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/db/agent.ts:363)
- 影响：agent/watch 请求，不在 pane live 输出热路径；并发 agent 较多时会阻塞 WS。
- 修复：先用 `EXPLAIN QUERY PLAN` 验证，再补复合索引；考虑 session sequence counter，减少 `max(seq)`；高延迟操作移出主请求路径。
- 预期：降低 agent 查询扫描和 event-loop blocking。
- 风险：迁移成本、写入竞争和索引维护开销。

### 16. Pane churn 下的 dedup/throttle Map 只在设备断开时清理

- `bellDedup` 按 pane ID 增长，未见 TTL sweep。[external-tmux-core.ts:529](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/external-tmux-core.ts:529)
- notification throttle map 也按 pane/source 增长，只在 cleanup device 时删除。[session-state.ts:442](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/session-state.ts:442) [session-state.ts:481](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/borsh/session-state.ts:481)
- 影响：长期运行、频繁创建 pane 时的慢性内存增长。
- 修复：按时间 TTL 清理或在 snapshot prune 时删除无效 pane key。
- 风险：清理过早会降低 bell 去重效果。

### 17. 两个 reorder 操作有低频 O(n²)

- `filter()` 内对每个 window/pane 使用 `includes()`。[tmux.ts:278](/Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/tmux.ts:278) [tmux.ts:358](/Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/tmux.ts:358)
- 影响：仅发生在用户拖拽重排，不是持续热点。
- 修复：一次建立 `Set(windowIds)` / `Set(paneIds)`。
- 预期：大树重排从 O(n²) 降为 O(n)。
- 风险：很低。

## Rust 替换评估

| 候选 | 当前成本 | `>2x` 可能性与 FFI | 分发复杂度 | 建议 |
|---|---|---|---|---|
| 控制模式 + Pane VT 前置解析 | JS 逐字节 dispatch、数组 push、重复扫描和复制，是真正 compute-bound | NAPI 单次传入 4–64 KiB、一次返回 Buffer 时，`>2x` 有可能；若按 byte 或控制事件回调 JS，FFI 会抵消收益 | managed gateway 使用 Bun `--compile`，当前已经需要把 `cpu-features` externalize。[build-managed.ts:145](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/scripts/build-managed.ts:145) [build-managed.ts:158](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/scripts/build-managed.ts:158) 还需多平台 native prebuild | **先测量，暂不移植**。先做 JS zero-copy/range parser；只有 parser 占 gateway CPU 20% 以上且 benchmark 超过 2x 才做 NAPI |
| Canonical Borsh codec/sizer | Generic schema serialize、二分 sizing、重复 encode；大 metadata/大 payload 才明显 | Rust 可在“长度计算 + 一次编码”上超过 2x；但直接跨 FFI 复制大 Buffer 会抵消，且前端仍需 TS/WASM 实现 | 需维护 native gateway 与浏览器协议实现；npm 包目前主要分发 JS runtime、FE 资源和相邻 WASM。[package.json:12](/Users/konata/code/tmex-enhanced-wt-tabs/packages/app/package.json:12) [build-runtime.ts:18](/Users/konata/code/tmex-enhanced-wt-tabs/packages/app/scripts/build-runtime.ts:18) | **先改 sizing 算法并测量**；不要为了省几次 Borsh serialize 立即引入 Rust |
| Ghostty packed render-state ABI | 现有 Rust/WASM 核心已承担 VT parsing，JS 主要浪费在逐 cell getter、alloc/free 和对象构造 | 如果 Rust/WASM 一次返回 packed dirty rows，`>2x` 很有可能；若仍逐 cell crossing，收益会被 FFI 彻底吃掉 | 复用既有 Ghostty WASM 资源；构建系统已把 wasm 作为相邻资源复制。[build-managed.ts:207](/Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/scripts/build-managed.ts:207) | **做 ABI 优化，不做第二套 Rust parser**。这是最值得优先测量的 Rust/WASM 方向 |

不建议把 SQLite、Canvas API 或 snapshot diff 直接 Rust 化：它们主要受 I/O、浏览器绘制 API 或 JS 对象分配影响，无法稳定保证 `>2x`。

## 低成本基准

1. `bun bench`：Pane parser 对 1 MiB plain ASCII、ANSI-heavy、OSC/kitty、tmux passthrough 输入测试 MB/s、分配量和输出一致性。
2. `bun bench`：Retention 在 `P=10/100/500`、不同 segment 大小下测试 `ingest()` 总耗时；分别测当前 `sweep/enforce` 与增量计数实现。
3. `bun bench`：Canonical `maxPaneDataBytes()`、`sendPaneData()`、metadata partition，记录 encode 次数、耗时、临时内存。
4. `bun bench`：Ghostty 120×40 全量更新、单 dirty row、20% dirty rows，分别测 `updateRenderState + iterateRows + buildLineModel` 与 packed-row 原型；浏览器侧再测 Canvas frame time。
5. `bun bench`：模拟 WS frame 洪水，比较立即 dispatch 与按 pane 合批，记录 Borsh decode、WASM write 次数、p95 主线程任务和端到端延迟。

## 实施顺序

1. 先补上述基准和阶段计时：parser、retention、sizer、render bridge、WASM write。
2. 先处理 P0：dirty-row packed bridge、parser zero-copy、retention 增量淘汰、canonical exact sizing、门控 byte cap。
3. 再处理 history 增量重放、pane 输出合批、Canvas layer dirty repaint。
4. 最后处理 React selector、legacy diff、DB 索引和 Map TTL。
5. 只有基准确认单一热点稳定占用 CPU 且替换版本达到 `>2x`，才进入 Rust/NAPI 或 Ghostty WASM ABI 改造。