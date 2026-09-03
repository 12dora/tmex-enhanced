# CAN：Canonical State 客户端迁移结果

## 设计与实现

### 命令与路由

客户端已覆盖 `CanonicalFeedSession` 接受的全部五种 `KIND_CANONICAL_COMMAND` 变体：

- `SetPaneSubscriptions`：聚合所有设备的 pane 意图，发送全局替换集；支持 active/hot 集合、单调 generation 和 pane cursor。
- `TerminalInput`：覆盖普通输入与粘贴；保留 legacy 每 1024 字符一次写入的边界，并在 canonical frame 上限内继续按 UTF-8 字节语义拆分；每次写入使用独立 ID。
- `ResizePane`：服务端转回既有 viewport arbiter，保持多客户端尺寸仲裁行为。
- `RequestScreen`：使用独立 request ID 请求原子屏幕快照。
- `RequestHistory`：携带 pane/history cursor 请求分页历史。

设备 attach/detach 继续使用既有 `DEVICE_CONNECT`/`DEVICE_DISCONNECT` 控制面，因为 canonical v1 schema 没有设备连接命令。选择 pane、设备生命周期、窗口/pane 管理、terminal viewport、布局与重排等无 canonical 等价物的控制命令也继续走 legacy；canonical 模式下 `TMUX_SELECT` 仍发送，但强制 `wantHistory=false`，避免同时触发 legacy 整段历史。legacy state feed 没有删除，旧服务端仍完整可用。

canonical 客户端不再注册 legacy pane observer，也忽略 legacy snapshot diff/history/live/output 主数据消息，避免未订阅 pane 输出继续穿过整条旧流水线。树顺序和自定义名称目前不在 canonical metadata schema 中，因此保留精确的 legacy snapshot sideband：树顺序持续覆盖，自定义名称只作为首次种子，后续 canonical `String`/`Unset` patch 和全量 rebase 不会被旧值回滚。

### Capability gate、fallback 与 kill switch

HELLO 完成后，仅在以下条件同时成立时选择 canonical：服务端 capability 精确包含 `canonical-state-v1`、客户端 `canonicalStateEnabled` 未关闭、协商后的有效 frame 上限足以承载 canonical feed 最小安全帧。否则逐连接选择 legacy。连接重建时重新协商，不缓存旧节点能力，适配 mesh 节点独立升级。

`canonicalStateEnabled` 缺省为 `true`。FE 接线读取 `localStorage['tmex.disable-canonical-state']`，值为 `1` 或 `true` 时强制 legacy，可在不重新部署前端的情况下关闭。选择结果通过 `stateFeedMode: 'pending' | 'legacy' | 'canonical'` 暴露在 client、transport 和 tmux store，测试与 UI 均可观察。

### ACK、epoch、gap 与事务

- `SubscriptionApplied` 仅接受不落后于本地 wire generation 的 ACK，完整保留 `not_found`、`resource_exhausted`、`epoch_changed` 拒绝原因。not-found 清理该 pane 的待发命令；resource-exhausted 有界退避重试；epoch-changed 清 cursor 并以更高 generation 重订阅。
- gateway/server/pane/metadata epoch 或 metadata revision 不连续时，不应用跨 epoch 数据。客户端清理对应 cursor、半成品事务和缓冲，发出既有 store 可消费的 `rebase-required`，再重订阅、重取 metadata 或重试仍有效的 screen/history 请求。
- `SourceGap` 的 pane、metadata、stream 三种 scope 都会显式进入重同步，不会静默丢弃。未知 gap reason 也保留为可见 rebase，而不是当作成功处理。
- metadata snapshot、screen、history 均按其原生事务协议组装；校验 request、目标、epoch、chunk offset、总字节数、history line/cursor 连续性，只有完整 `Commit` 后才写入既有 store 形状。重复/冲突/不完整事务不会部分提交。并发 metadata 半成品最多保留 8 个，新快照提交后淘汰同设备旧半成品。
- `PaneSinkRegistry` 在 screen base 与历史重建之间缓存有序 live delta，历史应用后重放，避免历史分页覆盖同期输出。单 pane 2 MiB、全局 8 MiB，并同步终端既有的 22 页/2,000,000 字节历史预算；超限或序列断裂转为显式 rebase。
- 服务端在屏幕 capture 开始前即进入 live hold，直到 ScreenCommit 后再放行；单 pane hold 上限 2 MiB，溢出时中止事务并发送 resource gap。screen/history 在 backpressure 中断时也发送显式 gap。

### Frame 上限

canonical envelope 始终以 `min(32 KiB, effectiveMaxFrameBytes)` 为硬上限，且 protocol dispatcher、mesh queued-frame rewrite 和发送端都禁止 canonical 使用 generic `CHUNK`。输入按语义拆分；metadata、screen、history只使用各自的 canonical chunk 事务。若协商上限不足以安全承载 canonical metadata 单记录，客户端直接选择 legacy，而不是产生无法恢复的半帧。

## `stream-replay-state.ts` canonical 分支核验

原先不可达的 canonical replay 分支现在由真实客户端订阅触发，并完成以下修正与验证：

- 记录最后一个全局 canonical subscription；failover 时先以 generation 0 空订阅完成 bootstrap，设备连接就绪后发送 `generation + 1` 的恢复订阅，不再生成 legacy pane subscribe 或整段 history 请求。
- pane cursor 只从连续 `PaneData` 或完整 `ScreenBegin/Chunk/Commit` 更新；未提交 screen、pane/server epoch 不匹配、pane/stream gap、订阅拒绝和设备断开都会清除失效 cursor。
- 同时跟踪 HELLO 两侧 frame 上限。带 cursor 的恢复订阅过大时，剥离 cursor 并向浏览器发送 resource-exhausted stream gap；无 cursor 仍过大时丢弃恢复帧。排队中的 canonical 命令同样重新校验，canonical generic `CHUNK` 被拒绝。
- forwarder 在切换 carrier 后先完成排队帧 rewrite/flush，再读取并发送浏览器侧 gap 信号，保证恢复订阅与 gap 的顺序。
- 服务端 subscription coordinator 的 round-trip 测试验证恢复 cursor 命中时先 ACK 再补 delta，cursor miss 时先 ACK 再显式 gap，不隐式抓整屏。

这证明 failover 后 canonical 路径按 cursor 精确补流，不会进入 `buildLegacyHistoryRequests()` 的全历史 replay storm。

## `apps/gateway/src/ws/index.ts` 的精确改动

共享文件只改了三处 canonical wiring，未改连接/断开日志：

1. 向 `CanonicalFeedSession` 注入 `resizePane` callback，并复用 `handleTermResize` viewport arbiter。
2. 将 `GatewaySession.onDirectFallback` 绑定到当前 canonical session 的 `onCarrierFallback()`。
3. 手工关闭 active direct carrier 时同步触发同一个 canonical fallback hook。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| `packages/shared && bun test` | 451 pass，0 fail（基线 442） |
| `packages/ws-client && bun test` | 373 pass，0 fail（基线 319） |
| `packages/stores && bun test` | 432 pass，0 fail（基线 420） |
| `apps/fe && bun test src/` | 1744 pass，0 fail（基线 1737） |
| gateway canonical/failover/RTC/wiring 定向套件 | 162 pass，0 fail，8 files |
| `apps/gateway && bun test` 稳定态全量 | 3817 pass，6 fail，3823 tests（通过数高于 3750 基线） |

gateway 全量的 6 个失败均不在本任务路径，且两次全量的失败集合不同。稳定态轮次失败项为 peer replay-cache 时序、multi-hub token failover、RTC candidate summary、两个 RTC breaker 时序项和真实 tmux `run_command` 集成项。随后按测试名定向复验，除 multi-hub token 用例仍返回 409 外，其余 5 项全部通过；前一轮偶发失败的 legacy stream failover 与 24 MiB mesh push 在稳定态全量已通过，legacy stream failover 也单独复验通过。multi-hub 文件及其实现不属于本任务改动，应由 commander 在合并其他并行改动后再次全量确认。

TypeScript 最终结果：gateway、ws-client、FE 均 0 error；stores 仅保留基线中的 1 个 `host-services.test.ts:93` 错误。Biome 对 56 个本任务源码文件通过；`git diff --check` 通过。复杂度门禁中本任务新增违规为 0，仍有 8 个任务外既有/并行违规，分布于 account security、nodes management、mesh runtime/RTC/peer race、shared test fake 和 direct dial breaker。

## Reviewer 应重点关注的风险

1. `CanonicalLiveReplay` 的 22 页和 2,000,000 字节预算是对当前 TerminalSurface 行为的镜像；未来终端预算调整时必须同步修改。
2. direct carrier 丢失后，服务端能用 stream gap + metadata snapshot 恢复 S2C 状态，但已经发往失效 direct carrier、尚未被节点处理的浏览器输入无法重放；现有 direct-fallback toast 仍负责提示这项协议边界。
3. canonical metadata 尚不包含持久化树顺序/自定义名称，当前兼容性依赖受控 legacy snapshot sideband；未来扩展 schema 时应删除这层 overlay，而不是形成第二套长期事实源。
4. metadata assembly 总数已限制为 8，但单个合法大 snapshot 仍会按 schema 声明分配 chunk 数组；需要留意异常大拓扑的峰值内存。
5. 低于 canonical 最小安全 frame 的连接会有意回退 legacy；review 时需确认这与部署侧 HELLO/frame 配置一致。
6. gateway 全量仍有一个可重复的任务外 multi-hub token 409；虽然 canonical 定向套件全绿，合并轮次仍应复跑 gateway 全量以区分环境波动与其他并行变更。
