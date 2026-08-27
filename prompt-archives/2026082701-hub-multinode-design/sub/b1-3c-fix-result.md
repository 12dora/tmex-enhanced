# B1-3c-fix 结果：gateway auth 对齐 shared-auth 安全修复 + store 审查

范围仅 `apps/gateway/src/auth/**`。验收：`bun test src/auth` 绿、`src/auth` tsc 0、biome 干净。

## 审查项 → 改动 → 测试

### A1. passkey `sig` 改为 Borsh `PasskeyAssertion`

- 删除 JSON-string 编码。`encodePasskeyAssertionSig` 把浏览器 base64url 字段 decode 成原始字节后走 `encodePasskeyAssertion({credential_id, client_data_json, authenticator_data, signature})`。
- `decodePasskeyAssertionSig` 解 Borsh 再拼回 `AuthenticationResponseJSON`（`expectedChallenge = encodeBase64url(challenge)`）。
- JSON 字节被 `makeVerifyPasskeyAssertion` 拒绝。
- 测试：`passkey.test.ts` `passkey record sig is Borsh PasskeyAssertion of raw bytes, not JSON`；原 round-trip 用 Borsh sig 仍通过；JSON 断言被拒。

### A2. `allowGenesis: true` 仅 `bootstrapUser`

- `apply` / `applyMany` 永远 `allowGenesis: false`。
- 仅 `bootstrapUser` 经私有 `applyInternal(..., { allowGenesis: true })` 写本地 genesis。
- `verifyChainForJoin` 仍先 `verifyKeyLogChain`（链上 index 0 才允许 genesis），再 `commitVerified` 落库，不再走 `apply`。
- 测试：`remote reset-root at head 0 is rejected with reset_not_genesis`（`apply` 与 `applyMany`）；既有 join 链测试仍绿。

### A3. passkey delegation 验时间窗

- `makeVerifyDelegationPasskey(userStore, { now?: () => number })` 先 `verifyDelegationTimes(delegation, now())`。
- 测试：合法 TTL + 注入 `now` 通过；过期 / 非法 TTL 拒绝。

### A4. `PasskeySigner.credentialId`

- `selfSignedNodeCertificate(identity, signer: EnrollmentSigner, opts)`，passkey 路径把 `credentialId` 写入 Authorization。
- 测试：`selfSignedNodeCertificate passkey path carries credentialId on Authorization`。

### A5. 硬编码 Authorization / admit-node 向量

- `apps/gateway/src/auth/**` 测试全部现场 `createEnrollment` / `selfSignedNodeCertificate`，无硬编码 hex。无需重生。

### A6. `clearPeerCache` → `UserStore.deleteAllPeers()`

- 已接线于 `persistApplied`。补回归。
- 测试：`reset-root clearPeerCache effect deletes all peer_cache rows`（二次 `bootstrapUser`）。

### A7. `node_id_reused` 作为 apply 错误

- `applyKeyLogRecord` 已返回该错误，gateway 原样透出。
- 测试：二次 admit、revoke 后再 admit → `{ ok: false, error: 'node_id_reused' }`，head 不变。

### A8. persist fork 比较 `computeRecordHash({bytes,sig})`

- 事务内用 `detectFork({bytes,sig}, {bytes,sig})`，不再只比 `bytes`。
- 测试：同 `bytes` 不同 `sig` 于已有 seq → `fork`，DB 未变。

### B9. 原子 `consumeEnrollmentToken`

- `UPDATE … WHERE enroll_public_key = ? AND used_at IS NULL AND expires_at > ? RETURNING …`。
- `markEnrollmentUsed` 仍保留：`apps/gateway/src/hub/hub-runtime.ts` 还在用（scope 外）。
- 测试：连续两次 consume → 第二次 `null`；`now >= expiresAt` → `null`。

### B10. `IssueNodeSessionInput` 判别联合

- `{delegationMethod:'root'; credentialId?: null} | {delegationMethod:'passkey'; credentialId: Uint8Array}`。
- `issue` 在 passkey 且无/空 credential 时 throw。
- 测试：root 无 credential 成功且 `credentialId === null`；passkey 带 credential 成功；缺 credential throw。

---

## 改动的文件

| 文件 | 变更 |
|---|---|
| `passkey.ts` | Borsh sig；`verifyDelegationTimes` + `now` 注入 |
| `user-key-service.ts` | genesis 仅 bootstrap；persist fork 比 hash；join 走 `commitVerified` |
| `user-store.ts` | `consumeEnrollmentToken` |
| `node-session-store.ts` | 判别联合 + runtime throw |
| `node-identity-service.ts` | `EnrollmentSigner` |
| `index.ts` | 导出 `MakeVerifyDelegationPasskeyOptions` |
| `*.test.ts` | 上列回归 |

---

## Changed signatures

```ts
// passkey.ts
type MakeVerifyDelegationPasskeyOptions = { now?: () => number }

function encodePasskeyAssertionSig(assertion: AuthenticationResponseJSON): Uint8Array
function decodePasskeyAssertionSig(sig: Uint8Array): AuthenticationResponseJSON
function makeVerifyDelegationPasskey(
  userStore: UserStore,
  options?: MakeVerifyDelegationPasskeyOptions
): VerifyDelegationPasskey

// node-identity-service.ts
function selfSignedNodeCertificate(
  identity: NodeIdentityKeys,
  signer: EnrollmentSigner,  // 旧：RootKey
  opts: { uid: string; rootEpoch: number; now: number | bigint }
): Promise<AdmitNodePayload>

// user-store.ts
function consumeEnrollmentToken(
  enrollPublicKey: Uint8Array,
  input: { nodeId: string; now: number }
): EnrollmentTokenRecord | null
// markEnrollmentUsed 仍在（hub-runtime 引用）

// node-session-store.ts
type IssueNodeSessionInput = {
  userId: string; viaNodeId: string; sessPublicKey: Uint8Array; now: number
} & (
  | { delegationMethod: 'root'; credentialId?: null }
  | { delegationMethod: 'passkey'; credentialId: Uint8Array }
)
// issue(passkey 且无 credential) throws Error('passkey session requires credentialId')

// user-key-service.ts：公开 apply/applyMany 签名未变；内部 apply 永不 allowGenesis
```

未列出的导出名保持不变。

---

## 测试 / tsc / biome

```
cd apps/gateway && bun test src/auth

 45 pass
 0 fail
 607 expect() calls
Ran 45 tests across 10 files. [2.11s]
```

tsc：`src/auth/**` **0 errors**（基线 0 → 0）。`apps/gateway` 全量本次 **26** 条 `error TS`（基线 23）；本任务引入 1 条在 scope 外，见下。其余为并发模块（push/tmux/telegram/ws）。

biome：`apps/gateway/src/auth` `Checked 23 files. No fixes applied.`

---

## 未能做的 / 协调者必须做的

1. **`apps/gateway/src/mesh/auth-routes.ts:268`**（本任务引入的 tsc）：`issue({ delegationMethod: delegation.method, credentialId: credentialIdBytes(...) })` 不再满足判别联合。需按 method 分支：

```ts
const issued =
  delegation.method === 'passkey'
    ? this.deps.nodeSessionStore.issue({
        userId: user.id,
        viaNodeId: challenge.entryNodeId,
        sessPublicKey: delegation.sess_pk,
        delegationMethod: 'passkey',
        credentialId: credentialIdBytes(delegation.credential_id) ?? new Uint8Array(),
        now,
      })
    : this.deps.nodeSessionStore.issue({
        userId: user.id,
        viaNodeId: challenge.entryNodeId,
        sessPublicKey: delegation.sess_pk,
        delegationMethod: 'root',
        now,
      });
```

passkey 分支若 `credentialId` 为空，`issue` 会 throw，应在调用前返回 400 而不是把空数组传进去。

2. **`apps/gateway/src/hub/hub-runtime.ts:345`** 仍 `markEnrollmentUsed`。redeem 应在验签通过后改调 `consumeEnrollmentToken(certificate.enroll_pk, { nodeId: hexId, now })`，`null` → `reused`/`expired`。否则并发 redeem 仍可双花。

3. **`apps/gateway/src/db/schema.ts` `node_sessions` CHECK**（审查项 2 的 schema 半边，scope 外）：建议 `root ⇒ credential_id IS NULL`、`passkey ⇒ credential_id IS NOT NULL`。

未碰生产 tmex、默认 tmux session `tmex`、`bun install`、生成文件。
