# B1-3c 结果：gateway key-log store / passkey / user bootstrap

## 做了什么

在 `apps/gateway/src/auth/` 落地密钥日志持久化、`UserKeyService`（单事务 apply）、SimpleWebAuthn 胶水、节点身份 ensure + 自签 `admit-node`。消费 `@tmex/shared/auth`（实现期间 shared 仍在改：`applyKeyLogRecord` 已变为 async；`reset-root` 必须 `allowGenesis`；`KeyLogEffect` 增加 `clearPeerCache`）。

## 文件清单

新增：

| 文件 | 作用 |
|---|---|
| `key-log-store.ts` | `user_key_log` 读写 + `payload_json` 投影 |
| `user-key-service.ts` | apply / applyMany / bootstrap / signAndApply / currentState / verifyChainForJoin |
| `passkey.ts` | SimpleWebAuthn 注册/断言 + 两个 adapter |
| `node-identity-service.ts` | `ensureNodeIdentity` / `selfSignedNodeCertificate` |
| `*.test.ts`（上列四模块） | bun test |

修改：

- `index.ts` — barrel
- `user-store.ts` — `deleteKeysByUser` / `listCertsByUser` / `deleteCertsByUser` / `deleteAllPeers`
- `node-session-store.ts` — `deleteAllForUser`

## Passkey `sig` 编码（已锁定）

passkey 签的 key-log 记录，`sig` = **UTF-8 字节** 的 `JSON.stringify(AuthenticationResponseJSON)`（WebAuthn 浏览器 `startAuthentication` 的 JSON 响应，原样序列化）。

- 记录验签 challenge = `sha256(recordBytes)`，放进 `clientDataJSON.challenge` 的是其 **base64url**（无 padding）。
- Delegation 路径：`assertion` 仍是 `AuthenticationResponseJSON` 对象（不是 bytes）；challenge = `delegationChallenge(delegation)` 的 base64url。
- 编解码：`encodePasskeyAssertionSig` / `decodePasskeyAssertionSig`。
- origin / rpId 取自 `user_keys` 该 credential 行（注册时绑定的 origin）。
- **未**使用 shared 后来加的 Borsh `PasskeyAssertion`；若协议要改成 Borsh sig，需 follow-up。

## 公开 API

### KeyLogStore

```ts
new KeyLogStore(db: AuthDb)
head(userId: string): KeyLogHead | null  // 读 users.key_log_head_*
list(userId: string, fromSeq?: number): { bytes, sig, seq: number, hash }[]
getAtSeq(userId: string, seq: number): KeyLogEntry | null
append(input: AppendKeyLogInput): void
deleteAll(userId: string): void
projectPayloadJson(type: string, payload: Uint8Array): string
```

### UserKeyService

```ts
new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore, verifyPasskeyAssertion? })

apply(userId, { bytes, sig }): Promise<
  | { ok: true; seq: number; hash: Uint8Array; effects: KeyLogEffect[] }
  | { ok: false; error: VerifyKeyLogError | ApplyKeyLogError | 'unknown_user' | 'malformed_payload' }
>
applyMany(userId, records): Promise<
  | { ok: true; applied: number; seq: number; hash: Uint8Array }
  | { ok: false; applied: number; error: string }
>
bootstrapUser({ username, password }): Promise<{
  userId: string; rootPublicKey: Uint8Array; rootEpoch: number; rootKey: RootKey
}>  // RootKey 只返回、永不落库
signAndApply(userId, rootKey, { type, payload: Uint8Array }): Promise<ApplyKeyLogServiceResult>
currentState(userId): UserKeyState
verifyChainForJoin(records, expectedRootPublicKey, expectedHeadHash): Promise<
  { ok: true; state: UserKeyState } | { ok: false; error: string }
>
kdfParamsToJson(params: KdfParams): string
kdfParamsFromJson(json: string): KdfParams
```

行为要点：

- `apply`：先 `verifyKeyLogRecord`（`existingAtSeq = {bytes,sig}`；`allowGenesis` 当 head.seq===0；fork 不写库），再 `await applyKeyLogRecord`，再 **一条 SQLite 事务** 落 diff（users 根钥/epoch/kdf/head/totp seq、`user_keys` 增删、`node_certs` upsert/`markCertRevoked`、effects → `revokeAllForUser` / `revokeByCredential` / `revokeVia`；`revoke-node` 删 `peer_cache`；`reset-root` 清空该用户 certs + `clearPeerCache` 清空 peer_cache）。
- `bootstrapUser`：派生根钥；已有用户则用当前 `root_epoch` 作 genesis 记录 epoch，否则 0；wipe `user_key_log` / `user_keys` / `node_sessions`、清 totp、head 归零，再 apply 自签 `reset-root`（seq 1）。返回的 `rootEpoch` 是 apply 后的值（genesis epoch + 1）。
- `verifyChainForJoin`：DB 已有该 uid 的 log → `{error:'not_empty'}`；否则按 genesis.uid 建用户（id=username=uid）再 `applyMany`。

`users.kdf_params_json`：`{"salt":"<base64url>","memory_kib":65536,"iterations":3,"parallelism":1}`。

`user_keys.credential_id`：payload 里的 base64url 字符串 decode 后的原始字节。

### passkey.ts

```ts
createRegistrationOptions({ uid, userId, rpId, existingCredentialIds, challenge: Uint8Array })
  → PublicKeyCredentialCreationOptionsJSON  // UV required, rpName 'tmex', userHandle=utf8(userId)
verifyRegistration({ response, expectedChallenge /* base64url */, origin, rpId })
  → AddPasskeyPayload | null
createAuthenticationOptions({ rpId, allowCredentials, challenge: Uint8Array })
verifyAssertion({ response, expectedChallenge, origin, rpId, credential: { id, publicKey(COSE), counter, transports } })
  → { ok: true, newCounter, userVerified } | { ok: false }
  // 计数器：stored≠0 且 new≤stored → 拒绝；stored=0 → 跳过（与 SimpleWebAuthn 13.3.3 一致）
makeVerifyPasskeyAssertion(userStore): VerifyPasskeyAssertion
makeVerifyDelegationPasskey(userStore): VerifyDelegationPasskey
```

### node-identity-service.ts

```ts
ensureNodeIdentity(store, { hubUrl? }): Promise<NodeIdentityKeys>
  // 已有则原样返回；否则生成 Ed25519+X25519 + 16B node id（hex 落库）
selfSignedNodeCertificate(identity, rootKey, { uid, rootEpoch, now }): Promise<AdmitNodePayload>
```

`NodeIdentityKeys`：`nodeId`（16B）/`nodeIdHex`/`hubUrl`/`edPrivateKey`/`edPublicKey`/`x25519PrivateKey`/`x25519PublicKey`。

首次 persist 时 `certificateJson` 占位 `{"x25519PublicKey":"<base64url>"}`（store 没有公钥列，load 时用它恢复 X25519 公钥；Ed25519 由 `rootKeyFromSeed` 派生）。后续若有任务把该列改成真正证书 JSON，必须同时保住 X25519 公钥。

## 测试

`cd apps/gateway && bun test src/auth`：

```
 37 pass
 0 fail
 551 expect() calls
Ran 37 tests across 10 files. [1256.00ms]
```

覆盖：bootstrap genesis；rotate-root 吊销会话/清 passkey+totp/拒旧根；fork 不改库；admit-node + revoke-node（revoked + revokeVia + 删 peer）；verifyChainForJoin 跨 DB 同 head hash；passkey ES256 合成认证器 round-trip + counter；ensure 稳定；自签 cert 经 `applyKeyLogRecord`。

全量 `cd apps/gateway && bun test`：

```
 1543 pass
 1 fail
 5094 expect() calls
Ran 1544 tests across 179 files. [29.42s]
```

失败不在本范围：`src/hub/uplink-server.test.ts`（心跳超时后 `online` 仍为 true，hub agent）。

biome：本范围 11 个文件 `Checked 11 files. No fixes applied.`

## tsc

| | 数量 |
|---|---|
| 基线 `apps/gateway` | 27 |
| 本次全量 | 35（并发 hub/mesh/ws 在改，会漂） |
| `src/auth/**` | **0** |
| 排除 `src/ws/**`、`runtime.ts`、`managed-entry.ts`、`agent/**` | 34（均非本任务文件：hub/uplink-protocol、mesh/peer-server、push、telegram、tmux-client 等） |

新文件无 tsc 错误；未增加 `src/auth` 错误。

## 协调者需要知道的

1. **shared 并发变更已适配**：`await applyKeyLogRecord(..., { verifyPasskeyAssertion })`；genesis `reset-root` 传 `allowGenesis: true`；fork 比较 `{bytes,sig}` 的 hash（不再把 record bytes 当 hash）；`reset-root` 清 `node_certs` + `clearPeerCache`。
2. **未接线** runtime / ws / CLI。调用方：`new UserKeyService({ db: getDb(), userStore, keyLogStore, nodeSessionStore, verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore) })`。
3. `hub join` 落库用户的 `username` 暂用 genesis `uid`（链上没有显示名）。
4. 范围外：`src/hub/uplink-server.test.ts` 1 fail；tsc 增量在 hub/mesh/push/tmux，不是本任务。
5. 未碰生产 tmex / 默认 tmux session `tmex`。未 `bun install`。
