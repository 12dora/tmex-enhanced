# B2 结果：中继运行时（RelayRuntime）、中继侧持久化与角色挂载

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`）。未 commit。

## 一、改动文件

### 新增 `apps/gateway/src/relay/`（全部 ≤600 行）

| 文件 | 行 | 职责 |
|---|---|---|
| `types.ts` | 103 | 常量（路径/心跳/防抖/限速/默认配额）、`RelayRuntimeConfig`、行记录类型 |
| `relay-http.ts` | 48 | `RelayErrorCode` 表 + `{ error: { code, message } }` 响应助手 |
| `relay-password.ts` | 130 | argon2id 口令哈希（走 `@tmex/shared/auth` 的 `deriveSeed`）、常数时间比较、令牌/租户号生成、`sha256Hex` |
| `relay-quota.ts` | 129 | 配额解析/序列化/生效值 + 每租户带宽令牌桶 `RelayTokenBucket` |
| `relay-config-store.ts` | 99 | `relay_config` 单例行（口令哈希、两个 epoch、管理令牌 hash、默认配额） |
| `relay-tenant-store.ts` | 324 | `relay_tenants` / `relay_nodes` / `relay_enrollments` 读写 |
| `relay-key-log-store.ts` | 76 | `relay_key_log` 读写 + `parseRelayEnvelopeJson` |
| `relay-key-log-page.ts` | 61 | 分页裁剪到 64 KiB（对齐 hub 的 `trimKeyLogPageToByteLimit`） |
| `relay-key-log-service.ts` | 104 | `appendRelayKeyLog`（seq = head+1 判定 + member 处理）、`pageRelayKeyLog` |
| `relay-member.ts` | 133 | `verifyRelayMemberProof`：admit/revoke 记录验签与字段提取 |
| `relay-registry.ts` | 116 | 内存注册表 租户 → 节点 → 活链路（状态块、并发流计数） |
| `relay-metering.ts` | 67 | 每租户流量内存累计 + 定时/停机落库 |
| `relay-ctl-queue.ts` | 76 | 每链路 ctl 串行队列（限深 256 条 / 4 MiB）与停机排空 |
| `relay-node-list.ts` | 60 | `relay.list` 构造与编码（超 64 KiB 退化成无 blob 版本） |
| `relay-stream-router.ts` | 140 | relay 流授权、并发配额、带宽桶 pump、计量 |
| `relay-uplink-handlers.ts` | 167 | `relay.rtc` / `relay.keylog.append` / `relay.enroll.create` / authorization 校验 |
| `relay-uplink-server.ts` | 552 | `relay/v1` 服务端：challenge/auth/心跳/ctl 分发/广播/踢人/停机 |
| `relay-routes.ts` | 323 | 无鉴权与租户令牌路由：health / enroll / redeem / enrollment 查询 |
| `relay-admin-auth.ts` | 87 | 管理令牌首启生成与 bearer / 本机 session 双通道鉴权 |
| `relay-admin-routes.ts` | 146 | status / password / config / tenant patch / kick / delete |
| `relay-runtime.ts` | 329 | 组装 + HTTP 路由分发 + WS 升级与适配器 + 停机 |
| `relay-enroll-limiter.ts` | 53 | enroll 按源 IP 失败限速（5 次 / 15 分钟） |
| `index.ts` | 56 | barrel |
| `relay-test-harness.ts` | 465 | 进程内 harness（见 §四） |
| `relay-units.test.ts` / `relay-routes.test.ts` / `relay-uplink.test.ts` / `relay-admin.test.ts` | 177/341/463/271 | 69 个用例 |

### 新增 schema / 迁移

- `apps/gateway/src/db/schema/relay.ts`（81 行）
- `apps/gateway/drizzle/0039_relay.sql`（68 行）
- 共享文件各追加一处（未重排任何既有条目）：`apps/gateway/src/db/schema.ts` 末尾 `export * from './schema/relay';`；`apps/gateway/src/db/managed-migrations.ts` 的 `MIGRATIONS` 追加 `'0039_relay.sql'`；`apps/gateway/drizzle/meta/_journal.json` 追加 `idx: 39, tag: '0039_relay'`。

### 修改

- `apps/gateway/src/config.ts`：角色错误文案补 `relay | relay,node`；`parseTmexRoles` 里调用 `validateRoles()`（`hub && relay` → 抛 `TMEX_ROLES is invalid: relay cannot be combined with hub`）；新增 `relayPublicUrl`（`TMEX_RELAY_PUBLIC_URL`）与 `relayAdminToken`（`TMEX_RELAY_ADMIN_TOKEN`）。
- `apps/gateway/src/config.test.ts`：+4 用例（relay 角色、hub+relay 拒绝、错误文案、非法组合）。
- `packages/app/src/runtime/assemble.ts`：`AssembledTmex` 加 `relay`；`isRelayOnly()`；relay 单跑跳过 auth surface 且前端换成 404 stub；在 routeDeps 之后、`buildHttpAndWs` 之前创建 RelayRuntime；`meshShutdownNeeded` 把 relay 也算进去。
- `packages/app/src/runtime/assemble-routes.ts`：`buildHttpAndWs` 在 hub **之前**挂 `relay.handleRequest`；`routeWebsocket` 最先判 `relay.isUplinkSocket`；`createAssembledLifecycle` 最先 `relay.stop()`。
- `packages/app/src/runtime/assemble-relay.ts`（新，62 行）：`createAssembledRelay()`。从 assemble-routes 拆出来是为了复杂度门禁（assemble-routes 已 596/600 行）。
- `packages/app/src/runtime/assemble-relay.test.ts`（新）：4 个用例。

## 二、HTTP 路由（全部落在 `/api/relay/*` 与 `/relay/uplink`）

响应体错误一律 `{ error: { code, message } }`（对齐 F2 契约与 `packages/api-client/src/relay/admin-api.ts` 的 `readCodedError`）；写接口成功返回 `{ ok: true }`。

### 无鉴权

| 方法 路由 | 行为 |
|---|---|
| `GET /api/relay/health` | `{ ok, version, tenants, nodesOnline, uptimeMs }`；不查库以外的任何东西 |
| `POST /api/relay/enroll` | body `{ password?, root_public_key, root_epoch, proof }` → `{ tenant_id, token, password_epoch }` |

**`proof` 是对象** `{ bytes: b64url, sig: b64url(64B) }`（`signRelayEnrollProof` 的两个字段直接 b64url）。`root_public_key` 为 b64url 32B，`root_epoch` 为非负整数。
错误码：`RELAY_INVALID_BODY` 400 / `RELAY_BAD_PROOF` 401（域、host、pk、时间窗 ±5 min、签名任一不符）/ `RELAY_PASSWORD_REQUIRED` 401（中继有口令但没带）/ **`RELAY_PASSWORD_INVALID` 401**（口令错，形如 `{"error":{"code":"RELAY_PASSWORD_INVALID","message":"RELAY_PASSWORD_INVALID"}}`）/ `RELAY_RATE_LIMITED` 429（同一源 IP 15 分钟内 5 次口令失败后，**任何** enroll 都拒，含口令正确的）。
同一 `root_public_key` 重复 enroll → `tenant_id` 不变、换新令牌、`token_epoch = password_epoch`、清 `kicked`、刷新 `root_epoch`。

### 租户令牌（header `x-tmex-relay-token: <token 原文 b64url>`）

| 方法 路由 | 行为 |
|---|---|
| `POST /api/relay/tenants/:tenantId/enrollments/redeem` | body `{ certificate, cert_sig, pop }`（都 b64url；`name` 不上传也不读）→ `{ tenant_id, relays: [publicUrl], rtc, key_log: [{ seq, blob }] }` |
| `GET /api/relay/tenants/:tenantId/enrollments/:enrollPkB64url` | → `{ authorization, authorization_sig, exp, used_at }`（前两个 b64url，`exp` 毫秒数，`used_at` null 或毫秒数） |

redeem 校验顺序：令牌 → enrollment 存在且属本租户 → `enroll_pk` 一致 → 未用过 → 未过期 → `cert_sig`（用 enrollment 存的 `enroll_pk` 验）→ PoP（`encodeRedeemPopMessage`，用证书里的 `ed_pk` 验，**必填**）→ 节点已存在且 revoked 拒 → 新节点查 `maxNodes` 配额 → 消费 enrollment → `relay_nodes` upsert 成 `pending`（已 admitted 的重 redeem 保持 admitted）→ 向该租户全部在线节点广播 `enroll.redeemed` → 返回。
错误码：`RELAY_UNAUTHORIZED` 401（无令牌）/ `RELAY_TOKEN_INVALID` 401（令牌不符或 epoch 过旧）/ `RELAY_TENANT_KICKED` 401 / `RELAY_TENANT_NOT_FOUND` 404 / `RELAY_INVALID_BODY` 400 / `RELAY_BAD_CERTIFICATE` 400 / `RELAY_ENROLLMENT_UNKNOWN` 400（含跨租户，不区分以免泄露）/ `RELAY_ENROLLMENT_USED` 400 / `RELAY_ENROLLMENT_EXPIRED` 400 / `RELAY_BAD_CERT_SIG` 400 / `RELAY_BAD_POP` 400 / `RELAY_NODE_REVOKED` 409 / `RELAY_QUOTA_NODES` 409。
enrollment 查询：找不到（含 b64url 非法、跨租户）一律 `RELAY_NOT_FOUND` 404。

### 管理（bearer 管理令牌 **或** 注入的本机 node-session）

| 方法 路由 | 说明 |
|---|---|
| `GET /api/relay/status` | `{ config: { hasPassword, passwordEpoch, minTokenEpoch, defaultQuota }, tenants: [...], totals: { tenants, nodesOnline, streams, bytesIn, bytesOut } }`，与 F2 契约逐字段一致；`bytesIn/Out` = 落库值 + 未刷新的内存增量 |
| `POST /api/relay/password` | `{ password: string \| null, mode: 'kick' \| 'keep' }` → `password_epoch += 1`；`kick` 时 `min_token_epoch = password_epoch` 并立刻断开 `token_epoch` 过旧的链路（先发 `relay.kicked{password_rotated}`） |
| `PATCH /api/relay/config` | `{ defaultQuota }` → 落库并把新配额推给所有「跟随默认」的在线租户 |
| `PATCH /api/relay/tenants/:id` | `{ quota?: RelayQuota \| null, label?: string \| null }`；`quota: null` 回到默认，`label: null` 或空串清空（label ≤128 字符，两端空白会 trim） |
| `POST /api/relay/tenants/:id/kick` | 置 `kicked`，发 `relay.kicked{kicked}` 后断开；该租户须重新 enroll 才能再连 |
| `DELETE /api/relay/tenants/:id` | 断开 + 删注册表、enrollment、密钥日志、计量 |

鉴权失败一律 401 `RELAY_UNAUTHORIZED`；未知 `/api/relay/*` 404 `RELAY_NOT_FOUND`；方法不符 405 `RELAY_METHOD_NOT_ALLOWED`。bearer 从 `Authorization: Bearer <token>` 或 `x-tmex-relay-admin-token` 读，比较的是 sha256 的常数时间比较。

### WebSocket

`GET /relay/uplink` → Bun upgrade（socket data `{ kind: 'relay-uplink' }`）。升级失败返回 426 `RELAY_UPGRADE_FAILED`。

## 三、表结构（迁移 `0039_relay.sql`）

```
relay_config      id(=1) PK, password_hash TEXT NULL, password_epoch INT=0, min_token_epoch INT=0,
                  admin_token_hash TEXT NULL, default_quota_json TEXT NOT NULL, updated_at INT
                  CHECK(id = 1)
relay_tenants     id TEXT PK(32 hex), root_public_key BLOB NOT NULL UNIQUE, root_epoch INT,
                  token_hash TEXT, token_epoch INT, quota_json TEXT NULL, label TEXT NULL,
                  kicked INT=0, created_at INT, last_seen_at INT NULL,
                  bytes_in INT=0, bytes_out INT=0, key_log_head_seq INT=0
relay_nodes       (tenant_id, node_id) PK, ed_pk BLOB, x25519_pk BLOB,
                  status TEXT CHECK in ('pending','admitted','revoked'), admit_seq INT NULL,
                  last_seen_at INT NULL, proto_version INT NULL, client_version TEXT NULL,
                  created_at INT, FK tenant_id → relay_tenants ON DELETE CASCADE
relay_enrollments id TEXT PK, tenant_id FK, enroll_pk BLOB UNIQUE, authorization_bytes BLOB,
                  authorization_sig BLOB, expires_at INT, used_at INT NULL, node_id TEXT NULL,
                  created_at INT
relay_key_log     (tenant_id, seq) PK, blob TEXT NOT NULL(信封 JSON), created_at INT
```

- `password_hash` 落 JSON：`{"kdf":"argon2id","salt":hex,"hash":hex,"memoryKib":65536,"iterations":3,"parallelism":1}`（与根密钥同参数）。
- `admin_token_hash` = sha256 hex；令牌原文不落库。
- `relay_key_log.blob` 存的是 `RelayEnvelope` 的 JSON 原样（`{v,epoch?,n,ct}`），中继从不解开。
- 中继不写 `users` / `node_certs` / `nodes` / `peer_cache` 等任何 hub 表。

## 四、测试 harness API（`apps/gateway/src/relay/relay-test-harness.ts`）

```ts
bootRelayHarness(opts?: {
  config?, now?, listDebounceMs?, heartbeatIntervalMs?, authTimeoutMs?, meterFlushIntervalMs?,
  minClientVersion?, isLocalUserAuthenticated?, clientIp?, password?
}): Promise<RelayHarness>

RelayHarness = {
  runtime: RelayRuntime; db; adminToken;
  now(); advance(ms);
  fetch(path, init?); adminFetch(path, init?); tenantFetch(path, token, init?);
  createTenant(opts?: { password?; uid? }): Promise<RelayTenantHandle>;
  close(): Promise<void>;
}

RelayTenantHandle = {
  id; token; root; uid; passwordEpoch;
  addNode(opts?: { admitSigner?: 'root' | 'passkey' }): RelayNodeFixture;  // 生成 ed/x25519/enroll + 证书 + admit-node 记录
  revokeRecord(nodeId, signer?): { bytes; sig };
  redeem(node): Promise<Response>;
  lookupEnrollment(node, token?): Promise<Response>;
  createEnrollment(node, client, id?): Promise<void>;   // 走 relay.enroll.create
  connect(node, opts?: { withMember?; clientVersion?; token? }): Promise<RelayNodeClient>;
}

RelayNodeClient = { nodeId; link; inbox; send(msg); openRelay(to); onStream(cb); close() }
relayCtlInbox(link) → { take(ms?), takeOf(type, ms?), drain() }
常量：RELAY_TEST_PUBLIC_URL = 'https://relay.example'，RELAY_TEST_ADMIN_TOKEN = 'relay-test-admin-token'
```

链路用 `createInMemoryLinkPair()`，不起真 WebSocket；`harness.fetch` 直接调 `runtime.handleRequest`。

用例覆盖：两租户隔离（list 不含对方、跨租户 relay OPEN → RST `unknown-target`、跨租户 rtc 不投递、跨租户 enrollment/key log 互不可见）、改密 kick vs keep、令牌 epoch、member admit（root 验签 / passkey 仅在已有 admitted 节点时容忍 / 证书 node_id 不符拒）、revoke 仅根签名（passkey → ack `member_ignored`）、seq mismatch、节点数与并发流配额、计量与落库、健康/状态/管理鉴权、enrollment 查询与 redeem 全链路。

## 五、配置键

| env | 作用 |
|---|---|
| `TMEX_ROLES=relay` / `relay,node` | 启用中继；`hub` 与 `relay` 同机 = 配置错误（启动即抛） |
| `TMEX_RELAY_PUBLIC_URL` | **必填**（缺失时 assemble 抛 `TMEX_RELAY_PUBLIC_URL is required when TMEX_ROLES includes relay`）。uplink 签名绑定其 host，redeem 的 `relays` 也用它 |
| `TMEX_RELAY_ADMIN_TOKEN` | 管理令牌；缺失时首启生成，production 写回 app.env，dev/test 只打印一次并把 sha256 落库 |
| 复用 | `TMEX_STUN_SERVERS` / `TMEX_TURN_URL` / `TMEX_TURN_USERNAME` / `TMEX_TURN_CREDENTIAL` 随 `auth.ok` / `relay.list` 下发 |

`createAssembledRelay` 读的是**运行时** `process.env`（回落到 config 快照），因为 `apps/gateway/src/config` 是模块加载时的 env 快照，同进程内多实例测试会读不到。

## 六、B3 / B4 / F1 必须知道的

1. **`POST /api/relay/enroll` 的 `proof` 是对象 `{ bytes, sig }`**（B4 §四.4 指出 B3 `callRelayEnroll` 目前发 `proof`(=sig) + `proof_bytes`，会被 400 `RELAY_INVALID_BODY`）。B3 需改成对象。`root_epoch` 必填且是整数。
2. **relay 流转发出去的 OPEN 首帧是 `{"to":"<target>","from":"<source>"}`**（与 hub 一致；`decodeRelayOpenStream` 只读 `to`，`from` 需自己从 JSON 取，见 `uplink-client.ts` 的 `parseOpenPayload`）。中继侧 OPEN 只接受 `{to}`。
3. **`relay.auth` 门禁**：`proto` 必须 `=== 1`；`client_version` 必须 ≥ `MIN_RELAY_CLIENT_VERSION`（`1.1.23`，`_dev` 后缀会被剥掉）。**当前仓库版本是 1.1.22，节点若照实上报会被以 `client-too-old` 断开** —— 集成实测前必须先把版本升到 1.1.23。
4. **断连原因字符串**（`link.close(reason)`，B3 可据此做提示）：`unknown-tenant` / `tenant-kicked` / `token-epoch` / `bad-token` / `proto-unsupported` / `client-too-old` / `member-required` / `member-<malformed|type_mismatch|bad_signature|node_mismatch|passkey_unverifiable>` / `revoked` / `bad-sig` / `unauthorized` / `auth-timeout` / `relay-password_rotated` / `relay-kicked` / `relay-revoked` / `relay-replaced` / `relay-stop`。
5. **成员规则**：节点未知或 `pending` 时 `relay.auth` 必须带 `member`（明文 `admit-node` 记录 bytes+sig）。根签名直接验；passkey 签名只有在该租户**已有** admitted 节点时才接受（首个节点必须根签名）。`relay.keylog.append.member` 的 `revoke` 只认根签名，passkey 会 ack `ok:true, member_ignored:true` 且不动注册表。
6. **`relay.keylog.append`** 的 `seq` 必须等于 head+1，否则 `ack {ok:false, error:'SEQ_MISMATCH', head}`。成功后中继向**同租户其他**在线节点推 `relay.keylog.push {records:[{seq,blob}]}`（一条一帧）。`relay.keylog.res` 每页 ≤64 条且整帧 ≤64 KiB，超了置 `has_more`。
7. **中继不解 blob**：`relay_key_log.blob` 原样存 `RelayEnvelope`。B4 §四.1 定的明文帧（`JSON {bytes, sig}` + kind `'keylog'`）对中继完全透明，B3/B4 自己对齐即可，中继不做任何校验。
8. **`enroll.redeemed`** 广播给该租户**全部**在线节点（中继不知道 entry node，不带 `entry_sid` / `already_admitted`）。
9. **`relay.status`** 只存内存最新一块，节点断开即消失；`relay.list` 里对端的 `blob`/`epoch` 只有该对端在线时才有。list 广播时机：auth ok、status 更新、keylog append、redeem、断开；默认 100 ms 防抖（harness 设 0）。整帧超 64 KiB 时退化成**不带 blob** 的清单。
10. **配额**：`maxNodes` 在 redeem 时按 pending+admitted 计（revoked 不占位）；`maxStreams` 在 OPEN 时按租户全部在线节点的并发流总数计，超了 `RST reason=quota-streams`；`bandwidthBytesPerSec` 是每租户令牌桶，只延迟不丢帧，`null` = 不限速。配额变更会立刻推 `relay.quota`。
11. **计量口径**：中继从节点读到的每一帧同时计入该租户的 `bytesIn` 与 `bytesOut`（转发前记账），即一次中转的同一份字节两边各记一次。默认 30 s 落库，`stop()` 强制刷。
12. **F1/F2**：`relay` 角色缺席时 `/api/relay/*` 由 gateway 兜底 404（`{error:"Not found"}` 字符串形态，`readCodedError` 会归一成 code=该字符串、status=404，`isRelayNotEnabled` 仍成立）。**注意**：node 角色下 `/api/*` 会先过 `localUiGuard`，非本机 UI 的请求可能拿到 403 而不是 404 —— 探针请求务必从已登录的本机 UI 发出。
13. **`relay,node` 的管理鉴权**：assemble 注入 `isLocalUserAuthenticated = (req) => routeDeps.authenticate(req).ok`（就是 mesh 的 `authenticateRequest`），所以本机 node-session 直接可用，不必配管理令牌。
14. `relay` 单跑时：不创建 mesh、不创建 standalone auth surface、前端一律 404（`{error:{code:'RELAY_NO_FRONTEND'}}`）。`assembled.relay` 字段可供上层判断。

## 七、验证

| 项 | 结果 |
|---|---|
| `bun test src/relay src/config.test.ts`（apps/gateway） | **107 pass / 0 fail**（relay 69 + config 38） |
| `bun test`（apps/gateway 全量） | **4077 pass / 0 fail**（169 s；中途曾见 B3 在飞的 `UplinkPool 上级种类切换` 失败，其代码落定后消失） |
| `bun test src`（packages/app 全量） | **766 pass / 0 fail**（含我新增的 4 个 assemble relay 用例；基线里那条 cpu-features 失败本次也过了） |
| `bunx tsc --noEmit -p apps/gateway` | **0 error** |
| `bunx tsc --noEmit -p packages/app` | 只剩基线 `TS2688 Cannot find type definition file for 'node'`（见 §八.2） |
| `bunx biome check`（本任务全部文件） | clean（37 文件） |
| `bun scripts/complexity/gate.ts` | 本任务文件全部合规（`relay-uplink-server.ts` 552、`assemble-routes.ts` 596，均在 600 内，未加 allowlist） |
| 真实临时实例 | 见下 |

真实实例（已停）：

```
TMEX_ROLES=relay TMEX_RELAY_PUBLIC_URL=http://127.0.0.1:19993 GATEWAY_PORT=19993 \
TMEX_BIND_HOST=127.0.0.1 TMEX_TMUX_SOCKET=tmex-relay-dev NODE_ENV=test \
DATABASE_URL=<scratch>/relay.db TMEX_DIRECT_ENABLED=false \
bun packages/app/src/runtime/server.ts
```

- 启动日志：`[relay] generated admin token (not persisted, set TMEX_RELAY_ADMIN_TOKEN to keep it): …`（test 模式不写 env 文件，符合设计）
- `GET /api/relay/health` → 200 `{"ok":true,"version":"1.1.22","tenants":0,"nodesOnline":0,"uptimeMs":4304}`
- `GET /api/relay/status` 无鉴权 401，带 bearer 200 且字段与 F2 契约一致
- `GET /` → 404（relay 单跑无前端）
- `POST /api/relay/enroll` 空 body → 400 `{"error":{"code":"RELAY_INVALID_BODY",…}}`
- 真 WebSocket 连 `ws://127.0.0.1:19993/relay/uplink` → 首帧为 ctl stream 0 上的 `{"t":"auth.cha…`，证明 Bun WS 适配器与 `routeWebsocket` 接线正确
- 收尾：kill 进程；`tmux -L tmex-relay-dev kill-server`（**只**杀隔离 socket，默认 socket 上的生产 `tmex` session 复查仍在）

## 八、需要指挥官处理

1. **`bun run lint` 仍有 4 个格式错误，全部来自指挥官那次机械补 `relay: false` 的提交**（`03837ef5`），不在我范围，未动：
   - `apps/gateway/src/db/local-auth-settings.test.ts`
   - `apps/gateway/src/mesh/mesh-http.test.ts`
   - `apps/gateway/src/mesh/session-middleware.test.ts`
   修法：`bunx biome check --write` 这三个文件（纯换行重排）。
2. **`bunx tsc --noEmit -p packages/app` 的基线 `TS2688` 是致命配置错误，会让 tsc 直接不报文件级错误**（我实测：故意塞一个 `const x: number = "nope"` 也不报）。也就是说 packages/app 目前 **没有任何有效的类型门禁**。临时绕法：用 `types: []` 的临时 tsconfig 跑（会冒出大量与 bun 类型不兼容的既有噪音，只能人工筛）。建议本轮之内修 `packages/app/tsconfig.json` 的 `types: ["node"]`（装 `@types/node` 或改成 `["bun"]`），否则 B4/L2 的类型问题都看不见。B4 §四.6 报的 `setup-service.ts:68 LocalStatus.role` 三值收窄就是被它挡住的。
3. **版本门禁**：`MIN_RELAY_CLIENT_VERSION = 1.1.23` 但仓库版本还是 1.1.22。B5 的进程内集成测试若用真实 `getBaseVersion()` 上报会被拒；发版前请先 bump（或让 B3 在测试里显式传 `client_version`）。
4. **`packages/api-client/src/local/types.ts` 的 `LocalRole`** 仍是三值（F2 §六.2 已提），`/api/local/status` 现在可能返回 `relay,node`。不在我范围。
5. `apps/gateway/drizzle/meta/_journal.json`、`db/schema.ts`、`db/managed-migrations.ts` 三个共享文件我各追加一行/一条目（0039），B3 的 0040 已在其后，顺序正确，无冲突。
