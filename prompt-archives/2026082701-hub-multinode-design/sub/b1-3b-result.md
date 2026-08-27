# B1-3b 结果：gateway auth 存储层

## 做了什么

在 `apps/gateway` 落地 hub/node 鉴权存储：schema + 0018 迁移、challenge / node-session / node-identity / user 存储、cookie 工具、`TMEX_ROLES` 等配置解析。不依赖 `packages/shared/src/auth/`（未 import）。

`packages/shared/src/env/load-env.ts` **未改**：它只枚举 production 必需键，没有全量 env schema；新变量默认 standalone 不必填。

## 文件清单

新增 `apps/gateway/src/auth/**`：

| 文件 | 作用 |
|---|---|
| `types.ts` | `AuthDb` / `ChallengeKind` / `DelegationMethod` / `NodeStatus` |
| `binary.ts` | `toBuffer` / `toBytes` / `toBase64Url` / `fromBase64Url` |
| `cookies.ts` | Cookie 解析与 `Set-Cookie` |
| `challenge-store.ts` | 内存 challenge（60s、原子消费、过期清扫） |
| `node-session-store.ts` | `node_sessions`：签发 / 滑动续期 / 吊销 |
| `node-identity-store.ts` | 单行 `node_identity`，私钥用现有 `encrypt`/`decryptWithContext` |
| `user-store.ts` | users / user_keys / node_certs / peer_cache / nodes / enrollment_tokens CRUD |
| `index.ts` | barrel |
| `test-db.ts` | 测试用隔离 `:memory:` + 全量迁移（不从 barrel 导出） |
| `*.test.ts` | 各模块单测 + `schema.migration.test.ts` |

修改：

- `apps/gateway/src/db/schema.ts` — 9 张新表
- `apps/gateway/src/db/managed-migrations.ts` — 追加 `0018_hub_auth.sql`
- `apps/gateway/drizzle/0018_hub_auth.sql` + `drizzle/meta/0018_snapshot.json` + `_journal.json`
- `apps/gateway/src/config.ts` + `config.test.ts`

## Schema

表：`users`, `user_keys`, `user_key_log`, `node_sessions`, `node_certs`, `nodes`, `enrollment_tokens`, `node_identity`, `peer_cache`。

约定：二进制 `blob({ mode: 'buffer' })`（读写 `Buffer`，store 边界转 `Uint8Array`）；时间戳 integer ms；JSON 文本列带 `_json` 后缀。`node_identity.private_key` / `x25519_private_key` 为加密后的 **text**（`encrypt()` 输出 base64）。

唯一索引：`users.username`、`user_keys.credential_id`、`user_key_log (user_id, seq)`（另有复合 PK）、`node_certs.node_id`、`nodes.id`、`peer_cache.node_id`、`node_sessions.sid`（sid 亦为 PK）；普通索引 `node_sessions (user_id, via_node_id)`。`enrollment_tokens.enroll_public_key` 额外 unique（`getByEnrollPublicKey`）。`node_identity` 单例 `id=1`。

`user_key_log` 列：`seq, user_id, prev_hash, hash, root_epoch, type, record_bytes, sig, payload_json, created_at`。本任务无 key-log store（留给 follow-up）。

## 公开 API

构造 store 时注入 drizzle：`new XxxStore(getDb())`（`AuthDb = BunSQLiteDatabase<typeof schema>`）。

### cookies.ts

```ts
parseCookies(header: string | null | undefined): Map<string, string>
nodeSessionCookieName(nodeId: string): string  // 'tmex_s_' + nodeId（本地用 'self'）
buildSetCookie(name: string, value: string, { maxAgeSec, secure }): string
  // `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=…` [; Secure]
buildClearCookie(name: string): string
  // `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
```

### ChallengeStore（内存 Map；每次 create/consume 清扫过期）

```ts
type ChallengeKind = 'login' | 'passkey-register' | 'passkey-login' | 'rtc-authorize'
create({ uid, entryNodeId, kind, ttlMs, payload? }): { challengeId: string; nonce: Uint8Array } // nonce 32B
consume(challengeId: string): ChallengeEntry | null  // 原子；二次/过期/未知 → null
sweepExpired(now?: number): number
// ChallengeEntry: { challengeId, nonce, uid, entryNodeId, kind, expiresAt, payload? }
```

### NodeSessionStore

```ts
NODE_SESSION_TTL_MS = 18h
NODE_SESSION_HARD_TTL_MS = 7d
NODE_SESSION_RENEW_THROTTLE_MS = 5min

issue({ userId, viaNodeId, sessPublicKey, delegationMethod, credentialId?, now })
  → { sid: string /* 32B base64url */, expiresAt, hardExpiresAt }

verify(sid, { viaNodeId, now })
  → { ok: true, session: NodeSessionRecord, renewedExpiresAt?: number }
  | { ok: false, reason: 'unknown' | 'expired' | 'revoked' | 'via_mismatch' }
  // 校验顺序：unknown → revoked → via_mismatch → expired
  // now - renewedAt > 5min 时 expiresAt = min(now+18h, hardExpiresAt)，返回 renewedExpiresAt

revoke(sid, now?)
revokeAllForUser(userId, now?)
revokeByCredential(credentialId: Uint8Array, now?)
revokeVia(viaNodeId, now?)
sweepExpired(now): number  // 删除 expiresAt 或 hardExpiresAt ≤ now 的行
```

`sid` 落库为 32 字节 blob PK；cookie/API 用 base64url。

### NodeIdentityStore

```ts
load(): Promise<{
  nodeId: string
  hubUrl: string | null
  edPrivateKey: Uint8Array
  x25519PrivateKey: Uint8Array
  certificateJson: string
  certSig: Uint8Array
} | null>
save({ nodeId, hubUrl, edPrivateKey, x25519PrivateKey, certificateJson, certSig }): Promise<void>
clear(): void
```

私钥 `encrypt(base64(bytes))` / `decryptWithContext`（`scope: 'node_identity'`）。不生成密钥。

### UserStore（单类、表名前缀消歧义）

```ts
// users
getByUsername(username): UserRecord | null
getById(id): UserRecord | null
create({ id, username, rootPublicKey, rootEpoch, kdfParamsJson, totpRecordSeq?, keyLogHeadSeq, keyLogHeadHash, now }): UserRecord
updateRoot(userId, { rootPublicKey, rootEpoch, kdfParamsJson, now }): void
setKeyLogHead(userId, { seq, hash, now }): void
setTotpRecordSeq(userId, seq: number | null, now): void

// user_keys
listKeysByUser(userId): UserKeyRecord[]
getKeyByCredentialId(credentialId: Uint8Array): UserKeyRecord | null
insertKey({ id, userId, credentialId, publicKey, rpId, origin, counter, transports?, name?, logSeq, now }): UserKeyRecord
updateKeyCounter(credentialId: Uint8Array, counter): void
deleteKey(id): void

// node_certs
listCerts(): NodeCertRecord[]
getCert(nodeId): NodeCertRecord | null
upsertCert({ nodeId, userId, admitRecordSeq, certificateBytes, certSig, authorizationBytes, authorizationSig, revokedLogSeq? }): void
markCertRevoked(nodeId, revokedLogSeq): void

// peer_cache
listPeers(): PeerCacheRecord[]
upsertPeer({ nodeId, name, endpointsJson, inventoryJson, directCapable, lastSeenAt, listVersion }): void
deletePeer(nodeId): void

// nodes
createNode({ id, userId, name, status?, lastSeenAt?, version?, directCapable?, inventoryJson?, inventoryVersion?, endpointsJson?, now }): NodeRecord
getNode(id): NodeRecord | null
listNodes(): NodeRecord[]

// enrollment_tokens
createEnrollmentToken({ id, userId, enrollPublicKey, authorizationJson, authorizationSig, expiresAt }): EnrollmentTokenRecord
getEnrollmentTokenByEnrollPublicKey(enrollPublicKey: Uint8Array): EnrollmentTokenRecord | null
markEnrollmentUsed(id, { nodeId, now }): void
sweepExpiredEnrollmentTokens(now): number  // 只删未使用且过期
```

密钥/哈希/凭证字段在 store 边界为 `Uint8Array`。

### config

```ts
parseTmexRoles(raw?: string): { hub: boolean; node: boolean }
  // standalone → {f,f}；node → {f,t}；hub,node → {t,t}；其余抛错
parsePeerPort(raw?: string): number  // 默认 39001，范围 1..65535
parseStunServers(raw?: string): string[]

config.roles / hubUrl / hubPublicUrl / peerPort / stunServers / turnUrl / turnUsername / turnCredential
```

空可选 URL → `null`。

## 测试

本范围（`src/auth` + `config.test.ts`）：

```
 49 pass
 0 fail
 507 expect() calls
Ran 49 tests across 7 files. [221.00ms]
```

全量 `cd apps/gateway && bun test`：

```
 1496 pass
 8 fail
 1 error
 4762 expect() calls
Ran 1504 tests across 172 files. [27.21s]
```

失败全部在范围外（ws 重构 agent）：

- `src/agent/ws-hub.test.ts` — 6 fail（`AgentHubClient` / 发送路径）
- `src/ws/device-connection-registry.test.ts` — 1 fail（`client.borshState.selectedPanes`）
- `src/ws/borsh/index.test.ts` — 1 error（`createBorshClientState` 未导出）

基线 1472 pass；本任务新增约 27 条，均绿。

biome：范围文件 `Checked 19 files. No fixes applied.`

## tsc

| | 数量 |
|---|---|
| 基线 `apps/gateway` | 27 |
| 本次全量 | 31（ws 重构仍在改，数字会漂） |
| 排除 `src/ws/**`、`runtime.ts`、`managed-entry.ts`、`agent/ws-hub.ts` | **22 ≤ 27** |
| `src/auth/**` | **0** |

排除范围后的 22 条均在既有文件（push / telegram / tmux-client / tmux/ssh-auth 等），非本任务引入。

排除范围内的 tsc 错误文件（供对照）：`agent/ws-hub.test.ts`、`ws/index.test.ts`、`ws/issue45-cross-bug.test.ts`、`ws/switch-barrier.issue45.test.ts`（以及可能仍在变的 `ws/borsh`、`ws/host-interfaces`）。

## 协调者 / 范围外

1. **未改** `load-env.ts`、`development.env` / `test.env`、`packages/app` 的 `app.env` 写入。安装/init 要把 `TMEX_ROLES` 等写进 `app.env` 时由 CLI 任务做。
2. **未接线** runtime：store 需调用方 `new NodeSessionStore(getDb())` 等。
3. **无** `user_key_log` 读写 store（schema 已有）；key-log / passkey 验证 follow-up 用本报告 + schema。
4. UserStore 方法因同文件多表而加了前缀（`listKeysByUser` 而非 `listByUser`）；见上表。
5. 生产私钥加密依赖已有 `TMEX_MASTER_KEY`；identity 测试走 `test.env` 的 master key。
