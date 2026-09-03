# TASK C6：multi-hub failover flake 根因与修复

## 结论

这是一个既有的 peer relay 换链竞态，被本轮 RTC native 懒加载改变时序后显著放大；`waitSocketOpen` 合并等改动会继续影响命中概率，但不是数据截断的语义根因。

本轮懒加载移除了启动阶段的 `await rtc.ready()`，同时 `RtcPeerManager.available` 在首次加载前会乐观返回可用。旧的 `PeerManager.dialDc()` 会先启动异步 native 加载，再立即发送 `rtc.wake`。测试环境的 `loadNative()` 最终返回 `null`，因此 wake 没有任何建立 DC 的可能，却会令对端同时执行 `getLink()` 并反向建立 relay。

## 精确失败时序

1. C 发起远端登录时，HTTP `/api/auth/challenge` 子流运行在 C↔目标节点的 peer `LinkMux` 上；这个 peer mux 的 carrier 是 uplink relay stream。G5 在 A 下线后走 `C uplink → B hub → D uplink`，standby enrollment 则走 `C uplink → A hub → B uplink`。
2. 首条 relay 刚建立后，lazy RTC 尝试在确认 native 可用前发送 wake。目标节点收到 wake 后反向拨号，于是第二条同等级 relay 与第一条竞争。
3. simultaneous-dial 仲裁选中后到达的 winning relay，`PeerManager.track()` 将第一条、也就是已经承载 challenge HTTP 子流的 relay 标为 `replaced`。
4. 既有 quiesce 逻辑只在开始退役时发送一次 `link.quiesce`。当时 HTTP stream 尚未完成，但双方已经提前收到 `link.quiesce`/ACK；目标端稍后把 response END 交给异步 carrier 后，本端 stream 计数先降为 0，旧 ACK 立即满足关链条件。
5. 旧 peer mux 关闭后，`byteTransportFromStream.close()` reset 外层 uplink relay stream；hub 的 `pumpRelay()` 将其扩散为 `relay-rst`。C 已收到 150 字节 response DATA，却未收到排在异步发送队列尾部的 END，因此 `openHttpStream()` 在 `stream-targets.ts:377` 以 `http stream aborted` error 结束 body。

150 字节与 `/api/auth/challenge` 的 JSON 长度完全一致：22 字符 challenge id、两个 43 字符 base64url 字段及 JSON 结构合计 150 字节。`loginRemote()` 正在 `await ch.json()`，即使 DATA 已完整到达，缺少 END 仍会直接令测试失败。

主线代码在构造 `RtcPeerManager` 时已开始加载 native，并在 `MeshRuntime.start()` 中等待 `rtc.ready()`；测试请求开始前 `available` 已变为 false，不会发出无效 wake。分支的懒加载破坏了这个隐含前置条件。主线也存在“一次 quiesce + 旧 ACK 可立即关链”的缺陷，只是原时序很少制造双 relay，因此没有触发。

## 修复

- `apps/gateway/src/mesh/peer-manager.ts`
  - `dialDc()` 先等待 lazy `rtc.ready()`；只有确认 native 可用且 generation 仍有效后，才创建连接并发送 wake。保留首次真实需要时才加载 native 的性能目标，不恢复启动期 eager load。
  - 退役链路出现任何新 stream 时废弃先前的 quiesce 状态；最后一个 stream 结束后重新发送 `link.quiesce`。由于 `stream.closed` 发生在本端 END 的 send promise 完成之后，新的 quiesce/ACK 在同一有序链路上必定位于 END 之后，不能再用 stream 活跃期的旧 ACK 提前关闭 carrier。
  - 既有最小静默期和最大退役期 fallback 保持不变，兼容未完成第二轮握手的旧 peer。
- `apps/gateway/src/mesh/peer-manager.test.ts`
  - 新增 `lazy native miss falls back without waking the peer`；固定大 node id，确定性证明 native 返回不可用时不会调用 `connectToPeer()` 或发送 wake。
  - 补齐现有 RTC mock 的 `ready()` 行为。
- `apps/gateway/src/mesh/peer-manager.upgrade.test.ts`
  - 新增 `retiring link re-quiesces after its last stream drains`；显式让第一轮 quiesce/ACK 发生在活动 stream 期间，验证 drain 后必须出现第二轮屏障，第二轮 ACK 前旧链路不能关闭。

两条新增测试在生产修复前均稳定失败：前者得到 `readyCalls=0`；后者等待第二次 quiesce 超时。修复后均稳定通过。未修改 integration test 的 timeout、`waitUntil` budget 或断言。

## 证据与失败率

- 未修改代码基线：完整 `multi-hub.integration.test.ts` 连跑 16 次，12 次通过、4 次失败，失败率 **25%**。
  - G5：2 次。
  - standby enrollment：2 次。
  - 日志：`/private/tmp/c6-baseline-16.log`。
- 修复后：同文件、同机器完整连跑 16 次，**16/16 通过，失败率 0%**。
  - 日志：`/private/tmp/c6-after-16.log`。
- 修复前 `TMEX_LOG_LEVEL=debug` 全量尝试 8 次没有复现最终 test failure，说明额外日志会扰动窄时序窗口；但 `/private/tmp/c6-debug-full.log` 多次清楚记录 `signal send kind=wake → signal recv kind=wake → reason=replaced`。题目提供的失败日志和本次非 debug 基线都记录了后续 `sent=150 → http stream aborted`。
- 修复后 debug G5 日志 `/private/tmp/c6-debug-after-g5.log` 只记录 native unavailable，不再出现对应的 wake send/recv；合法的其他 `replaced` 仍可发生，但 16 次后测中没有一次 `sent=150` abort。
- 每轮测试结束时仍会看到一个 `sent=0` 的诊断：G5 最后只检查 Response status，fixture 随即主动 stop，未消费的最终 response body 被取消。这不产生异常或 test failure，与本次 `sent=150` 且发生在业务请求中的截断不同。

## 验证

- `bun test src/mesh/peer-manager.upgrade.test.ts`：18 pass，0 fail。
- `bun test src/mesh/peer-manager.test.ts` 相关 RTC/退役集合：5 pass，0 fail。
- 排除 9 个必须监听本地端口、在当前沙箱被 `EADDRINUSE`/`EPERM` 拒绝的用例后，其余 peer-manager 全集：66 pass，0 fail。直接跑完整文件时仅这 9 个环境性监听失败，没有逻辑断言失败。
- `bun test src/mesh/integration/multi-hub.integration.test.ts`：单轮 21 pass；统计后测 16/16 全部通过。
- `bunx tsc --noEmit -p .`（`apps/gateway`）：0 error；修改前基线为 11 个并行区域既有错误，未增加。
- `bunx biome check src/mesh/peer-manager.ts src/mesh/peer-manager.test.ts src/mesh/peer-manager.upgrade.test.ts`：通过，无修复项。

