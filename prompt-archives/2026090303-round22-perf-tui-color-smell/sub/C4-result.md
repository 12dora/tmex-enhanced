# C4 执行结果

## 结论

C4 已完成 R2、R5、R6，并完成 R3 的 runtime/control-mode 侧实现与 legacy observer 接线口。零客户端时，push supervisor 仍持有 runtime/control-mode 连接，但 cold pane 在首个真实 terminal output 完成一次谓词发现后进入 notifications-only 路径：继续完整运行 BEL、OSC、title、prompt marker、clipboard、theme subscription 状态机，不创建输出缓冲、不进入 terminal output 广播，也不调用 retention `ingest`。

因此，设备没有客户端时仍会正常发送 bell/notification push。`push/supervisor.ts` 与 `push/tmux-push-events.ts` 无需修改；现有常驻连接与推送产品语义均保留。

## 实现

### R2 / R3

- `PaneStreamParser.push(data, materializeOutput)` 支持不物化模式；`ParserContext.output` 为 `null` 时所有写操作直接跳过，但状态机和非输出回调保持一致。
- `ControlModeSubscriptionOptions.materializeOutput` 提供显式动态谓词；runtime 路径通过首个真实输出对象的一次性能力发现取得 `RuntimeEventBridge` 谓词，之后在 pane parser 之前判断。
- runtime 谓词等价于 `legacy observed || pane retained`。canonical 的 active、grace、hot 均视为 retained，保持现有 replay 行为；cold pane 才短路。
- `device-connection-registry.ts` 维护设备客户端存在状态。legacy observer 计数尚未接线时，有客户端的设备保守地维持旧行为，避免 legacy feed 丢输出；零客户端不受此保守回退影响。
- cold 期间未物化输出由 `retention/skipped-output.ts` 记录为轻量 dirty 标志。旧 cursor 再订阅时，`replay-store.ts` 返回 `cache_evicted + needsScreen`，避免 `latestSeq` 未推进导致误判为 replay hit；没有保存输出字节，也没有调用 `ingest`。
- pane 从未观察切换为观察后，下一 chunk 即物化；已有显式谓词测试和 runtime + retention 集成测试。

canonical 首屏/历史结论：`SetPaneSubscriptions` 先提交 retention mode；无 cursor 或 dirty/gap 时返回 `needsScreen`，客户端随后通过 `RequestScreen`，服务端调用 `captureCanonicalScreen`，并 hold 捕获期间的 live data。它不依赖 cold 期间保留 replay 字节。带有效 cursor 的 active/grace/hot pane 仍完整保留和回放，与修改前一致。

### R5

- `csiBytes` 改为 parser 生命周期内复用的 `Uint8Array(MAX_CSI_BYTES)` 与 `csiLength`，不再为每个 CSI 开始/结束创建 JS Array。
- theme mode 2031 参数直接扫描固定缓冲，不再构造数组、TypedArray、字符串并 `split`。
- `writeRun` 对整段输入直接 `set(src)`，对不超过 16 B 的短 run 直接逐字节复制，避免 SGR 密集流为每个短 run 创建 `subarray` 视图。

### R6

- control-mode 反转义使用 parser 级可增长 scratch；含转义结果为下次调用前有效的视图。生产调用方均同步消费，未发现保留该视图的调用方。
- `%N` pane id 通过上限 256 项的数字键 Map 复用字符串；非标准 pane id 仍按原值解码。
- parser 的 `ctx`、scan stack、stack work、`pendingPassthrough` 提升到实例 frame pool。正常路径零重复创建；重入时按深度分配并复用独立 frame。测试证明 callback 内嵌套 `push` 不会破坏内外输出，返回的物化缓冲也不会被下一次 push 覆盖。
- replay fanout 改为循环内直接 `try/catch`，去掉每消费者闭包，同时保持单个消费者抛错不影响后续消费者。

## legacy broadcaster 待接线

按任务约束未修改正在由另一任务重写的 `ws/legacy-feed-broadcaster.ts`。本侧已导出单行同步接口；在该文件导入 `syncLegacyPaneOutputObserverCounts`，并在 `syncLegacyPaneObservers()` 的 `applyObserverDiff(...)` 后增加：

```ts
syncLegacyPaneOutputObserverCounts(deviceId, this.legacyObserverCounts);
```

该调用会一次性同步当前设备的聚合 observer counts，包括空集合，因此接线后 legacy subscribe/unsubscribe/select/focus 变化会从下一 chunk 精确驱动 R2。接线前行为是安全的保守物化，不会丢 legacy 输出，但有客户端时无法获得完整 R3 收益。

## 性能数据

命令：`cd apps/gateway && bun bench/control-output-pipeline.bench.ts`。4 KiB/control-output 事件；baseline 为修改前采样，final 为三轮中位数。

| workload | baseline 物化 ns/event | final 物化 ns/event | final notifications-only ns/event | 物化变化 | notifications-only 对 baseline |
|---|---:|---:|---:|---:|---:|
| plain | 5,567.2 | 4,876.4 | 4,642.2 | -12.4% | -16.6% |
| SGR-dense | 85,782.4 | 42,962.8 | 35,837.7 | -49.9% | -58.2% |
| mixed | 75,515.6 | 52,746.7 | 45,968.0 | -30.2% | -39.1% |

分配数据：

| workload | baseline backing Uint8Array/event | final 物化 | final notifications-only | transient Uint8Array/event，短 run 优化前 → 后 |
|---|---:|---:|---:|---:|
| plain | 1 | 1 | 0 | 5 → 4 |
| SGR-dense | 2 | 1 | 0 | 781 → 5 |
| mixed | 101 | 100 | 99 | 505 → 105 |

backing 分配通过替换 `Uint8Array` constructor 计数；transient view 通过 `bun:jsc.heapStats()` 在 10-event 无 GC 窗口计数。mixed 每事件含 99 个必须交付的 OSC notification，因此 notifications-only 仍保留对应 payload 分配。

按源码对本任务目标分配点计数：plain 约 `8 → 2 → 0`，SGR-dense 约 `787 → 2 → 0`，mixed 约 `409 → 2 → 0`（依次为 baseline、final 物化、final notifications-only；不含协议语义必须保留的 OSC payload/string）。其中基准 SGR 每事件原有约 778 次 CSI Array 创建、mixed 原有 400 次，final 均为 0。

现有 `pane-stream-parser.bench.ts` 三轮中位数：ANSI-heavy `47.4 → 105.0 MiB/s`（+121.5%），tmux passthrough `37.7 → 55.3 MiB/s`（+46.6%）；plain 与 OSC-heavy 基本持平。escaped unescape 的粗略 heap 增量从 baseline `0.25 MiB/iter` 降为 `0`。

## 测试与检查

- 用户指定命令 baseline：`708 pass / 10 fail`；final：`727 pass / 10 fail`，通过数增加 19，没有新增失败。10 个失败均为该目录选择器纳入的 `local-external-connection.integration.test.ts`，隔离的 `tmex-test-*` socket 未成功启动，与 baseline 相同。
- parser/control/runtime/retention/registry 聚焦测试：`278 pass / 0 fail`。
- materializing golden 断言未改，全部通过；每个 pane-stream golden case 额外对比 whole-input 与 byte-split notifications-only 的非输出事件序列，均完全一致。
- `bunx tsc --noEmit -p .`：0 错误；初始 baseline 曾有 1 个并行任务中的 `ws/index.test.ts` 错误，最终工作树已为 0。
- `bunx biome check <25 个 C4 文件>`：通过，0 finding。
- complexity gate：C4 文件没有违规；全仓命令仍因并行任务拥有的 `apps/gateway/src/mesh/peer-manager.ts` 为 1939 行、超过既有 allowlist 1930 行而失败。该文件属于明确禁止触碰的 `mesh/*`，因此未修改 allowlist、也未改该文件。

## 文件

- parser：`tmux-client/pane-stream-parser.ts`、`tmux-client/pane-stream/{parser-state,csi-handler,esc-handler,tmux-passthrough-handler}.ts` 及相关测试/golden。
- control mode：`tmux-client/control-mode-subscription.ts`、`tmux-client/control-mode/{notifications,unescape}.ts` 及相关测试。
- runtime/retention：`tmux-client/runtime/{event-bridge,output-materialization}.ts`、`tmux-client/retention/{replay-store,skipped-output}.ts` 及相关测试。
- WS：`ws/device-connection-registry.ts` 及测试。
- bench：`bench/control-output-pipeline.bench.ts`、`bench/pane-stream-parser.bench.ts`。
