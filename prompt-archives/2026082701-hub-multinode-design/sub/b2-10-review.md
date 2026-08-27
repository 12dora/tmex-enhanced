## Blocker

- `apps/gateway/src/mesh/mesh-runtime.ts:115`：`connectionId` 可由调用方指定，发生重复时仅执行 `drop(prev)`，没有关闭被替换的 `GatewaySession`、PeerConnection 或 bulk 通道。远程 entry 在重连时复用同一 ID，旧会话会从所有索引消失；随后登出或撤销只会关闭新会话，旧会话仍留在 `WebSocketServer` 中并可继续接收终端广播。应为每条实际 WS 生成高熵且不可复用的服务端 ID；重复注册必须拒绝，或在替换前完整执行旧绑定的 teardown。索引也应至少按 `sid + via + connectionId` 作用域组织，避免跨会话碰撞。

## Major

- `apps/gateway/src/mesh/stream-targets.ts:505`：新增的 `connectionId` 参数没有贯穿真实远程 WS 转发路径；生产调用 `Forwarder.handleRemoteWs()` 仍只执行 `openWsStream(link, auth)`。因此目标端生成随机 `session.id` 后，同一 sid 有两个标签页时 `/api/mesh/connection` 永远返回 409，浏览器没有办法知道各自对应的 ID，无法实现“两个标签分别绑定自己的会话”。当前集成测试直接调用 `openWsStream(..., 'tab-a')` 绕过了这个缺口。应通过浏览器可携带的 WS 查询参数、子协议或 HELLO 响应传递每连接随机 ID，并让 `Forwarder` 转交给 `openWsStream`；测试应经过真实转发入口。

- `apps/gateway/src/mesh/mesh-runtime.ts:923`：RTC 握手完成后只核对 registry 中缓存的 `sid/uid/via`，没有再次调用 `verifyBoundSession()`。若 `/api/rtc/authorize` 在硬期限前通过，但握手在期限后才完成，已经失效的会话仍会挂载 direct carrier，并开始通过它发送出站数据。此外，`apps/gateway/src/mesh/rtc/carrier-switch.ts:140` 会在 ACK 前直接缓存入站帧，缓存阶段同样不会触发 `deliverInbound` 中的验票和 teardown。应在 attach 前重新验票，并在 direct 帧进入屏障缓冲区前执行独立的验证回调；失败时立即关闭整个会话、PC 和 bulk。

- `apps/gateway/src/mesh/rtc/bulk.ts:283`：验票仅发生在浏览器发来的控制帧或上传数据帧上。下载收到一次合法 `{op:'get'}` 后，`pumpDownload()` 和 `sendFrame()` 可以持续发送数据而不再验证 session。若请求发生在 `hard_expires_at` 前一刻，大文件仍可在硬期限后继续下载。应在每个下载数据帧及 EOF 发送前调用绑定的验证函数，失败时取消 reader 并走完整 teardown。

- `apps/gateway/src/mesh/rtc/signaling.ts:103`：`shouldCacheLocal` 只在没有 listener、准备写入 inbox 时执行；一旦 `acceptBrowser()` 注册了 listener，来自错误 node、错误 `to` 或已过期授权的同 `rtcSession` 信令会直接交给 PeerConnection。失陷 hub 或获知该 session 的错误 peer 可以在握手期间注入 SDP/candidate，至少稳定破坏直连。应在查找 listener 之前统一执行授权、目标和来源校验，校验成功后才能投递或缓存。

- `apps/gateway/src/mesh/peer-manager.ts:450`：node↔node RTC 的 `rtcListeners` 仍没有注销路径。每次 DC 尝试都会把闭包加入集合；常见的 ICE 失败后回退 relay、随后再次升级会不断保留已关闭 PeerConnection 的回调。长期运行后，每条信令都会遍历所有历史回调，并让这些 PC 无法被回收。应让 `RtcSignaling.onMessage()` 返回 unsubscribe，并在连接失败、超时、PC 关闭及 manager stop 的 `finally` 中调用，同时清理对应 inbox。

## Minor

- `apps/gateway/src/mesh/integration/direct-path.integration.test.ts:418`：正确 owner 的 bulk 分支没有发送数据和 `{op:'done'}`；因为成功的 `{op:'put'}` 本来不会回复，测试又在第 420 行人工注入第二个 `put`，实际得到的是 `protocol` 错误，却仅断言“不包含 permission_denied”，因此错误实现也会通过。测试同时没有覆盖要求中的过期及错误 via 无法 attach。应完成真实上传并断言 `{ok:true}`，另增加过期、via 不匹配以及 connectionId 重用后的旧会话已关闭断言。

## 结论

该 diff 已基本修正 control-send 的 queued/blocked 语义、pending switch 的关闭取消、链路升级顺序、retiring link 的 revoke/stop 关闭以及 hub 对 `dc:*` 的 `from:'browser'` 拒绝；但 connectionId 重用仍可制造无法撤销的孤儿会话，直连 attach、屏障缓冲和 bulk 下载也仍存在 session 生命周期缺口，RTC listener 清理亦未闭环。当前仍有会话撤销后继续接收数据的风险，不建议合入。