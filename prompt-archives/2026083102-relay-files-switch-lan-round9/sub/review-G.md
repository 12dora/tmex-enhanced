## 1. Blockers

### 1.1 stop 可能遗留已认证但尚未 track 的 winner socket

位置：[peer-manager.ts:1427](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1427)、[peer-ws-race.ts:308](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-ws-race.ts:308)

`raceWsSecureEndpoints()` 选出 winner 后，父 signal abort 只执行 `abortLosers()`，明确保留 `winnerCtl`。如果此时 `stop()`/generation 变化发生在 race 返回与 `dialWsSecure()` 恢复之间，1427 行会直接抛错，但没有关闭 `raced.winner.session`。该 session 尚未进入 `live`，所以 `stop()` 的 live 清理也看不到它。

具体场景：

1. endpoint A 完成认证并被选为 winner。
2. abort endpoint B 时触发 manager stop，父 signal 进入 aborted。
3. race 仍返回 A，且 A 保持打开。
4. `dialWsSecure()` 发现 stale 后抛出，A 成为未跟踪的已认证连接。

我用可控 abort 顺序复现到了 `parentAborted=true`、race 返回 winner、winner 仍为 open。

最小修复：取得 winner 后，在 stale 分支先执行 `winner?.session.close('stopped')` 再抛错；更完整的做法是让 race 的 parent-abort 分支同时关闭已选 winner，并返回 `winner: null`。补充覆盖“winner 已选出、track 前 stop”的回归测试。

### 1.2 接收端会把 loser/parked session 的密钥写到当前 winner 上

位置：[peer-manager.ts:1460](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1460)、[peer-manager.ts:1522](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1522)

`acceptDirect()` 在 `track()` 后无条件调用 `rememberKeys()`。当同一主动方的两个 endpoint 都完成认证时：

1. session A 先成为接收端 live，并记录 A 的 keys。
2. session B 随后认证完成；因为 A 尚未完成 quiesce 协商，`track(B)` 会 park B 并返回 A。
3. `rememberKeys(B)` 查找当前 live，结果把 B 的 keys 写入 A。
4. 若 A 是发起端最终 winner，B 关闭后 A 仍持有错误的 B keys。
5. 若 B 是 winner，A 关闭后 B 从 parked 提升，但 `ParkedInbound` 没有保存 keys，新 live 的 keys 为空。

因此接收端虽然通常只把一条连接计为 live，`sessionKeysOf()` 却与实际 live session 不一致；parked winner 后续提升时同样无法恢复正确 keys。现有 same-turn 测试只验证主动发起端，没有覆盖对端 `PeerManager`。

最小修复：让 keys 跟随具体 session 穿过 `track`、`parkInbound` 和 `installLive`，而不是在 `track()` 后通过 nodeId 回写当前 live。仅增加 `kept === result.session` 判断只能修复 loser 覆盖，不能修复 parked winner 提升后丢失 keys。

## 2. Should fix

### 2.1 mesh nodes 查询仍存在完全可避免的 N+1 数据库读取

位置：[peer-manager.ts:429](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:429)、[mesh-routes.ts:207](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-routes.ts:207)、[node-list-projection.ts:136](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/node-list-projection.ts:136)

原来的 `listPeers().find()` 型 O(N²) 已消除，但 `collectNodes()` 已经一次性构造了 `peerById`，随后每个 peer 又通过 `linkDetailOf()` 执行一次同步 `getPeer()` 查询。更重要的是，`linkDetailOf()` 查询并解析出的 `detail.endpoints` 最终被忽略，投影明确使用 `peerById` 中的 `storedEndpoints`。

具体场景：500 个节点的 `/api/mesh/nodes` 请求会额外执行约 500 次 indexed SELECT，而所取 endpoints 不参与响应。

最小修复：把 endpoints 完全留在已有 `peerById` 投影路径中，让 `linkDetailOf()` 只读取 `live` 和 `lastDirectAttempt` 等内存状态；或显式把已缓存 peer record 传入，避免再次查询。

### 2.2 缺少真实 stagger timer 在 stop 时被取消的测试

位置：[peer-ws-race.ts:323](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-ws-race.ts:323)

实现上 combined signal 会传入每个 stagger sleep，默认 scheduler 也会在 abort 时 `clearTimeout`，未发现实际 timer 泄漏。但当前相关 manager 测试使用立即完成 sleep 的 `ImmediateScheduler`，无法证明多个尚未到期的 stagger timer 在 stop 后全部取消。

最小修复：使用持有 pending sleeps 的 abort-aware 测试 scheduler，启动多个延迟 candidate，调用 stop 后断言所有 sleep 均已 reject/清理且没有 candidate 再进入 `wsFactory`。

## 3. Nits

无。

相关纯逻辑及定向回归测试通过：80 个 address/projection/routes/race/attempt 测试，以及 4 个定向 PeerManager race 测试。完整 PeerManager 测试在只读沙箱中有 8 个用例因禁止监听端口而失败（`EPERM`/`EADDRINUSE`），不是本补丁的断言失败。