## Blocker

- `apps/gateway/src/mesh/mesh-runtime.ts:318`：生产组装只构造了 `RtcPeerManager`，并接入指纹查询与 `CARRIER_SWITCH_ACK`；没有任何代码调用 `acceptBrowser()`、把返回的 `DataChannelCarrier` 绑定到对应 `GatewaySession`，也没有实例化或接入 `BulkTransferService`。因此 `/api/rtc/authorize` 可以返回 200，浏览器也可以发送 SDP，但目标 node 永远不会接受 `sess` 通道，`bulk:*` 通道同样无人处理，浏览器直连功能在生产环境完全不可用。更严重的是，当前授权记录只保存 `uid`，未绑定 `node-session sid`、`via` 和确切的 `GatewaySession`，后续即使简单补上 `attachDirect()` 也无法安全确定应该切换哪个会话。建议扩展授权输入以携带并保存 `sid/uid/via`，让 `acceptWsStream()` 注册 `sid → GatewaySession`；在目标 node 的 RTC 信令入口调用 `acceptBrowser()`，仅向完全匹配的会话执行 `attachDirect()`；同时用同一授权身份实例化并路由 `bulk:*` 到 `BulkTransferService`。

## Major

- `apps/gateway/src/mesh/peer-manager.ts:365`：node↔node DC 信令在没有现存 peer link 时直接通过 uplink 发送确定性的 `dc:<A>:<B>` 会话，但真实 hub 的 `UplinkServer.handleRtcSignal()` 只转发预先登记在 `rtcSessions` 中的会话；生产代码没有调用 `registerRtcSession()`。两台 `direct_capable=true`、仅能通过 hub 交换信令的 node 会让 SDP/Candidate 被 hub 静默丢弃，等待最多 15 秒后才降级，DC 路径实际无法建立。新增测试通过重写 `uplink.sendCtl` 直接互传，绕过了真实 hub 的信任决策，因此捕获不到该问题。建议为 node↔node 增加经证书及同用户校验的 RTC 会话登记协议，或让 hub 对规范化 `dc:A:B` 会话执行等价校验；集成测试必须经过真实 `HubRuntime/UplinkServer`。

- `apps/gateway/src/mesh/peer-manager.ts:393`：DC 结果无论是 offerer 还是 answerer，都以 `this.identity.nodeId` 作为 `initiatedBy`；随后 `track()` 在 `apps/gateway/src/mesh/peer-manager.ts:608` 只按发起者 nodeId 仲裁，完全没有 `dc > ws-secure > relay` 的载体优先级。比如 A `<` B，B 已持有由 A 发起的 relay，B 接受 A 发起的 DC 后却把它标成“由 B 发起”，于是 DC 会输给旧 relay 并被关闭；而 `getLink()` 又会直接复用已有低优先级链路，不主动升级。建议根据 `result.role` 设置真实发起者，并先按载体等级仲裁、仅在同等级时用 nodeId 打破同时拨号冲突；已有低等级链路还应允许无损升级到更高等级链路。

- `apps/gateway/src/mesh/mesh-runtime.ts:324`：载体切换控制帧通过 `sendEnvelope()` 发送，但其底层发送失败或背压只返回 `false`，这里既拿不到返回值又吞掉异常；`CarrierSwitchController` 随后仍立即把 node 出站切到 direct。旧载体正好背压时，浏览器收不到 `CARRIER_SWITCH`，继续使用旧载体，而 node 已向 direct 发送，形成永久分裂且等不到 ACK。建议让控制发送返回明确的发送状态；只有控制帧成功进入旧载体后才切换，背压时挂到 `onDrain` 重试，旧载体关闭时取消本次切换。

- `apps/gateway/src/mesh/peer-manager.ts:289`：新增的信任检查只拒绝“存在且已撤销”的证书，缺失 `node_certs` 的 node 仍会进入 DC、缓存 endpoint 和 relay 拨号。失陷 hub 可伪造 `node.list`，再注入对应 `dc:self:ghost` 信令，使 node 对任意内网 `ws://IP:port/peer` 发起连接；最终握手虽会因无证书失败，但该节点并未像设计要求那样被“忽略”，还产生了可利用的内网探测副作用。建议在 `getLink()`、`receiveRtcSignal()` 及 reach 枚举入口统一要求证书存在、属于当前用户且未撤销，在密钥日志追平并验证 admit 之前不要使用该节点的任何元数据。

- `packages/app/src/runtime/server.ts:33`：20 秒关停预算只覆盖 SIGINT/SIGTERM，重启回调仍直接等待 `assembled.stop()`；同时它与信号处理器不是同一个关停协调器。升级触发重启时，如果任一 mesh stop 挂起，进程会无限等待而不会触发预算；若期间又收到信号，则两条路径还会分别执行 `server.stop/process.exit`。此外 `assembleTmex.stop()` 任一步抛错都会跳过后续 hub/gateway 清理。建议建立唯一的 `shutdownPromise`，让重启和信号共用同一预算与退出路径，并在保持 peer→uplink→hub→gateway 顺序的同时确保前一步失败不会跳过后续清理。

- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:626`：所谓“node A 私钥无法获取 B 的 http/ws/relay”测试没有用 A 的节点身份建立攻击链路；HTTP/WS 请求只是缺少 cookie，并允许以 503 通过，而且 B 默认走测试 `linkFactory`，根本没有强制 relay。伪造登录又使用随机、格式无效的 delegation，可能在解析阶段就失败，没有证明“结构合法但由 node key 签名”的授权会在用户签名检查处被拒绝。建议让攻击者以 A 的真实节点证书完成 peer/relay 握手，再分别发送伪造 sid 的 HTTP/WS；登录部分构造完整合法 delegation 字节，仅把签名钥替换为 A 的 node key，并断言明确的鉴权错误。

- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:673`：测试没有发送伪造的 `node.list`，而是直接写 `peer_cache`；随后只断言 `getLink()` 最终 reject。该 reject 可以完全来自 `10.0.0.9:9` 不可达或 relay 不存在，未证明代码在证书信任决策处拒绝该节点，也未断言没有发生拨号。建议通过实际 uplink 注入含 ghost 的 `node.list`，提供一个可观测、可成功接受 TCP/WS 的 endpoint，并断言 peer 元数据未落库、拨号次数为零且错误原因为未 admit。

- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:525`：relay 密文测试没有断言 `captured` 非空，也没有检查标题所称的 Borsh magic；如果拦截点失效或写入绕过 monkey patch，空缓冲对三个 `includes()` 断言全部为真。建议先断言捕获了实际 relay 写入及合理字节数，再在每个捕获分片和跨分片窗口中查找真实 Borsh magic、HTTP OPEN 载荷和响应明文；最好同时解密测试端的同一密文，证明捕获内容确实对应本次请求。

## Minor

- `apps/gateway/src/mesh/mesh-runtime.ts:118`：endpoint 枚举仅依赖 `internal` 和地址中是否含 `%`，会广告现实中常见的 IPv4 link-local `169.254.0.0/16`，也可能广告不带 zone 文本但 `scopeid != 0` 的 `fe80::/10`；未指定地址和组播地址同样未排除。这些地址经 hub 下发后会在可用地址之前产生逐个连接超时。建议按 IP 地址范围明确排除 loopback、unspecified、multicast、IPv4/IPv6 link-local，并保留当前正确的 IPv6 方括号格式；补充 `169.254.x.x` 和无 `%` 的 `fe80::` 测试。

- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:574`：`waitUntil(() => true, 50)` 会立即成功，后面的固定 `Bun.sleep(30)` 无法保证 B 已创建目标 `Request` 并安装 abort listener。机器负载较高时 abort 可能先发生，测试随后因 `abortHook` 未触发而偶发失败。建议由 B 的 `dispatchHttp` 暴露一个 promise/latch，在确认 `/api/upload` 已进入且监听器已安装后再调用 `ac.abort()`。

## 结论

该 diff 保持了 standalone 不构造 mesh、IPv6 URL 加方括号以及 ACK 按来源 `GatewaySession` 分派等关键性质，但生产 WebRTC 的核心接线仍不完整，真实 hub 下的 node DC 信令也不可达，载体仲裁和信任入口还存在实质缺陷；新增的安全集成测试中多项可空跑或在错误层级提前失败。当前不建议合入生产。