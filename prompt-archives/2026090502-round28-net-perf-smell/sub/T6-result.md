# T6 结果：Mesh 网络稳健性与延迟

## 结论

T6 的 14 项交付均已实现并补充单元测试。唯一没有落代码的子项是“过滤明显无用的本地网卡”：当前锁定的 `node-datachannel@0.33.1` 只暴露 `bindAddress`，没有接口 allowlist、denylist 或 candidate filter API，因此按任务约定跳过；单一明确 IP 的绑定已经生效。

生产问题的主要修复是：RTC 信令现在按角色、attempt epoch 和单次 answer 约束过滤；订阅或信令应用异常不会泄漏 PeerConnection/监听器；offerer 不再缓存无 attempt 的旧 answer/candidate。弱网链路现在把任意入站帧视为活性，在途 peer/relay 流会先排空再退役或切换，中继限流按逻辑流公平调度，小帧具有优先通道。

## 交付状态

| 编号 | 状态 | 结果 |
| --- | --- | --- |
| 1 | 完成 | `bindSignaling`、`trackPc` 纳入 `connectToPeer` 的清理范围；信令应用明确 `offer`/`answer` 期望，重复 answer、错误类型和应用异常均记录 `signal dropped` 后丢弃。 |
| 2 | 完成 | inbox 通过 microtask 回放，订阅先返回可用的 unsubscribe；条目带 `receivedAt`，回放时丢弃超过 30 秒的数据；offerer 无监听器时不缓存 answer，无 attempt 时不缓存 candidate。 |
| 3 | 完成 | SDP/candidate JSON 信令新增可选 `epoch`；offerer 每次拨号生成 epoch，answerer 从 offer 继承并回传；已定义但不匹配的 epoch 被丢弃，未定义时按旧节点兼容路径只做类型过滤。 |
| 4 | 完成 | `FakePeerConnection` 增加 `stable`、`have-local-offer`、`have-remote-offer` 状态机，并复现 libdatachannel 的稳定态 answer 异常；覆盖 cooldown 后旧 answer 回放、单 attempt 重复 answer，以及 `livePcs`/监听器归零。 |
| 5 | 完成；接口过滤跳过 | ICE 默认启用 TCP、UDP mux，MTU 为 1200；单一具体 IP 写入 `bindAddress`；新增 `TMEX_RTC_PORT_RANGE=begin-end` 严格解析并映射端口范围；`dial start` 输出脱敏后的有效配置。网卡过滤因绑定库无相应 API 跳过。 |
| 6 | 完成 | breaker 通过 `skipKinds` 忽略本地 signaling-state/`signal dropped` 错误；达到永久禁用阈值后，每 10 分钟允许一次自动 force probe，失败后重新计时。 |
| 7 | 完成 | `connectToPeer` 使用单一 15 秒总 deadline，datachannel、open、fingerprint、handshake 共享剩余预算；fingerprint 等待改为 `onLocalDescription` fanout，不再 5 ms 轮询。 |
| 8 | 完成 | ws-secure/relay peer ping 改为 5 秒、3 次丢失；`LinkMux.lastFrameAt` 让任意入站帧重置 miss；`missed-pong`/`idle` 且存在流时进入既有 retire 宽限，`revoked`/`stopped` 仍立即关闭。 |
| 9 | 完成 | failover 退避追加 3200、6400 ms，总 sleep 预算为 12750 ms，连同每次尝试接近 15 秒。 |
| 10 | 完成 | relay client/pool 双层追踪在途隧道流；就近切换、回切、reconfigure 等待排空；每 3 秒复查、10 分钟硬上限；旧 client 停止接新流后 drain 再 stop，死链仍立即处理。 |
| 11 | 完成 | relay registry 维护 `lastByteAt`/字节流序号，心跳期间有流量不累加 miss；令牌桶为每条逻辑流建立独立队列并以 4 KiB quantum 轮转，小于等于 4 KiB 的帧走优先通道且不会饿死大流；pump 单向失败先 half-close，再按 `relay-rst:src-read`、`relay-rst:dst-write`、`relay-rst:peer-abort` 回退双向 RST。Hub 内置 relay pump 同步采用该语义。 |
| 12 | 完成 | DataChannel 与 bulk 的发送目标降为 16 KiB；接收上限仍为 64 KiB；覆盖 1 MiB 重组、旧 64 KiB 分片和 bulk 双向兼容。 |
| 13 | 完成 | relay 外层 `WebSocketLink` 增加 `{ transport: 'relay-uplink', url }` 日志上下文；`MAX_LINK_UNACKED` 调整为 `65 × 1 MiB`，覆盖默认 64 条 relay 流加控制流，并在常量旁记录约束。 |
| 14 | 完成 | RTC 按 peer 聚合 host/srflx/prflx/relay/unknown 候选对的成功、失败与拨号耗时，单条 `[mesh][rtc] summary` 每 peer 最多 60 秒输出一次。 |

## 主要实现

### RTC 信令与 ICE

- `RtcPeerManager` 在创建连接后立即进入统一 try/catch，任何订阅、SDP/candidate 应用、open、fingerprint 或握手失败都会取消监听、从 `livePcs` 移除并关闭 PC。
- 本地 description 使用单一原生回调加内部 fanout，同时服务信令发送和 fingerprint 等待，避免原生 API 只有一个 callback 时相互覆盖。
- answer 只允许在 offerer 的当前 attempt 应用一次；answerer 收到 offer 后先记录 epoch，再产生带同一 epoch 的 answer/candidate。
- `TMEX_RTC_PORT_RANGE` 拒绝格式错误、倒序、0 或超过 65535 的范围；未配置时不改变端口选择。

### Peer 与 uplink 弱网行为

- `LinkMux.lastFrameAt` 在每个成功解码的入站帧上推进；同一毫秒内多帧使用单调逻辑值，避免测试时钟或高吞吐下漏掉活性变化。
- peer 退役保留触发原因，宽限结束后仍以原始 `missed-pong`/`idle` 原因关闭。
- uplink drain 同时观察 pool 包装层和 relay client 自身的流集合，消除“open 已完成但 promotion/retire 恰好发生”的竞态；竞态中新流会被 `uplink-retiring` reset。
- reconfigure 对同一 pool 合并并发请求，排空后才 stop/start。

### Relay 数据面

- token bucket 的租户速率仍是共享的，但每个 relay 逻辑流单独排队；每轮最多授予 4 KiB，避免单个大上传占满整个等待队列。
- 小帧优先与普通流交替，既降低控制/交互帧排队延迟，也避免持续小帧饿死已排队的大流。
- 计量语义不变：读取后记录 ingress/egress，获得令牌后调用 `recordAdmitted`，成功写入目标后刷新目标链路字节活性。

## 协议兼容性

- **RTC epoch**：只在现有 JSON envelope 中新增可选数字字段；旧节点省略 epoch 时，新节点回退到类型过滤。`rtcSession` 仍严格为 `dc:<lo>:<hi>`，Hub 路由解析不变。
- **分片**：8 字节分片头和接收 64 KiB 上限不变，只降低新发送端的 payload。新发送端最大 256 KiB 的 LinkMux DATA 会拆成最多 17 片，仍落在旧接收端既有的 17 片限制内；新接收端继续接受旧节点的 64 KiB 分片。`packages/ws-client` 未改，旧浏览器发送也继续可接收。
- **RST**：原因从 `relay-rst` 细化为带冒号的子类型，但保留同一前缀；现有 `forwarder-unreachable.ts` 使用 `startsWith('relay-rst')`，因此错误分类继续得到 `link_lost`。
- **Ping**：`ping`/`pong` JSON 载荷没有变化，仅新节点的发送周期由 15 秒缩短为 5 秒；旧节点可直接互通。新节点在 3 次 miss 后约 15 秒发现失活，期间任意业务入站帧都会维持链路。
- **资源上限**：`MAX_LINK_UNACKED` 是本地保护阈值，不进入线协议；提高阈值不会影响旧节点解码。

## 修改文件

共 53 个 T6 文件通过定向 Biome 检查，其中 45 个既有文件修改、8 个新文件。

- 配置：`apps/gateway/src/config.ts`、`config.test.ts`。
- Peer/RTC：`mesh/mesh-deps.ts`、`peer-manager.ts`、`peer-manager.test.ts`、`peer-manager-types.ts`、`peer-reconnect-wake.ts`、`peer-rtc-wake.ts`、`peer-rtc-wake.test.ts`、`peer-dc-upgrade.ts`、`peer-dc-upgrade.test.ts`、`forwarder-failover.test.ts`；`mesh/rtc/{ice,native,rtc-dial-breaker,rtc-peer-manager,rtc-peer-helpers,test-fakes,fragmenter,bulk}.ts` 及相关测试，另含 `data-channel-carrier.test.ts`、`data-channel-link.test.ts`。
- Uplink：`mesh/uplink-pool.ts`、`uplink-pool.test.ts`、`uplink-relay-drain.ts`、`uplink-nearest-switch.ts`、`relay-uplink-client.ts`、`relay-uplink-client.test.ts`、`relay-wiring.ts`、`relay-pool-switch.test.ts`。
- Relay/Hub：`relay/relay-quota.ts`、`relay-units.test.ts`、`relay-registry.ts`、`relay-registry.test.ts`、`relay-stream-router.ts`、`relay-stream-router.test.ts`、`relay-uplink-server.ts`、`relay-uplink.test.ts`、`hub-relay-pump.ts`、`hub-relay-pump.test.ts`；`hub/uplink-server.ts`、`hub/uplink-server.test.ts`。
- Shared link：`packages/shared/src/link/{fragment-core,fragment-core.test,index,mux,mux.test,types}.ts`。
- `packages/app/src/vendor/node-datachannel/types.ts` 未修改；缺少的配置字段只补在 gateway 的 Bun/native 抽象中，因此无需运行 app 包测试。

## 测试与门禁

| 检查 | 结果 |
| --- | --- |
| Gateway 全量 `bun test` | **4502 pass / 0 fail**，415 个文件，20682 次断言，196.14 秒。任务基线为 4416/0，当前工作区总数增加 86；增量包含 T1、T4 等并发任务。 |
| RTC/peer 定向 | **102 pass / 0 fail**，3 个文件，496 次断言。 |
| Relay 全量定向 | **159 pass / 0 fail**。 |
| Uplink 定向 | **77 pass / 0 fail**。 |
| Shared link 定向 | **70 pass / 0 fail**，6 个文件，256 次断言。 |
| Shared 全量（T6 完成后的绿灯运行） | **713 pass / 0 fail**；任务基线为 692/0。 |
| Shared 全量（最终并发工作区复跑） | **719 pass / 1 fail**，72 个文件。唯一失败为范围外 `packages/shared/src/index.test.ts`：其他代理在主入口新增 `errorMessage`、`sleep`、`sleepOrAbort`，但运行时导出快照尚未同步。T6 link 用例全部通过，且该快照文件不在 T6 可编辑范围。 |
| Gateway TypeScript | `bunx tsc --noEmit -p apps/gateway`：**0 error**。 |
| Shared TypeScript | `bunx tsc --noEmit -p packages/shared`：**0 error**。 |
| Biome | 53 个 T6 文件：**clean**；生成的 i18n 文件未纳入检查。 |
| 差异检查 | T6 范围 `git diff --check`：**clean**。 |
| 新增测试块 | 50 个 `test`/`it`。 |

根复杂度门禁不再报告 T6 文件。门禁仍以非零退出，剩余 8 项违规位于并发任务范围：3 个 FE 函数、`tmux-client/local-external-connection.ts`、`tunnel/external-detect.ts`、`system/upgrade.ts`、`hub/hub-peer-poller.ts`、`packages/panels/src/agent/chat-thread.tsx`；另有 3 条 FE 陈旧 allowlist。T6 的 `peer-manager.ts`、`rtc-peer-manager.ts`、`uplink-pool.ts`、`peer-dc-upgrade.ts`、`hub/uplink-server.ts`、`packages/shared/src/link/mux.ts` 均已回到既有门限以内。

## 风险与后续验证

1. `MAX_LINK_UNACKED` 从 32 MiB 提高到 65 MiB，单 LinkMux 及复用该默认值的 detached fanout 理论最坏内存占用随之增加；这是满足 64 条满窗口 relay 流不误关链的直接代价。
2. drain 最长允许 10 分钟。到达硬上限仍有流时会停止旧 client，剩余流可能收到 reset；该上限用于避免配置切换永久悬挂。
3. 当前测试使用 fake/memory transport，没有执行真实公网 NAT、TURN、ICE-TCP 或端口范围集成测试。上线前可在仓库临时实例与独立测试网络中补 live integration，但不得连接或改动本机生产 tmex。
4. RTC summary 没有后台 flush timer：60 秒窗口内聚合的数据会在该 peer 下一次 dial 结束时输出。这满足“最多每 60 秒一条”，但低频 peer 的尾部统计会延迟。
5. `node-datachannel@0.33.1` 缺少 candidate/interface 过滤接口，因此无法在绑定库层排除虚拟、链路本地等网卡；具体 `bindAddress` 与现有 candidate 日志是当前可用控制面。
6. token bucket 在运行中修改速率不会唤醒已经开始的 sleep；下一次调度最多延迟当前 sleep 周期。现有实现把单次等待需求限制在 4 KiB，因此通常远小于 1 秒。

本轮未启动 tmex 实例、未访问生产目录、未操作任何 tmux session，也未执行 git 状态变更。
