## Blocker

- `apps/gateway/src/mesh/mesh-http.ts:167` — 本地 `/ws` 不经过会话校验。`localUiGuard()` 只保护 `/api/*`，实际组装层也只对 `/api/` 调用它，因此未登录客户端仍可直接升级旧 Gateway WebSocket，并发送终端、文件等 Borsh 指令。修复：在 Gateway upgrade 前统一校验 `tmex_s_self`；缺失或无效时完成升级后以 `4401` 关闭，并把续期及撤销逻辑绑定到该 WebSocket 会话。

- `apps/gateway/src/mesh/forwarder.ts:148` — 远端 HTTP 流最终进入目标侧 `GatewayRuntime.dispatchHttp()`，而它不包含本 diff 新增的 `AuthRoutes`/`MeshRoutes`。因此 `/n/:T/api/auth/challenge`、`/login` 和 `/api/rtc/authorize` 在目标节点均返回 404，远端节点无法登录或授权直连。修复：目标侧使用组合分发链，先注入可信 WeakMap 上下文 `{via: peerNodeId, auth}`，再依次分发 mesh 路由和 Gateway API。

- `apps/gateway/src/mesh/auth-routes.ts:471` — passkey 的 `delegation_sig` 被当作 UTF-8 JSON 解析，但前端和共享类型明确发送 Borsh `PasskeyAssertion`。真实 passkey 登录必然落入异常并返回 `DELEGATION_BAD_SIGNATURE`。修复：使用共享的 Borsh 解码器（如 `decodePasskeyAssertionSig`）还原 `AuthenticationResponseJSON`，并补充一次真实 passkey 登录测试。

- `apps/gateway/src/mesh/mesh-routes.ts:218` — `/api/rtc/authorize` 只向 `ChallengeStore` 写入一条以 `challengeId` 为键的记录，却只向浏览器返回 nonce；代码库中没有按 nonce 消费记录、校验首帧或比较 `remoteFingerprint()` 的路径。与此同时 `handleMeshSocketMessage()` 在 `:117` 允许浏览器任意声明 `from:'node'`、`to` 和 `rtcSession`。失陷 hub 可改写信令建立中间人通道，授权记录不会阻止它。修复：建立专用、单次消费的 RTC 授权注册表，绑定 `nonce/uid/via/rtcSession/target/fp_browser/exp`；首个 `sess` 帧必须消费 nonce 并比较实际 DTLS 指纹，信令也必须按已登记会话路由。

## Major

- `apps/gateway/src/mesh/mesh-http.ts:108` — `/n/self/api/mesh/nodes` 和 `/n/self/api/mesh/rtc-config` 会绕过外层 `/api/*` 守卫：原始路径不以 `/api/` 开头，重写后又直接调用 `dispatchLocal()`。未登录请求可以读取节点名称、公钥、inventory，甚至 TURN 凭证。修复：对重写后的 Request 再执行认证守卫，并让这两个敏感 handler 自身使用 `requireSession()`，避免依赖调用顺序。

- `apps/gateway/src/mesh/auth-routes.ts:74` — 默认 passkey verifier 只按全局唯一的 credential ID 查钥，没有核对该 key 的 `userId` 是否等于 `delegation.uid`。当库中存在两个用户时，用户 B 可以让自己的 passkey 签署 `uid=A` 的 delegation，最终取得 A 的会话。修复：验签接口显式接收目标用户，并要求 `stored.userId === user.id === delegation.uid` 后才能验证 assertion。

- `apps/gateway/src/mesh/auth-routes.ts:273` — 登录响应同时把 opaque sid 放入 JSON body 和可被脚本读取的 `x-tmex-set-session`，远端转发器还会把该内部头继续透传。这使 `HttpOnly` 失去意义：同源 XSS 可导出 sid，随后经同一 entry 重放。修复：浏览器响应只返回非敏感状态和过期时间；entry 消费并删除 `x-tmex-set-session` 后再生成 `Set-Cookie`，不得把 sid 或内部头暴露给前端。

- `apps/gateway/src/mesh/mesh-http.ts:181` — 本地旧 Gateway API 的认证通过 `localUiGuard()` 完成，但 `authenticateRequest()` 返回的 `renewedExpiresAt` 被丢弃，后续 Gateway 响应无法附加续期头或刷新 cookie。远端普通 Gateway API 也存在相同断链，`forwarder.ts:252` 期待的续期头实际不会产生。持续活跃的用户仍会在初始 18 小时后因浏览器 cookie 到期而掉线。修复：让认证结果随下游响应传递并统一调用 `applySessionHeaders()`；远端流协议也必须传播续期结果，WS 入站消息需执行同样的节流续期。

- `apps/gateway/src/mesh/forwarder.ts:273` — 401 augmentation 会无上限执行 `upstream.text()`，同时保留原响应的 `Content-Length`、ETag 等表示元数据。失陷目标节点可返回无限 401 流耗尽 entry 内存；普通带 `Content-Length` 的 401 也会因改写后长度不符而截断或发送失败。修复：限制可解析错误体大小并取消剩余流量；改写 body 时删除或重新计算 `content-length/content-range/etag/content-disposition`。

- `apps/gateway/src/mesh/forwarder.ts:118` — `/n/self/*` 的重写只存入 WeakMap，mesh 内部未命中后返回 `null`；组装层随后把原始 `/n/self/api/...` Request 交给 Gateway，而不是重写后的 Request。因此 `/n/self/api/devices`、`/n/self/ws` 等设计规定的本地别名不可用。修复：将重写后的 Request 明确交给本地 Gateway dispatcher，或让组装层读取并使用 rewrite 结果。

- `apps/gateway/src/mesh/mesh-routes.ts:232` — `/mesh/ws` 缺少会话时返回 HTTP 401，浏览器 WebSocket API无法取得该状态，也收不到规范要求的 `4401`；已升级 socket 又只保存 `{kind}`，logout、会话过期或撤销后仍可继续收发信令。远端 WS 的过期 sid 同样通常被映射为普通 reset，而不是 `4401`。修复：把 sid、uid、via 绑定到 socket，认证失败以 `4401` 关闭，并在消息或续期节流点重新验票；撤销/logout 时主动关闭关联 socket。

- `apps/gateway/src/mesh/auth-routes.ts:590`、`apps/gateway/src/mesh/session-middleware.ts:120` — 外部 origin 和 HTTPS 判断直接取 Bun Request URL。文档中的 Cloudflare Tunnel 场景由 HTTPS 终止后以 HTTP 连接本机，结果是 `mode` 报告 passkey 不可用，且登录/续期 cookie 缺少 `Secure`。修复：从受信配置的公共 origin/协议解析这些属性；不要直接信任客户端可伪造的转发头。

- `apps/gateway/src/mesh/auth-routes.ts:116` — `mode:'none'` 分支在实际 standalone 组装中不可达，因为 standalone 不创建 `MeshHttpRuntime`；`GET /api/auth/mode` 会落入旧 Gateway 并返回 404，而不是设计要求的 `{mode:'none'}`。修复：在 standalone 组装层提供轻量 mode endpoint，或始终构造仅负责公共模式查询的 auth 路由，同时保持其他 standalone 路径完全旁路。

## Minor

- `apps/gateway/src/mesh/auth-routes.ts:169` — 未注入上下文时所有登录请求都使用固定 IP `"local"`；当前 HTTP 边界没有写入真实来源地址，因而不具备“每 IP”限速，一处来源的十次失败还会占满所有本地来源共享桶。修复：仅在可信 Bun/peer 接入边界读取并注入来源地址，转发登录则携带 entry 观察到的地址，禁止从普通请求头直接取值。

- `apps/gateway/src/mesh/auth-routes.ts:293` — 远端 logout 只返回 `Set-Cookie: tmex_s_self=...Max-Age=0`，该头会被 entry 丢弃，也没有可信内部清除指令，所以浏览器的 `tmex_s_<T>` 保留到自然过期；`/api/mesh/nodes` 又只按 cookie 是否存在计算 `loggedIn`，会长期显示已登录并反复触发 401。修复：通过受信 `x-tmex-set-session` 协议表达 `Max-Age=0`，由 entry 清除目标 cookie。

- `apps/gateway/src/mesh/mesh-http.ts:181` — `/healthz` 不在认证判断范围内，mesh 公网入口仍会公开运行环境、tmux 健康状态和 owner proof 元数据，而设计明确公开的只有登录流程和静态资源。修复：明确决定 health endpoint 的公开契约；若需探活，仅公开最小状态，其余字段要求 self session。

结论：该 diff 目前不应合入。核心登录边界既存在可直接绕过的本地 WebSocket，又无法完成远端或 passkey 登录；RTC 指纹绑定尚未真正生效，续期、logout 和响应改写也存在可复现的协议断裂。现有单测覆盖了各类的孤立 happy path，但没有覆盖实际组装后的路由链和跨节点流程。