# 最终结论

**不建议合并。** 发现 **2 个 blocker、5 个 should-fix、1 个 nit**。未修改任何文件。

## 1. Stream failover

### Blocker：当前实际使用的 legacy pane 输出无法连续恢复

位置：[forwarder.ts:654](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:654)、[forwarder.ts:686](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:686)、[stream-failover.integration.test.ts:415](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/stream-failover.integration.test.ts:415)

只有 canonical `PaneData` 会记录 cursor；实际前端仍发送 legacy `TMUX_SUBSCRIBE_PANES`，它仅被原样重放，没有 cursor。旧 GatewaySession 关闭到新 session 订阅完成之间产生的 tmux 输出不会补发。

具体场景：远端持续编译或 `tail -f`，DC 断开后 entry 等待 relay/重拨数秒；此间输出永久缺失，多个已订阅 pane 中只有最后 `TMUX_SELECT` 的 pane 可能通过 history 重建。

现有集成测试不能证明连续性：没有连接 client 时它根本不递增 `SEQ`，且断言还删除了相邻重复值。

### Should-fix：failover 期间的新订阅可能被同 generation 的 replay 覆盖

位置：[forwarder.ts:164](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:164)、[forwarder.ts:324](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:324)、[forwarder.ts:341](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:341)、[forwarder.ts:733](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:733)

failover 先生成状态快照，再等待 HELLO；期间浏览器发送的新 canonical subscription 同时更新 replay state 并进入 queue。新链路随后收到：

1. 旧快照合成的 generation `G+1`；
2. queue 中浏览器发送的、内容不同的 generation `G+1`。

目标端会报 generation conflict，并保留旧订阅。具体场景是 failover 期间切换 pane，恢复后仍显示旧 pane。

### Should-fix：浏览器关闭期间可遗留孤儿上游 WS

位置：[forwarder.ts:172](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:172)、[forwarder.ts:283](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:283)、[forwarder.ts:291](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/forwarder.ts:291)

浏览器关闭只会关闭当时的 `pump.stream`。若关闭发生在 `await getLink()` 或 `openWsStream()` 期间，await 返回后没有再次检查 abort，仍会创建并绑定新上游流，随后直接 return，且不关闭该流。

只读复现结果：`{"opened":1,"orphanClosed":false}`。

HTTP GET/HEAD 重试：**no findings**。仅 GET/HEAD、无 body 时重试；响应头返回后不重试 body。语义是标准的 at-least-once GET，当前 GET endpoint 未发现非幂等写操作。

## 2. DC liveness

**no findings。**

位置：[liveness.ts:123](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/liveness.ts:123)、[data-channel-link.ts:73](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/data-channel-link.ts:73)、[data-channel-carrier.ts:61](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/data-channel-carrier.ts:61)

- liveness 使用保留的 frame ID 0，应用 frame 从 1 开始并跳过 0。
- ping/pong 在进入 reassembler/sess framing 前被截获。
- channel close、protocol error、timeout 都会停止两组定时器并 dispose reassembler。
- 未发现 close 后 timer 继续运行或 ping 污染 Borsh sess 帧。

## 3. Uplink diagnostics 与 connect timeout

**no findings。**

位置：[uplink-client.ts:420](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:420)、[uplink-client.ts:499](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:499)、[uplink-client.ts:452](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:452)

- 20 秒 timeout 覆盖 WS open 和 auth；auth 半开时 abort 会通过 `authenticate.finish()` 关闭 Link/WebSocket。
- generation 检查阻止超时连接稍后被标记 online。
- connect 日志只输出 `URL.host`、稳定 reason code、attempt/backoff；不输出 URL path/query、异常原文、nonce、签名或私钥。
- ctl 错误日志只包含白名单 type、长度和归一化错误码。

## 4. Hub redeem 幂等

### Should-fix：同公钥路径没有节点私钥持有证明

位置：[hub-runtime.ts:527](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:527)、[hub-runtime.ts:532](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:532)、[hub-runtime.ts:536](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:536)

攻击者拿到一个未使用的 enrollment token 后，可以复制公开的目标 `nodeId` 和 Ed25519 public key，用 enrollment key 签一张新证书。比较 public key 相等不能证明攻击者持有目标节点私钥。

当前会：

- 消费新 token；
- 解绑旧 token；
- 修改目标节点 name/version；
- 将 revoked 节点的 registry 状态改回 `enrolled`；
- 允许替换 X25519 public key。

攻击者仍不能通过 uplink Ed25519 认证，因此不是跨节点权限突破，但可以污染节点身份元数据和造成 enrollment DoS。新 token 绑定已有 nodeId 应要求现有 Ed25519 私钥 PoP，或直接继续返回 409；仅精确同 token replay 保持幂等。

## 5. Join stale-user replacement

**no findings。**

位置：[user-key-service.ts:945](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:945)、[user-key-service.ts:1107](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-key-service.ts:1107)、[user-store.ts:313](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/auth/user-store.ts:313)

- `node_certs`、`nodes`、`enrollment_tokens` 均按被替换 uid 清理。
- `node_identity` 未删除，只更新 userId/新证书。
- 完整链在同一事务中重放；失败会整体回滚，hub/self cert 会从已验证 keylog 重建。
- `peer_cache` 包括 hub sentinel 在内会全清，但它本身没有 `user_id`，且当前运行模型明确只支持单用户；新 uplink list 会重新填充。

如果未来真正支持多用户，全局 `peer_cache` 确实会让一个用户 rejoin 清掉其他用户缓存，但那需要先完成 peer_cache 用户隔离，不是当前受支持场景。

## 6. Node-name propagation

### Should-fix：peer 自报名称可在 hub list 缺失时伪造 UI 名称

位置：[peer-manager.ts:1645](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1645)、[mesh-routes.ts:470](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:470)

已 admit 的恶意 peer 可在 `node.status.name` 中声明任意名称并写入 `peer_cache`。entry 重启且 hub 离线时没有内存中的 `node.list`，普通 node 也没有本地 `nodes` registry，于是 UI 回退使用该伪造名称。

具体场景：失陷节点把自身名称改成另一台生产机名称；用户从离线 entry 打开 UI 时可能操作错误节点。建议 peer status 不更新 name；名称只来自 hub `node.list` 或本地 hub registry。

新加入的 hub name 本身：**no findings**。它仍是设计中明确允许 hub 篡改的元数据；节点枚举、public key、鉴权和路由继续由非吊销 `node_certs`/nodeId 决定，name 不进入安全判断。

## 7. Round-4 RTC

### Blocker：review-3 的 handshake handoff 只修复了“小 OPEN”，一般情况仍会关链

位置：[dc-handshake.ts:113](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:113)、[dc-handshake.ts:231](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:231)、[dc-handshake.ts:283](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/dc-handshake.ts:283)、[data-channel-link.ts:73](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/data-channel-link.ts:73)

存在两个确定性失败场景：

- 一侧先完成握手并安装 `DataChannelLink`，另一侧仍每 40ms 重传 `hello`。后到的 JSON `hello` 被 Link reassembler 当作 fragment，触发 `fragment-protocol` 并关闭健康 DC。
- 一侧完成后立即发送大于 4 KiB 的正常 LinkMux DATA；另一侧仍由 handshake queue 接收时会以 `dc handshake message too large` 关闭通道。队列上限 8 也会拒绝正常 burst。

只读复现分别得到：

```json
{"linkClosedReason":"fragment-protocol","channelOpen":false}
{"bHandshake":{"ok":false,"error":"dc handshake message too large"},"channelOpen":false}
```

因此 review-3 的小 OPEN 丢失已修复，但完整的 handshake→Link 交接仍未修复。

浏览器 nonce→carrier 交接：**no findings**。`shiftPendingMessage()`、listener unsubscribe 和剩余帧重新缓存路径正确。

### Should-fix：失败的 DC upgrade retry 产生未处理 Promise rejection

位置：[peer-manager.ts:939](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:939)

`void pending.finally(...)` 返回的新 Promise 会继承 `pending` 的 rejection，但没有 `.catch()`。ICE/DC upgrade 失败时会产生未处理 rejection；Bun 最小复现继续执行但最终退出码为 1。持续网络故障会反复打印堆栈并污染服务退出状态。

### Nit：revoked authenticated-hub 测试仍可真空通过

位置：[rtc-wake.integration.test.ts:297](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts:297)、[uplink-server.ts:932](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:932)

目标 revoked identity 从未建立在线 uplink。即使删除 hub 的 revoked 检查，消息仍会因 registry 中无目标而丢弃，断言不变。应使用已在线后再吊销、但 uplink 尚存活的第三节点。

## 验证

- 相关无监听端口测试：**178 pass，0 fail**。
- 扩大到 PeerManager/MeshRuntime 后：**223 pass，10 fail**；10 项均为只读沙箱禁止 `Bun.serve()` 绑定端口，不作为代码失败。
- 额外完成上述 RTC 两个 handoff 复现、Forwarder 浏览器关闭孤儿流复现，以及 Promise rejection 复现。
