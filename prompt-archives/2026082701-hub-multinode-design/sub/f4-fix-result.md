# F4-fix 结果 — 前端安全评审整改（登录/会话/运行时 + Nodes 页）

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。
对齐的后端契约：`sub/b2-2b-fix-result.md` + **`sub/b2-5-result.md`（收尾时已存在，逐条核对过实现代码）**。

`sub/f4-1-review.md` 与 `sub/f4-3-review.md` 的全部条目已落地，另附带修掉 f4-3 的 Minor（Borsh 枚举/版本校验）。

---

## 一、分项：条目 → 改动 → 回归测试

### 1. 契约对齐

| 子项 | 改动 | 测试 |
|---|---|---|
| 登录前用 `/api/auth/nodes` | `AuthApi.listPublicNodes()`（新）；`LoginPage` 挂载时拉公开列表，渲染「本次将登录以下节点」并用它取 entry 显示名 | `auth-api.test.ts`「listPublicNodes 打公开的 /api/auth/nodes」 |
| self 登录后再用 `/api/mesh/nodes` fan-out | `loginToAllReachable()` 重写：**先登 `self`（`selfBootstrap`）→ 拿 `tmex_s_self` → 拉 mesh 列表 → 并行登其余在线 node**；返回 `FanOutResult {rows, anyOk, listFailed}` | `session-key-store.test.ts`「先登录 self，再用新会话拉 /api/mesh/nodes…」「self 登录失败时不拉 mesh 列表」 |
| 登录体无 `sid` | `AuthLoginResponse` 只剩 `{expires_at}` | mock 只回 `{expires_at}`，全部登录用例 |
| entry 公钥事后核对 | self bootstrap 时记下 challenge 的 `nodePk`，列表到手后与 `mesh` 里 entry 行比对，不一致 → 清会话钥 + `NODE_PK_MISMATCH` | 「entry 公钥被掉包时清掉会话钥并报 NODE_PK_MISMATCH」 |
| passkey `delegation_sig` = Borsh `PasskeyAssertion` | 已是 `encodePasskeyAssertion(...)`，保持并加断言 | `session-key-store.test.ts` 登录签名对拍（delegation/sig 走共享验签器） |
| `rootEpoch` mesh 模式必填 | `requireRootEpoch(mode)`（`types.ts`，缺失抛 `ProtocolMismatchError`），`LoginPage` / `NodesPage`（enroll、admit、revoke）全部改用它，**删掉所有 `?? 0`** | tsc + 三处调用点；`auth.errors.PROTOCOL_MISMATCH` i18n |
| `keylogHead()` / `listPasskeys()` 打真实端点 | `listPasskeys` 去掉 404→`[]` 兜底，失败一律抛 | 「listPasskeys 打真实端点；失败一律抛错」「keyLogHead 打 /api/auth/keylog/head」 |
| join 命令的 hub 地址 | `resolveHubPublicUrl(created, mode)`：`enrollment.public_url` → `mode.hubPublicUrl` → **`null`（不生成命令，提示 `nodes.enrollment.missingHubUrl`）**；`hubPublicUrl()`（读 `location.origin`）已删除 | `NodesPage.test.tsx`「resolveHubPublicUrl」3 例 |
| `isHub` 发现 hub | `findHubNodeId(nodes, mode.hubNodeId)` 取代 `hubCandidates()` 启发式；`useHubNode` 不再逐个探测 | `mesh-nodes.test.ts`「findHubNodeId」4 例 +「mergeNodes 的 isHub」 |

### 2. `enroll_sk` 绝不落盘

- `PendingEnrollment` = `{hubEnrollmentId, enrollPk, authorizationBytes, authorizationSig, exp, name, createdAt}`。
  **去掉 `enrollSk` 与 `joinToken`**；`name`/`createdAt` 是非敏感的展示字段（admit 只需 `enroll_pk` + 授权 + 证书）。
- 反序列化守卫遇到含 `enrollSk`/`joinToken` 的旧格式**整条丢弃**，不迁移、不回写。
- `createEnrollmentOnHub()` 返回 `{pending, joinToken, hubPublicUrl}`；`joinToken` 只在内存，`finally` 里 `enrollment.enrollSk.fill(0)`。
- `NodesPage` 的 `created` 状态在 admit 成功或过期时清空（`clearedIds` = `expiredIds ∪ admittedIds`）。
- 过期清理改为**定时器**：`nextPendingExpiry()` 排最早的一次性 timer，触发即 `prunePendingEnrollments()`（现在返回被丢弃的行）。
- `signAdmit` 在 `await api.keyLogHead()` 之后**重新检查 `exp`**，过期则报错并移除 pending。

测试：`enrollment.test.ts`「落盘内容里绝不出现 enroll_sk 或 join 串」「旧格式读回时整条丢弃」「过期 pending 被 prune 掉，并返回被丢弃的那些」「nextPendingExpiry」「createEnrollmentOnHub：join 串只在返回值里…」。

### 3. redeem 证书投递

- `mesh-events.ts`：解 `wsBorsh.KIND_ENROLL_REDEEMED`（`EnrollRedeemedSchema` 是 bytes，转 base64url），新增 `MeshEventSource.onEnrollRedeemed()`。
- `hub-api.ts`：`getEnrollment(id)` → `GET /n/<hub>/api/hub/enrollments/:id`。
- `enrollment-watch.ts`：`useEnrollmentWatch` 同时**订阅推送**与**按 enrollment id 轮询**（`collectRedeemedCertificates`），两条路径都汇进 `offerCertificate()`。
  删除 `certificatesFromHubNodes` / `certificatesFromMeshNodes`（列表里的旧证书不再是候选来源）。

测试：`mesh-events.test.ts`「ENROLL_REDEEMED 解出 hub 转发的证书（字节转 base64url）」「缺证书 / 签名长度不对时作废」；新增 `enrollment-watch.test.ts`（轮询命中 / 未 redeem / hub 失败不抛 / 推送与轮询同一判定 / 未知证书报 unknown）。

### 4. admit / revoke 可靠性

- `AuthApi.appendKeyLog(body, {hubSync:true})` → `POST /api/auth/keylog?hub=sync`，解出 `{ok, seq, hash, hubAck, hubError}`。
- admit：`hubAck === true` 才 `removePendingEnrollment`；否则 **保留 pending**、置 `hubUnconfirmedIds`、toast `nodes.enrollment.hubNotConfirmed`，该行按钮变「重试」（`nodes.enrollment.retryHub`）走同一条 `confirmManually`。
- revoke：**只有一条路径**——`keylog?hub=sync`。删掉 `HubApi.revoke()` 与 entry 侧的第二次 POST（原来两条独立通道会互相 `seq_gap`）。`hubAck !== true` 时只告警、不刷新列表。

测试：`auth-api.test.ts`「appendKeyLog(hubSync) 走 ?hub=sync 并透出 hubAck」「hub 未确认时 hubAck=false 原样透出」。

### 5. nodeId 校验

`packages/api-client/src/node-url.ts` 新增 `assertNodeId(id)`（`self` 或 `^[0-9a-f]{32}$`，否则抛 `InvalidNodeIdError`）与 `isValidNodeId()`。
`nodePathPrefix` → `resolveNodeUrl` / `nodeWsUrl` / `createNodeApiClient` / `nodeAppPath`，以及 `auth-api.nodeAuthPath`（现在直接复用 `resolveNodeUrl`）全部经它。
`parseNodeIdFromPath` / `session-interceptor.nodeIdFromPath` 对非规范前缀返回 `self`，不把脏值带下去。

测试：`node-url.test.ts`「路径穿越形态一律拒绝：`..`、`%2e%2e`、`a/b`」「大写 hex、长度不对、非 hex 字符都拒绝」「前缀不是规范 node id 时按 self 处理」等。

### 6. 4401 处理

- `mesh-events.ts`：`onclose(event)` 读 `code`；**4401 → 停止重连 + `handleGlobalUnauthorized('/mesh/ws')`**；退避 1–60 s 且乘 `[0.5,1]` 抖动；**只有「稳定 ≥10 s」或「收到过一帧合法数据」才重置 attempt**（原来任何 `open` 都重置，会变成每秒 open→close 循环）。
- `packages/ws-client/src/connection.ts`（**纯增量**）：新增 `onClose?(code)` 选项 + `withCloseCode()` 薄壳 socket（占住真 socket 的 `onclose`，先回调再转给 client）。client.ts 一行未改。
- `packages/stores/src/node-connection-manager.ts`：默认连接带 `onClose`；新增公开 `notifyClose(nodeId, code)` 供宿主自建连接回传；4401 → `client.disconnect()` + self→`handleGlobalUnauthorized` / 其余→`handleNodeLoginRequired(nodeId)`。
- `apps/fe/src/node/node-runtimes.ts`：`createNodeConnection` 加 `onClose` 转发（F3-1 覆盖了 `createConnection`，不接就没人处理 4401）。

测试：`mesh-events.test.ts`「4401：停止重连并派发一次全局未授权」「只有稳定连接才重置退避」「收到一帧合法数据即视为连接可用」「退避有上限，且带 [0.5,1] 抖动」；`node-connection-manager.test.ts`「WS 4401」3 例；`ws-client/connection.test.ts`「onClose 关闭码回调」3 例。

### 7. passkey 凭证选择

- `selectPasskeyCredential({allowCredentials, passkeys, rpId, origin, preferredId})`（`session-key-store.ts`，纯函数）：先按 `origin` 精确匹配，再按 `rp_id`；**有元数据但当前 origin 无凭证 → 返回 `null`**（宁可报「本入口没有可用 passkey」也不发起注定 `NotAllowedError` 的仪式）；拿不到元数据（登录前无会话）才信后端过滤结果。
- `AccountSecurityPage`：`passkeysForOrigin(passkeys)` 过滤后取用，不再 `passkeys[0]`；`listPasskeys` 失败单独提示 `auth.security.passkeyListFailed`。

测试：`session-key-store.test.ts`「selectPasskeyCredential」4 例；`account-security-actions.test.ts`「passkeysForOrigin」2 例。

### 8. TOTP 两段式

`setTotp()` 拆成 `beginTotpSetup()`（只生成 secret + otpauth URI，**不写记录**）与 `confirmTotpSetup()`（先 `verifyTotpCode` 本地验 6 位码，通过才 append `set-totp`）。
UI：生成 → QR + 明文 URI + 6 位码输入 + 「确认并启用」/「取消」；卸载或取消时 `secret.fill(0)`。

测试：`account-security-actions.test.ts`「第一段只生成密钥与 URI，不写任何 key-log 记录」「验证码不对时直接拒绝，仍然不写记录」「验证码正确后才追加 set-totp…」。

### 9. seed / 根钥卫生

- `withRootSigner(password, kdfParams, fn)`：`finally` 里 `rootKey.seed.fill(0)`。清 TOTP、增删 passkey、revoke 全部改用它。
- `changePassword` / `confirmTotpSetup` 的 seed 与 `k_totp` 也移进 `try/finally`。
- `rememberSigner()`：替换或到期由**定时器**主动 `wipeSigner()`（不再只丢引用）；`forgetSigner()` 立即清零；`NodesPage` 卸载时调用。

测试：`account-security-actions.test.ts`「withRootSigner：回调返回后 seed 立刻清零」「回调抛异常也照样清零」；`enrollment.test.ts`「窗口结束 / 换 signer 时根钥 seed 被清零」。

### 10. 拦截器归属判定

`ApiClient.fetch` 的钩子上下文加 `pathname`（`urlPathname(baseUrl + path)`），`sessionResponseHook` 改用它。
每 node runtime 的 `client.fetch('/api/devices')`（baseUrl=`/n/<id>`）现在能正确归到该 node。

测试：`session-interceptor.test.ts`「node runtime 的相对路径 + baseUrl 前缀：401 归该 node，不把整页踢去登录页」。

### 11. 登录页

`runFanOut` 用 `FanOutResult`：
- `anyOk === false` → 清掉刚建的会话钥 + `auth.login.allNodesFailed`，**不跳转**；
- `listFailed === true` → `auth.login.nodeListFailed`，**不跳转**（与「没有其它目标」区分开）；
- 其余才 `phase='done'` → 跳 `next`。
指定 `?node=` 的单点登录失败时同样清会话钥。

测试：`session-key-store.test.ts`「mesh 列表拉取失败与「没有其它目标」区分：listFailed=true」+ 上面 fan-out 用例。

### 12. 每 node QueryClient 释放

`NodeConnectionManagerOptions.onDispose?(nodeId)`，在 `dispose()` 末尾调用；`appNodeRuntimes` 传 `onDispose: disposeNodeQueryClient`。
（`node-runtimes.ts` 在动手时是干净工作区、F3-1 已提交，故直接落地而非只写报告。）

测试：`node-connection-manager.test.ts`「onDispose：runtime 真正被回收时才回调」。

### 附带：f4-3 Minor（Borsh 严格校验）

`decodeMeshFrame` 现在要求 `envelope.version === wsBorsh.CURRENT_VERSION`，且 `NODE_EVENT.status` / `RTC_SIGNAL.from` 走完整 allowlist，未知值**整帧返回 `null`**。
测试：「未知 status 枚举整帧作废」「未知 RTC_SIGNAL.from 整帧作废」「协议版本不符整帧作废」。

---

## 二、文件清单

| 文件 | 说明 |
|---|---|
| `packages/api-client/src/node-url.ts` | `assertNodeId` / `isValidNodeId` / `InvalidNodeIdError`；前缀构造统一走它 |
| `packages/api-client/src/client.ts` | `ResponseHookContext.pathname` + `urlPathname()` |
| `packages/api-client/src/auth/types.ts` | mode 新字段、`requireRootEpoch`、`PublicNode`、`KeyLogAppendResult.hubAck`、`HubEnrollmentStatus`、登录体去 sid、`MeshNode.isHub` |
| `packages/api-client/src/auth/auth-api.ts` | `listPublicNodes`、`appendKeyLog(…, {hubSync})`、`listPasskeys` 不再吞 404、`nodeAuthPath` 复用 `resolveNodeUrl` |
| `packages/api-client/src/auth/session-interceptor.ts` | 用 `pathname` 判定；`nodeIdFromPath` 校验 |
| `apps/fe/src/auth/session-key-store.ts` | self-bootstrap 登录 + `FanOutResult`、entry 公钥事后核对、`selectPasskeyCredential` |
| `apps/fe/src/auth/account-security-actions.ts` | `withRootSigner`、`beginTotpSetup`/`confirmTotpSetup`、`passkeysForOrigin`、seed 全部 `finally` 清零 |
| `apps/fe/src/node/enrollment.ts` | pending 去私钥 + 旧格式丢弃、`CreatedEnrollment`、`nextPendingExpiry`、remembered signer 定时清零 |
| `apps/fe/src/node/enrollment-watch.ts` | 推送订阅 + 按 id 轮询，两路汇入 `offerCertificate` |
| `apps/fe/src/node/mesh-events.ts` | `ENROLL_REDEEMED`、4401、抖动退避、稳定后才重置、枚举/版本严格校验 |
| `apps/fe/src/node/mesh-nodes.ts` | `findHubNodeId`（删启发式）、`useHubNode` 不再探测、`mergeNodes` 认 `isHub` |
| `apps/fe/src/node/hub-api.ts` | `getEnrollment`、`public_url`；删 `revoke` |
| `apps/fe/src/node/node-runtimes.ts` | `onClose` 转发 + `onDispose: disposeNodeQueryClient` |
| `apps/fe/src/pages/LoginPage.tsx` | 公开节点列表、`requireRootEpoch`、anyOk/listFailed、失败清会话钥 |
| `apps/fe/src/pages/AccountSecurityPage.tsx` | TOTP 两段式、passkey 按 origin 选、`withRootSigner`、列表失败提示 |
| `apps/fe/src/pages/NodesPage.tsx` | hub URL 来源、过期定时器、`created` 清理、`hub=sync` + hubAck 重试、单路径 revoke、`requireRootEpoch` |
| `packages/stores/src/node-connection-manager.ts` | `onClose`/`notifyClose`/4401 分派、`onDispose` |
| `packages/ws-client/src/connection.ts` | **增量**：`onClose` 选项 + `withCloseCode` 薄壳 |
| `packages/shared/src/i18n/locales/*.json` | 12 个新 key ×3 语言（+ `bun run build:i18n`） |

新增测试文件：`apps/fe/src/node/enrollment-watch.test.ts`。
改写测试：`session-key-store.test.ts`、`account-security-actions.test.ts`、`enrollment.test.ts`、`mesh-events.test.ts`、`mesh-nodes.test.ts`、`node-url.test.ts`、`session-interceptor.test.ts`、`auth-api.test.ts`、`node-connection-manager.test.ts`、`connection.test.ts`、`NodesPage.test.tsx`。

**范围外的最小改动（仅测试夹具）**：`assertNodeId` 生效后，用 `node-a` / `remote` / `entry-1` 这类假 node id 的既有测试会抛。已把这些**测试数据**换成 32 位 hex，逻辑一行未动：
`apps/fe/src/components/global-device-provider.test.ts`、`apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx`、`apps/fe/src/node/node-runtime-boundary.test.tsx`、`apps/fe/src/pages/FilePage.test.tsx`、`apps/fe/src/pages/LoginPage.test.tsx`。

新增 i18n key：`auth.login.{nodeListFailed,willSignIn}`、`auth.errors.{PROTOCOL_MISMATCH,INVALID_NODE_ID,TOTP_CODE_REQUIRED}`、`auth.security.{totpConfirm,totpConfirmHint,totpCodeRequired,totpDone,passkeyListFailed}`、`nodes.enrollment.{hubNotConfirmed,retryHub,missingHubUrl}`。

---

## 三、测试 / tsc / biome

| 包 | 测试 | 基线 | tsc | 基线 |
|---|---|---|---|---|
| `apps/fe` | **142 pass / 0 fail**（16 文件） | 101 | **0** | 0 |
| `packages/api-client` | **82 pass / 0 fail** | 69 | **5** | 5 |
| `packages/stores` | **123 pass / 0 fail** | 119 | **1** | 1 |
| `packages/panels` | **212 pass / 0 fail** | 199 | **0** | 0 |
| `packages/ws-client` | **172 pass / 0 fail**（收尾复跑时 182 pass / 1 fail，见下） | — | **0** | — |
| `packages/shared` | **282 pass / 0 fail** | — | **0** | — |

> api-client 的 5 个 tsc 报错与 stores 的 1 个都在既有测试文件里（`client.test.ts` 的 mock 元组推断、`files-download.test.ts` 的 `Uint8Array` BodyInit、`host-services.test.ts`），与本次改动无关，数量与基线一致。
> panels / ws-client / shared 数字上升是因为并行的 F3/B2 分支也在同一 worktree，本任务未碰它们的源文件。
> 收尾复跑时 ws-client 出现 1 条失败：`direct/data-channel-carrier.test.ts`「分片中途抛异常：关闭载体而不是留一个半帧」——该文件属于 **F3** 且在两次运行之间刚被改（用例数 172→182），与本任务无关；本任务新增的 `connection.test.ts`「onClose 关闭码回调」3 例全绿。

biome：本任务范围内 100 个文件 `No fixes applied.`（`apps/fe/src/index.css` 的 `noInvalidPositionAtImportRule` 是既有告警，非本次引入）。

---

## 四、遗留 / 需协调

1. **`hubAck` 依赖 B2-5「协调者必须做」第 4 条**：`publisher.publishAndAck` 未接线时后端恒返回 `hubAck:false, hubError:'unavailable'`。前端此时的行为是**保留 pending + 显示「hub 未确认，稍后重试」+ 重试按钮**（不会丢 enroll 授权，也不会误报成功），接线后自动转正常。revoke 同理会一直告警。
2. **`isHub` / `hubPublicUrl` 依赖 `node.list` 的 `hub` 字段真正下发**。非 hub 机在 `peer_cache` 学到之前，`findHubNodeId` 返回 `null` → Nodes 页显示「hub 不可达」、新增节点按钮禁用。这是有意的降级（比乱探测安全）。
3. **passkey 做节点管理**（f4-3 Major「enrollment 输入硬编码 `RootKey`」）不在本次 12 项内，仍未做：`createEnrollmentOnHub` 需要 `rootKey.publicKey` 拼 join 串。现在 `/api/auth/mode` 已下发 `rootPublicKey`，改成 `RecordSigner + rootPublicKey` 的前置条件已具备，建议单开一项。
4. `packages/ws-client/src/connection.ts` 的 `withCloseCode` 是薄壳而不是改 `client.ts`，为的是不和 F3-1 的改动打架。若后续 `client.ts` 愿意把 `CloseEvent` 透给 `onclose`，这层壳可以直接删掉。

未碰生产 tmex、默认 tmux session `tmex`；未跑 `bun install`；未执行任何改状态的 git 命令。
