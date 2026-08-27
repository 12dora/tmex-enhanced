## blocker

- `apps/gateway/src/mesh/uplink-client.ts:304`：`auth.challenge` 在任意连接状态下都可重复触发，并且会签名任意长度的解码结果，而不是仅接受一次 32 字节 nonce。这把 node 身份私钥暴露成了跨协议签名 oracle：失陷 hub 可以构造完整的 peer transcript，将其作为 `auth.challenge.nonce` 发给真实 node，取得签名后冒充该 node 完成 peer 握手。建议仅在 `authenticating` 状态接受一次 challenge，强制解码结果恰好为 32 字节；最好为 uplink 签名增加独立的 Borsh domain，并同步修改 hub 验签。

- `apps/gateway/src/mesh/peer-manager.ts:235`（另见 `apps/gateway/src/mesh/peer-protocol.ts:214`）：所谓直连把整个 `LinkSession` 直接跑在明文 `ws://` 上，却以 `path:'dc'` 签 transcript，并把 DTLS 指纹固定为 `null`。这既没有 `DataChannelLink`，也没有实际指纹绑定，还完全缺少“hub 信令 + ICE”第二级回退；同一局域网内的被动监听者可以直接读取 HTTP auth、终端输入输出和文件内容。建议 peer WebSocket 仅承载签名信令，建立真实 WebRTC DataChannel 后读取本地 SDP 与 `remoteFingerprint()`，将双方规范化指纹纳入 transcript，再用 `DataChannelLink` 承载业务流；顺序应为缓存地址信令 → hub 信令/ICE → 加密 relay。

- `apps/gateway/src/mesh/stream-targets.ts:221`（另见 `:300`）：entry 侧没有实现任何请求头过滤或响应头安全策略，直接发送调用方提供的全部请求头，并把目标返回的全部响应头原样构造成 `Response`。实际代理浏览器请求时会把 `cookie`、`authorization`、`host`、`x-forwarded-*` 等泄露给目标；失陷目标还能返回 `text/html`、`image/svg+xml` 或 `Set-Cookie`，在 entry origin 下执行脚本或覆盖 entry cookie。建议在编码 OPEN 前强制过滤规定的请求头，在构造响应前执行响应头 allowlist、Content-Type allowlist、CSP sandbox、`nosniff` 和 attachment 降级；登录所需 cookie 应走专用、受验证的转换逻辑，不能透传任意 `Set-Cookie`。

- `apps/gateway/src/mesh/stream-targets.ts:150`（另见 `apps/gateway/src/mesh/types.ts:60`、`apps/gateway/src/runtime.ts:149`）：传输层知道可信的 `peerNodeId`，但 `DispatchHttp` 只收到 `{uid}`，而 challenge/login 免鉴权时甚至只收到空 uid；`GatewayRuntime.dispatchHttp` 又完全忽略该上下文。因此 `/api/auth/challenge|login` 的处理器无法把登记和会话绑定到实际链路对端，只能缺失该校验或信任可伪造的请求字段。建议把可信的 `{viaNodeId, uid?, renewedExpiresAt?}` 作为内部路由上下文贯穿 `acceptHttpStream → dispatchHttp → ApiRouteContext`，登录处理器必须只使用该 `viaNodeId`，不能从 OPEN、header 或 body 获取。

## major

- `apps/gateway/src/mesh/stream-targets.ts:76`：目标侧后台任务持续读取整个 LinkStream，并把数据累积进无上限的 `bodyChunks`；读取本身又会返回 WINDOW credit，完全绕过 `Request.body` 消费速度。大文件上传到一个缓慢读取请求体的 handler 时，目标会把整个上传缓存在内存中，最终 OOM。建议让 `Request.body` 的 `pull()` 直接读取一个 LinkStream chunk，只有下游消费时才归还窗口；不要使用独立的贪婪读取循环和无界数组。

- `apps/gateway/src/mesh/stream-targets.ts:181`（另见 `:235`）：HTTP 的 RST/取消映射不完整且存在顺序竞态。目标先调用未等待的 `stream.end()`，随后立即 `reset()`；由于 `end()` 只是排入 write chain，RST 可以先终止流并清掉尚未被 entry 消费的响应体。反方向上，peer RST 的回调为空，不会取消 entry 的请求体 reader；entry 取消响应时也没有显式取消目标的 `response.body` reader。典型场景是无限上传遇到立即返回的 413：响应可能被截断，而上传源或 rsync 响应生产者继续挂起。建议为两端建立统一 abort controller，peer RST 时 `cancel()` 对应 reader；等待响应 DATA/END 的确定完成，并为“响应已完成、仅停止请求方向”提供不会清除完整响应的明确协议状态。

- `apps/gateway/src/mesh/stream-targets.ts:345`：WS session 只在 OPEN 时验证一次 sid，之后每条 Borsh 消息都直接交给 `GatewaySession`。会话在连接期间过期、达到 7 天硬上限、因根轮换/凭证删除被撤销时，已打开的 WS 仍能无限期控制 tmux；同时也不会按每条入站消息续期。建议把 sid、via 和 uid 绑定到 stream session，在每个完整 Borsh 入站帧分发前调用 `NodeSessionStore.verify()`，失败立即 RST/关闭，成功则执行节流续期。

- `apps/gateway/src/mesh/stream-targets.ts:350`（另见 `:388`）：WS 的正常关闭没有双向传播。entry 调用 `close()` 只发送半关闭 END；目标读到 EOF 后只执行 `attached.onClose()`，没有结束自己的发送方向，因此 `stream.closed` 永远不完成，PeerManager 的活动流计数也不会归零。RST 时 `onAbort` 和 `finally` 还会重复调用 `onClose()`。建议使用幂等的 session teardown：收到任一正常 END 后完成本地 GatewaySession 清理并发送对应 END；RST 只执行一次双向终止，并确保双方 readable/closed 都能结束。

- `apps/gateway/src/mesh/stream-targets.ts:22`：`NodeSessionStore.verify()` 返回的 `renewedExpiresAt` 被 `verifyAuth()` 丢弃，所有远程 REST 响应都无法携带 `x-tmex-session-renewed`。持续活跃的用户虽然服务器端 sid 已滑动续期，entry cookie 仍会在最初 18 小时后消失并强制重新登录。建议保留完整验证结果，并在成功响应上注入续期头，由 entry 据此刷新目标节点 cookie 的 `Max-Age`。

- `apps/gateway/src/mesh/uplink-client.ts:275`（另见 `:65`）：WebSocket 打开和认证均没有超时。hub 接受 TCP/WebSocket 后不发送 challenge，或发送 challenge 后不发送 `auth.ok`，会让唯一的 `runLoop` 永久停在 `authenticate()`，既不进入心跳也不重连；stop 时等待打开的 socket也没有被主动关闭。建议给 connect 与 auth 分别设置有限超时，超时/abort 时关闭当前 socket/link并清理所有监听器，然后进入统一退避路径。

- `apps/gateway/src/mesh/uplink-client.ts:220`：`waitUntilClosed()` 正常返回后，循环直接开始下一次连接，没有 `tearDownLink()`、没有停止旧 heartbeat，也没有任何 backoff；`attempt` 还在认证成功后被重置为零。网络反复建立后立即断开时会无间隔重连，旧 heartbeat 至少持续到下一次认证成功；若下一次认证挂住则长期泄漏。建议把任何非主动 stop 的 link closure 都转成同一失败状态：立即清理 link/heartbeat、设置 offline，然后按 1–60 秒指数退避重连。

- `apps/gateway/src/mesh/uplink-client.ts:327`（另见 `:344`）：key-log catch-up 没有串行状态机。多个 `node.list`、`key.log.res` handler 都以 `void` 并发执行；当本地 seq 与公告 seq 相等时也完全不比较 head hash。连续两次 node.list 可能从同一旧 head 发出重复请求并并发应用，导致后一个批次因 seq 不连续失败且结果被忽略；同 seq、不同 hash 的分叉则不会触发设计要求的硬失败。建议为每个 user 建立串行 catch-up 队列，记录目标 `{seq,hash}`，严格按 seq 应用、检查 `applyMany` 结果，并在达到目标后比较 hash；完成 catch-up 前不要向上层发布依赖新证书的 node.list。

- `apps/gateway/src/mesh/peer-manager.ts:287`：连接替换缺少确定性仲裁和 generation 保护。双方同时拨号时，一个入站连接可能在出站 `dialDirect()` 返回前替换并关闭它，导致 `getLink()` 返回已关闭 session；旧连接中尚未关闭的 stream 随后执行 `armIdle(live)`，还会为已经不在 `live` Map 的对象创建永不自清理的 interval。类似地，`stop()` 不取消 `pending` dial，握手完成后仍可重新 `track()` 并复活定时器。建议按 nodeId/transport 定义唯一胜者，引入 manager generation/AbortController；`track()` 前检查未停止且 generation 当前，stream close 回调仅在该 live 仍为当前项时才能重新布置 idle timer。

- `apps/gateway/src/mesh/peer-manager.ts:342`：未知 OPEN 类型没有被 RST，函数直接返回，但该流已被计入 `live.streams`。任一已认证 node 即使没有用户 session，也能不断打开随机 payload 的流且不 END，使 LinkMux stream Map 和 PeerManager 计数无限增长，并永久阻止 idle close。建议对 `unknown` 以及当前链路不允许的 `relay` 类型立即 `stream.reset('unknown-stream-type')`，并考虑链路级并发流上限。

- `apps/gateway/src/mesh/link-stream-carrier.ts:48`：`close()` 先把 `closed` 设为 true，而 pump 的循环条件是 `!closed`，因此队列中所有已经由 `send()` 返回 `sent/backpressure` 的帧都会被静默丢弃，只发送 END。服务端发送最后一批 Borsh 帧后正常关闭时，客户端可能只看到 EOF。建议区分 `closing` 与 `closed`：拒绝新 send，但继续排空已接受队列，全部 `stream.write()` 完成后再 `await stream.end()`；`terminate()` 才应立即清空并 RST。

- `apps/gateway/src/mesh/peer-server.ts:72`：默认先绑定 `::`，但只要首次绑定失败且尚无 server，catch 就立即抛错，不会尝试后续的 `0.0.0.0`。在禁用 IPv6的主机或 IPv4-only 容器中，peer server 因此完全无法启动，尽管 IPv4 可用。建议对每个 host 独立记录错误并继续尝试，循环结束后仅在一个成功绑定都没有时抛出聚合错误。

## minor

- `apps/gateway/src/mesh/peer-server.ts:31`：限速表只会在同一 IP 再次请求时过滤旧时间戳，从不删除不再出现的 key；同时普通 HTTP `GET /peer` 也会在验证 WebSocket upgrade 前消耗握手额度。公网 peer 端口遭遇持续的唯一 IPv6 地址扫描时，`hits` 会随进程寿命无限增长；同一地址的十次非 upgrade 请求也会阻断其合法握手一分钟。建议先校验合法 WebSocket upgrade，再计数，并周期性清理过期且为空的 IP 项或使用有界 TTL cache。

- `apps/gateway/src/mesh/ctl.ts:59`：`sleep()` 在定时器正常触发后没有移除注册在长期存活 stop signal 上的 abort listener。hub 长期离线时，每次退避都会遗留一个 listener，最终在 stop 时集中触发且持续占用内存。建议使用具名 abort handler，并在 resolve 与 reject 两条路径统一清除 timer 和 listener。

总体结论：该 diff 已覆盖部分证书查找、撤销拒绝、双方 hello transcript 和 relay 每连接双向密钥派生，但直连数据面、HTTP 同源安全边界、认证上下文与长连接生命周期仍存在可直接触发的安全缺口，且 uplink、流终止和连接替换状态机有多处资源泄漏或竞态；当前实现不应合并或进入可联网环境。