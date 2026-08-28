结论：**Request changes，暂不建议合入。** 精确补丁与 `0f8d00b^..0f8d00b` 一致。发现 4 个实质缺陷，其中 2 个 P1、2 个 P2。

## Findings

1. **P1 — 混版本 quiesce 仍可无 fence 替换，`caps` 也未绑定认证 transcript。**  
   [peer-protocol.ts:109](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-protocol.ts:109)、[encoding.ts:66](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/auth/encoding.ts:66)、[peer-manager.ts:578](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:578)

   `caps` 只从原始 JSON 读取，没有进入 `PeerHelloSchema`、Ed25519 transcript 或 HKDF。中间人可剥离 `caps` 而不破坏签名。虽然加密后的 `link.hello` 最终可恢复能力，但在 ACK 到达前，`getLink()` 仍允许 `userPath && streams === 0` 直接升级。

   对真正的旧 peer，该分支永久存在：远端 OPEN 尚在传输、所以本端尚未计入 `streams` 时，业务请求触发新链；旧 peer 随后按旧逻辑替换链路，OPEN 仍可能丢失。新端延迟关闭旧链不能约束旧端。

   修复：未在已认证链路收到 capability ACK 前，任何路径都不得替换旧链。删除未认证 raw `caps`，或引入带版本和降级保护的 v2 transcript；旧 peer 只能保留现有链，不能自动升级。

2. **P1 — catch-up generation 未传入 push helper，旧任务可通过新连接写 key-log。**  
   [uplink-client.ts:636](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:636)、[uplink-client.ts:824](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:824)、[uplink-client.ts:923](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:923)

   旧代次在 `pushMissingToHub()` 等待 `keyLogApplier.list()` 时发生重连；新代次认证后，旧 `list()` 返回，helper 会调用当前连接的 `appendAndAck()`，把旧代次工作发送到新链，直到整个 helper 返回后才检查 generation。

   `catchUpChain = Promise.resolve()` 也只是丢弃引用，没有取消正在等待的 `head/list/applyMany`；若底层 Promise 卡住，每次重连都可遗留一条任务链，并允许旧、新代次并发操作 applier。

   修复：捕获并传递 `(generation, epoch, userId, AbortSignal)` 到所有 helper；每个 await 后、每次 append 前校验。为 applier 调用增加取消或超时，并显式追踪、收敛旧任务，而不是只重置链引用。

3. **P2 — offline 去重按 status 一刀切，吞掉正常 inventory/version 更新。**  
   [mesh-runtime.ts:581](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:581)、[mesh-runtime.ts:791](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:791)、[mesh-nodes.ts:34](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/mesh-nodes.ts:34)

   节点保持 `online` 并上报新 inventory 时，hub 会发送新 `node.list`，但 `lastEmittedNodeStatus` 因状态仍为 `online` 而丢弃事件。前端正依赖该事件更新 inventory 和 version，因此 UI 会持续显示旧数据，直到重新完整拉取。

   该 Map 对历史 nodeId 也无 TTL、撤销清理或 stop 清理，长期 churn 下再次单调增长。

   修复：只对“断链合成的 offline”按连接代次去重；正常 `node.list` 应按完整事件投影去重，或始终发送。若保留缓存，应提供撤销、stop、TTL/LRU 生命周期。

4. **P2 — 固定容量 LRU 让 key-log 限频在超过 1024 个节点时可循环绕过。**  
   [uplink-server.ts:150](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:150)、[uplink-server.ts:206](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:206)、[uplink-server.ts:555](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:555)

   1025 个已认证节点轮询请求时，每次都会淘汰下一个节点的 bucket；该节点再次出现即获得全新的 20-token burst。于是超过容量的合法 fleet，或控制大量已登记身份的攻击者，可以让 per-node 限频实际上失效，并反复触发大范围 `keyLogSource.list()`。

   修复：容量不足时不得通过“新建满 bucket”降级；为 overflow 增加不可淘汰的全局/每用户 bucket，或按 enrolled fleet 配置容量并拒绝淘汰活跃窗口内的限频状态。

## 原 9 项关闭状态

| # | 状态 |
|---|---|
| 1 quiesce 混版本 | **未关闭**：仍有无 ACK 的 user-path 替换，raw caps 可被剥离 |
| 2 长流硬关闭 | 已关闭 |
| 3 升级退避 | 已关闭 |
| 4 applier 异常重试 | 已关闭 |
| 5 catch-up generation | **部分关闭**：主流程有检查，push helper 与任务取消仍遗漏 |
| 6 空 userId listener | 已关闭 |
| 7 authenticated generation | 已关闭 |
| 8 presence freshness | 原问题已关闭；引入 status-only 去重缺陷 |
| 9 限频状态内存 | 原无界增长已关闭；引入容量淘汰绕过 |

补充判断：

- `0f8d00b^` 的 hello parser 会忽略未知字段，因此对直接上一版兼容；未找到实际存在的严格拒绝未知字段 peer，故不单列 finding。
- hub 空库时 getter 本身不会放宽认证：peer 仍必须具有 DB cert 并通过 transcript 签名；`hub user add` 竞态未发现授权窗口。
- catch-up 持续失败时，hub-only 节点可以长期显示 offline，但这是等待撤销日志同步的 fail-closed 行为；已有直连/relay 仍由 `listReach()` 单独计为在线，不判为缺陷。
- 本次为只读静态审查，未独立重跑 P8 报告中的测试。