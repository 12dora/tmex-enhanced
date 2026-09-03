# R3 结果：中继模式密钥日志本地优先 + `relay,node` 退出 mesh

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`），未 commit。

## 零、结论速览

| 审查项 | 判定 | 结果 |
|---|---|---|
| 1. `set-relays` 走 `?hub=sync` 会死锁 | **属实，且比报告更严重** | 已在服务端修好；**前端一行都不用改** |
| 2. `relay,node` 退不出 mesh、退出不清中继密钥 | **属实** | 已修（含纯 `relay` 明确拒绝） |
| 附加发现 A：记录类型版本门禁在节点侧一律 fail-closed | 属实（**并行 agent 已修完**） | 我独立复现并确认；最终修法在 `hub-authorization.ts`，`src/hub` / `auth-routes.test.ts` 现已全绿 |
| 附加发现 B：`RelaySecrets.targetsKey()` 不含令牌 | 属实，影响有限 | 未改（B5 文件），见 §四.2 |

---

## 一、发现 1（BLOCKER）：`POST /api/auth/keylog?hub=sync` 在中继模式下必然死锁

### 1.1 核实：实际有三处独立的堵点，比审查意见描述的更宽

读 `apps/gateway/src/mesh/auth-key-log-routes.ts`（`handleKeyLog` 老版本）+ `uplink-pool.ts` + `relay-wiring.ts` 之后确认：

1. **`refuseIfAttachedNotWriter()` 会挡住中继模式下的每一条记录（不只是 `set-relays`）。**
   `UplinkPool.promote()` 在挂上中继时也会写 `this.attached = {hubNodeId: null, publicUrl: <中继 url>, ...}`，
   而 `runReconcile()` 切到 relay 时把 `mesh_hubs` 清空（`relay-wiring.ts:56`）。于是
   `attached != null` 且 `authorizedHubRows() = []` → `pickWriterHub([]) = null` → **409 `HUB_NOT_WRITER`**。
   受害的是 `revoke-node` / `admit-node` / passkey 增删 / `meta-key` / `set-relays` 全部记录。
2. **`handleKeyLogHubSync()` 等上级 ACK。** `usesHubSync()` 在 `roles.node && !roles.hub` 时**即使不带 `?hub=sync` 也返回 true**，
   之后 `publisher.publishAndAck` → `UplinkPool.requireLive()`，没有活跃上级直接 `throw new Error('uplink is not online')`
   → `safePublishAndAck` 兜成 `{ok:false, error:'uplink is not online'}` → **409**；
   若池子活着但中继未认证，`RelayKeyLogSync.appendAndAck` 立刻回 `{ok:false, error:'offline'}` → 同样 409。
   三个场景全中：(a) 首次接入没有任何上级；(b) 被踢后链路已断；(c) 迁移时旧 hub 未必认识 `set-relays`。
3. **迁移时 `set-relays` 会被灌回旧 hub。** 老实现在 `apply` 成功后无条件 `publisher.publish(...)`；
   hub 模式下这条记录会经 `key.log.append` 送到旧 hub，旧 hub 版本不够会拒，够的话又会把**它自己**也拖进中继模式
   （hub 侧同样跑 `user-key-persistence` 的 `set-relays` 应用）。两种结果都不对。

### 1.2 落地的行为（服务端修，前端契约不变）

新增纯函数（`auth-key-log-routes.ts`，已导出便于测试）：

```ts
export function definesUplink(bytes: Uint8Array): boolean;          // 记录类型 ∈ RELAY_RECORD_TYPES（set-relays / meta-key）
export type KeyLogAppendPlan = { localFirst: boolean; publish: boolean };
export function planKeyLogAppend(input: { relayMode: boolean; bytes: Uint8Array }): KeyLogAppendPlan;
//   localFirst = relayMode || definesUplink   —— 本地优先落账，不等上级
//   publish    = relayMode || !definesUplink  —— 是否把记录推给当前上级
```

`relayMode` **不新增任何依赖注入**：从已应用的密钥日志直接读
（`keyLogService.currentState(uid).relays?.relays.length > 0`）。这是权威来源，且比 `node_identity.uplink_kind`
早一步生效（`uplink_kind` 要等 `RelaySecrets.reconcile()` 落库）。因此 `auth-routes.ts` / `mesh-http.ts` /
`mesh-runtime.ts` **一行未改**（原本的 `relayMode?: () => boolean` 注入方案会把 `auth-routes.ts` 顶破门禁额度 767，已撤回）。

`handleKeyLog` 拆成 `handleKeyLog`（读 body）→ `appendKeyLog`（决策）→ `applyKeyLogLocally` / `handleKeyLogHubSync`：

| 情形 | 行为 |
|---|---|
| `set-relays` / `meta-key`（任何模式） | 跳过 attached-writer 判定；**不**走 hub ACK；本地验签+链校验后落账；**不**推给旧上级（hub 模式下 `publish=false`），由 `set-relays` 应用触发的 `reconcileQuietly + reconfigureUplinkPool` 重连中继后，`RelayKeyLogSync` 的 catch-up（`local.seq > remote` → `pushMissing`）自动补推整段日志 |
| 中继模式的其它记录 | 跳过 attached-writer 判定；不等中继 ACK；本地落账后 `publisher.publish()` 尽力推（`RelayUplinkClient.sendCtl('key.log.append')` → `RelayKeyLogSync.appendAndAck`，会自动挂 `member` 证明）；中继离线时 publish 抛错被吞，改由重连后的 catch-up 补推 |
| hub 模式的其它记录 | **完全不变**：attached-writer 判定 → 版本门禁 → `handleKeyLogHubSync`（等 hub ACK、重试、`queryKeyLogAt` 兜底、504 `HUB_TIMEOUT`） |

- 版本门禁 `refuseUnsupportedHubAuthRecord` **保留**在所有分支（`set-relays`/`meta-key` 的 `minVersion 1.1.23`、`allowForce:false` 照旧生效）。
- 响应体：本地优先落账时返回 `{ ok:true, seq, hash, hubAck: true, localApply: true }`。
  `hubAck: true` 是**故意**的——中继模式下本地日志就是权威，「已确认」= 已落账。
  前端三处判定（`relay-enroll.ts` 的 `hubAck === false`、`use-node-row-actions.ts` / `self-revoke.ts` / `enrollment.ts` 的 `hubAck !== true`）
  因此全部照旧工作，**不需要 F1/F3 改任何代码，也不需要新的 query flag**（`?hub=local` 之类没有引入）。
  `localApply: true` 只是给排查用的附加字段，前端忽略它即可。
- 非 `hub=sync` 的老路径（hub 自己 append）响应体一字未变（无 `hubAck` / `localApply`）。

### 1.3 权衡与风险（请指挥官知晓）

- **中继不再仲裁 seq**。老 hub 模式靠 `publishAndAck` 让 hub 挡住并发同 seq 的写，中继模式现在不挡：
  两台节点同时写会各自落本地、其中一台在中继上被 `SEQ_MISMATCH` 拒，之后 catch-up 里 `applyMany` 报 fork 并打 warn。
  这是 plan §1.4「本地成员表权威、中继注册表可重建」的直接后果，也是任务书要求的「`hub=sync` 绝不阻塞中继」的代价。
  实际风险低（前端所有写都在 `withKeyLogLock` 里，且同一时刻一般只有一个管理会话）。
  中继的 ack 错误（`BAD_SEQ` / `SEQ_MISMATCH`）**刻意不再转成 HTTP 错误**——它同样可能只是「中继落后」（本地离线期间写过），
  转成 409 会把节点永久卡死。
- `hub,node` 的机器如果密钥日志里出现了非空 `relays`（plan 明令 relay 与 hub 不同机，正常不会发生），也会被判成中继模式。
  真出现这种配置本身就是错误配置，此处不额外兜底。

### 1.4 新增测试

`apps/gateway/src/mesh/auth-key-log-relay.test.ts`（479 行，9+1 条用例，全部走真实 `MeshHttpRuntime` + 真实登录 +
真根钥签名 + 真 `buildSetRelaysPayload`/`buildMetaKeyPayload`，`RelaySecrets` 真落库）：

1. **(a) 首次接入**：`publishAndAck`/`publish` 都抛 `uplink is not online` → 200 + `hubAck:true` + `localApply:true`，
   head +1，`acked`/`published` 均为空（不回灌旧上级），reconcile 后 `uplinkKind()==='relay'`、`mesh_relays` 有行、令牌可解密对拍。
2. **(b) 被踢后 reauth**：先接入→ `markKicked(true)` → 再签一条新令牌的 `set-relays` → 200，`mesh_relays` 里换成新令牌且 `kicked` 归零。
3. **(c) hub → 中继迁移**：`attachedHub()` 指向一个 writer hub、publisher 可用 → 200，`acked`/`published` 仍为空（旧 hub 既没被问也没收到）。
4. hub 模式 attached 不是 writer 时普通记录仍 409 `HUB_NOT_WRITER`（回归）。
5. 中继模式普通记录不再被 `HUB_NOT_WRITER` 挡住，且 `published` 有 1 条、`acked` 为 0。
6. 中继离线时普通记录照样 200 落账（不再 504/409）。
7. `meta-key` 同样本地优先（吊销后的轮换不依赖中继在线），reconcile 后 `currentMetaEpoch()===2`。
8. 追加第二条中继：两个目标按 priority 落 `mesh_relays`。
9. 退出前的自吊销：中继模式下 200 + `hubAck:true`，本机证书 `revokedLogSeq` 已写，且这条记录被推给中继（`published` 1 条）。
10. hub 模式普通记录仍先等 hub ACK（回归，`acked` 1 条、无 `localApply`）。

---

## 二、发现 2（MAJOR）：`relay,node` 退出 mesh

### 2.1 核实：属实

`local-routes.ts` 的 `isMeshRoleName()` 只认 `node | hub,node`，前端 `MeshRole`（`Exclude<LocalRole,'standalone'|'relay'>`）
会发 `relay,node` → 409 `role_mismatch`；`MeshMembershipStore.clearAll()` 也没删 `mesh_relays` / `mesh_secrets`。

### 2.2 落地的行为

- `packages/api-client/src/local/types.ts`：新增 `export type LocalMeshRole = Exclude<LocalRole, 'standalone' | 'relay'>`；
  `LocalLeaveRequest.expectedRole` / `LocalLeaveResponse.fromRole` 改用它（= `'node' | 'hub,node' | 'relay,node'`，与前端 `MeshRole` 同集合）。
- `membership-reset.ts`：`MeshRoleName` 收窄为 `Exclude<TmexRoleName,'standalone'|'relay'>`；
  新增并导出 `isLeavableRoleName()`；`leaveMesh` 的守卫从 `fromRole === 'standalone'` 换成 `!isLeavableRoleName(fromRole)`，
  纯 `relay` 与 `standalone` 一律 **400 `not_member`**（消息带角色名：`relay has no mesh membership to leave`）。
- `local-routes.ts`：`handleLeave` 的前置守卫从 `isStandaloneRoles(deps.roles)` 换成 `!deps.roles.node`
  （纯 `relay` 在**查会话之前**就 400，它本来也没有本机用户）；`expectedRole` 用 `isLeavableRoleName()` 校验，
  传 `'relay'` 仍是 409 `role_mismatch`。
- `apps/gateway/src/auth/mesh-membership-store.ts`：`clearAll()` 增删 `mesh_relays`、`mesh_secrets`。
  `node_identity` 本来就整行删除，所以 `uplink_kind` / `name` 随之消失（退出后 `uplinkKind()` 回到 `'hub'`、`localName()` 为 null）。
- `packages/app/src/commands/hub.ts`（R2 领地，**1 行编译修**）：`runHubLeave` 里
  `expectedRole: fromRole === 'standalone' ? 'node' : fromRole` → `isLeavableRoleName(fromRole) ? fromRole : 'node'`
  （类型收窄后 `'relay'` 不再可赋值；语义不变：不可退角色都会在 `leaveMesh` 里拿到 400 `not_member`）。

**残留角色的裁定：`relay,node` 退出后落到 `standalone`（而不是保留 `relay`）。** 理由：
① 前端本机卡片的可选角色只有 `standalone | node | hub,node`（`local-machine-card.tsx:57`），
`relay,node → node/hub,node` 的「切换」也是先退出再跑向导，退出后必须还有网页才能继续；保留纯 `relay` 会让页面直接消失。
② 与既有的 `hub,node → standalone` 完全一致——那条路同样会把别的节点依赖的 hub 一起停掉。
③ 中继侧的数据（`relay_tenants` / `relay_key_log` 等）不动，`TMEX_RELAY_*` 也不清，
运营者把 `TMEX_ROLES` 改回 `relay,node` 即可恢复对外服务。

**「把吊销推给中继、让注册表丢掉这个节点」**：这一步由「前端自吊销 + 发现 1 的修复」共同完成，`leaveMesh` 里不需要额外接线——
`self-revoke.ts` 在调 `/api/local/leave` **之前**就走 `?hub=sync` 送 `revoke-node`，现在这条记录会本地落账并
经 `RelayKeyLogSync.appendAndAck` 带上 `member:{op:'revoke'}` 推给中继（见测试 §1.4.9）。已知边界（plan §1.12）：
中继只认**根签名**的 revoke，passkey 签的会被 `member_ignored`；中继当时离线则这条记录随后被清库带走，
注册表会留一条陈旧的 admitted 行，需要运营者手动 `tmex relay kick`。

### 2.3 新增测试

- `packages/app/src/runtime/membership-reset.test.ts`（+3）：
  `relay,node` 可退出且 `mesh_relays`/`mesh_secrets`/`node_identity` 全空、env 落 `standalone`；
  纯 `relay` 400 `not_member` 且**不清库**（`mesh_relays` 仍在、env 仍是 `node`）；
  `relay,node` 报成 `node` 仍 409 `role_mismatch` 且不清库。新增 fixture `seedRelayAttachment()`。
- `packages/app/src/runtime/local-routes.test.ts`（+3）：
  `expectedRole:'relay,node'` 不再 409（走到 401 就说明这一关过了）；
  纯 `relay` 400 `not_member` 且 `authenticate` 一次都没被调；`expectedRole:'relay'` 仍 409 `role_mismatch`。
- `apps/gateway/src/auth/mesh-membership-store.test.ts`：扩到覆盖 `mesh_relays` / `mesh_secrets`，
  并断言 `uplinkKind()` 回落 `'hub'`、`localName()` 为 null。

---

## 三、改动文件清单

新增：

| 文件 | 行 |
|---|---|
| `apps/gateway/src/mesh/auth-key-log-relay.test.ts` | 479 |

修改：

| 文件 | 说明 |
|---|---|
| `apps/gateway/src/mesh/auth-key-log-routes.ts` | 本任务主体（443 → 515 行）：`definesUplink` / `planKeyLogAppend` / `readKeyLogAppend` / `inRelayMode` / `appendKeyLog` / `applyKeyLogLocally`；`keyLogSuccess` 改成 options 形参并加 `localApply` |
| `apps/gateway/src/auth/mesh-membership-store.ts` | `clearAll()` 增删 `mesh_relays` / `mesh_secrets` |
| `apps/gateway/src/auth/mesh-membership-store.test.ts` | 覆盖上面两张表 |
| `packages/app/src/runtime/membership-reset.ts` | `MeshRoleName` 收窄 + `isLeavableRoleName` + 守卫 |
| `packages/app/src/runtime/membership-reset.test.ts` | +3 用例 + `seedRelayAttachment` |
| `packages/app/src/runtime/local-routes.ts` | 接受 `relay,node`、纯 `relay` 明确 400 |
| `packages/app/src/runtime/local-routes.test.ts` | +3 用例 |
| `packages/app/src/commands/hub.ts` | 1 行编译修（R2 领地，改前重读过） |
| `packages/api-client/src/local/types.ts` | `LocalMeshRole` |

**没有改** `auth-routes.ts` / `mesh-http.ts` / `mesh-runtime.ts` / `relay-wiring.ts` / `relay-key-log-sync.ts` /
`uplink-pool.ts` / `setup-service.ts` / 任何 `apps/fe` 文件 / 任何 allowlist。

---

## 四、附带发现（不在 R3 修复范围，请指挥官分派）

### 1. 记录类型版本门禁在节点侧一律 fail-closed（P0，**并行 agent 已修完，无需再派活**）

`nodesBlockingMinVersion()` 遍历 `node_certs` 后查 `nodes.version`，而 `nodes` 表**只有 hub 侧代码会写**
（`hub/node-persistence.ts`；节点侧的 `node.list` 只进内存 `state.lastNodeList`）。所以普通节点/中继租户上
`nodes` 是空表 → 每张证书都被判「版本过旧」→ `set-relays` / `meta-key` 一律
409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` 且 `allowForce:false`，**接中继的第一步就走不动**。

这是我在写 (a) 用例时独立撞到并复现的（去掉测试里那行 `createNode({version:'1.1.23'})` 就稳定 409）。
写报告期间有并行 agent 在 `apps/gateway/src/hub/hub-authorization.ts` 把它修掉了，最终形态是
`if (isRelayRecordType(type) && userStore.listNodes().length === 0) return { ok: true };`
——只对中继记录放行空注册表，`rotate-root-keep` / hub-auth 仍 fail-closed。
该修法中途有一版打红了 3 条老用例，现在已全部恢复（`src/hub` 208 pass、`auth-routes.test.ts` 63 pass），
我在 `auth-routes.test.ts` 里加的临时补丁也已撤掉，该文件回到未改动状态。

**我的用例仍然刻意给本机建了一行 `nodes{version:'1.1.23'}`**，这样版本门禁是**真的跑过**再放行，
而不是靠空注册表逃逸——两条路径都有覆盖。

### 2. `RelaySecrets.targetsKey()` 不含租户令牌（P2，B5 的 `relay-secrets.ts`）

`targetsKey()` 只拼 `uplinkKind|priority:url`，所以「同一个中继、只换令牌」的 reauth 拿到 `targetsChanged=false`，
不会触发 `reconfigureUplinkPool`。好在 `buildRelayAuth()` 每次认证都现读 `store.getRelay(url)`，
所以池子**下一次退避重连**就会用上新令牌——只是恢复时间取决于退避窗口，而不是立刻。
若要秒恢复，`targetsKey()` 加一段令牌指纹（如 `sha256(token).slice(0,8)`）即可。

### 3. 中继模式下 `/api/auth/keylog` 的 `hubAck` 语义已被重载

`hubAck: true` 在中继模式表示「本地权威日志已落账」，不代表中继已收到。想区分的话看新增的 `localApply: true`。
如果后续要给前端做「中继尚未收到该记录」的提示，建议在 `/api/mesh/relay/status` 里加 `keyLogRemoteHead`，
而不是改 `hubAck`（改了会连带打破 admit/revoke 的三处判定）。

---

## 五、给指挥官 / 前端的契约结论

- **前端不需要任何改动。** `?hub=sync` 在服务端做对了：中继模式与 `set-relays`/`meta-key` 一律本地优先，
  仍返回 `hubAck: true`，`relay-enroll.ts` / `self-revoke.ts` / `use-node-row-actions.ts` / `enrollment.ts` 的判定全部照旧成立。
  **没有引入 `?hub=local` 之类的新 flag。**
- `POST /api/local/leave` 的 `expectedRole` 现在接受 `'node' | 'hub,node' | 'relay,node'`；
  纯 `relay` → 400 `{error:{code:'not_member'}}`（且不查会话）；`expectedRole:'relay'` → 409 `role_mismatch`。
  `relay,node` 退出后落 `standalone`（会同时停掉中继服务，理由见 §2.2），响应仍是 `{ok:true, fromRole:'relay,node', restarting:true}`。
- 若产品上希望「退出租户但保留中继服务」，需要前端先把 `relay` 加进本机卡片的可选角色，
  再给 `/api/local/leave` 加一个显式的目标角色字段；本轮没有做，也没有猜着做。

---

## 六、验证

| 项 | 结果 |
|---|---|
| `apps/gateway: bun test src/mesh src/auth src/db` | **1322 pass / 0 fail**（111 个文件） |
| `apps/gateway: bun test src/mesh/auth-routes.test.ts src/auth src/mesh/relay-key-log-sync.test.ts src/mesh/auth-key-log-relay.test.ts` | 168 pass / 0 fail |
| `apps/gateway: bun test src/hub src/mesh/auth-routes.test.ts src/mesh/auth-key-log-relay.test.ts` | **282 pass / 0 fail** |
| `packages/app: bun test src/runtime` | **168 pass / 0 fail**（基线 162 + 本任务 6） |
| `packages/api-client: bun test src/local` | **35 pass / 0 fail**；`bun test`（全量）199 pass / 0 fail |
| `bunx tsc --noEmit -p apps/gateway` | **0 error** |
| `bunx tsc --noEmit -p packages/app` | **0 error** |
| `bunx tsc --noEmit -p packages/api-client` | 5 error（`client.test.ts` ×4、`files-download.test.ts` ×1，均为基线） |
| `bunx biome check`（本任务全部改动文件） | clean |
| `bun run lint`（全仓） | 剩 2 条，均非本任务文件：`apps/fe/src/main.tsx`（import 排序）、`apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`（format） |
| `bun scripts/complexity/gate.ts` | 本任务文件零违规；全仓剩 `apps/gateway/src/mesh/relay-uplink-client.ts` 608>600、`apps/gateway/src/relay/integration/relay-mesh-harness.ts` >600（均 B5） |

未跑：Playwright e2e、真实中继实例实测（按分工留给 B5 / 指挥官）。
