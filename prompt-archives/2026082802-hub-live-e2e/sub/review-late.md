# 审查结论

未发现 blocker。发现 3 个 should-fix；其余重点区域为 no findings。未修改任何文件。

## Link 状态机

**no findings。**

`live`、`retiring`、`pending`、`upgrading` 的清理和竞态处理未发现新增泄漏或 double-close：

- `transportOf()` 只读取已安装的 `live`，不会把握手中的 DC 报成已连接。
- DC 关闭后仅提升仍在 `retiring` 集合中的 fallback。
- upgrade 完成、吊销和 stop 路径最终都能清理相应 map。
- retiring 链路允许刚从 `getLink()` 返回的调用继续 `openStream()`，属于该提交刻意支持的竞争窗口；活动流结束后仍会完成 retire。

## Re-join 证书复用

### Should-fix：远端 entry 的本地证书投影落后时仍会执行重复 admit

位置：[hub-runtime.ts:602](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:602)、[enroll.ts:351](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/enroll.ts:351)

Hub 已确认节点 `alreadyAdmitted` 时，`enroll.redeemed` 仍只发送新 enrollment 签出的、尚未 admit 的证书，也不携带 `already_admitted`。发起 enroll 的 CLI 仅查询自己的本地 `node_certs` 决定是否跳过 admit。

失败场景：普通 entry 的 key-log/cache 尚未同步到目标节点的旧 admission，但 Hub 已有该证书。目标重新 join 后，Hub 正确复用旧证书；entry 因本地查不到旧证书，仍签出第二条 `admit-node`，最终收到 `node_id_reused` 或序列冲突，合法 re-join 失败。应让 Hub 的 poll/event 明确返回 `already_admitted` 和原 admitted cert，不能由 entry 的本地缓存推断。

### Should-fix：复用校验只绑定 Ed25519，没有绑定证书中的 X25519 公钥

位置：[hub-runtime.ts:535](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/hub-runtime.ts:535)、[hub.ts:409](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/commands/hub.ts:409)

Hub 的 PoP 和 CLI 的 `assertJoinCertReusable()` 都只比较 Ed25519 公钥。若 nodeId 与 Ed25519 私钥保留，但 X25519 密钥被重建或轮换，Hub 会接受新请求并返回包含旧 X25519 公钥的 admitted cert；CLI 随后把旧证书与当前 X25519 私钥/公钥一起保存，形成互相矛盾的身份状态。

当前 peer/DC 鉴权实际使用 Ed25519 和临时 X25519，因此这不是现有跨节点越权；但返回证书并没有完整绑定 redeemer 当前提交的密钥材料。应同时比较 admitted cert 的 `x25519_pk` 与当前 identity。

跨节点冒领方面：**no findings。** Enrollment token 持有人能在 redeem 响应中看到其他节点的公开证书，但不能把它作为自己的证书使用；既有 nodeId 路径要求对精确 cert bytes 做现有 Ed25519 私钥 PoP，客户端还会按 nodeId 选择证书并复核 Ed25519 公钥，完整响应也会对照已验证 key-log projection。

## Hub auth-reject 日志

### Should-fix：限流键和日志内容均由未认证客户端控制

位置：[uplink-protocol.ts:229](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-protocol.ts:229)、[uplink-server.ts:815](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:815)

`auth.response.node_id` 只要求非空字符串，随后原样进入日志和 `${nodeId}|${reason}` 限流键。

失败场景：未认证客户端不断使用不同 nodeId 建立连接，可以绕过每键 10 秒限制持续写 warning；nodeId 还可包含换行符，伪造额外日志行。LRU 只限制内存，不限制新键的日志速率。应先严格校验 32 位十六进制 nodeId、转义日志字段，并增加不依赖攻击者标识的全局/IP 级限流。

## DataChannel 控制帧抢占

**no findings。**

- WINDOW 与同 stream 的本端 DATA 分属双向独立流控；抢占不会改变同方向 DATA 顺序。
- END 通过每流 `writeChain` 排在该流既有 DATA 完整发送之后。
- RST 的抢占符合立即取消语义。
- ping/pong 使用两个布尔 pending 位合并，队列大小有界；flush retry 也只有一个 timer。
- 分片 deadline 在每个新片到达时刷新，未发现 timer 泄漏。

## Mux receive-window overflow

**no findings。**

溢出调用 `resetStream()`，只终止违规 stream；RST payload 包含 `stream <id> exceeded receive window`，对端 `handleRst()` 会把该文本写入 `stream.closed.message`，因此对端能够得知原因，其他 stream 和 link 保持存活。

## 验证

- DataChannel、mux、uplink-server 定向测试：74 pass，0 fail。
- 本次新增的 PeerManager 状态机定向测试：8 pass，0 fail。
- 扩大运行时有 6 项因只读沙箱禁止 `Bun.serve()` 绑定端口而失败，不属于代码断言失败。