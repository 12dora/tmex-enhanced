# B5 结果：中继进程内集成测试（1 中继 × 2 租户 × 2 节点）、密钥日志帧上提 shared、版本门禁、packages/app 类型门禁

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`）。未 commit。

## 一、改动文件

### 新增

| 文件 | 行 | 内容 |
|---|---|---|
| `packages/shared/src/relay/keylog-frame.ts` | 54 | 密钥日志块明文帧（B3/B4 重复实现的唯一权威版本） |
| `packages/shared/src/relay/keylog-frame.test.ts` | 58 | 4 例（帧形状 / 变长签名 / 非法输入 / 信封往返） |
| `apps/gateway/src/relay/integration/relay-mesh-types.ts` | 126 | 集成 harness 的类型、常量、`ShortBackoffScheduler`、`waitUntilAsync` |
| `apps/gateway/src/relay/integration/relay-mesh-harness.ts` | 248 | 起 RelayRuntime + 若干真实节点栈（`createMeshRuntime`）、fetch/ws 接线 |
| `apps/gateway/src/relay/integration/relay-tenant-ops.ts` | 378 | 租户操作：enroll / 签记录 / r3 加入 / 承认 / 吊销 / 换 K_meta |
| `apps/gateway/src/relay/integration/relay.integration.test.ts` | 312 | 5 例：接入与扇出、proof 端到端、双租户隔离、密钥日志双向同步、r3 路由 |
| `apps/gateway/src/relay/integration/relay-membership.integration.test.ts` | 277 | 6 例：改密 kick/keep、吊销+轮换、两类配额、hub→relay 迁移 |

### 修改

- `packages/shared/src/relay/index.ts`：barrel 追加 keylog-frame 导出块。
- `apps/gateway/src/mesh/relay-key-log-sync.ts` / `.test.ts`：删掉本地重复实现，改用 shared。
- `packages/app/src/lib/relay-keylog.ts` / `.test.ts`、`packages/app/src/commands/relay-join.test.ts`：同上，`openRelayKeyLogPage` 改调 shared 的 `openRelayKeyLogRecord`。
- `apps/gateway/src/mesh/relay-node-list.ts`：新增 `acceptRelayEnrollRedeemed()`（归一化 + 落库），见 §三.1。
- `apps/gateway/src/mesh/relay-uplink-client.ts:405`：`handleEnrollRedeemed` 改调上面那个。
- `apps/gateway/src/mesh/relay-wiring.ts:60-68`：K_meta 世代变化后立刻重发状态块，见 §三.2。
- `apps/gateway/src/hub/hub-authorization.ts:214` + `.test.ts`：版本门禁在空注册表上放行中继记录，见 §三.3。
- `apps/gateway/src/mesh/mesh-runtime.ts:1423`：`MeshRuntime.stop()` 顺带停自己造的 `HubRuntime`，见 §三.4。
- `apps/gateway/src/relay/relay-units.test.ts` / `relay-uplink.test.ts`：版本门禁用例，见 §四。
- `packages/app/tsconfig.json`：`types: ["node"]` → `["bun"]`，补 `noEmit` / `allowImportingTsExtensions` / jsx 三项，见 §五。

## 二、集成场景与断言（11 例，全部真实节点栈）

harness 的节点栈 = `createMigratedAuthDb` + `ensureNodeIdentity` + `createMeshRuntime`（真实 `UplinkPool` / `RelayUplinkClient` / `RelayKeyLogSync` / `RelaySecrets` / `UserKeyService` applier / `/api/mesh/relay/*` 路由），
链路走 `fakeSocketPair` + `WebSocketLink` 接进 `RelayRuntime.uplink.accept()`；`globalThis.fetch` 被临时改写，
把发往 `https://relay.example` 的请求接进进程内 `RelayRuntime.handleRequest`（teardown 还原）。
签记录一律走真实 HTTP：`GET /api/auth/keylog/head` → 根钥签 → `POST /api/auth/keylog[?hub=sync]`。

| plan §四 | 用例 | 断言 |
|---|---|---|
| (b) | `口令 enroll 后 set-relays 落到两个节点…` | 两侧 `mesh_relays.uplink_kind='relay'`、同一 tenant_id；双方 `peer_cache` 出现对方名字（= `relay.list` 里的对端状态块被 K_meta 解开）；`/api/mesh/relay/status` mode=relay/attached/online/reauthRequired=false；`nodesViaRelay=1`；中继内存里的 `statusBlob` 用租户 K_meta 能解出 `{name:'alpha-b'}`（中继自己解不开） |
| (h) | `enroll proof 端到端` | 口令错 → 401 且透传中继错误码 `RELAY_PASSWORD_INVALID`；别的根钥签的 proof → 节点本地 400 `BAD_PROOF`（不打中继）；正确路径返回 `{tenantId(32hex), token(32B), payload}` 且中继 `relay_tenants` 已建行 |
| (a) | `两个租户互不可见` | 两租户 tenant_id 不同；各自 `peer_cache` 只有本租户成员、查不到对方节点；跨租户 `openRelay` → `rst / unknown-target`；同租户 `openRelay` 首帧带 `from` 送达对端；alpha 的租户令牌读 beta 的 enrollment → 401 |
| (c) | `A 追加记录经中继推给 B；迟到的节点下载整段积压` | 迟到节点 join 时下载的整链 head hash 与主节点一致；主节点新签 `meta-key` 后 B 经 `relay.keylog.push` 拿到新 epoch 并应用；三方 head seq 收敛（本地 A = 本地 B = 中继 `relay_tenants.key_log_head_seq`） |
| (i) | `CLI 用的两条中继路由` | `GET /api/relay/tenants/:id/enrollments/:enrollPk` 返回 authorization 且 `used_at=null`、解出的 uid == 租户 uid；令牌不对 → 401；`redeem` 返回 `relays` 与可用 K_log 逐条解开的连续日志（条数 == 主节点 head seq）；中继登记 `pending`；重放 redeem → 400 |
| (d) | `kick 模式作废旧令牌，重新 enroll 后恢复` | 改密(kick) 后节点收到 `relay.kicked` → `mesh_relays.kicked=true`、注册表里链路消失、`reauthRequired=true`；旧口令再 enroll → 401；新口令重新 enroll → tenant_id 不变、kicked 清零、重新 online |
| (d) | `keep 模式改密后旧令牌继续可用` | `passwordEpoch=2` 且 `minTokenEpoch=0`；注册表里的 `RelayLiveNode` 对象没被替换（未断线）；节点侧无 kicked、仍 online |
| (e) | `吊销节点后 meta-key 轮换` | 主节点 epoch +1，被吊销方 `mesh_secrets` 里没有新 epoch；中继 `relay_nodes.status='revoked'`（根签名的 revoke 成员证明）且链路被踢；主节点用新世代重封状态块后，**旧 K_meta 解该块抛 `RelayCipherError`**，新 K_meta 能解；本地 `node_certs.revoked_log_seq` 已置 |
| (f) | `节点数配额在 redeem 时生效` | `maxNodes=1` 后新节点 redeem → 409 `RELAY_QUOTA_NODES` |
| (f) | `并发流配额生效` | `maxStreams=1` 后第二条 relay 流 → `rst / quota-streams` |
| (g) | `hub,node 节点接入中继后切到中继上级` | 迁移前 attach 自己的 hub（memory 传输）、`mode='hub'`；enroll 并落 `set-relays` 后池子重建 → `attachedHub().publicUrl == 中继`、`mode='relay'`、`metaEpoch>0`、`uplink_kind='relay'`、`/api/mesh/hubs` 返回 `hubs: []`、中继注册表里有该节点 |

## 三、集成过程中发现并修掉的缺陷

### 1. 中继模式下 `enroll.redeemed` 不落库 → r3 加节点走不完（阻断级）

`apps/gateway/src/mesh/relay-uplink-client.ts` 收到 `enroll.redeemed` 后只调 `onEnrollRedeemed`，而 mesh-runtime 把它接到
`MeshRoutes.forwardEnrollRedeemed`（`mesh-routes.ts:390`）——那个函数第一行就是 `if (!msg.entrySid) return;`，而中继的
`enroll.redeemed` **没有 entry_sid**（B2 §六.8 已写明）。结果：本地 `enrollment_tokens` 行永远 `used_at = null`，
`GET /api/mesh/relay/enrollments/:id` 永远 `status: 'pending'`，主节点也就永远拿不到证书去签 `admit-node`——
**r3 加入的节点无法被承认**。

修法（`relay-node-list.ts:219`，与 hub redeem 的落库形状逐字段对齐）：

```ts
export function acceptRelayEnrollRedeemed(userStore, msg, now): UplinkEnrollRedeemed | null {
  const normalized = toUplinkEnrollRedeemed(msg);      // 原来的解析
  if (!normalized) { warn; return null; }
  persistRelayEnrollRedeemed(userStore, normalized, now);   // 新增：consumeEnrollmentToken
  return normalized;
}
```
`persistRelayEnrollRedeemed` 用 `userStore.consumeEnrollmentToken(enroll_pk, { nodeId, now, authorizationJson })`
把 `certificate_b64` / `cert_sig_b64` / `node_id` 并进 `authorizationJson`（`hub-runtime.ts:1234` 同款），
已用过或不存在的行返回 false（重复广播幂等）。`relay-uplink-client.ts:405` 改调它。

### 2. 拿到新 K_meta 后不重发状态块 → 对端最长一个心跳周期看不见本节点

节点刚 attach 时若还没有 K_meta（r3 加入方在 `meta-key` 记录到达前就是这种状态），`buildRelayStatusMessage` 返回
null，状态块发不出去；随后 `meta-key` 记录到账、`RelaySecrets.reconcile()` 解出新世代，但**没有任何地方重发状态块**，
只能等下一次心跳（`UPLINK_PING_INTERVAL_MS`）里的 `sendStatusIfChanged`。表现是新节点承认之后仍有一个心跳周期
「在线但无名字、无 endpoints」，`peer_cache` 也不更新。

修法（`relay-wiring.ts:33-68`）：`RelayBinding` 记住上次的 `metaEpoch`；`runReconcile` 里世代变化且不需要重建池子时
`bound.uplink.liveClient()?.sendStatus()`。

### 3. 版本门禁把节点侧的 `set-relays` / `meta-key` 全部堵死（阻断级）

`inspectHubAuthRecordCompat` → `nodesBlockingMinVersion` 用 `userStore.getNode(cert.nodeId)?.version` 判定；
**`nodes` 注册表只有 hub 侧会写**（redeem 时 `hub-runtime.ts:1244`，uplink 认证时 `uplink-server.ts:1371`）。
中继租户是纯节点，那张表永远为空 → 每个 cert 的 version 都是 null → `set-relays` / `meta-key`
（B1 给它们定的 `minVersion=1.1.23, allowForce=false`）在 `POST /api/auth/keylog` 上一律 409
`KEYLOG_TYPE_UNSUPPORTED_BY_NODES`，且 `x-tmex-force-keylog` 也救不了。实测：租户 enroll 的第一条记录就提交不了。

修法（`hub-authorization.ts:210-214`）：

```ts
// 版本来自 `nodes` 注册表，而注册表只有 hub 侧会写。中继租户是纯节点，那张表永远为空，
// 一律判「过旧」会把 set-relays / meta-key 这两类节点侧记录全部堵死。
// 因此注册表为空时只放行中继记录；hub-auth 与 rotate-root-keep 仍然 fail-closed。
if (isRelayRecordType(type) && userStore.listNodes().length === 0) return { ok: true };
```

刻意做成最窄的口子：`admit-hub` / `retire-hub` / `rotate-root-keep` 的 fail-closed 行为一字未动
（既有用例 `cert without a nodes row blocks` 仍然绿）。新增用例
`中继记录在空注册表（纯节点）上放行，hub-auth 记录仍然 fail-closed` 同时覆盖两侧，
并验证一旦有了注册表行（hub 侧），中继记录也回到版本门禁。

**遗留**：中继模式下节点侧确实无从知道对端版本（`peer_cache` 没有 version 列，状态块里的 `version` 只进 `node.list` 不落库），
所以中继租户上的这道门禁是「不判定」而不是「判定通过」。要真正判定需要给 `peer_cache` 加 version 列并在
`relayListToNodeList` 里写入——属于下一轮。

### 4. `MeshRuntime.stop()` 不停自己造的 `HubRuntime` → 全量测试里 2 分钟后炸「closed database」

`createMeshRuntime` 在 `roles.hub` 时自己 new 了 `HubRuntime`，但 `stop()` 只停 peer/uplink/http/rtc/bulk。
`HubUplinkServer` 的 attachment keepalive 是 `setInterval(..., ATTACHMENT_KEEPALIVE_MS = 120s)`，
测试里 `mesh.stop(); db.close()` 之后这个定时器还活着，**两分钟后** 打到已关闭的库上抛
`RangeError: Cannot use a closed database`，bun 把它算成「当时正在跑的那个测试」失败。
`apps/gateway` 全量跑约 190 s，所以炸点总是落在靠后的 `src/relay/integration`（跟改动无关，只是受害者）。

修法（`mesh-runtime.ts:1423`）：`stopQuietly` 列表里加 `['hub', () => d.hub?.stop() ?? Promise.resolve()]`。
`HubRuntime.stop()` 幂等（置 `stopped`、清定时器、关链路），生产侧 `assemble-routes.ts:452` 仍会再停一次，无影响。
这一条同时让任务书列的 4 个「已知负载 flake」（stream failover、large raw-body push ×2、RtcPeerManager ice summary）
在本次全量跑里全部变绿。

## 四、版本门禁（deliverable 3）

`nodeVersionMeets(client_version, MIN_RELAY_CLIENT_VERSION)` 实现本身没问题：`normalizeReportedNodeVersion`
用 `raw.trim().replace(/_dev$/, '')` 剥后缀，与 `peerSupportsCanonicalV11` 的约定一致。**未改代码，只补测试**：

- `relay-units.test.ts` 新增 `relay client version gate`：`1.1.23` / `1.1.23_dev` / `1.1.24` / `1.2.0` / `2.0.0_dev` 通过；
  `1.1.22` / `1.1.22_dev` / `1.0.99` / `''` / `nightly` / `null` / `undefined` 拒绝；`1.1.23-rc.1` 拒绝（预发布低于正式版）。
- `relay-uplink.test.ts` 新增 `accepts the dev build suffix reported by non-production gateways`：
  真实握手用 `client_version: '1.1.23_dev'` 拿到 `auth.ok`，且 `relay_nodes.client_version` 原样落库。

节点默认上报的是 `getDisplayVersion()`，test/dev 下就是 `1.1.23_dev`——集成测试全程走这条真实路径。

## 五、密钥日志块明文帧上提 shared（deliverable 2）

`packages/shared/src/relay/keylog-frame.ts`（从 `@tmex/shared/relay` 导出）：

```ts
const RELAY_KEYLOG_ENVELOPE_KIND = 'keylog';
const RELAY_KEYLOG_PLAINTEXT_MAX_BYTES = 256 * 1024;
type RelayKeyLogEntry = { bytes: Uint8Array; sig: Uint8Array };
function encodeRelayKeyLogPlaintext(entry: RelayKeyLogEntry): Uint8Array;   // utf8(JSON{bytes,sig} b64url)
function decodeRelayKeyLogPlaintext(plaintext: Uint8Array): RelayKeyLogEntry;
function sealRelayKeyLogRecord(logKey, entry): Promise<RelayEnvelope>;      // sealEnvelope(K_log,'keylog',…)
function openRelayKeyLogRecord(logKey, envelope): Promise<RelayKeyLogEntry>;
```

- `apps/gateway/src/mesh/relay-key-log-sync.ts` 删掉重复实现，保留 `export type RelayKeyLogRecord = RelayKeyLogEntry` 别名（下游 import 路径不变）。
- `packages/app/src/lib/relay-keylog.ts` 只剩 `openRelayKeyLogPage` / `parseRelayKeyLogPage`（页级校验：seq 从 1 起连续），逐条改调 `openRelayKeyLogRecord`。
- 两侧原有用例保留，import 改指 shared；shared 侧补 4 例（含变长 passkey 签名与错误分支）。原 gateway 侧那条「能打开 CLI 产出的块」的互通用例仍在（现在断言的是同一份实现的字节形状）。

## 六、packages/app 类型门禁（deliverable 4）

`packages/app/tsconfig.json` 原来 `types: ["node"]` 而 workspace 里根本没装 `@types/node`，
`TS2688` 让 tsc 直接不报任何文件级错误——这个包**长期没有有效类型门禁**（B2 §八.2 已指出）。改成：

```json
"types": ["bun"],            // @types/bun 本来就是 packages/app 的 devDependency，无需 bun install
"noEmit": true,              // 本包用 bun build 出产物，tsc 只做检查
"allowImportingTsExtensions": true,   // native-datachannel.ts:135 故意 import '.../index.ts'
"jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"   // 本包 import 了 apps/gateway 的 .tsx
```

放开后冒出 121 个真实错误，已全部修完（这部分我派了子 agent 并行做，逐条复核过）：
vendor/node-datachannel 的原生 addon 类型（29 处，同时同步了生成脚本 `scripts/vendor-node-datachannel.ts` 并验证幂等）、
`typeof fetch` 缺 `preconnect`（新增 `packages/app/src/lib/fetch-like.ts` 的 `FetchLike`，约 47 处）、
`Uint8Array<ArrayBufferLike>` 不是 `BodyInit`（9 处）、`TmexRoles` 字面量补 `relay`、
`setup-service.ts` 的 `LocalStatus.role` 放宽成 `TmexRoleName`，以及若干**真实缺陷**：
`tls-service.ts:660` 传给 listener 的其实是 `string | null`、`enroll.ts:382` 闭包里收窄失效传了 `undefined`、
`install.ts:63` `Array.isArray` 对 `readonly string[]` 不收窄、`init.ts:299` 返回类型与实际不符、
`enroll.ts:169` 把 `LocalAuthContext.sqlite` 断言成有 `run()`（已在 `local-auth.ts` 补 `LocalSqliteClient`）、
`auth-spawn.ts:174` 与 `enroll.ts:442` 的 `process.off` 被 `@types/bun` 的 `memoryPressure` 重载遮蔽。
**现在 `bunx tsc --noEmit -p packages/app` 是真实的 0。**

## 七、验证

| 项 | 结果 |
|---|---|
| `apps/gateway` `bun test`（全量） | **4114 pass / 0 fail**（193 s；任务书列的 4 个已知负载 flake 因 §三.4 一并消失） |
| `apps/gateway` `bun test src/relay src/mesh src/auth src/hub` | 1505 pass / 0 fail |
| `apps/gateway` `bun test src/relay/integration` | 11 pass / 0 fail（6.7 s） |
| `packages/shared` `bun test` | 616 pass / 0 fail（基线 632 是 R1b 删 legacy wire 用例前的数；本任务净 +4） |
| `packages/app` `bun test src` | 795 pass / 0 fail |
| `bunx tsc --noEmit -p apps/gateway` / `-p packages/shared` / `-p packages/app` | 全部 **0 error** |
| `bunx biome check`（全部改动文件 + 相关目录 333 文件） | clean |
| `bun run lint`（根） | biome 2427 文件 clean；complexity gate ok（1397 文件 / 12752 函数，未加 allowlist） |

复杂度门禁过程中压回去两处：`relay-uplink-client.ts` 608 → 597（把 `enroll.redeemed` 的处理整段搬进 `relay-node-list.ts`）、
harness 689 → 拆成 `relay-mesh-types.ts` / `relay-mesh-harness.ts` / `relay-tenant-ops.ts` 三个文件。

## 八、需要指挥官处理 / 知晓

1. **越界改动 3 处（都是阻断集成的真实缺陷，已在 §三 说明）**：`apps/gateway/src/hub/hub-authorization.ts`(+test)、
   `apps/gateway/src/mesh/mesh-runtime.ts`(1 行)。两者都不在任务书给我的文件清单里，但不改就没法跑通任何一条中继场景
   （§三.3）或没法让全量测试稳定绿（§三.4）。`mesh-runtime.ts` 与并行 agent 有重叠，合并时注意保留
   `stopQuietly` 里那条 `['hub', …]`。
2. **`/api/mesh/relay/*` 在 standalone 角色下不可用**：`relay-wiring.ts:createRelayRoutes` 给 `RelayRoutes` 的
   `session` deps 没有 `localAuthEffective`，standalone（`roles = {hub:false,node:false}`）走
   `standaloneOpenBypass` 得到 `{ok:true, userId:null}`，`RelayRoutes.handle` 于是一律 401。
   也就是说 `tmex relay enroll` 在一台 standalone 机器上会 401。我按「中继租户角色是 `node`」的设计跑集成
   （B4 的 r3 join 也写 `TMEX_ROLES=node`），没有改这个。若要支持 standalone 直接接中继，需要在
   `createRelayRoutes` 里把 `MeshHttpRuntime` 那份 `sessionDeps.localAuthEffective` 透传进来——一行，但要
   同时确认 standalone 下 `userId` 从哪来。请指挥官裁定是否本轮做。
3. **中继租户侧没有对端版本信息**：见 §三.3 遗留。`peer_cache` 没有 version 列，所以中继模式下
   `KEYLOG_RECORD_COMPAT` 这道门禁实际是空转。若要在中继模式下真正拦住老节点，需要加列 + 在
   `relayListToNodeList` 写入（新迁移，建议下一轮）。
4. **`apps/gateway/src/mesh/relay-routes.ts` 我没动**（F3 在飞）。集成期间它的两个问题在我跑之前已被并行 agent 修掉：
   `callRelayEnroll` 现在用 `readRelayErrorCode(payload)` 读 `{error:{code}}`（我的用例已断言
   口令错时透传 `RELAY_PASSWORD_INVALID`），`?hub=sync` 也已按 `planKeyLogAppend` 改成中继模式本地优先。
   目前没有发现残留问题。
5. **shared 用例数从 632 掉到 616**：R1b 删了 legacy wire kind 的用例（`tmux-fetch-pane-history.test.ts` 等），
   不是本任务造成的；本任务净 +4。验收表里的 shared 基线建议按 R1b 的终值更新。
6. **docker-node 实测未做**：任务书只给了进程内集成测试这一项 deliverable，docker 多容器实测（plan §四最后一条）
   不在本次范围，仍待指挥官安排。
7. 集成 harness 里有两处刻意的取舍，评审时不必当成缺陷：`ShortBackoffScheduler`（池子在没有可用上级时会立刻重试，
   `FastScheduler` 的 sleep 直接 resolve 会把测试拖成热循环，这里退避 ≤20 ms）；节点 `close()` 里 50 ms 的静置
   （记录应用触发的 `reconcile` 是异步的，直接关库会炸在 closed database）。
