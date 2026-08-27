# F4-3 结果：Nodes 页、侧边栏聚合、node 徽标、enrollment / admit / revoke

分支 `feat/hub-node`，worktree `/Users/konata/code/tmex-enhanced-wt-hub`。输入：设计 `docs/hub/2026082700-hub-node-architecture.md` §2 / §4，以及 `sub/f4-1-result.md`、`sub/f4-2-result.md`、`sub/b2-1-result.md`、`sub/b2-2b-result.md`、`sub/b1-3a-result.md`、`sub/b1-3a-fix-result.md`。

---

## 一、文件清单

### 新增

| 文件 | 内容 |
|---|---|
| `packages/ws-client/src/direct/types.ts` | 直连诊断**契约**：`DirectCarrierPath` / `DirectIceDiagnostics` / `DirectDiagnostics` / `DirectDiagnosticsSource` / `PRIMARY_ONLY_DIAGNOSTICS` / `createStubDirectDiagnosticsSource` / `resolveDirectDiagnostics` |
| `apps/fe/src/node/mesh-events.ts` | `/mesh/ws` 订阅：`decodeMeshFrame` / `encodeRtcSignal` / `meshWsUrl` / `MeshEventSource`（指数退避重连）/ `sharedMeshEvents` |
| `apps/fe/src/node/mesh-nodes.ts` | 纯函数（指纹 / NODE_EVENT 投影 / 排序 / hub 合并 / hub 候选）+ 宿主级 store + `useMeshNodes` / `useHubNode` / `useSharedAuthMode` |
| `apps/fe/src/node/hub-api.ts` | `HubApi`：`/n/<hub>/api/hub/{nodes,nodes/:id/rename,nodes/:id/revoke,enrollments}` |
| `apps/fe/src/node/enrollment.ts` | pending 存储（内存 + `sessionStorage`）、证书匹配、`admit-node` / `revoke-node` 记录构造、`createEnrollmentOnHub`、`joinCommand`、5 分钟凭据复用 |
| `apps/fe/src/node/enrollment-watch.ts` | **唯一**的证书检测入口 `offerCertificate` + 5 秒轮询 hook `useEnrollmentWatch` |
| `apps/fe/src/node/direct-diagnostics.ts` | `useDirectDiagnostics(nodeId)` / `useNodeReach(nodeId)` |
| `apps/fe/src/node/device-node-badges.tsx` | 设备页头部两枚徽标 + ICE 诊断浮层 |
| `apps/fe/src/node/node-runtime-scope.tsx` | 按**显式 nodeId** 挂运行时子树（聚合视图可并存多份） |
| `apps/fe/src/pages/NodesPage.tsx` | Nodes 管理页（表格 + enrollment + rename + revoke + 账号安全链接） |
| `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx` | 原 `sidebar-device-list.tsx` 的内容（单运行时设备树） |
| `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx` | 聚合侧边栏的「一个 node」分节（在线已登录 / 在线未登录 / 离线） |
| `packages/panels/src/device-tree/node-badge.tsx` | `NodeBadge` + 纯函数 `nodeBadgeAppearance` |
| 测试 | `apps/fe/src/node/{mesh-nodes,mesh-events,enrollment}.test.ts`、`apps/fe/src/pages/NodesPage.test.tsx`、`apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx`、`packages/panels/src/device-tree/node-badge.test.ts` |

### 修改

- `apps/fe/src/main.tsx`：**只加了两行**——`nodesModule` 懒加载与顶层路由 `{ path: '/nodes', ... }`（与 `/login`、`/account/security` 同级，在 node 边界之外）。
- `apps/fe/src/pages/DevicePage.tsx`：`PageActions` 前置 `<DeviceNodeBadges nodeId={useRouteNodeId()} />`；`self` 时该组件返回 `null`，旧头部逐像素不变。
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`：改为**分流器** + 纯函数 `toSidebarEntries`。
- `packages/panels/src/device-tree/{device-row,sidebar-device-list}.tsx`：新增**可选** `nodeBadge` 与 `emptyLabel` 两个 prop（不传 = 今天的渲染结果）。
- `packages/panels/src/device-tree/index.ts`：导出 `NodeBadge` / `nodeBadgeAppearance` / 类型。
- i18n locale JSON（三份）：新增 `translation.nodes`（9 组共 ~60 键）与 `translation.sidebar.node`（3 键）。已跑 `bun run build:i18n` 重建 `resources.ts` / `types.ts`（未手改生成文件）。

---

## 二、公开 API

```ts
// packages/ws-client/src/direct/types.ts（F3-1 的对接点）
type DirectCarrierPath = 'primary' | 'direct'
interface DirectDiagnostics { path: DirectCarrierPath; rtt: number | null; ice: DirectIceDiagnostics | null }
interface DirectDiagnosticsSource { get(): DirectDiagnostics; subscribe(fn): () => void }
function resolveDirectDiagnostics(connection: unknown): DirectDiagnosticsSource
// 鸭子类型：connection 上有 `directDiagnostics` 就用它，否则返回恒 primary 的桩

// apps/fe/src/node/mesh-events.ts
function decodeMeshFrame(data: Uint8Array): MeshFrame | null      // 非 mesh kind / 畸形帧 → null
function encodeRtcSignal(payload: RtcSignalPayload, seq?): Uint8Array
function meshWsUrl(location?): string
class MeshEventSource {
  start() / stop() / connected
  onNodeEvent(fn): () => void            // 多播
  onStatusChange(fn): () => void
  setRtcSignalHandler(fn | null): () => void   // 单一 handler（Phase 3 的钩子）
  sendRtcSignal(signal): boolean
  retryDelay(attempt): number
}
function sharedMeshEvents(): MeshEventSource

// apps/fe/src/node/mesh-nodes.ts
function publicKeyFingerprint(pkB64url): string        // sha256(pk) 前 16 hex
function toRuntimeNodeId(nodeId, entryNodeId): string  // entry 自身 → 'self'
function patchNodesWithEvent(nodes, event): MeshNode[] // revoked → 摘除；无变化返回原引用
function sortNodes(nodes, entryNodeId): MeshNode[]     // self 优先 → 在线 → 名称
function mergeNodes(meshNodes, hubNodes | null, { entryNodeId, hubNodeId }): NodeRow[]
function hubCandidates(nodes, entryNodeId): string[]
function ensureAuthMode(api?): Promise<void>
function useSharedAuthMode(api?): { mode, loaded, meshEnabled, entryNodeId }
function useMeshNodes(options?): MeshNodesState & { refresh }
function useHubNode(nodes, entryNodeId, options?): HubNodeState   // { hubNodeId, hubApi, hubNodes, online, loading, error, refresh }
function setEntryNodeId(id | null) / applyMeshNodeEvent(event) / refreshMeshNodes(api?)

// apps/fe/src/node/hub-api.ts
class HubApi { listNodes() / rename(id, name) / revoke(id, {bytes, sig}) / createEnrollment({...}) }

// apps/fe/src/node/enrollment.ts
listPendingEnrollments() / addPendingEnrollment() / removePendingEnrollment() /
subscribePendingEnrollments() / prunePendingEnrollments(now) / setPendingStorage(s)   // 测试注入
matchPendingCertificate(pending, candidate, now): CertificateMatch
findPendingForCertificate(pendings, candidate, now)
buildAdmitNodeRecord(input): Promise<{bytes, sig}>
buildRevokeNodeRecord(input): Promise<{bytes, sig}>
createEnrollmentOnHub(input): Promise<PendingEnrollment>
joinCommand(hubPublicUrl, token, name?): string
rememberSigner(signer, now) / takeRememberedSigner(now) / forgetSigner()   // 5 分钟窗口，仅内存

// apps/fe/src/node/enrollment-watch.ts
offerCertificate(pendings, candidate, now): CertificateOutcome   // 唯一判定入口
useEnrollmentWatch({ pendings, hubApi, onOutcome, collect?, intervalMs? }): void

// apps/fe/src/node/direct-diagnostics.ts
useDirectDiagnostics(nodeId): DirectDiagnostics
useNodeReach(nodeId): 'lan' | 'relay' | null

// apps/fe/src/pages/NodesPage.tsx
export default function NodesPage(props?: { mode?: AuthModeResponse; api?: AuthApi })
export const PageTitle, nodesRoute, hubPublicUrl, formatLastSeen

// packages/panels/src/device-tree
<SideBarDeviceList nodeBadge? emptyLabel? … />     // 两个新可选 prop
<NodeBadge info={NodeBadgeInfo} />
nodeBadgeAppearance(info): { label, title, dimmed }
```

---

## 三、关键设计与取舍

### 3.1 mesh 列表用模块级 store，不用 react-query

`/api/mesh/nodes` 是**入口级**数据（永远打 entry 自身，不带 `/n/:id` 前缀），而侧边栏与设备页可能挂在任意 node 的 `QueryClient` 下（F4-2 每 node 一份 client）。放进某个 node 的缓存会在切 node 时重复拉取，也拿不到跨边界的 `NODE_EVENT` 实时更新。因此实现为一个宿主级 store + `useSyncExternalStore`：`/api/auth/mode` 全宿主只拉一次（`ensureAuthMode`），节点列表 30 s 轮询 + `NODE_EVENT` 投影。

### 3.2 `useHubNode()`：契约没有 hub 标志位，用启发式探测

`GET /n/<hub>/api/hub/nodes` 的响应里没有「谁是 hub」这一信息，`/api/mesh/nodes` 也没有。候选顺序（`hubCandidates`，纯函数、有测试）：

1. `inventory.hub === true` 或 `inventory.roles` 含 `hub` 的 node；
2. entry 自身（`hub,node` 同机是默认部署形态，一次本地请求就能确定）；
3. 其余 `online && reach !== null` 的 node。

逐个 `listNodes()`，第一个 200 的即为 hub；已确定的 hub 下轮优先重试（走 ref，不作为重新探测的触发条件）。全部失败 → `online:false` → 页面顶栏出「hub 不可达」提示，**新增 / 重命名 / 吊销三个按钮 disabled 并带 title 提示**。

### 3.3 enrollment / admit 的检测入口只有一个

设计要求 hub 收到 redeem 后把 `{certificate, cert_sig}` 推给发起 enrollment 的 entry 页面。后端现状（见第五节）**没有任何通道把证书交给浏览器**，所以：

- `offerCertificate(pendings, candidate, now)` 是唯一判定实现：`enroll_pk` 命中 → `cert_sig` 用该 `enroll_pk` 验签 → pending 未过期，三者全过才返回 `admit`；签名坏 / 过期返回 `invalid`；都不匹配返回 `unknown`。
- `useEnrollmentWatch` 在 pending 存在期间每 5 s 拉 `GET /n/<hub>/api/hub/nodes` + `GET /api/mesh/nodes`，把其中**带上** `certificate` / `cert_sig` 字段的行喂给 `offerCertificate`。字段是前向兼容的：后端补上这两个字段（或补推送后直接调 `offerCertificate`）当天即生效，UI 与匹配逻辑零改动。
- **轮询路径不发「收到未知节点证书」告警**：列表里本来就有一堆与本次 enrollment 无关的旧证书，那是正常状态而不是攻击信号。该告警只由推送路径（`offerCertificate` 返回 `unknown`）触发——目前只有手动确认按钮会走到。

### 3.4 5 分钟凭据复用

设计 §2 步骤 3 要求「同 enroll 时那次交互后的 5 分钟内免二次输入」。F4-1 没有这种缓存，因此在 `enrollment.ts` 里实现 `rememberSigner / takeRememberedSigner`：**只在内存**（绝不进 `sessionStorage`），TTL `SIGNER_REUSE_WINDOW_MS = 5 min`。生成 enrollment 时记住根钥，证书到达时若窗口未过就自动签 `admit-node`；过期则 pending 停在「待确认」，用户点确认按钮重新输密码。

### 3.5 pending 落 `sessionStorage`

键 `tmex.enrollment.pending`，内容 `{id, uid, rootEpoch, enrollPk, enrollSk, authorization, authorizationSig, exp, joinToken, name, createdAt}`。`enroll_sk` 与 join 串确实落在 `sessionStorage` 里——这是设计的显式要求（页面刷新后仍要能展示 join 串并完成 admit），且 `sessionStorage` 随标签页关闭即销毁、不跨 origin。过期 pending 在页面挂载时 `prune` 掉。

### 3.6 侧边栏聚合：按 node 分节 + 每行徽标

`SideBarDeviceList` 现在是分流器：

- `meshEnabled === false`（standalone 或 mode 未加载）→ 渲染 `SideBarDeviceListForRuntime`，即**今天的单 node 设备树**，不发任何 `/api/mesh/*` 请求、不开 `/mesh/ws`、不渲染徽标。
- mesh → `toSidebarEntries()` 映射（self 已由 `sortNodes` 排最前）后逐 node 渲染 `SidebarNodeSection`：
  - **在线且已登录**：`NodeRuntimeScope`（懒建该 node 的运行时，引用计数，卸载归还）→ panels 设备树，`nodeBadge` 传下去，非 self 用 `expansionKeyFor = ${nodeId}:${deviceId}` 隔离 UI store 的展开态（self 保持旧 key）；
  - **在线未登录**：只渲染 `NodeLoginButton`，**不建连接**（避免每次渲染撞 4401）；
  - **离线**：灰显 `inventory.devices` 里最近一次已知的设备名，链接 `/n/<id>/devices/<deviceId>`，不建连接、不发请求。
- self 恒按「已登录」处理：本地 UI 已过 `localUiGuard`，再显示登录按钮是死循环。

### 3.7 设备页头部徽标

`DevicePage.PageActions` 前置 `DeviceNodeBadges`：左徽标 = 浏览器↔node 承载（`primary` / `direct`）+ RTT，点击展开 ICE 诊断浮层；右徽标 = entry↔node 的 `reach`（`lan` / `relay` / `—`）。`self` 时整个组件返回 `null`。诊断数据来自 `resolveDirectDiagnostics(connection)`——F3-1 之前恒为 `{path:'primary', rtt:null, ice:null}`，浮层显示占位说明。**接口定义在 `packages/ws-client/src/direct/types.ts`**，F3-1 只需给 `GatewayConnection` 挂一个 `directDiagnostics: DirectDiagnosticsSource`，本侧零改动。

### 3.8 revoke 双写

设计要求 `revoke-node` 既要进 key-log，也要让 hub 断 uplink 并置 `nodes.status=revoked`。实现为：先 `POST /api/auth/keylog`，再 `POST /n/<hub>/api/hub/nodes/:id/revoke` 送**同一份** `{bytes, sig}`。两者是同一条记录（`computeRecordHash` 相同），不构成分叉；hub 侧失败降级为 warning toast（`nodes.revoke.hubFailed`），key-log 侧失败才算失败。`self` 行的吊销按钮恒 disabled（不能吊销当前入口自身）。

---

## 四、测试

| 包 | 前 → 后 | 说明 |
|---|---|---|
| `apps/fe` | 49 → **101**（0 fail） | 新增 52：`mesh-nodes` 14、`mesh-events` 12、`enrollment` 14、`sidebar-device-list` 8、`NodesPage` 4 |
| `packages/panels` | 196 → **199**（0 fail） | `node-badge` 3 |
| `packages/ws-client` | 75 → 75 | 未加测试（`direct/types.ts` 只有契约与桩，由 fe 侧的 `useDirectDiagnostics` 消费） |
| `packages/shared` | 281（0 fail） | 只改了 locale JSON |
| `packages/stores` / `packages/api-client` | 119 / 69（0 fail） | 未改动 |

覆盖点：

- **mesh-nodes**：指纹取 `sha256(pk)` 前 16 hex 且畸形输入不抛；`toRuntimeNodeId`；NODE_EVENT 的 online/offline/revoked 投影与「未知 nodeId 返回原引用」；`sortNodes` 的 self 优先；`mergeNodes` 的 hub 合并 / hub 为 null / hub 多出来的 node 不会凭空出现；`hubCandidates` 三条候选规则。
- **enrollment**：pending 写入 `sessionStorage` 并可重新读出（模拟刷新）、同 id 覆盖、过期被 prune；`enroll_pk` 命中 + `cert_sig` 有效 → ok 且给出 32 hex node id；别的 enroll key 签的证书 → `enroll_pk_mismatch` 且 `offerCertificate` 报 `unknown`；`cert_sig` 篡改 → `bad_cert_sig`；pending 过期 → `expired`；畸形串 → `unknown` 不抛；**`admit-node` 记录过 `verifyKeyLogRecord` 并被 `applyKeyLogRecord` 收下（`nodeCerts.size === 1`），payload 里内嵌的 authorization / certificate 与本地 pending 逐字节一致**；用错根钥验签必然 `bad_signature`；`revoke-node` 的 payload 形状（16 字节 node_id + reason）与签名；node id 长度不对直接拒绝；5 分钟窗口边界；`joinCommand` 的引号处理。
- **mesh-events**：NODE_EVENT / RTC_SIGNAL 往返与枚举映射、inventory 非 JSON 时保留原串、非 mesh kind 与畸形帧返回 null、`meshWsUrl` 的 scheme；`MeshEventSource` 的多播与注销、RTC handler 单一注册与注销、断线指数退避（100→200→400，连上后重置为 100）、退避上限、`stop` 后不再重连、未连上时 `sendRtcSignal` 返回 false。
- **sidebar**：`toSidebarEntries`（self 映射成 `self` 且恒已登录、entryNodeId 未知时无人被当作 self）、`inventoryDevices` 的容错；三种 node 形态的渲染（离线灰显 + `/n/<id>/devices/<id>` 链接 + 不渲染设备树；未登录只出登录按钮；在线已登录挂运行时并把徽标传给设备树）；**standalone 渲染与今天一致**（无 `sidebar-node-list`、无 `node-badge-`）。
- **NodesPage**：standalone 整页不渲染；mesh 下表格 self 在前、指纹 16 位、未登录行出 `NodeLoginButton`、账号安全链接；hub 不可达时提示 + 三个按钮 disabled；缺 uid / kdfParams 时不渲染表格。
- **panels**：`nodeBadgeAppearance` 的文案、灰显与名称回落。

> 说明 1：仓库无 DOM 测试环境（禁止 `bun install`），组件测试沿用 F4-2 的 `react-dom/server` + `MemoryRouter` 静态渲染。
> 说明 2：`sidebar-device-list.test.tsx` 里把 `./sidebar-device-list-runtime` mock 成一个探针。原因有二：本文件测的是**聚合与分支**（设备树本身由 panels 自己覆盖），且 `apps/fe/src/pages/FilePage.test.tsx` 用 `mock.module` **全局**替换了 `@tanstack/react-query`（一个空的假 `QueryClient`），该 mock 会泄漏到后续 test 文件，真实渲染 panels 列表时会在 `useMutation` 处炸。这是 F4-2 遗留的测试隔离问题，**不在本任务文件范围**，建议后续把那份 mock 收进 `beforeEach/afterEach` 或改用依赖注入。

### tsc / biome

| 包 | 基线 | 现在 |
|---|---|---|
| `apps/fe` | 0 | **0** |
| `packages/panels` | 0 | **0** |
| `packages/ws-client` | 0 | **0** |
| `packages/shared` | 0 | **0** |
| `packages/stores` | 1 | 1（既有 `host-services.test.ts`） |
| `packages/api-client` | 5 | 5（既有 `client.test.ts` / `files-download.test.ts`） |

`bunx biome check` 覆盖全部改动文件：只剩 `apps/fe/src/main.tsx:81` 的 `StatusBarSync` `useExhaustiveDependencies`——F4-2 已确认为**改动前既有**，本任务未动该 hook。未对 `resources.ts` / `types.ts` 等生成文件做 lint / format。

---

## 五、后端必须补的（阻塞 / 降级项）

按严重程度排序。

1. **【阻塞自动 admit】证书没有任何通道到达浏览器。**
   hub 收到 redeem 后只向 entry 的 **ctl 流**推 `enroll.redeemed`（`sub/b2-1-result.md`），而 `/mesh/ws` 的 `NODE_EVENT` schema 里没有证书字段，`GET /api/mesh/nodes`（`mesh-routes.ts`）与 `GET /n/<hub>/api/hub/nodes`（`hub-runtime.ts`）都不返回 `certificate` / `cert_sig`。
   任选其一即可打通：
   - （推荐）新增一个 Borsh kind `ENROLL_REDEEMED { enroll_pk, certificate, cert_sig }` 走 `/mesh/ws` 推给浏览器；前端只需在 `mesh-events.ts` 加一个 case 并调 `offerCertificate`。
   - 或者在 `GET /n/<hub>/api/hub/nodes` 的行里补 `certificate` / `cert_sig` 两个 base64url 字段（前端已按此前向兼容，补上即生效）。
   在此之前，enrollment 能正常创建、join 串能正常展示，但 admit 只能停在「待确认」，点确认按钮也会提示「尚未收到该节点的证书」。

2. **【阻塞一切签名动作】`GET /api/auth/keylog/head` 不存在**（F4-1 已提，本任务同样依赖）。`admit-node` / `revoke-node` 都要 `{seq, hash, rootEpoch, uid}`。

3. **【阻塞】`GET /api/auth/mode` 缺 `rootEpoch`。** 记录的 `root_epoch` 必须等于用户当前 epoch，否则 gateway 报 `epoch_mismatch`；hub 的 `POST /api/hub/enrollments` 也会用 `authorization.root_epoch !== user.rootEpoch` 拒掉。前端缺失时退化为 `0`——用户 rotate 过根钥后**所有** Nodes 页动作都会失败。

4. **【功能缺失】hub 的 `config.publicUrl` 没下发给浏览器。** join 命令里的 `<hub 地址>` 目前退化成当前页面 `location.origin`（`hubPublicUrl()`），hub,node 同机时正确，其它拓扑下用户需要自己改。建议在 `GET /n/<hub>/api/hub/nodes` 的响应里加 `publicUrl`，或新增 `GET /n/<hub>/api/hub/info`。

5. **【功能缺失】没有 hub 标志位。** `useHubNode()` 只能启发式探测（3.2）。建议在 `GET /api/mesh/nodes` 的行里加 `roles: string[]`（或 `is_hub: boolean`），或在 `/api/auth/mode` 里加 `hubNodeId`——`useHubNode` 已经支持传入 `hubNodeId` 直接跳过探测。

6. **【降级】passkey 无法发起 enrollment。** join 串 = `enroll_sk ‖ root_public_key ‖ key_log_head_hash`，浏览器拿不到 `root_public_key`（`/api/auth/mode` 不下发，只有密码路径能从 `deriveRootKey` 现算出来）。因此「新增节点」目前**只支持密码（根钥）**。若要支持 passkey 发起 enrollment，请在 `/api/auth/mode` 或 keylog head 响应里加 `rootPublicKey`（base64url）——`createEnrollmentOnHub` 的签名改成接收 `{signer, rootPublicKey}` 即可，`createEnrollment` 本身已支持 `PasskeySigner`。

7. **【一致性】revoke 双写的幂等。** 前端把同一条 `{bytes, sig}` 同时送 `POST /api/auth/keylog` 与 hub 的 revoke 端点。请确认两侧 append 同一条记录时返回成功（或至少不返回 `KEY_LOG_FORK`）——`detectFork` 比的是 `computeRecordHash`，同字节同签名不应判分叉，但 `seq_gap` 的判定需要 gateway 侧确认。若后端希望只写一处，请明确哪一处，前端删掉另一处即可。

8. **【已由协调者完成】** `packages/shared/src/ws-borsh/index.ts` 已 re-export `KIND_NODE_EVENT` / `KIND_RTC_SIGNAL` / `NODE_EVENT_STATUS_*` / `RTC_SIGNAL_FROM_*`，`mesh-events.ts` 直接 `wsBorsh.KIND_NODE_EVENT` 可用。

---

## 六、遗留 / 开放问题

1. **`packages/ws-client/src/index.ts` 未导出 `direct/types`**（该文件不在本任务范围）。fe 走子路径导入 `@tmex/ws-client/direct/types`（package.json 已有 `"./*": "./src/*.ts"`）。F3-1 落地时建议一并加进 barrel。
2. **`RTC_SIGNAL` 的下行 handler 只留了钩子**：`MeshEventSource.setRtcSignalHandler()` 与 `sendRtcSignal()` 已可用，但没有消费者。Phase 3 的 `DirectCarrierController` 直接注册即可。
3. **离线 node 的 inventory 形状是猜的**：`inventoryDevices()` 读 `inventory.devices[] = {id, name}`。node 的 `node.status` ctl 目前只上报 `{version, tmux, direct_capable, inventory:{}, endpoints}`，`inventory` 里到底放不放设备清单尚未定。若后端定了别的形状，只需改这一个纯函数（有测试）。
4. **`admit-node` / `revoke-node` 暂只支持根钥签名。** `RecordSigner` 的 passkey 分支（F4-1 已实现）在 UI 上没有入口——Nodes 页的三处交互都直接 `prompt` 密码。要加 passkey 选项需要 `GET /api/auth/passkeys`（F4-1 已提的可选端点）来列出可用凭证。
5. **`prompt()` / `confirm()` 作为交互**：吊销的确认、原因输入与密码输入用了浏览器原生对话框，移动端体验一般。做成 Dialog 需要 `@tmex/ui/dialog` 的表单封装，属于纯 UI 打磨，未做。
6. **`useEnrollmentWatch` 的 5 秒轮询会打两个接口**：只在存在 pending 时启动，pending 清空即停。后端补上推送后应把 `collect` 换成 no-op 或直接删掉这段轮询。
7. **未跑 e2e**（任务禁止）。改动面涉及侧边栏结构与 `main.tsx` 路由表，合入后建议跑一轮 fe e2e 对齐 `e2e-baseline-failures` 的既有 9 个失败。
8. **未碰**：生产 tmex、名为 `tmex` 的 tmux session、`bun install`、`apps/gateway/**`、`packages/app/**`、`packages/shared/src/{auth,link}`、F4-2 已有的 `apps/fe/src/node/{node-runtimes.ts, node-runtime-boundary.tsx}`（只新增了同目录的文件）。
