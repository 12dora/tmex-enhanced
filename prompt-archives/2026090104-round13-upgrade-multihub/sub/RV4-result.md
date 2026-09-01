## 结论

**不建议合入。** 发现 **3 个 blocker、6 个 should-fix、1 个 nit**。RV2 的 staged-upgrade blocker 基本关闭；主要遗留在多 hub 候选构造、standby 离线写围栏和混合版本 fallback。

### Blocker

1. **1.1.11 standby 接收 1.1.10 legacy `node.list` 后会删除自身 hub 行，从而失去本机 fallback。**

   [mesh-runtime.ts:869](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:869)、[hub-replication.ts:50](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-replication.ts:50)、[hub-replication.ts:62](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-replication.ts:62)

   失败场景：B 为 1.1.11 standby，连接 1.1.10 active A。legacy 列表被合成为只有 A 的记录并 `replaceAll`，先删除 B；随后 `applyReplicatedNodeList()` 因 `!list.hubs` 提前返回，没有重新插入 own snapshot。B 的候选只剩 A；A 下线后，B 连自己的 in-memory fallback 都无法尝试。

   这是明确的 1.1.10/1.1.11 滚动升级破坏。own snapshot 必须在 legacy 列表路径也恢复。

2. **空/不完整 hub store 会让 standby 在 active 可达时先挂到自己，并永久停留。**

   [uplink-pool.ts:151](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:151)、[uplink-pool.ts:165](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:165)、[mesh-runtime.ts:981](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:981)、[mesh-runtime.ts:986](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:986)

   失败场景：新 standby 构造 HubRuntime 后，store 只有自身 standby 行；远端 active 仅来自 `TMEX_HUB_URL` seed。`mergeUplinkCandidates()` 固定把 stored self 放在 seed active 前，因此第一个候选是本机 in-memory。连接成功后 self 是 index 0，不会启动 preferred probe，即使 active 一直可达也不会切过去。

   实际求值结果就是 `self:standby, active:active`。候选合并后必须统一排序，不能让来源类别优先于 hub mode/epoch/priority。

3. **双角色 standby 在 `attachedHub() === null` 时仍可本地延长 key log。**

   [auth-routes.ts:474](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/auth-routes.ts:474)、[auth-routes.ts:688](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/auth-routes.ts:688)、[auth-routes.test.ts:1764](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/auth-routes.test.ts:1764)

   失败场景：B 已配置/持久化为 standby，但处在启动、切换或 uplink 暂时断开的 `attached === null` 窗口。浏览器向 B 提交合法 seq=N+1；`refuseIfAttachedNotWriter()` 直接放行，随后本地 DB 先写入。与此同时 active A 可接受另一条 N+1，仍会产生确定 fork。

   “未知 attachment”不能等同于“允许写”。双角色 hub 至少应根据自身 runtime mode、own nodeId 和已知 writer 继续 fencing；仅 standalone 才应保留离线本地写。

### Should-fix

4. **WebSocketLink 仍无法安全发送协议允许的最大单帧。**

   [websocket-link.ts:157](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/link/websocket-link.ts:157)、[types.ts:1](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/link/types.ts:1)、[codec.ts:62](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/link/codec.ts:62)、[runtime.ts:217](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/runtime.ts:217)

   `MAX_FRAME_PAYLOAD` 是 1 MiB，但编码后还有 10 字节 header，即 **1,048,586 bytes**。当前 guard 在 `buffered === 0` 时无条件发送单帧；慢 socket 需要缓冲该帧时仍会超过 gateway 的 1 MiB fatal limit 并断链。`MAX_LINK_UNACKED=32 MiB` 对此无帮助，因为问题发生在 WS 队列层。

   Bun 官方确认 server `send()` 的 `-1/0/positive` 语义以及默认 1 MiB backpressure limit；本 gateway 又显式启用了 `closeOnBackpressureLimit`。[Bun WebSocket 文档](https://bun.sh/docs/runtime/http/websockets)

5. **主 gateway 上仍有绕过任何背压处理的 server socket 写路径。**

   [forwarder.ts:373](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/forwarder.ts:373)、[mesh-routes.ts:301](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-routes.ts:301)、[mesh-routes.ts:458](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-routes.ts:458)

   `MESH_FORWARD_WS` 的 remote→browser pump 以及 `/mesh/ws` 广播直接调用 `ws.send()`，不检查 `-1/0`。慢浏览器遇到约 1 MiB 终端输出/转发积压时仍会被 Bun 关闭。普通 gateway session 有独立 `WebSocketSendGuard`，但这些 mesh socket 路径没有。

   peer server 的 `ws-secure` 已通过共享 WebSocketLink 获得 pacing，且它没有启用 fatal close，因此不是相同的立即断链问题；但其无 `bufferedAmount` fallback 只是 16 ms 启发式。

6. **构造期/运行期 fencing 的真实 mode 没有进入 node advertisement。**

   [mesh-runtime.ts:576](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:576)、[mesh-runtime.ts:853](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:853)、[uplink-server.ts:297](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:297)

   `hubRoleAdvertisement()` 始终读取静态 config。A 被高 epoch 自动 fencing 为 standby 后，后续 TLS/status refresh 仍广告 `mode:'active'`；上游会把 A 重新存为 active 并向节点传播错误候选状态。写入口本身仍由 `currentMode` 拒绝，因此主要是路由和可观测性错误，但 persisted fencing 没有端到端表达完整。

7. **RV3 要求的 `keyCertSign` 检查没有实现。**

   [uplink-pool.ts:124](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:124)

   当前只检查“恰好一个 PEM”和 `cert.ca === true`，没有验证 CA Key Usage。带 `basicConstraints CA:true`、但不允许签发证书的证书仍会被持久化并唤醒 failover，之后 TLS 验证继续失败。Node 将 `ca` 与 `keyUsage` 暴露为不同属性。[Node X509Certificate 文档](https://nodejs.org/api/crypto.html#class-x509certificate)

8. **诊断日志可泄露 URL userinfo。**

   [uplink-pool.ts:97](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:97)、[uplink-pool.ts:645](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:645)、[uplink-pool.ts:841](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:841)

   `canonicalHubUrl()` 会拒绝 credentials，但 `normalizeHubEndpointUrl()` catch 后保留原字符串；`https://user:secret@hub/` 随后被完整写入 try/failure/bootstrap 日志。应统一记录去掉 userinfo、query、fragment 的 origin/host。

9. **flapping 下新增日志仍可高频刷屏。**

   [uplink-pool.ts:645](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:645)、[uplink-pool.ts:570](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:570)、[uplink-pool.ts:985](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:985)

   只有“同 URL + 同错误”的 candidate-failed 行限流；每轮 `try` 和 `failover` 都不限流，错误字符串交替也会绕过限制。多个候选立即失败时，每个 backoff round 都会产生 O(N) 日志。测试运行本身已输出大量此类行。建议对整个候选状态转换限流，并仅在错误/候选状态变化时记录。

### Nit

10. **主动 pause 无 drain 的根因缺少直接回归测试。**

   [websocket-link.test.ts:194](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/link/websocket-link.test.ts:194)

   现有 fake 在缓冲清空时主动触发 drain，未覆盖 follow-up 修复的关键条件：“主动 pause 后永远没有 drain，只能依赖 `getBufferedAmount()` poll”。`1437377b` 也没有修改测试文件。

## 已确认正常

- 未授权普通节点的 hub advertisement 会在 ingest 前丢弃；不会参与 hub 端 `mesh_hubs`、writer 选择、fencing 或 `node.list.hubs[]`。
- `isWriter()` 已覆盖 hub enrollment/redeem/rename/revoke 和 ctl `key.log.append`。
- standby identical replay 使用解码出的准确 seq，并比较已有记录的完整 bytes+sig；比仅比较摘要更严格，chain-extending append 不落库。
- staged PUT/POST 的开放模式鉴权、同 controller 互斥、unique part、原子移入 txn、移入后流式哈希、pipeline 错误传播、分步超时、failedAt TTL 和 GC 保留目录均已落实。
- live `node.list` 后的 attached 元数据刷新、`syncProbe()`、switch token、pending relay/fork generation guard 基本正确。
- hub WebSocket adapter 的 pause/poll/drain 交互本身没有发现 double-resume 或 close 后 timer 泄漏：close 会清 timer，drain 会取消 poll，`pumping` 防止重入。
- 新旧 uplink wire 字段是加法字段，WebSocket pacing 不改变 wire format；除上述 legacy own-row 删除外，没有发现额外 1.1.10/1.1.11 编解码不兼容。

验证方面，四个不写文件的针对性套件为 **119 pass / 0 fail**。upgrade 套件需要创建临时目录，在本次只读沙箱中因 `EPERM` 无法运行；这些失败是环境权限所致，不是产品断言失败。