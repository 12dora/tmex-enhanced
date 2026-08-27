## Blocker

- `apps/gateway/src/mesh/mesh-runtime.ts:473`：直连入站帧直接交给 `gateway.wsServer.handleMessage()`，没有重新校验注册记录中的 `sid/via`；`bulk` 在 `apps/gateway/src/mesh/mesh-runtime.ts:761` 也只保留 `uid`。远程 entry 建立直连后，只要让 primary `LinkStream` 保持空闲，即使 node-session 已过期、登出或因根轮换被撤销，直连 Borsh 帧和 bulk 操作仍可继续访问目标 node，绕过 18 小时滑动期限及 7 天硬上限。建议按 `GatewaySession` 反查完整授权，在每个直连入站帧上执行与 WS 相同的 `sid + via` 验证／续期；撤销或过期时关闭整个会话及 PeerConnection，并让 bulk 通道共享该会话生命周期。

## Major

- `apps/gateway/src/mesh/mesh-runtime.ts:95`：`SessionRegistry` 以 node-session `sid` 唯一索引 `GatewaySession`，但同一 cookie 可以被多个标签页或重连后的多个 WS 复用。后注册的连接会覆盖旧连接；随后任一标签页的 RTC 授权都可能把 direct carrier 挂到另一个标签页的会话，后者关闭后还会让仍存活的旧连接彻底失去映射。建议为每条 gateway WS 生成独立连接标识，并把它同时绑定到 WS、`/api/rtc/authorize` 和 `rtcSession`；registry 应按该标识精确查找，而不是假设 `sid` 唯一对应一条 WS。

- `apps/gateway/src/mesh/mesh-runtime.ts:760`：新接线调用 `attachDirect()` 时没有传递 `rtcSession`，目标版本的 `CarrierSwitchController` 因而始终发送 `rtcSession: ''`；同时 `apps/gateway/src/ws/index.ts:457` 解码 ACK 后也丢弃了 ACK 中的 `rtcSession`。第一次直连断开并在同一 primary 会话上重试时，浏览器屏障已进入第二次 attach，会拒绝空 `rtcSession` 的切换帧，而 node 已把出站切到 direct，造成载体分裂并反复重试失败。建议把 `rtcSession` 纳入 `AcceptBrowserResult`，贯穿 `attachDirect`、direct/primary 切换帧及 ACK，并同时校验 epoch 和 `rtcSession`。

- `apps/gateway/src/ws/index.ts:548`：`sendControl()` 混淆了“本帧已入队但产生背压”和“因已有背压而尚未发送”。`LinkStreamCarrier.send()` 会先入队再返回 `backpressure`，当前控制器却在 drain 后重发相同切换帧；若 carrier 原本已处于 guard 背压状态，`canSend()` 还会把本次探测标记成 skipped frame，使 guard 在 drain 时直接 terminate old carrier。新增测试 `apps/gateway/src/mesh/rtc/carrier-switch.test.ts:147` 的假 carrier 在返回 `backpressure` 时故意不记录首帧，因此没有覆盖生产语义。建议区分 `queued-backpressure` 与 `blocked`：已入队时只等待 drain 后切换、不得重发；尚未入队时 drain 后发送一次，并通过真实 `WebSocketSendGuard` 和 `LinkStreamCarrier` 测试。

- `apps/gateway/src/mesh/rtc/carrier-switch.ts:199`：所谓“旧载体关闭时取消”只等待 `onDrain`，没有订阅 primary close；新增测试在设置 `session.closed` 后又人工触发 drain，不能代表真实的 WS close/RST。实际旧载体关闭且永不再 drain 时，等待 Promise 不会结束，控制器状态也不会执行取消路径。建议给会话或 primary carrier 提供 close/abort 通知，与 drain 竞速；close 时解析等待、清理状态并显式关闭未采用的 direct carrier，测试应只触发 close、不得额外触发 drain。

- `apps/gateway/src/mesh/peer-manager.ts:421`：升级逻辑只尝试 DC，没有真正实现 `ws-secure > relay`。RTC 不可用时 `wantsUpgrade()` 对现有 relay 返回 false；RTC 可用但 DC 建链失败时，`dial()` 又在 `apps/gateway/src/mesh/peer-manager.ts:513` 立即返回旧 relay，不再尝试已经可达的 WS endpoint。例如两台机器先经 relay 建链，随后进入同一 LAN，但 node-datachannel 不可用或 ICE 失败，后续所有 `getLink()` 仍永久使用 relay。建议按当前载体等级只尝试更高等级路径：relay 依次尝试 DC、ws-secure，ws-secure 只尝试 DC；单个高等级候选失败不能提前返回旧链路。

- `apps/gateway/src/mesh/peer-manager.ts:1013`：升级时有流的旧链路被从唯一的 `live` map 删除后，没有放入任何 retired 集合。`onRevoked()`、`stop()` 和后续关闭逻辑因此找不到它。若 relay 上有长连接 WS/流式 HTTP，升级到 DC 后再撤销该 peer，当前 DC 会关闭，但旧 relay 及已有流仍可继续传输；关停也会在它仍存活时返回。建议显式跟踪 retiring links：正常升级时允许已有流自然结束，但 revoke、证书失效和 stop 必须强制关闭同一 peer 的所有 active/retiring 链路。新增的 `apps/gateway/src/mesh/peer-manager.test.ts:640` 实际没有打开任何流，也未断言旧链路保持可用，不能验证标题所称的“不丢流”。

- `apps/gateway/src/hub/uplink-server.ts:575`：确定性 `dc:A:B` 分支仍接受 `from:'browser'`，而 `apps/gateway/src/mesh/rtc/signaling.ts:88` 会把没有 owner、没有授权记录的本地信令无限缓存。一个已 admit 但失陷的 node 可以持续向另一 node 发送 `from:'browser'` 的 `dc:A:B` 信令，使目标的 `localInbox` 无界增长；普通 peer ctl 还可用不同 `rtcSession` 扩大 map。与此同时，`acceptingBrowser` 仅在失败时删除，成功会话的 owner/listener 也从未注销，正常网络重试同样持续泄漏。建议 hub 对 `dc:*` 只允许规范化的 `from:'node'`；目标仅在信号来源等于授权 `via`、目标为 self 且授权存在时才缓存，并设置严格上限；成功、失败、超时和关闭都应在 `finally` 中清理 `acceptingBrowser`、owner、listener 和 inbox。

- `apps/gateway/src/mesh/integration/direct-path.integration.test.ts:180`：直连集成测试手工构造并注册 `GatewaySession`，所有 `sid/uid/via` 都预先匹配，没有经过真实 `/ws` upgrade 或 `acceptWsStream()`，因此即使生产注册接错、错误会话被覆盖或撤销后仍可 attach，测试仍会通过。bulk 部分在 `apps/gateway/src/mesh/integration/direct-path.integration.test.ts:280` 使用不存在的 transfer，并允许 `not_found`，该分支在检查 owner uid 前就返回，传入任意 uid 都能通过。建议用真实 WS 路由创建至少两条共享 sid 的会话，分别验证错误连接标识、uid、via、过期和撤销均不能 attach；bulk 应预建属于指定 uid 的真实 transfer，并断言正确 uid 成功、错误 uid 明确返回 forbidden。

## Minor

- `apps/gateway/src/mesh/integration/mesh.integration.test.ts:566`：测试要求 AES-GCM 密文中完全不存在两字节序列 `0x54 0x58`。随机密文合法出现该序列的概率随载荷长度快速上升，较大响应或重复运行会产生随机失败；后面的成功解密已经足以证明捕获内容对应本次请求。建议不要对两字节随机子串做否定断言，改为检查较长的完整明文标记不存在，并保留解密后验证 OPEN/path/响应内容的正向断言。

## 结论

该 diff 已补上 hub 对 DC 两端证书归属／撤销的基础校验、endpoint 过滤和统一关停协调器，但直连仍可绕过 node-session 生命周期，无法精确绑定具体 GatewaySession，重连切换与生产背压路径不正确，链路升级和 retiring 链路撤销也不完整；新增测试又未覆盖这些关键信任决策。当前存在可延长未授权访问和载体分裂的高风险问题，不建议合入。