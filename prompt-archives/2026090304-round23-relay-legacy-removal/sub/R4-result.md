# R4 结果：中继后端安全审查 14 项的核实与修复

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`），未 commit。
14 项全部核实为真（无一误报），全部已修 + 补测试。

---

## 一、逐条结论

### 1. BLOCKER — 重放/伪造的 member sidecar 能把已吊销节点抬回 admitted ✅ 属实，已修

**核实**：`relay-key-log-service.ts` 旧版第 53–73 行只按 `member.op` 验签，既不看 `record.seq` 是否等于
`msg.seq`，也不看 `record.root_epoch`；`applyRelayMemberEffect()` 直接 `upsertNode({status:'admitted'})`，
而 `RelayTenantStore.upsertNode` 的 `onConflictDoUpdate` 无条件覆盖 `status`。所以任何持有效令牌的节点，
把别人（或自己）**旧的** `admit-node` 记录挂到一条新 append 上，就能把 `revoked` 行改回 `admitted`；
passkey 签名的 admit（中继验不了、靠 `tolerantAdmit` 放行）同样能翻案。

**修复**：

- `apps/gateway/src/relay/relay-member.ts:97` `verifyRelayMemberProof()` 新增三条硬规则：
  `record.root_epoch === tenant.rootEpoch`（`epoch_mismatch`）、`record.seq === expectSeq`（`seq_mismatch`）、
  root 签名必须是 64 字节（`bad_signature`）。
- `apps/gateway/src/relay/relay-key-log-service.ts:44` 传入 `expectSeq = 本次 append 的 seq`、
  `rootEpoch = 租户当前 epoch`。
- `apps/gateway/src/relay/relay-tenant-store.ts:243` `upsertNode()`：**`revoked` 是终态**，命中即原样返回，
  永远不会被抬回 pending/admitted；重新加入必须换 node id。
- `apps/gateway/src/relay/relay-key-log-service.ts:69` / `relay-uplink-server.ts:462`：upsert 之后复查返回的
  `status`，不是 `admitted` 就当作 `member_ignored` / `auth` 拒绝（`reason=revoked`）。

**说明（为什么没做「sidecar 哈希绑定信封明文」）**：帧里没有明文承诺字段，加上密文与 sidecar 都由**同一个
上传者**产生，加一个由上传者自己算的哈希对恶意上传者零收益（他可以两边都改）。真正起作用的是
seq 绑定 + epoch 绑定 + 状态单调，这三条已经实现。

**测试**：`apps/gateway/src/relay/relay-uplink.test.ts`
- 「member 明文必须是本次 seq 的那条记录：错位的 admit 一律忽略」→ `member_error === 'seq_mismatch'`
- 「被吊销的节点不会被重放的 admit 抬回来（root 与 passkey 两条路都不行）」→ 重放 root admit、
  伪造 passkey admit、被吊销节点重连（`closed === 'revoked'`）三段断言

### 2. BLOCKER — `direct_capable` 走明文 ✅ 属实，已修

**核实**：`relay.status` / `relay.list` 的 codec 都有明文 `direct_capable`（`codec.ts` 旧 74/95/329/402 行），
中继据此知道每个节点能否直连——这是节点网络指纹，属 plan §1.2 的「不可见」栏。

**修复**：字段移进 K_meta 封里的 `RelayStatusBlob`
（`packages/shared/src/relay/blobs.ts:17`），codec 里彻底删掉
（`packages/shared/src/relay/codec.ts:70`/`95`/`320`/`398`）。中继只存/广播密封块
（`relay-registry.ts` 删掉 `directCapable` 字段、`relay-node-list.ts:26` 不再输出）；
节点解开后写 `peer_cache`（`apps/gateway/src/mesh/relay-node-list.ts:86`），解不开时回落到本地
`peer_cache.directCapable`（同文件 :58）。

**测试**：`packages/shared/src/relay/codec.test.ts`（「relay.status / relay.list 不再带明文 direct_capable」，
显式塞进去也会被 codec 丢弃）、`blobs.test.ts` round-trip、
`apps/gateway/src/mesh/relay-uplink-client.test.ts`（从封里解出 `direct_capable=true` 并落 peer_cache）。

### 3. BLOCKER — 中继没有根轮换路径 ✅ 属实，已修

**核实**：`relay_tenants.root_public_key` 只在 enroll 时写；`reissueToken()` 还把客户端自称的
`root_epoch` 原样写库。租户换根之后中继仍用旧公钥验成员记录（所有新 admit 全被拒），
而旧根持有者拿旧公钥重新 enroll 就能拿到**原租户**的新令牌（`getByRootPublicKey` 命中旧值）。

**修复**：

- `member.op` 新增 `'rotate-root'`（`codec.ts:65`），载荷是 `rotate-root` / `rotate-root-keep` /
  `reset-root` 记录的 bytes+sig。
- `relay-member.ts:194 rotateResult()`：用**当前**租户根公钥验签，`record.root_epoch` 必须等于当前 epoch，
  取出 payload 里的新根公钥，`nextRootEpoch = record.root_epoch + 1`。
- `relay-tenant-store.ts:147 rotateRoot()`：`WHERE root_epoch = expectedRootEpoch` 的 CAS 更新，
  且 `rootEpoch` 必须严格递增，与日志行同事务提交。
- `relay-tenant-store.ts:125 reissueToken()`：**不再写 `root_epoch`**（enroll body 里的是未鉴权自称值）。
  重新 enroll 只按当前 pk 匹配：换根之后旧 pk 匹配不到任何租户 → 建一个全新的空租户。
- `relay-uplink-handlers.ts:113` `relay.enroll.create` 的 authorization 也要求 `root_epoch` 等于当前 epoch。
- 节点侧 `apps/gateway/src/mesh/relay-key-log-sync.ts:24` `RELAY_MEMBER_OPS` 把三种根轮换记录映射到
  `op: 'rotate-root'`，上传时自动带上 sidecar。
- **附带修复（否则第 3 条在生产里根本走不到）**：`apps/gateway/src/mesh/auth-key-log-routes.ts:466`——
  中继模式下 `nodes` 版本注册表永远是空的（那张表只有 hub 侧会写），`rotate-root-keep` 的
  `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` 门禁会把根轮换**永久堵死**。中继在 `relay.auth` 上已强制
  `client_version ≥ 1.1.23`，严于该记录要求的 1.1.16，因此中继模式豁免这条门禁（仅
  `rotate-root-keep`，hub 模式不变）。

**测试**：
- 单元：`relay-uplink.test.ts`「根轮换：新根签的 admit 通过，旧根签的被拒」
  （轮换后旧根 admit → `epoch_mismatch`；新根 admit → admitted）、
  「根轮换后旧根 enroll 落到新租户，拿不到原租户的注册表」。
- 集成（真实节点栈）：`apps/gateway/src/relay/integration/relay.integration.test.ts`
  「根轮换后中继换到新根公钥；旧根 enroll 落到新租户，新根签的加入照常」——
  通过 `/api/auth/keylog?hub=sync` 提交真的 `rotate-root-keep`，等中继 `root_epoch+1`、
  公钥换成新值，旧根再 enroll 得到不同 tenant_id 且注册表/日志皆空，最后 `joinNode()` 全流程跑通。

### 4. MAJOR — codec 强制 64 字节签名，passkey 记录根本上不去 ✅ 属实，已修

**核实**：`memberProof()` / `keylogMember()` / `relay.enroll.create` 都用 `b64(value,'sig',64)`；
passkey 签名是变长 Borsh `PasskeyAssertion`（真实断言约 300 B），一律被 codec 拒；
harness 用 `new Uint8Array(64)` 假冒 passkey 签名，把这个洞掩盖了。

**修复**：
- `codec.ts:45` 新增 `RELAY_CTL_MAX_SIG_BYTES = 4096`，`member.sig` / `authorization_sig` 改为
  变长有界（`codec.ts:298`/`311`/`450`）。
- 「必须 64 字节」的判定下沉到解码之后按签名者判断：`relay-member.ts:140`（root 记录）、
  `relay-uplink-handlers.ts:173`（root 签名的 authorization）。
- harness 改用**真实 ES256 认证器**产出的断言：`relay-test-tenant.ts` `realPasskeyAssertion()` 用
  `createEs256Authenticator()` + `encodePasskeyAssertionSig()`（真 clientDataJSON / authenticatorData /
  ECDSA 签名，Borsh 编码）。中继按设计验不了 passkey 签名，所以不做逐记录挑战绑定，注释已写明。

**测试**：`packages/shared/src/relay/codec.test.ts`「变长签名与根轮换 sidecar」（300 B 签名在
`relay.keylog.append` / `relay.auth` / `relay.enroll.create` 三处往返）；
`relay-uplink.test.ts` 断言 `revoke.sig.length > 100` 且中继回 `member_error='passkey_unverifiable'`。

### 5. MAJOR — `relay.enroll.create` 的 exp 未与 authorization 对齐 ✅ 属实，已修

**核实**：旧代码只校验 `now < exp <= now + 24h`，可以签发一个比 authorization 本身活得更久的
enrollment；authorization 的 `root_epoch` 也完全没看。

**修复**：`apps/gateway/src/relay/relay-uplink-handlers.ts:152 verifyRelayAuthorization()` 增加
`authorization.root_epoch === tenant.rootEpoch`（`ROOT_EPOCH_MISMATCH`）与
`BigInt(exp) <= authorization.exp`（`BAD_EXPIRY`）；`now < exp <= now+24h` 保留。

**测试**：`relay-hardening.test.ts`「exp 不得超过 authorization 自身的到期」「authorization 的 root_epoch
必须等于租户当前 epoch」。

### 6. MAJOR — 重新签发令牌不断旧链路，认证后再不复查令牌 ✅ 属实，已修

**核实**：`issueTenantToken()` 只改库；`dispatchAuthenticated()` 只在握手时比过一次 token 哈希。
被踢的节点只要连着就永远在线。

**修复**：
- `RelayLiveNode` 增加 `tokenHash`（`relay-registry.ts:11`），握手时记下
  （`relay-uplink-server.ts:502`）。
- `RelayUplinkServer.enforceTokenReissue(tenantId, tokenHash)`（`relay-uplink-server.ts:200`）：
  哈希不同的链路一律 `relay.kicked {reason:'kicked'}` 后关闭；`handleRelayEnroll` 的 reissue 分支调用它
  （`relay-routes.ts:108`）。
- 认证后的每条消息复查：`relay-uplink-server.ts:354`，`live.tokenHash !== tenant.tokenHash || tenant.kicked`
  → 立刻踢（防止「库改了但链路还没断」的窗口）。

**测试**：`relay-hardening.test.ts`「重新 enroll 后旧令牌链路被踢…」「认证后的每条消息都复查令牌：
库里换了哈希就踢」。

### 7. MAJOR — 追加日志非原子 + 垃圾信封堵死节点同步 ✅ 属实，已修

**(a) 中继侧原子性**：旧代码 `keyLog.append()` → `setKeyLogHead()` → （ack 之后）成员副作用，三段各自
提交，中途失败会留下「日志行在但 head 没动」或「head 动了但成员表没改」。
**修复**：`relay-key-log-service.ts:118` 把三件事包进一个 `db.transaction()`，并在事务内对
`keyLogHeadSeq` 做 CAS 复查，冲突就整体回滚并回 `SEQ_MISMATCH`（带最新 head）。链路层动作
（踢被吊销节点、push 给同租户、`scheduleList`）留在事务外。
**测试**：`relay-uplink.test.ts`「日志行与 head 同事务：head 冲突时不会留下半条记录」。

**(b) 节点侧不再被毒记录堵死**：旧 `applyPage()` 遇到解不开的块直接 `return false`，`pullPages()`
随即 `return`，此后每次追平都卡在同一页，永远追不平。
**修复**：`apps/gateway/src/mesh/relay-key-log-sync.ts`
- `applyPage()` 返回 `{applied, skipped, maxSeq}`，解不开的记录记一笔跳过（不应用）；
- `pullPages()` 在本地 head 推不动但本页有跳过时，把**中继 seq 意义上的游标**推过这一页继续
  （本地 head 因为链连续性推不过去，这是预期的）；
- `blockedSeq` 记下第一条卡住的 seq，`runCatchUp()` 据此不再空转；`reset()`（重连）会清掉它重试一次；
- 新增计数器 `skipped` / `blockedSeq` / `caughtUp`，经 `RelayUplinkClient.keyLogHealth()` →
  `GET /api/mesh/relay/status` 的 `keyLog` 字段暴露给前端。

**测试**：`apps/gateway/src/mesh/relay-key-log-sync.test.ts`「解不开的记录被跳过而不是永远堵住同步」。

### 8. MAJOR — 并发流配额重复计数且有竞态 ✅ 属实，已修

**核实**：`live.streams` 与 `target.streams` 各加 1，`registry.streamCount()` 求和 → 一条逻辑流算两次
（实际额度只有配额的一半）；且配额判定在 `await target.link.openStream()` **之前读、之后写**，
并发到达的多条 OPEN 会一起读到旧计数穿过配额。

**修复**：`RelayRegistry` 改为**租户级逻辑流计数**（`relay-registry.ts:37`），提供
`reserveStream(tenantId, limit)` / `releaseStream(tenantId)`；`relay-stream-router.ts:49`
**先占位再 await**，`openStream` 失败或 pump 结束时归还（`release()` 幂等）；
`registry.clear()` 一并清空计数。`RelayLiveNode.streams` 字段删除。

**测试**：`relay-hardening.test.ts`「并发打开的流共用同一份租户额度（先占位再 await）」——
`maxStreams=2`，`Promise.allSettled` 并发开 6 条，断言在线流数 ≤2 且至少 4 条被 RST。

### 9. MAJOR — `relay.list` 先截断后过滤 + `maxNodes` 上限与清单容量不符 ✅ 属实，已修

**核实**：`buildRelayList()` 先 `.slice(0, 256)` 再映射，吊销行会把还活着的节点挤出窗口；
而 `RELAY_QUOTA_MAX_NODES_LIMIT = 4096` 允许运营者配一个清单根本装不下的额度。

**修复**：`relay-node-list.ts:25` 先 `filter(status !== 'revoked')` 再截断（吊销节点不再出现在清单里）；
`relay-quota.ts:8` `RELAY_QUOTA_MAX_NODES_LIMIT = RELAY_CTL_MAX_NODES`（256），默认与每租户覆盖走
同一条 `normalizeRelayQuota()` 校验；CLI 的 `--max-nodes` 范围提示随之变成 `1..256`
（`packages/app/src/commands/relay-shared.ts` 直接引用同一常量，无需改代码）。

**测试**：`relay-hardening.test.ts`「先滤 revoked 再截断…」（塞 264 条吊销行后活节点仍在清单里）、
「maxNodes 配额被清单容量封顶」；`packages/app/src/commands/relay-shared.test.ts` 范围断言更新。

### 10. MAJOR — 中继路径被 Access/域名守卫挡住，限速用 socket IP ✅ 属实，已修

**核实**：`isAccessGuardExemptPath()` 只豁免 `/healthz` 与 `/hub/`、`/api/hub/` 前缀；
`isServicePath()` 只认 hub 的机器路径。中继机若开了 tunnel/域名访问控制，节点 uplink 与 CLI redeem
全被 403。`assemble-relay.ts:60` 的 `clientIp` 直接取 socket IP，反代后面所有人共用一个桶。

**修复**：
- `apps/gateway/src/tunnel/access-paths.ts`：`ACCESS_EXEMPT_EXACT_PATHS` 加
  `/relay/uplink`、`/api/relay/health`、`/api/relay/enroll`；新增只做 origin 守卫豁免、
  **不建 Cloudflare bypass app** 的 `ACCESS_EXEMPT_PATH_PREFIXES = ['/api/relay/tenants/']`
  （避免给既有 hub 部署平白多出 bypass 应用）。管理面 `/api/relay/status|password|config|tenants/:id`
  **不豁免**。
- `apps/gateway/src/mesh/domain-access-policy.ts:73 isServicePath()`：加 `/relay/uplink`、
  `/api/relay/health`、`POST /api/relay/enroll`、`GET|POST /api/relay/tenants/:id/enrollments/:x`。
- `packages/app/src/runtime/assemble-relay.ts:60`：改用 `clientIpFromRequest(req)`（trusted-proxy 感知）。

**测试**：`apps/gateway/src/tunnel/access-entry.test.ts`、
`apps/gateway/src/mesh/domain-access-policy.test.ts` 各加一条（含「管理面不放行」的反向断言）。

### 11. MAJOR — 每租户 enrollment 无上限 ✅ 属实，已修

**修复**：
- `RELAY_MAX_UNUSED_ENROLLMENTS = 32`（`types.ts:18`）：`countUnusedEnrollments()` 超限即
  `ack {ok:false, error:'ENROLLMENT_QUOTA'}`。
- 创建频率闸 `RelayEnrollCreateRate`（`relay-enroll-limiter.ts`，16 条 / 60 s），
  超限回 `ENROLLMENT_RATE_LIMITED`。
- 定期清扫：`RelayTenantStore.sweepEnrollments(now, 24h)` 删掉过期行与用过超过 24 h 的行，
  挂在既有 30 s 计量刷盘上（`RelayMetering` 新增 `onFlush` 钩子，无待落库计量时也照跑）。

**测试**：`relay-hardening.test.ts`「未使用的 enrollment 有每租户上限，过期行随清扫删除」
「创建频率闸：窗口内超量直接拒」。

### 12. MINOR — `relay.list` fire-and-forget，旧清单可能覆盖新清单 ✅ 属实，已修

**核实**：`void this.handleList(msg)`；解 blob 是异步的，blob 多的大清单会晚于后到的小清单完成。

**修复**：`apps/gateway/src/mesh/relay-uplink-client.ts:515 enqueueList()` 串行化到一条 promise 链，
入队与写回前各做一次 `msg.version < this.listVersion` 的丢弃判定，并绑定 `connectGeneration`。

**测试**：`relay-uplink-client.test.ts` 在原用例尾部追加——先发 version 7（带 blob），再发 version 3（空），
断言只回调一次且 `listVersion === 7`、`nodesViaRelay` 不被清零。

### 13. MINOR — 拉取硬停在 256 页，上传把整条链读进内存 ✅ 属实，已修

**修复**：`relay-key-log-sync.ts`
- `pullPages()` 上限从 256 提到 `RELAY_KEYLOG_MAX_PAGES = 4096`（纯防御性上限，防止伪造的天文 seq 空转），
  循环到追平为止；
- `pushMissing()` 改成分页 `applier.list(userId, cursor+1, undefined, RELAY_KEYLOG_PUSH_PAGE=64)`，
  逐页上传；
- `onSynced()` 只在 `local.seq === remoteHead` 时触发（新增 `caughtUp` 标志）。

**测试**：`relay-key-log-sync.test.ts`「上传缺失记录分页进行，超过一页也能全部推上去」（80 条，跨 2 页，
最后断言 `caughtUp` 与 `onSynced` 只在追平后触发）。

### 14. B5 遗留 — standalone 机器 `/api/mesh/relay/*` 恒 401 ✅ 属实，已修

**核实**：`createRelayRoutes()` 构造 `session` 时不传 `localAuthEffective`，standalone 角色下
`standaloneOpenBypass()` 返回「ok 但 userId=null」，`RelayRoutes.handle()` 里 `auth.userId ? ... : 401`
直接 401——而 standalone 正是一台机器变成中继租户节点的起点。

**修复**：`apps/gateway/src/mesh/relay-wiring.ts:167` 增加可选 `localAuthEffective`，
`apps/gateway/src/mesh/mesh-runtime.ts:1187 relayLocalAuthEffective()` 从 `http.auth.isLocalAuthEffective()`
取值（异常按未生效处理）传入。

**测试**：`apps/gateway/src/mesh/relay-routes.test.ts`「standalone 机器的中继接入」两条
（本机登录门生效 → 200；未生效 → 仍 401）。

---

## 二、wire / 契约变更清单

### `packages/shared/src/relay/codec.ts`

| 消息 | 变更 | 新形态 |
|---|---|---|
| `relay.status` | **删** `direct_capable` | `{t:'relay.status', blob:Envelope, epoch:u32}` |
| `relay.list` 的 `nodes[]` | **删** `direct_capable` | `{id:hex32, online:bool, status:'pending'\|'admitted'\|'revoked', epoch?:u32, blob?:Envelope}` |
| `relay.auth` 的 `member.sig` | 64 B → **变长有界** ≤4096 B（`RELAY_CTL_MAX_SIG_BYTES`） | `{bytes:b64url≤8KiB, sig:b64url≤4KiB}` |
| `relay.keylog.append` 的 `member` | 同上；`op` 增加 `'rotate-root'` | `{op:'admit'\|'revoke'\|'rotate-root', bytes:b64url, sig:b64url}` |
| `relay.keylog.ack` | **新增可选** `member_error:string` | `{t,id,ok,seq?,error?,head?,member_ignored?,member_error?}` |
| `relay.enroll.create` 的 `authorization_sig` | 64 B → 变长有界 ≤4096 B | 其余不变 |

### `packages/shared/src/relay/blobs.ts`（K_meta 封内明文，中继看不到）

```ts
RelayStatusBlob = {
  name: string;
  version: string;
  tmux: boolean;
  direct_capable: boolean;   // ← 新增（从 relay.status 明文搬进来）
  inventory: unknown;
  endpoints: unknown;
}
```
JSON 字段顺序：`{name, version, tmux, direct_capable, inventory, endpoints}`（`encodeRelayStatusBlob` 固定序）。

### `relay.keylog.append.member.op = 'rotate-root'` 的语义

- `bytes` = `rotate-root` / `rotate-root-keep` / `reset-root` 记录的 Borsh 字节，`sig` = **旧根**的 Ed25519 签名；
- 中继用**当前**租户根公钥验签，要求 `record.root_epoch === relay_tenants.root_epoch` 且
  `record.seq === msg.seq`；通过后在同一事务里把 `root_public_key` 换成 payload 里的新公钥、
  `root_epoch` 置为 `record.root_epoch + 1`（严格递增，CAS）；
- 校验不过 → `ack {ok:true, member_ignored:true, member_error:'epoch_mismatch'|...}`，日志行照旧落库。

### HTTP 契约

- `POST /api/relay/enroll`：请求体不变；**行为变化**——重复 enroll 只按**当前**根公钥匹配租户，
  且不再改写 `root_epoch`；命中已有租户时会立刻踢掉持旧令牌的 uplink。
- `relay.enroll.ack` 新增错误码：`ROOT_EPOCH_MISMATCH`、`ENROLLMENT_QUOTA`、`ENROLLMENT_RATE_LIMITED`
  （`BAD_EXPIRY` 语义扩展为「超过 authorization 自身到期」）。
- `GET /api/mesh/relay/status`（节点侧，前端可见）**新增** `keyLog` 字段：
  ```jsonc
  { "keyLog": { "skipped": 0, "blockedSeq": null, "caughtUp": true } }
  ```
  `blockedSeq` 是字符串化的 u64（可能超 `Number.MAX_SAFE_INTEGER`）或 `null`。
  已同步到 `packages/api-client/src/relay/tenant-api.ts`（`RelayKeyLogHealth`，
  `normalizeRelayStatus()` 补默认值；字段可选，旧节点不返回也不炸）。
  `apps/fe/src/node/mesh-relay.ts` 的 `MeshRelayState extends RelayTenantStatus`，自动继承，无需改动。
- 配额范围：`maxNodes` 上限 4096 → **256**（`normalizeRelayQuota` 与 CLI `--max-nodes` 共用同一常量，
  超范围的 `PATCH /api/relay/config|tenants/:id` 现在回 400）。

---

## 三、要补进文档 §1.12「已知边界」的文字

> - **中继上的密钥日志是同租户成员共同写入的，中继无法审阅内容**。任何一个已承认（admitted）且
>   持有效令牌的节点，都可以往本租户日志里塞入其它成员解不开、或验签/接链不过的记录，把该租户
>   在中继上的日志「投毒」，直到它被吊销为止。其它节点不会因此卡死：解不开/应用不了的记录会被
>   跳过并计数（`GET /api/mesh/relay/status` 的 `keyLog.skipped` / `keyLog.blockedSeq`），
>   但**本地日志无法越过被投毒的那一条继续追平**（链是连续的），表现为该节点此后拿不到更新的
>   成员/密钥记录。恢复手段：吊销该节点后由健康节点重建日志，或运营者踢掉整个租户令牌。
>   这是「中继不看内容」这条隐私边界的直接代价。
> - **中继的成员表只是链路准入缓存，且 `revoked` 是终态**：被吊销的 node id 永远不会因为任何
>   （哪怕根签名完好的）`admit-node` 记录复活；一台机器要重新加入必须换新的节点身份（新 node id）。
> - **根轮换必须由租户主动告知中继**：`rotate-root` / `rotate-root-keep` / `reset-root` 记录上传时
>   附带明文 sidecar，中继用旧根验签后换公钥并把 `root_epoch` +1。若该记录没能上传（例如中继长期离线），
>   中继会继续用旧公钥验成员记录，新的 admit 全被拒；此时用**新根**重新 enroll 会得到一个
>   **新租户**（tenant_id、注册表、日志全新），需要重新加入各节点。
> - **中继一次只看得见 256 个节点**：`relay.list` 一帧最多 `RELAY_CTL_MAX_NODES` 个条目，
>   因此每租户 `maxNodes` 配额同样封顶 256；吊销的节点不占清单也不占配额。
> - **passkey 签名的 authorization / admit 中继验不了**：`relay.enroll.create` 与 `relay.auth` 的
>   passkey 分支只做 `root_epoch` 与令牌校验后放行，真正的成员判定仍在节点侧。

---

## 四、改动文件

新增：
- `apps/gateway/src/relay/relay-hardening.test.ts`（10 条：令牌重签发/enroll 校验/并发流配额/清单容量）
- `apps/gateway/src/relay/relay-test-tenant.ts`（从 harness 拆出的租户 fixture，门禁行数所迫）

主要修改（相对路径，`apps/gateway/src` 下）：
`relay/relay-member.ts`、`relay/relay-key-log-service.ts`、`relay/relay-uplink-handlers.ts`、
`relay/relay-uplink-server.ts`、`relay/relay-registry.ts`、`relay/relay-stream-router.ts`、
`relay/relay-tenant-store.ts`、`relay/relay-node-list.ts`、`relay/relay-quota.ts`、
`relay/relay-routes.ts`、`relay/relay-runtime.ts`、`relay/relay-metering.ts`、
`relay/relay-enroll-limiter.ts`、`relay/types.ts`、`relay/relay-test-harness.ts`、
`mesh/relay-key-log-sync.ts`、`mesh/relay-uplink-client.ts`、`mesh/relay-uplink-auth.ts`、
`mesh/relay-node-list.ts`、`mesh/relay-routes.ts`、`mesh/relay-wiring.ts`、`mesh/mesh-runtime.ts`、
`mesh/auth-key-log-routes.ts`、`mesh/domain-access-policy.ts`、`tunnel/access-paths.ts`；
`packages/shared/src/relay/{codec,blobs,index}.ts`；
`packages/api-client/src/relay/tenant-api.ts`；`packages/app/src/runtime/assemble-relay.ts`。

集成测试扩展：`relay/integration/{relay-tenant-ops,relay-mesh-types,relay-mesh-harness}.ts`
（新增 `tenant.rotateRoot()`）、`relay/integration/relay.integration.test.ts`（根轮换场景）。

---

## 五、验证结果

| 命令 | 结果 |
|---|---|
| `apps/gateway`：`bun test src/relay src/mesh` | **1232 pass / 0 fail**（基线 1210） |
| `apps/gateway`：`bun test` | **4141 pass / 0 fail**（基线 4114；2 个 "errors" 是 `tmux-client` 既有的「吞异常」用例打印，非失败） |
| `packages/shared`：`bun test` | **621 pass / 0 fail** |
| `packages/app`：`bun test` | 798 pass / **1 fail** — `scripts/build-runtime.test.ts`，读 `dist/runtime/server.js`，本 worktree 未跑过 `build:tmex:runtime`，**与本次改动无关的环境性失败**（`dist/` 里只有 `cli-node.js`） |
| `packages/api-client`：`bun test` | 201 pass / 0 fail |
| `apps/fe`：`bun test src/node` | 299 pass / 0 fail |
| `tsc --noEmit`：gateway / shared / app / fe | **0 错误** |
| `bunx biome check`（全部改动文件） | 通过 |
| `bun run lint`（biome + 复杂度门禁） | **通过**，0 违规、未加任何 allowlist 条目 |

`packages/api-client` 的 `bunx tsc --noEmit` 有 10 条报错，全部在 `src/client.test.ts` /
`src/files-download.test.ts`，**改动前后逐条相同**（已用 `git stash` 对照确认），属既有问题。

---

## 六、给指挥官的话

1. **必须一起发版**：`relay/v1` 的 `relay.status` / `relay.list` 去掉了明文 `direct_capable`，
   而它被搬进 K_meta 封里的状态块。中继与节点必须同版本升级；由于 `MIN_RELAY_CLIENT_VERSION = '1.1.23'`
   本轮才首发，不存在需要兼容的线上旧客户端。
2. **`maxNodes` 上限 4096 → 256** 是对外可见的行为变化（管理 API 与 `tmex relay quota --max-nodes`）。
   若线上已有配了 >256 的租户配额，读库时会被 `parseRelayQuotaJson` 判为非法而回落到默认配额——
   本轮首发，不存在存量数据，但发行说明值得写一句。
3. **顺手修了一个不在审查清单里的真 bug**（见第 3 条末尾）：中继模式下 `rotate-root-keep` 被
   `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` 门禁永久堵死（中继租户的 `nodes` 版本注册表恒为空）。
   不修的话「中继支持根轮换」这件事在生产里根本触发不到。改动只有一处（`auth-key-log-routes.ts`），
   仅对中继模式 + `rotate-root-keep` 生效，hub 模式的 fail-closed 语义原样保留。
   **建议 review 这一处**，因为它落在 R4 的名义范围之外。
4. **相邻的、本轮**没**处理**的观察**：中继租户节点的 `nodes` 表永远为空（那张表只有 hub 侧会写），
   所以任何依赖「节点版本」的门禁在中继模式下都失效。本轮只对 `rotate-root-keep` 做了有理有据的豁免；
   若后续还有按版本 gate 的记录类型，需要给中继模式补一条真正的版本来源
   （`relay.list` 的状态块里已经有 `version`，可以考虑写进 `peer_cache` / `nodes`）。
5. `relay-test-harness.ts` 因门禁（≤600 行、函数 ≤120 行）拆成了
   `relay-test-harness.ts` + `relay-test-tenant.ts`，对外导出面不变（harness 继续 re-export），
   现有测试的 import 都没改。
6. R1a 并行改的 `hub/uplink-server*.ts`、`mesh/forwarder*.ts` 全程未触碰。
