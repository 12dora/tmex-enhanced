## Blocker

- `packages/api-client/src/auth/auth-api.ts:143`：前端依赖 `GET /api/auth/passkeys` 和 `GET /api/auth/keylog/head`，但当前 `AuthRoutes` 未实现这两个端点，均会被兜底为 405。结果是改密、设置/清除 TOTP、注册/移除 passkey、enroll、admit、revoke 都会在读取 key-log head 时失败，已有 passkey 也始终显示为空。建议先补齐两个带会话鉴权的后端端点，并用真实 `AuthRoutes` 做集成测试，不要只 mock 响应。

- `packages/api-client/src/auth/types.ts:19`、`apps/fe/src/pages/LoginPage.tsx:131`：代码已知 `/api/auth/mode` 不返回 `rootEpoch`，却用 `0` 继续派生 `k_totp`。用户轮换根钥并在 epoch 1 重新启用 TOTP 后，下一次密码登录会派生错误密钥，所有 node 均返回 `TOTP_INVALID`，可能造成远程锁死。建议让 `rootEpoch` 成为 mesh mode 的必填字段；缺失时中止登录并报告协议不兼容，禁止回退为 0。

- `apps/fe/src/node/enrollment.ts:30`、`apps/fe/src/node/enrollment.ts:120`：`PendingEnrollment` 将 `enrollSk` 及包含它的 `joinToken` 整体写入 `sessionStorage`。设计只允许持久化公开的 `{enroll_pk, authorization}`；当前实现使后续加载的同源脚本可以取走 enrollment 私钥、伪造节点证书并抢先 redeem。建议拆分“内存展示数据”和“可持久化 pending”，只持久化公钥、授权及元数据；生成 join token 后立即清零 `enroll_sk`，绝不存储 token。

- `apps/fe/src/node/enrollment-watch.ts:24`、`apps/fe/src/node/enrollment-watch.ts:127`：自动及手动 admit 都从 `hub/nodes` 或 `mesh/nodes` 读取 `certificate/cert_sig`，但当前两个后端响应均不提供这些字段，也没有把 `enroll.redeemed` 转发到浏览器。因此 join 成功后 watcher 永远没有候选证书，节点会永久停在“待确认”。建议先实现经 `/mesh/ws` 推送或专用查询端点传递 redeem 证书，再接入 `offerCertificate()`。

## Major

- `packages/api-client/src/node-url.ts:20`、`packages/api-client/src/auth/auth-api.ts:26`：`encodeURIComponent()` 不编码 `.`，所以 `nodeId='..'` 会产生 `/n/../api/x`，URL 规范化后实际请求 `/api/x`，突破目标 node 路径边界。建议统一使用一个 helper，并严格验证非 `self` nodeId 为规范的 32 位小写十六进制 node ID；不要仅依赖 URL 编码。

- `apps/fe/src/node/mesh-events.ts:278`、`packages/stores/src/node-connection-manager.ts:92`：WS 关闭没有检查 4401。`MeshEventSource` 会无条件重连，普通 gateway connection 也没有接入 `handleGlobalUnauthorized`/`handleNodeLoginRequired`。会话过期后客户端将持续建立并被关闭 WS，而不是跳转登录页或显示“登录此节点”。建议向连接层传递 `CloseEvent.code`；4401 时停止重连，并按 self/目标 node 分派一次鉴权事件。

- `apps/fe/src/auth/session-key-store.ts:257`：passkey 登录从后端返回的全部 `allowCredentials` 中直接选择第一把。用户分别在 node A、node B 注册 passkey 后，从 B 登录时若 A 的 credential 排在前面，浏览器会被强制使用属于 A RP/origin 的凭证并以 `NotAllowedError` 失败，即使 B 存在有效 passkey。`AccountSecurityPage.tsx:401` 也有相同问题。建议后端按当前精确 origin/RP ID 过滤并返回候选 credential ID，前端只能从该集合选择。

- `apps/fe/src/pages/AccountSecurityPage.tsx:282`：TOTP 记录先写入 key log，成功后才显示 QR code，且没有要求用户输入一次验证码确认。若写入成功后页面刷新、崩溃或用户未及时扫码，账号已要求一个用户从未保存的 TOTP secret，后续登录可能被锁死。建议改成“生成并展示 secret → 用户输入 6 位码并本地验证 → 追加 `set-totp` 记录”的两阶段流程。

- `apps/fe/src/auth/account-security-actions.ts:214`、`apps/fe/src/auth/key-log-actions.ts:93`、`apps/fe/src/node/enrollment.ts:169`：`rootSignerFromPassword()` 创建的 `RootKey.seed` 在签名后没有清零；enrollment 的 remembered signer 过期时也只是丢引用，而且没有定时清理。清除 TOTP、注册/删除 passkey、admit/revoke 后，根私钥副本会继续留在堆中直至 GC。建议用回调式 `withRootSigner()` 并在 `finally` 清零；5 分钟复用窗口到期或替换 signer 时也必须显式 wipe。

- `packages/api-client/src/client.ts:52`、`packages/api-client/src/auth/session-interceptor.ts:129`：响应 hook 收到的是调用方传入的 `path`，不包含 `ApiClient.baseUrl`。每 node runtime 调用 `client.fetch('/api/devices')` 时，即使真实 URL 是 `/n/node-b/api/devices`，无 JSON code 的 401 仍会被识别为 self，从而把整页踢到全局登录页。建议把规范化后的 URL pathname 或显式 `nodeId` 传给 hook，并据此分类。

## Minor

- `apps/fe/src/node/node-runtimes.ts:28`：每 node 的 `QueryClient` 永久保存在模块级 Map；`NodeConnectionManager` 在引用归零后只释放 runtime 和 WS，`disposeNodeQueryClient()` 从未调用。节点被撤销或长期切换后，文件列表等缓存仍驻留并可能在重建 runtime 时短暂显示旧数据。建议把 QueryClient 生命周期接入 manager 的实际 dispose 回调。

- `apps/fe/src/pages/LoginPage.tsx:97`：`loginToAllReachable()` 在 `/api/mesh/nodes` 请求失败时返回空数组，页面却将其视为登录成功并跳到 `next`；受保护请求随后再返回 401，用户被弹回登录页。同时所有节点登录失败时，新建的无效 session key 也未清除。建议区分“没有目标”和“列表加载失败”，只有至少一个登录成功才进入完成态，其余情况清除刚创建的会话钥。

## 结论

不建议合入。虽然本次抽查的 51 个相关测试及前端 TypeScript 检查通过，但测试大量使用了当前 gateway 并不存在的 mock 端点，也未覆盖根轮换后的 TOTP、跨 origin passkey、4401 重连和 `..` nodeId；现有实现包含可导致账号锁死、节点无法 admit、私钥落入 sessionStorage 以及 WS 无限重连的阻断问题。