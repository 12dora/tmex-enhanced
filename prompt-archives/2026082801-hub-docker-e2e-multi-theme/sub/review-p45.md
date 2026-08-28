结论：**Request changes，暂不建议合入。** 发现 9 个真实缺陷，其中 6 个 P1、2 个 P2、1 个 P3。

## Findings

1. **P1 — quiesce fence 无法保护混版本升级。**  
   [peer-manager.ts:936](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:936)、[peer-manager.ts:1285](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1285)

   旧版 peer 会忽略未知的 `link.quiesce` JSON，不会因此触发协议错误或杀链；但它在新链建立后仍按旧逻辑立即关闭 `streams === 0` 的旧链。此时尚在传输中的 OPEN 仍会丢失，因此滚动升级期间原 P1 可复现。

   修复：在拨新链前通过旧链协商 capability/quiesce，并且必须收到 ACK 才允许自动替换；不支持该能力的旧 peer 应跳过后台升级，而不是先换链再发送 fence。

2. **P1 — 30 秒硬退役会主动中断正常长流。**  
   [peer-manager.ts:1319](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1319)

   `PEER_RETIRE_MAX_MS` 到期后不检查 `streams`，直接关闭旧链。终端、WebSocket、长 HTTP 或文件流超过 30 秒时，后台传输升级会稳定将其切断。现有测试只观察了 50 ms。

   修复：活跃 stream 存在时不得执行硬关闭；只对 `streams === 0` 但 fence 未完成的链使用超时兜底，或实现明确的 stream 迁移协议。

3. **P1 — 正常业务流量可绕过升级退避并造成 semaphore 饥饿。**  
   [peer-manager.ts:389](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:389)、[peer-manager.ts:565](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:565)

   `getLink()` 对现有 relay 链调用 `{cooldown:false}`。每次直连升级失败后，下一次代理请求都能立即再次拨号，完全忽略刚计算的 10 秒至 5 分钟退避。繁忙 relay peer 可持续占据全部 4 个升级槽，其他 peer 饥饿。

   修复：所有“替换现有链”的升级都必须检查 `nextEligibleAt`；首次 gate 本来就是 0，无需专门绕过 cooldown。

4. **P1 — key-log 抛异常时仍保持 online，未执行重试或断链。**  
   [uplink-client.ts:537](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:537)、[uplink-client.ts:577](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:577)、[uplink-client.ts:639](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:639)

   `head()`、`list()` 或 `applyMany()` 抛出 DB/I/O 异常时，最外层 catch 只写 warn。连接继续 online，catch-up 没有恢复触发；包括撤销记录在内的安全日志可能长期不应用。

   修复：所有 applier 调用的异常都进入同一有界重试状态机，超过次数后 teardown；`fork` 仍保持硬失败。

5. **P1 — 旧代次 catch-up 可污染或打断新连接。**  
   [uplink-client.ts:167](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:167)、[uplink-client.ts:522](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:522)、[uplink-client.ts:838](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:838)

   `catchUpChain` 不绑定 generation，而重连将 `listEpoch` 重置为 0。旧连接的第一份 list 和新连接的第一份 list 都可获得 epoch 1。旧任务若停在 `await head/applyMany`，新连接认证后恢复时会通过当前 `isAuthenticated()` 和相同 epoch 检查，可能按旧 target 调用 `failFork()`、push 或 teardown 新链。

   修复：为每个 catch-up 捕获 generation，并在每个 await 后校验；epoch 应全局单调，或使用 `(generation, epoch)` 联合标识并取消旧代次队列。

6. **P1 — “拒绝启动 uplink”之前已经启动 PeerManager。**  
   [mesh-runtime.ts:1183](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:1183)、[peer-manager.ts:465](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:465)

   node-only 多用户歧义场景中，`peerManager.start()` 先绑定 peer 端口，随后才因空 `userId` 返回。此时 PeerManager 把空 userId 当通配符，证书属于任一用户的 peer 都可能完成握手和被 track；这不是完整的“拒绝上线”。

   修复：在启动任何 peer/uplink 子系统前完成 userId guard；node 角色的空 userId 必须 deny-all。hub 空库 bootstrap 也应延迟 peer listener，或在用户创建后重新装配带确定 userId 的运行时。

7. **P2 — `authenticatedGeneration` 未覆盖所有受保护路径。**  
   [uplink-client.ts:229](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:229)、[uplink-client.ts:264](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:264)、[uplink-client.ts:380](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:380)

   替换一个已经 online 的连接时，`resetConnectionState()` 不把 state 改为 connecting，因此新链 auth.ok 前，`sendCtl()`、`openRelay()`、`sendStatus()`、`appendAndAck()` 仍可使用新链。入站 relay OPEN 也只检查 generation，不检查认证门闩。

   修复：换链时立即退出 online；所有受保护的发送、relay OPEN 和 append 路径都要求 `authenticatedGeneration === generation`，未认证 stream 应 reset。

8. **P2 — 重连后会重新信任旧 presence，并可重复发送 offline 事件。**  
   [mesh-runtime.ts:767](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:767)、[mesh-runtime.ts:900](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:900)

   `hubPresenceLive` 在收到 auth.ok、uplink 变 online 时就置真，而不是等当前代次收到新 `node.list`。如果重连后 list 构建失败或延迟，API 会再次使用上个代次的在线节点；每次已认证连接随后断开，又会对同一批节点重复广播 offline，形成 O(节点数 × 重连次数) 的事件风暴。

   修复：presence 必须绑定“当前在线代次已收到并完成 catch-up 的 node.list”；断线后清除该 freshness 标志，并按最后已发状态去重 offline 事件。

9. **P3 — hub token bucket 与日志状态永久按 nodeId 增长。**  
   [uplink-server.ts:134](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:134)、[uplink-server.ts:734](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:734)

   `keyLogReqBuckets`、`keyLogReqLogs` 在断开、撤销和 stop 时均不清理。长期 enroll/revoke 不同 node 后，两个 Map 单调增长。直接在断开时删除 bucket 又会允许重连重置 burst。

   修复：采用有上限、带 idle TTL 的 LRU/sweep；撤销时清理，stop 时 clear，并保留短期断线状态以防重连绕过限频。

## 旧 finding 关闭状态

| 来源 | 状态 |
|---|---|
| review-p1b #1 key-log 失败 | **未完全关闭**：返回错误已处理，但抛异常和跨代次任务未处理 |
| #2 authenticated generation | **部分关闭**：ctl 已门控，relay 与出站路径遗漏 |
| #3 key-log response ID | 已关闭 |
| #4 list version watermark | 同代次降序已关闭；跨代次异步任务仍不安全 |
| #5 stale hub presence | **未完全关闭**：断线立即态正确，重连未收到新 list 时复发 |
| #6 resolveUserId | 解析规则已关闭；拒绝启动顺序引入新问题 |
| #7 hub key-log 限频 | 限频有效；内存生命周期未关闭 |
| #8 ctl 日志注入 | 已关闭 |
| review-p3 #1 in-flight OPEN | **未关闭**：仅新↔新短流有效，混版本和 30 秒长流仍失败 |
| #2 升级拨号限流 | **部分关闭**：endpoint 通知已限流，`getLink` 可绕过 |
| #3 status 去重 | 已关闭 |

补充确认：

- 未知 `link.quiesce*` ctl 会被旧端 default 分支忽略，不会触发 LinkMux protocol error。
- 恶意 peer 单独发送 quiesce 只会收到 ACK，不会直接让当前链进入 retiring；没有发现该方向的直接 DoS。
- retire interval、upgrade scan、semaphore waiter 的 stop/abort 清理路径本身正确。
- hub 角色存在唯一用户时会启动；node-only 在有 self cert 且数据库含多用户时也能正确选择 self cert 的 userId。

审查的是精确的 `44138c7..001322c`：supplied patch 与 Git diff SHA-256 一致，目标 9 个文件也与 `001322c` 完全一致。未运行测试，因为这是只读审查；没有声称测试通过。