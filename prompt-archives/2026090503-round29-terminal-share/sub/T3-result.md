# T3 结果：mesh / 路由装配的分享凭证打通

范围：`apps/gateway/src/mesh/**`、`packages/app/src/runtime/assemble-routes.ts`（+ 新拆的 `assemble-websocket.ts`）、`apps/gateway/src/tunnel/access-paths.ts`（结论：不改）、`apps/gateway/src/api/domain-access-routes.ts`（结论：不改）。另有一处 `apps/gateway/src/runtime.ts` 的最小改动（见「越界改动」）。

## 一、对外约定（供指挥官与 T1/T2 交叉核对）

以下常量全部来自 T1 的 `apps/gateway/src/share/share-token.ts`（叶子模块，无循环依赖），mesh 侧只 re-export，不重复定义：

| 项 | 值 | 谁产生 | 谁消费 |
|---|---|---|---|
| cookie 名 | `tmex_sh_<via>`（`shareCookieName`）；via = `self` 或节点 id | 本机 `session-middleware`、Hub `forwarder-auth-policy` | 浏览器 → `mesh-http.guardGatewayWebSocket`（self）/ `Forwarder.handleRemoteWs`（Hub）；节点侧 T1 的 `readShareCookieToken` |
| cookie 属性 | `Path=/; HttpOnly; SameSite=Lax; Max-Age=<n>`，https 时加 `Secure`（复用 `buildSetCookie`/`buildClearCookie`） | 同上 | — |
| 内部响应头 | `x-tmex-set-share: <token>` + `x-tmex-set-share-max-age: <秒>`；`x-tmex-clear-share: 1` | T1 的 `/api/share-access/*` 路由 | 本机 `consumeSetSessionForBrowser`、Hub `applyAuthPolicy`；两处翻完即 `headers.delete`，`copyUpstreamHeaders` 也把这三个头列入内部凭证头白名单外，不会漏给浏览器 |
| 流 auth 值 | `share:<token>`（`SHARE_AUTH_PREFIX`） | `Forwarder.forwardHttp` / `handleRemoteWs` | 节点侧 `stream-auth.verifyStreamAuth` |
| 公开路径 | `/api/share-access`（裸）与 `/api/share-access/` 前缀全部子路径（`isShareAccessPath`） | `auth-public-paths.ts` | `isAuthPublicPath`（localUiGuard）、`isAuthSkippedPath`（节点侧流入口）、forwarder 的凭证选择与 401 改写豁免 |
| ws socket kind | `MESH_SHARE_WS_KIND = 'gateway-share-ws'`，`data = { kind, scope, accessId, shareToken, shareVerifiedAt, via, cid? }` | `mesh-http.guardGatewayWebSocket` | `assemble-websocket.routeWebsocket` → `gw.open(ws, { shareScope })` |
| 关闭码 | 4401 `SHARE_LOGIN_REQUIRED`（带 cookie 但无效）/ 4401 `NODE_LOGIN_REQUIRED`（无任何 cookie）/ 4410 `SHARE_ENDED` | `mesh-http`、`stream-auth` | 浏览器 |
| 复验周期 | `SHARE_WS_VERIFY_MS = 60_000`（本机 `touchSocket`、节点侧逐帧节流复验） | `mesh-deps.ts` | — |

分享凭证校验入口统一在 `apps/gateway/src/mesh/share-credential.ts` 的 `verifyShareAccessToken(token, now?)`：生产走 `getShareService().verifyAccessToken`，单测用 `setShareAccessVerifier()` 注入假实现（不碰 DB）。

## 二、交付项与实现

1. **公开路径**
   - `auth-public-paths.ts` 新增 `SHARE_ACCESS_PATH_PREFIX` / `isShareAccessPath` / `isAuthLoginPublicPath`；`auth-routes.isAuthPublicPath` 与 `stream-targets.isAuthSkippedPath` 都改走 `isAuthLoginPublicPath`，所以 `localUiGuard` 与节点侧流入口同时放行。
   - `/s/<id>`、`/n/<N>/s/<id>`：与 `/n/<N>/devices` 完全同路——`Forwarder.handle` 对非 `/ws`、非 `/api` 的 rest 返回 `null`，落到装配链末端的 `serveFrontend` SPA fallback（无扩展名 → `index.html`）。`localUiGuard` 只对 `/api/*` 拦截，`/s/*` 不受影响。已加两个回归测试（`forwarder.test.ts` 断言 mesh 不接管 + 无转发；`serve-frontend.test.ts` 断言四条路径都回 index.html）。

2. **Cookie 翻译**
   - 本机：`session-middleware.consumeSetSessionForBrowser` 现在同时处理 `x-tmex-set-session` 与分享头（只在 via === `self` 时翻译，非 self 原样透传给上游 Hub 处理）。
   - Hub：`forwarder-auth-policy.applyAuthPolicy` 顶部调用 `applyShareCookieHeaders(headers, upstream, nodeId, secure)`；`forwarder-headers.copyUpstreamHeaders` 把三个分享头与 `x-tmex-set-session` 一起归入 `INTERNAL_CREDENTIAL_HEADERS` 不外传（其余 `x-tmex-*` 白名单行为不变）。
   - `adaptResponse` 的 `skip401Rewrite` 对分享路径也置真：节点端的 401 `SHARE_PASSWORD_INVALID` 不会被改写成 `NODE_LOGIN_REQUIRED`，也不会误清 cookie。

3. **WS 升级（本机）**
   - `guardGatewayWebSocket` 无常规会话时走新的 `upgradeShareWebSocket`：`tmex_sh_self` 有效 → `MESH_SHARE_WS_KIND` 升级；带了 cookie 但无效 → 4401 `SHARE_LOGIN_REQUIRED`；没带 → 保持原来的 `NODE_LOGIN_REQUIRED`。
   - `handleWebSocket.open` 对分享 kind 不做任何登记（不进 `sockets`、不进 `SessionRegistry`）。`touchSocket` 对分享 kind 走 `touchShareSocket`：距上次复验 ≥ 60 s 才复验一次，失效即 `close(4410, 'SHARE_ENDED')` 并返回 false。
   - `assemble-websocket.routeWebsocket`：`isMeshKind` 收入分享 kind；新增 `isGatewayBoundKind`（常规会话 + 分享）让 open/message/drain/close 都接到 gateway 的 ws 处理；`openGatewayBound` 对分享 kind 只调 `gw.open(ws, { shareScope })`，不调 `registerGatewaySession`。

4. **Hub → 节点转发**
   - `Forwarder.handleRemoteWs`：`remoteWsAuthFor` 先取 `tmex_s_<N>`，没有再取 `tmex_sh_<N>` 并转成 `share:<token>`。failover 复用同一 auth。
   - `Forwarder.forwardHttp`：`forwardedAuthFor` 对 `/api/share-access/*` 用 `share:<token>`，登录前公开面仍为 `null`，其余仍是节点会话 cookie。分享 cookie 拿不到任何常规 `/api/*`。
   - 节点侧（新文件 `stream-auth.ts`）：`verifyStreamAuth` 识别 `share:` 前缀；`authorizeHttpStream` 在 HTTP 流上只放行 `/api/share-access/*`（其余 401 `share_forbidden`），并把 token 合成回请求头 `cookie: tmex_sh_<peerNodeId>=<token>`——与 T1 `readShareCookieToken` 读 `shareCookieName(mesh via)` 的约定一致（`dispatchInboundHttp` 把 via 设为 peer 节点 id）。dispatch context 的 `uid` 恒为 `null`，`authenticateRequest` 不会把它当已登录用户。
   - `acceptWsStream`：分享凭证时 `attachStreamSession(carrier, { shareScope })` 且跳过 `onGatewaySession`/`onGatewaySessionClose`；逐帧复验由 `createStreamRecheck` 决定（常规会话每帧、分享 60 s 一次）。

5. **终止可达（撤销 1 s 内断开）**
   原来节点端关闭流后 Hub 一律当链路抖动去 failover，浏览器要等 HELLO 超时（≈2 s）才收到一个通用关闭码。新增 `stream-close-code.ts`：终止性关闭码白名单 `{4401, 4410}`，`LinkStreamCarrier.close(code, reason)` 对这两个码改用 `stream.reset('tmex-close:<code>:<reason>')`（mux RST 的 reason 会随帧到对端），`mesh-runtime.openAdaptedWsStream` 从 `stream.closed` 解码后交给 `Forwarder.bindStream` 的 `onClose`，命中即 `closePump` 直接把 4410/SHARE_ENDED 透给浏览器，不再 failover。普通关闭码行为不变（仍是干净半关闭 + failover）。
   已有端到端回归：`mesh/integration/mesh.integration.test.ts` 新增「分享连接：/n/B/ws 用分享 cookie 建流，B 端终止后浏览器收到 4410」——真实 hub A + 节点 B，`b.wsServer.closeShareSessions('sh-1')` 后浏览器 socket 收到 `{code: 4410, reason: 'SHARE_ENDED'}`。

## 三、Cloudflare Access / 域名访问开关的结论（按建议执行，未改代码）

- **不动 `tunnel/access-paths.ts`**：Cloudflare Access 是站长自己给入口加的边缘策略。分享链接用的就是站长选定的 origin，如果该 origin 被 Access 保护，被分享人本来就该先过 Access——给 `/api/share-access/*` 或 `/s/*` 打 bypass 等于替站长撤掉自己的策略。机器路径豁免（`/hub/uplink` 等）是因为它们没有浏览器 cookie 通道，分享页是浏览器，不适用。
- **不动 `api/domain-access-routes.ts` / `mesh/domain-access-policy.ts`**：域名访问开关是「关掉公网入口」的总闸，分享不能穿。现有 `decideDomainAccess` 已给出合理语义：`/api/share-access/*` 与 `/n/<N>/api/...` 命中 `isJsonDeniedPath` → 403 JSON；`/s/<id>` → 403 纯文本；内网来源仍放行（本机演示分享可用）。
- 净效果：分享面在「入口本身可达」时可用，不多开任何一条入口。

## 四、越界改动（最小 pointwise）

`apps/gateway/src/runtime.ts`（T1 范围）：`GatewayRuntime['websocket'].open` 增加可选第二参 `GatewayOpenOptions = { shareScope?: ShareScope }` 并透传给 `wsServer.handleOpen(ws, opts)`——契约 §2.4 要求装配层用 `gw.open(ws, { shareScope })`，而 T2 的 `WebSocketServer.handleOpen(ws, options)` 已经接受该参数，中间这一层必须打通。只加了类型与透传，无行为变化。

`packages/app/src/runtime/assemble-websocket.ts`（新文件）：把 `routeWebsocket` 及其私有辅助（`socketKind`/`uplinkView`/`isMeshKind`/`isGatewayBoundKind`/`openGatewayBound`）和 `GatewayWsAuth` 类型从 `assemble-routes.ts` 拆出。原因是加分享分支后 `assemble-routes.ts` 617 行 > 600 门禁、`open` CC 17 > 15；拆分后 469 行、`open` CC 6。`routeWebsocket` 原本就不导出，仅 `buildHttpAndWs` 使用，拆分无外部影响。

同理 `apps/gateway/src/mesh/stream-auth.ts`（新文件）：把流入口的鉴权（`StreamAuthContext`/`isAuthSkippedPath`/`verifyStreamAuth`/`authorizeHttpStream`/`createStreamRecheck`）从 `stream-targets.ts` 拆出，把该文件从 678 行拉回 597 行（allowlist 记录 609，且注明「只降不升」），`acceptHttpStream` CC 回到 18（allowlist 记录值），`acceptWsStream` 通过抽 `wsStreamTeardown`/`pumpWsStreamFrames` 回到门禁内。`stream-targets.ts` 仍 re-export `StreamAuthContext` 与 `isAuthSkippedPath`，调用方无需改。

## 五、文件清单

新增：
- `apps/gateway/src/mesh/share-credential.ts`（凭证读写/校验/cookie 翻译）
- `apps/gateway/src/mesh/stream-close-code.ts`（终止性关闭码编解码）
- `apps/gateway/src/mesh/stream-auth.ts`（流入口鉴权，从 stream-targets 拆出）
- `packages/app/src/runtime/assemble-websocket.ts`（routeWebsocket，从 assemble-routes 拆出）

改动：`auth-public-paths.ts`、`auth-routes.ts`、`mesh-deps.ts`、`mesh-http.ts`、`session-middleware.ts`、`forwarder.ts`、`forwarder-auth-policy.ts`、`forwarder-headers.ts`、`stream-targets.ts`、`link-stream-carrier.ts`、`mesh-runtime.ts`、`packages/app/src/runtime/assemble-routes.ts`、`apps/gateway/src/runtime.ts`。

测试：`mesh-http.test.ts`（+5）、`session-middleware.test.ts`（+3）、`forwarder-auth-policy.test.ts`（+2）、`forwarder.test.ts`（+6）、`stream-targets.test.ts`（+4）、`link-stream-carrier.test.ts`（+3）、`mesh/integration/mesh.integration.test.ts`（+1）、`packages/app/src/runtime/serve-frontend.test.ts`（+1）。

## 六、验证

- `cd apps/gateway && bun test src/mesh`：1112 pass / 16 fail —— 16 个失败全部来自 `src/mesh/rtc/rtc-dial-breaker.test.ts` 的 `SyntaxError: Export named 'dcFailureReason' not found in module peer-dc-upgrade.ts`，是另一位 agent 正在改 `peer-dc-upgrade.ts` 的在途状态，与本任务无关。只跑本任务涉及的 9 个文件：246 pass / 0 fail。（本任务开工前的基线全量为 1281 pass / 0 fail。）
- `cd apps/gateway && bunx tsc --noEmit -p .`：仅剩 `src/mesh/direct-failure-code.test.ts` 一条错误（同一位 agent 的在途新文件），本任务文件 0 错。
- `cd packages/app && bun test`：898 pass / 1 skip / 0 fail；`bunx tsc --noEmit -p .`：0 错。
- `bunx biome check <本任务 25 个文件>`：0 问题。
- `bun scripts/complexity/gate.ts`：本任务 0 违规（剩余 4 条为 `apps/fe/src/node/mesh-nodes.ts`、`peer-dc-upgrade.ts`、`peer-manager.ts`，均属他人在途改动）。

## 七、遗留 / 需指挥官确认

1. **分享登录限速的来源 IP**：经 Hub 转发到节点的请求，节点侧看到的 clientIp 是 `peer:<hubNodeId>`（`dispatchInboundHttp` 写入），且 `x-forwarded-*` 在两端都被剥。因此 T1 的「按分享 + 来源 IP，15 min 内 10 次失败锁 15 min」在 Hub 路径上会把所有经该 Hub 的访客算成同一个来源。常规登录是靠 Hub 侧的 `gateForwardedAuth` 用真实 IP 做限速来解决的；分享登录目前没有对应的 Hub 侧限速。契约 §2.3 把限速放在 T1，我没有越界加 Hub 侧限流器，请指挥官决定是否补一轮（做法与 `AUTH_LOGIN_PATH` 那条一致，在 `Forwarder.gateForwardedAuth` 里对 `/api/share-access/:id/login` 加一条按 shareId+IP 的配额）。
2. **`getShareService()` 的懒构造**：`share-credential.verifyShareAccessToken` 在没有注入 override 时直接 `getShareService()`；T1 的实现会在未装配时用默认 deps 现造一个 service。生产路径上 `createGatewayRuntime` 已先行装配，正常；但如果有测试在未装配 DB 的进程里触发 ws 升级，会走到默认构造。已用 try/catch 兜住（异常一律判为凭证无效）。
3. **终止性关闭码白名单含 4401**：顺带让「节点端判定会话失效」也能把 4401 直接透给浏览器（原来要等 failover 耗尽）。这改善了常规会话的失效体验，但属于本任务的顺带行为变化，请审查时留意。
