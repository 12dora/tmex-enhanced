# B1-3a-fix 结果：`packages/shared/src/auth/` 安全审查修复

范围仅 `packages/shared/src/auth/**`。审查 `b1-3a-review.md` 全部条目已按「先失败后通过」补回归测试并落地。

## 审查项 → 改动 → 测试

### 1. `reset-root` 仅 genesis（blocker）

- `verifyKeyLogRecord` 默认 `ctx.allowGenesis === false`。`type === 'reset-root'` 仅当 `allowGenesis && head.seq === 0n && record.seq === 1n && prev_hash 全零` 才继续；否则 `reset_not_genesis`（在矩阵/验签之前）。
- genesis 仍用 payload 新根公钥自签。
- `verifyKeyLogChain` 仅 index 0 传 `allowGenesis: true`；后续再出现 `reset-root` 直接 `reset_not_genesis`。
- 测试：`key-log.test.ts` `reset-root is genesis only`（无 flag 的 seq=1 自签、head 前进后再 reset、链上第二条 reset）。

### 2. 严格 type/signer 矩阵（blocker）

- 导出 `KEY_LOG_SIGNER_MATRIX`：`rotate-root`/`reset-root` → `root`；其余 6 种 → `root | passkey`。
- `verifyKeyLogRecord` 在任何签名验证（含 passkey hook）之前查表，失败 `signer_not_allowed`。
- 测试：矩阵内容；passkey 签 `rotate-root` 且 hook 若被调用会标 true——断言 `signer_not_allowed` 且 hook 未调用。

### 3. Delegation 时间窗（major）

- 导出 `DELEGATION_CLOCK_SKEW_MS = 60_000`、`verifyDelegationTimes(delegation, now)`：
  1. `exp - issued_at === DELEGATION_TTL_MS` → `invalid_ttl`
  2. `issued_at <= now + 60_000` → 否则 `issued_in_future`
  3. `now < exp` → 否则 `expired`
- `verifyDelegation`（root）复用该函数；passkey 路径由 gateway 同样调用。
- 测试：`delegation.test.ts` `verifyDelegationTimes`（超长 TTL、`issued_at=0/exp=2^63-1`、未来 issued_at、边界 skew、过期）。

### 4. 分叉比较完整后继 + 规范 passkey sig（major）

- `detectFork({bytes, sig}, {bytes, sig})` 比较 `computeRecordHash`（`sha256(bytes ‖ sig)`）。
- `existingAtSeq?: { bytes, sig } | Uint8Array`（`Uint8Array` = 已存 32B hash）。
- 新增 Borsh `PasskeyAssertion { credential_id, client_data_json, authenticator_data, signature }`；`signer=passkey` 时记录 `sig` 必须是这些字节。
- 测试：同 `record_bytes` 不同 `sig` 报 fork；预计算 hash 路径；`encoding.test.ts` 锁定 assertion hex。

### 5. Enrollment 授权 union（major）

- `Authorization` 在 `root_epoch` 后追加 `signer: enum{root,passkey}`、`credential_id: option<string>`。
- `AdmitNodePayload.authorization_sig` 从 `bytes(64)` 改为变长 `bytes()`（root=64B Ed25519；passkey=`PasskeyAssertion` 字节，challenge=`sha256(authorization_bytes)`）。
- `applyKeyLogRecord` 改为 `async`，可选 `ctx.verifyPasskeyAssertion`（与 `verifyKeyLogRecord` 同 hook 类型；passkey 分支把 `recordBytes`/`sig`/`challenge` 填成授权字节）。root 路径内部仍同步。
- `createEnrollment`：root → `signer=root` + 64B 签；`PasskeySigner`（须带 `credentialId`）→ `signer=passkey` + assertion 字节。
- 测试：两种 authorization/admit-node hex；passkey enroll；`applyKeyLogRecord` 无 hook 拒、有 hook 收。

### 6. `reset-root` 清成员（major）

- `reset-root` 清空 `passkeys`/`totp`/`nodeCerts`，effects = `revokeAllSessions` + `clearPeerCache`。
- `rotate-root` 仍清 passkeys/totp、保留 `nodeCerts`，只发 `revokeAllSessions`。
- 测试：`reset-root vs rotate-root membership`。

### 7. `node_id` 禁止重用（major）

- `admit-node`：`nodeCerts` 已有该 id（含已吊销）→ `node_id_reused`。
- `revoke-node` 未知 id 仍为 `unknown_node`。
- 测试：二次 admit、revoke 后再 admit、未知 revoke。

### 8. 锁定向量 + ZIP-215 负向量（minor）

硬编码 hex（`encoding.test.ts` / 各模块测试）：

| 对象 | 输入要点 |
|---|---|
| login | `ch-1` / nonce=32×0x09 / target=`node-a` / … |
| authorization | root 与 passkey 两种（`signer`/`credential_id`） |
| certificate | node_id=16×0x07, issued_at=99 |
| totpAad | uid=`user-1`, epoch=2, seq=9 |
| 各 key-log payload | add/remove/rotate=reset/set-totp/clear=0B/revoke |
| admit-node | root 64B 证明 + passkey assertion 证明 |
| PasskeyAssertion | cred-1 + 4B aa/bb/cc |
| join token | 32×0x01 ‖ 32×0x02 ‖ 32×0x03 → 128 字符 |
| delegation challenge | 与 canonical delegation 同输入 |
| record hash | canonical keylog ‖ 64×0xab |
| AES-GCM | `kTotp=32×0x44`, secret=`JBSWY3DPEHPK3PXP`, nonce=12×0x07 |

ZIP-215：identity 公钥 `01‖31×00` + sig `01‖63×00` + msg=`tmex`；`ed25519.verify(..., {zip215:true})===true`，`{zip215:false}` 与 `verifyEd25519` 均为 false（noble 对 `S≥L` 在两种模式下都拒，故用小阶点）。

---

## 改动的文件

| 文件 | 变更 |
|---|---|
| `encoding.ts` | Authorization 字段、PasskeyAssertion、admit-node 变长 sig |
| `key-log.ts` | 矩阵、genesis flag、fork、async apply、reset/admit 语义 |
| `delegation.ts` | `verifyDelegationTimes` + skew |
| `enrollment.ts` | PasskeySigner.credentialId；authorization union |
| `totp-cipher.ts` | `encryptTotpSecret` 可选 `nonce`（仅测试） |
| `index.ts` | 新导出 |
| `*.test.ts` | 回归 + 锁定向量 |

---

## Changed signatures

gateway 必须按此适配（部分调用点已部分跟上）。**未列出的导出名保持不变。**

### 新增

```ts
DELEGATION_CLOCK_SKEW_MS = 60_000

function verifyDelegationTimes(
  delegation: Delegation,
  now: number | bigint
): { ok: true } | { ok: false; error: 'expired' | 'invalid_ttl' | 'issued_in_future' }

const KEY_LOG_SIGNER_MATRIX: Record<KeyLogType, readonly KeyLogSigner[]>

type KeyLogSignedRecord = { bytes: Uint8Array; sig: Uint8Array }
type ApplyKeyLogCtx = { verifyPasskeyAssertion?: VerifyPasskeyAssertion }

type PasskeyAssertion = {
  credential_id: string
  client_data_json: Uint8Array
  authenticator_data: Uint8Array
  signature: Uint8Array
}
function encodePasskeyAssertion(value: PasskeyAssertion): Uint8Array
function decodePasskeyAssertion(bytes: Uint8Array): PasskeyAssertion
```

### 签名/类型变化

```ts
// Authorization：在 root_epoch 后追加（线格式变化）
type Authorization = {
  domain: string; uid: string; enroll_pk: Uint8Array /*32*/
  exp: bigint; root_epoch: number
  signer: 'root' | 'passkey'
  credential_id: string | null
}

// AdmitNodePayload.authorization_sig：bytes() 变长，不再是固定 64
type AdmitNodePayload = {
  authorization_bytes: Uint8Array
  authorization_sig: Uint8Array   // root=64 Ed25519；passkey=PasskeyAssertion bytes
  certificate_bytes: Uint8Array
  cert_sig: Uint8Array /*64*/
}

type PasskeySigner = {
  credentialId: string
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>
}

function detectFork(
  existing: KeyLogSignedRecord,
  incoming: KeyLogSignedRecord
): boolean
// 旧：(KeyLogRecord | Uint8Array, KeyLogRecord | Uint8Array) 已删除

type VerifyKeyLogCtx = {
  // …
  existingAtSeq?: KeyLogSignedRecord | Uint8Array  // 旧：Uint8Array=record_bytes；现 Uint8Array=32B hash
  allowGenesis?: boolean  // 默认 false；仅本地 bootstrap 置 true
}

async function applyKeyLogRecord(
  state: UserKeyState,
  record: KeyLogRecord,
  hash: Uint8Array,
  ctx?: ApplyKeyLogCtx
): Promise<ApplyKeyLogResult>
// 旧：同步、无 ctx

async function encryptTotpSecret(
  kTotp: Uint8Array,
  secret: Uint8Array,
  aad: TotpAad | Uint8Array,
  nonce?: Uint8Array  // 12B，仅测试注入
): Promise<SetTotpPayload>

type KeyLogEffect =
  | { type: 'revokeAllSessions' }
  | { type: 'revokeSessionsByCredential'; credentialId: string }
  | { type: 'revokeSessionsVia'; nodeId: Uint8Array }
  | { type: 'clearPeerCache' }  // 新增；仅 reset-root

type VerifyKeyLogError = /* 旧 */ | 'signer_not_allowed' | 'reset_not_genesis'
type ApplyKeyLogError = /* 旧 */ | 'node_id_reused'
type VerifyDelegationResult.error =
  | 'expired' | 'bad_signature' | 'method_mismatch'
  | 'invalid_ttl' | 'issued_in_future'
```

`verifyKeyLogChain` 形参未变；内部已 `await applyKeyLogRecord` 并向下传 passkey hook。

Passkey hook 用于 **admit-node 内层授权** 时：`recordBytes = authorization_bytes`，`sig = authorization_sig`，`challenge = sha256(authorization_bytes)`，`credentialId = authorization.credential_id`。

---

## 测试 / tsc / biome

```
# 仅 auth
 87 pass  0 fail  299 expect() calls
 Ran 87 tests across 10 files. [745.00ms]

# packages/shared 全量（含并发 B1-2 link）
 258 pass  13 fail
 Ran 271 tests across 28 files. [16.07s]
 # 13 fail 全部 src/link/*（并发任务），本 scope 无 fail
```

tsc：`src/auth/**` **0 errors**。`packages/shared` 当前剩余错误均在 `src/link/`（并发，约 7 条 `websocket-link.test.ts`），本任务未引入。基线 shared 0 → auth 增量 0。

biome：`packages/shared/src/auth` 干净。

---

## 协调者必须做的（scope 外）

1. **gateway `apps/gateway/src/auth/passkey.ts`**：`encodePasskeyAssertionSig` 目前是 `JSON.stringify(AuthenticationResponseJSON)`。记录 `sig` 必须改为 `encodePasskeyAssertion({ credential_id, client_data_json, authenticator_data, signature })`（各字段为原始字节，不是 base64url 字符串）。
2. **`allowGenesis`**：`user-key-service.ts` 现用 `allowGenesis: state.head.seq === 0n`。审查要求 **仅本地 bootstrap**（`hub user add` / `mesh reset-root`）置 true；远程增量 append 即使 head 为 0 也不应接受外来 `reset-root`（join 应走 `verifyKeyLogChain`）。
3. **passkey login**：验完 WebAuthn 后必须再调 `verifyDelegationTimes(delegation, now)`。
4. **`createEnrollment` passkey**：`PasskeySigner` 现在必须带 `credentialId`。
5. **Authorization 线格式已变**（多两个字段）；**admit-node payload 的 `authorization_sig` 带 u32 长度前缀**。已存测试向量/库若写死旧字节需重生成。DB blob 本身变长，schema 不必改。
6. **`clearPeerCache` effect**：`reset-root` 后 gateway 必须清 `peer_cache`。
7. **`node_id_reused`**：换钥必须新随机 node_id + 显式 `revoke-node`。
8. persist 路径若仍只比 `record_bytes` 不分 `sig`（`user-key-service.ts` `again.bytes`），应改为 `computeRecordHash`。

未碰生产 tmex、默认 tmux session、`packages/shared/src/index.ts`、`bun install`。
