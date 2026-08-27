# B1-3a 结果：`packages/shared/src/auth/` 身份原语

## 做了什么

新建纯函数模块 `@tmex/shared/auth`（未从主入口 `src/index.ts` 再导出）。无 DB / HTTP / cookie。

| 文件 | 职责 |
|---|---|
| `packages/shared/src/auth/encoding.ts` | Borsh schema、`encode*`/`decode*`、sha256 / base64url / hex / `randomBytes` |
| `packages/shared/src/auth/root-key.ts` | Argon2id `deriveSeed`、Ed25519 根钥、sign/verify（`zip215: false`）、X25519 |
| `packages/shared/src/auth/delegation.ts` | 18h 根钥 delegation；passkey challenge = `sha256(borsh(delegation))` |
| `packages/shared/src/auth/login.ts` | `buildLogin` / `signLogin` / `verifyLogin` 精确错误码 |
| `packages/shared/src/auth/key-log.ts` | 链式哈希、验签、纯 reducer、`verifyKeyLogChain` |
| `packages/shared/src/auth/enrollment.ts` | enroll 授权、join token、节点证书 |
| `packages/shared/src/auth/totp.ts` | 浏览器安全 HKDF `k_totp` + RFC 6238 HMAC-SHA1 |
| `packages/shared/src/auth/totp-cipher.ts` | Node/Bun WebCrypto AES-256-GCM（浏览器登录只需要 `deriveTotpKey`） |
| `packages/shared/src/auth/peer-handshake.ts` | transcript 排序、指纹规范化、会话密钥 HKDF |
| `packages/shared/src/auth/index.ts` | barrel |
| `packages/shared/package.json` | 增加 `"./auth": "./src/auth/index.ts"`（已保留并发加入的 `"./link"`） |
| `*.test.ts` | 每个模块一份 |

时间戳一律 **unix 毫秒 `bigint`**。`now` 接受 `number | bigint`（`Date.now()` 即可）。

Enum 走 `b.nativeEnum`，线格式为 Borsh `u8` 下标，**顺序即线格式**，JS 值为字符串（`'root'` / `'add-passkey'` 等）。

---

## 导入

```ts
import { deriveSeed, createDelegation, verifyLogin, verifyKeyLogChain } from '@tmex/shared/auth';
```

---

## 导出 API（gateway 按此写）

### 常量

```ts
DOMAIN_DELEGATION    = 'tmex/delegation/v1'
DOMAIN_LOGIN         = 'tmex/login/v1'
DOMAIN_AUTHORIZATION = 'tmex/enroll/v1'
DOMAIN_CERTIFICATE   = 'tmex/nodecert/v1'
DOMAIN_KEY_LOG       = 'tmex/keylog/v1'
DOMAIN_PEER          = 'tmex/peer/v1'

DelegationMethod = { root: 'root', passkey: 'passkey' }
KeyLogSigner     = { root: 'root', passkey: 'passkey' }
KeyLogType       = {
  'add-passkey': 'add-passkey',
  'remove-passkey': 'remove-passkey',
  'rotate-root': 'rotate-root',
  'set-totp': 'set-totp',
  'clear-totp': 'clear-totp',
  'admit-node': 'admit-node',
  'revoke-node': 'revoke-node',
  'reset-root': 'reset-root',
} // 线格式下标 0..7，禁止重排
PeerPath = { dc: 'dc', relay: 'relay' } // 0=dc, 1=relay

ARGON2ID_MEMORY_KIB = 65536
ARGON2ID_ITERATIONS = 3
ARGON2ID_PARALLELISM = 1
ARGON2ID_HASH_LENGTH = 32
KDF_SALT_LENGTH = 16
DELEGATION_TTL_MS = 18 * 60 * 60 * 1000
ENROLLMENT_TTL_MS = 10 * 60 * 1000
JOIN_TOKEN_BYTES = 96
JOIN_TOKEN_CHARS = 128
TOTP_SALT_PREFIX = 'tmex-totp'
TOTP_DEFAULT_STEP = 30
TOTP_DEFAULT_DIGITS = 6
TOTP_AEAD_ALG = 'A256GCM'
PEER_SESSION_INFO_PREFIX = 'tmex-sc/v1/'
```

### encoding

```ts
function encodeDelegation(value: Delegation): Uint8Array
function decodeDelegation(bytes: Uint8Array): Delegation
function encodeLogin(value: Login): Uint8Array
function decodeLogin(bytes: Uint8Array): Login
function encodeAuthorization(value: Authorization): Uint8Array
function decodeAuthorization(bytes: Uint8Array): Authorization
function encodeCertificate(value: Certificate): Uint8Array
function decodeCertificate(bytes: Uint8Array): Certificate
function encodeKeyLogRecord(value: KeyLogRecord): Uint8Array
function decodeKeyLogRecord(bytes: Uint8Array): KeyLogRecord
function encodePeerTranscript(value: PeerTranscript): Uint8Array
function decodePeerTranscript(bytes: Uint8Array): PeerTranscript
function encodeTotpAad(value: TotpAad): Uint8Array
function decodeTotpAad(bytes: Uint8Array): TotpAad
function encodeAddPasskeyPayload / decodeAddPasskeyPayload
function encodeRemovePasskeyPayload / decodeRemovePasskeyPayload
function encodeRotateRootPayload / decodeRotateRootPayload
function encodeResetRootPayload / decodeResetRootPayload   // 与 rotate 同 schema
function encodeSetTotpPayload / decodeSetTotpPayload
function encodeClearTotpPayload(value?: ClearTotpPayload): Uint8Array  // 空 struct = 0 字节
function decodeClearTotpPayload(bytes: Uint8Array): ClearTotpPayload
function encodeAdmitNodePayload / decodeAdmitNodePayload
function encodeRevokeNodePayload / decodeRevokeNodePayload
function encodeKdfParams / decodeKdfParams

function sha256(bytes: Uint8Array): Uint8Array
function bytesToHex(bytes: Uint8Array): string            // lowercase
function hexToBytes(hex: string): Uint8Array
function encodeBase64url(bytes: Uint8Array): string       // 无 padding
function decodeBase64url(input: string): Uint8Array
function randomBytes(n: number): Uint8Array               // crypto.getRandomValues
function concatBytes(...arrays: Uint8Array[]): Uint8Array
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
function compareBytes(a: Uint8Array, b: Uint8Array): number
function u32ToLe(value: number): Uint8Array
function nodeIdToHex(nodeId: Uint8Array): string          // lowercase hex，Map 键用这个
```

结构体字段（Borsh 顺序，首字段 `domain`，option 用 `null`）：

```ts
type Delegation = {
  domain: string; uid: string; sess_pk: Uint8Array /*32*/;
  issued_at: bigint; exp: bigint;
  method: 'root' | 'passkey'; credential_id: string | null;
}
type Login = {
  domain: string; challenge_id: string; nonce: Uint8Array /*32*/;
  target: string; target_pk: Uint8Array /*32*/; uid: string; entry: string;
}
type Authorization = {
  domain: string; uid: string; enroll_pk: Uint8Array /*32*/;
  exp: bigint; root_epoch: number;
}
type Certificate = {
  domain: string; uid: string; node_id: Uint8Array /*16*/;
  ed_pk: Uint8Array /*32*/; x25519_pk: Uint8Array /*32*/;
  enroll_pk: Uint8Array /*32*/; issued_at: bigint;
}
type KeyLogRecord = {
  domain: string; uid: string; seq: bigint; prev_hash: Uint8Array /*32*/;
  root_epoch: number; type: KeyLogType; payload: Uint8Array;
  signer: 'root' | 'passkey'; credential_id: string | null;
}
type PeerHello = {
  node_id: Uint8Array /*16*/; nonce: Uint8Array /*32*/;
  eph_x25519_pk: Uint8Array /*32*/ | null;
  dtls_fingerprint: { algorithm: string; value: string } | null;
}
type PeerTranscript = {
  domain: string; path: 'dc' | 'relay'; hello_lo: PeerHello; hello_hi: PeerHello;
}
type TotpAad = { uid: string; root_epoch: number; seq: bigint }  // 无 domain
type KdfParams = { salt: Uint8Array /*16*/; memory_kib: number; iterations: number; parallelism: number }

type AddPasskeyPayload = {
  credential_id: string; public_key: Uint8Array /*COSE*/; rp_id: string; origin: string;
  counter: number; transports: string[]; backup_eligible: boolean; backup_state: boolean;
  device_type: string; name: string;
}
type RemovePasskeyPayload = { credential_id: string }
type RotateRootPayload = { root_public_key: Uint8Array /*32*/; kdf_params: KdfParams }
type SetTotpPayload = { alg: string; nonce: Uint8Array /*12*/; ciphertext: Uint8Array; tag: Uint8Array /*16*/ }
type AdmitNodePayload = {
  authorization_bytes: Uint8Array; authorization_sig: Uint8Array /*64*/;
  certificate_bytes: Uint8Array; cert_sig: Uint8Array /*64*/;
}
type RevokeNodePayload = { node_id: Uint8Array /*16*/; reason: string }
```

Schema 值也导出（`DelegationSchema` 等），需要直接 `serialize` 时用。

### root-key

```ts
interface RootKey {
  readonly publicKey: Uint8Array;  // 32
  readonly seed: Uint8Array;       // 32，即 Ed25519 secret
  sign(message: Uint8Array): Uint8Array; // 64
}

function generateKdfParams(): KdfParams
async function deriveSeed(password: string, kdfParams: KdfParams): Promise<Uint8Array>
  // NFKC → UTF-8 → argon2id；每次调用新建 options 对象
function rootKeyFromSeed(seed: Uint8Array): RootKey
function signEd25519(secretKey: Uint8Array, message: Uint8Array): Uint8Array
function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean
  // 内部 { zip215: false }；畸形输入返回 false 不抛
function generateEd25519KeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array }
function generateX25519KeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array }
```

### delegation

```ts
function createDelegation(rootKey: RootKey, opts: {
  uid: string; sessPk: Uint8Array; now: number | bigint; credentialId?: string | null;
}): { delegation: Delegation; bytes: Uint8Array; sig: Uint8Array }
  // method='root'；exp = issued_at + 18h

function verifyDelegation(delegation: Delegation, sig: Uint8Array, ctx: {
  rootPublicKey: Uint8Array; now: number | bigint;
}): { ok: true; delegation: Delegation } | { ok: false; error: 'expired' | 'bad_signature' | 'method_mismatch' }
  // 仅 method=root；now >= exp → expired；passkey → method_mismatch

function buildPasskeyDelegation(opts: {
  uid: string; sessPk: Uint8Array; now: number | bigint; credentialId: string;
}): Delegation  // method='passkey'

function delegationChallenge(delegation: Delegation): Uint8Array
  // sha256(borsh(delegation))，给 SimpleWebAuthn 当 challenge

type VerifyDelegationPasskey = (args: {
  challenge: Uint8Array; delegation: Delegation; assertion: unknown; credentialId: string;
}) => boolean | Promise<boolean>
  // 仅类型；gateway 用 SimpleWebAuthn 填实现
```

### login

```ts
function buildLogin(fields: {
  challengeId: string; nonce: Uint8Array; target: string; targetPk: Uint8Array;
  uid: string; entry: string;
}): Login

function signLogin(sessSk: Uint8Array, login: Login): Uint8Array

function verifyLogin(
  login: Login, sig: Uint8Array, sessPk: Uint8Array,
  expected: { challengeId: string; nonce: Uint8Array; target: string; targetPk: Uint8Array; uid: string; entry: string }
): { ok: true } | { ok: false; error:
     'challenge_mismatch' | 'target_mismatch' | 'uid_mismatch' | 'entry_mismatch' | 'bad_signature' }
  // 检查顺序即错误码优先级；challenge_id 或 nonce 错 → challenge_mismatch；
  // target 或 target_pk 错 → target_mismatch
```

### key-log

```ts
type KeyLogHead = { seq: bigint; hash: Uint8Array /*32*/ }  // genesis: seq=0n, hash=32×0x00

function genesisHead(): KeyLogHead
function emptyUserKeyState(rootPublicKey: Uint8Array, kdfParams?: KdfParams, rootEpoch?: number): UserKeyState
function computeRecordHash(recordBytes: Uint8Array, sig: Uint8Array): Uint8Array  // sha256(bytes ‖ sig)

function buildKeyLogRecord(head: KeyLogHead, epoch: number, fields: {
  uid: string; type: KeyLogType; payload: Uint8Array;
  signer: 'root' | 'passkey'; credential_id: string | null;
}): KeyLogRecord  // seq = head.seq+1, prev_hash = head.hash

function signKeyLogRecordWithRoot(rootKey: RootKey, recordBytes: Uint8Array): Uint8Array

function detectFork(existing: KeyLogRecord | Uint8Array, incoming: KeyLogRecord | Uint8Array): boolean
  // 编码字节不同即为分叉

async function verifyKeyLogRecord(recordBytes: Uint8Array, sig: Uint8Array, ctx: {
  head: KeyLogHead; rootEpoch: number; rootPublicKey: Uint8Array;
  resolvePasskey: (credentialId: string) => Uint8Array /*COSE*/ | null;
  verifyPasskeyAssertion?: (args: {
    recordBytes: Uint8Array; sig: Uint8Array; credentialId: string;
    publicKey: Uint8Array; challenge: Uint8Array; // challenge = sha256(recordBytes)
  }) => boolean | Promise<boolean>;
  existingAtSeq?: Uint8Array;  // 若提供且与 incoming 不同 → 'fork'
}): Promise<
  | { ok: true; record: KeyLogRecord; hash: Uint8Array }
  | { ok: false; error: 'seq_gap' | 'prev_hash_mismatch' | 'epoch_mismatch' | 'bad_signature' | 'unknown_signer' | 'fork' }
>
  // signer=root：用 ctx.rootPublicKey（reset-root 特例：用 payload 里的新根公钥自签）
  // signer=passkey：无 credential / resolve 失败 / 无 hook → unknown_signer

type UserKeyState = {
  rootPublicKey: Uint8Array; rootEpoch: number; kdfParams: KdfParams;
  passkeys: Map<string, AddPasskeyPayload>;
  totp: SetTotpPayload | null;
  nodeCerts: Map<string /*nodeId hex*/, StoredNodeCert>;
  head: KeyLogHead;
}
type StoredNodeCert = {
  nodeId: Uint8Array; certificateBytes: Uint8Array; certSig: Uint8Array;
  authorizationBytes: Uint8Array; authorizationSig: Uint8Array; revoked: boolean;
}
type KeyLogEffect =
  | { type: 'revokeAllSessions' }
  | { type: 'revokeSessionsByCredential'; credentialId: string }
  | { type: 'revokeSessionsVia'; nodeId: Uint8Array }

function applyKeyLogRecord(state: UserKeyState, record: KeyLogRecord, hash: Uint8Array):
  | { ok: true; state: UserKeyState; effects: KeyLogEffect[] }
  | { ok: false; error:
      'bad_authorization_sig' | 'bad_cert_sig' | 'enroll_pk_mismatch' |
      'uid_mismatch' | 'unknown_node' | 'malformed_payload' }
  // 不修改入参；rotate-root/reset-root → 新 pk+kdf、epoch+=1、清空 passkeys/totp、effect revokeAllSessions
  // admit-node：authorization_sig 用当前根公钥；cert_sig 用 authorization.enroll_pk；
  //   certificate.enroll_pk == authorization.enroll_pk；三方 uid 一致
  // 会话吊销是 gateway 的事，只通过 effects 声明

async function verifyKeyLogChain(
  records: { bytes: Uint8Array; sig: Uint8Array }[],
  trustedRootPublicKey: Uint8Array,
  expectedHeadHash?: Uint8Array,
  options?: {
    verifyPasskeyAssertion?: VerifyPasskeyAssertion;
    initialKdfParams?: KdfParams;
    initialEpoch?: number;
  }
): Promise<
  | { ok: true; state: UserKeyState }
  | { ok: false; error: VerifyKeyLogError | ApplyKeyLogError | 'head_hash_mismatch' }
>
```

**hub join 语义（重要）**：`trustedRootPublicKey` 是 **链起点（epoch 0）验签钥**。遇到 `rotate-root` 后切换到 payload 新钥。调用方再用 `state.rootPublicKey` 与 join 串里的**当前**根公钥比对。若用户从未 rotate，join 串公钥 == 起点钥，直接传入即可。若已 rotate，join 串只有当前钥、没有 genesis 钥，本函数无法凭当前钥回放历史（旧记录由旧钥签）。gateway 若要在 rotate 后 join，需要额外拿到 genesis 根公钥，或改 join 串/redeem 响应。

`reset-root` 由 **payload 新根公钥自签**（灾难恢复，不依赖旧钥）。

### enrollment

```ts
type PasskeySigner = { sign(message: Uint8Array): Uint8Array | Promise<Uint8Array> }
type EnrollmentSigner = RootKey | PasskeySigner

async function createEnrollment(signer: EnrollmentSigner, opts: {
  uid: string; rootEpoch: number; now: number | bigint; ttlMs?: number; // 默认 10min
}): Promise<{
  enrollSk: Uint8Array; enrollPk: Uint8Array;
  authorizationBytes: Uint8Array; authorizationSig: Uint8Array;
}>
  // 内层 authorization 设计为 Ed25519 64 字节签（admit-node payload 固定 [64]）。
  // passkey 只应签外层 key-log 记录，不要把 WebAuthn assertion 塞进 authorization_sig。

function encodeJoinToken(enrollSk: Uint8Array, rootPublicKey: Uint8Array, keyLogHeadHash: Uint8Array): string
  // base64url(sk‖pk‖hash) = 96B → 128 字符，无 padding
function decodeJoinToken(token: string): {
  enrollSk: Uint8Array; rootPublicKey: Uint8Array; keyLogHeadHash: Uint8Array;
}

function createNodeCertificate(enrollSk: Uint8Array, opts: {
  uid: string; edPk: Uint8Array; x25519Pk: Uint8Array; enrollPk: Uint8Array;
  now: number | bigint; nodeId?: Uint8Array; // 默认 16 随机字节
}): { nodeId: Uint8Array; certificate: Certificate; certificateBytes: Uint8Array; certSig: Uint8Array }

function verifyNodeCertificate(certBytes: Uint8Array, certSig: Uint8Array, enrollPk: Uint8Array): boolean
```

### totp / totp-cipher

```ts
function deriveTotpKey(seed: Uint8Array, uid: string, rootEpoch: number): Uint8Array
  // HKDF-SHA-256(seed, salt="tmex-totp"‖u32LE(epoch), info=utf8(uid), 32)  — noble，浏览器安全

function totpCode(secret: Uint8Array, time: number /*unix 秒*/, opts?: {
  step?: number; digits?: number; t0?: number;
}): string  // 左边补 0

function verifyTotpCode(secret: Uint8Array, code: string, time: number, opts?: TotpCodeOptions): boolean
  // ±1 step

async function encryptTotpSecret(
  kTotp: Uint8Array, secret: Uint8Array, aad: TotpAad | Uint8Array
): Promise<SetTotpPayload>  // { alg:'A256GCM', nonce[12], ciphertext, tag[16] }

async function decryptTotpSecret(
  kTotp: Uint8Array, record: SetTotpPayload, aad: TotpAad | Uint8Array
): Promise<Uint8Array>  // 失败抛错（tag/AAD/密文篡改）

function totpAadBytes(aad: TotpAad | Uint8Array): Uint8Array
```

登录时浏览器只调 `deriveTotpKey`；`encrypt/decrypt` 仅 Bun/gateway。

### peer-handshake

```ts
function buildPeerTranscript(path: 'dc' | 'relay', helloA: PeerHello, helloB: PeerHello): PeerTranscript
  // 按 node_id 字节字典序排 hello_lo/hello_hi；A,B 与 B,A 编码字节相同

function signTranscript(nodeEdSk: Uint8Array, transcript: PeerTranscript | Uint8Array): Uint8Array
function verifyTranscript(transcript: PeerTranscript | Uint8Array, sig: Uint8Array, nodeEdPk: Uint8Array): boolean

function normalizeFingerprint(fp: { algorithm: string; value: string }): DtlsFingerprint
  // algorithm 小写；value 去冒号/空白后大写 hex
function parseSdpFingerprint(sdp: string): DtlsFingerprint | null
  // 匹配 a=fingerprint:<alg> <hex:hex:...>

function derivePeerSessionKeys(
  sharedSecret: Uint8Array, transcriptBytes: Uint8Array,
  selfNodeId: Uint8Array, peerNodeId: Uint8Array
): { sendKey: Uint8Array; recvKey: Uint8Array }
  // k = HKDF-SHA-256(ss, salt=sha256(transcript), info="tmex-sc/v1/"+hex(sender)+"->"+hex(receiver), 32)
  // sender/receiver = node_id 小写 hex（无分隔符）UTF-8
```

---

## 锁定向量（协议测试向量）

### Argon2id / 根钥 / delegation 签名

```
password = "tmex-test"
salt     = 16 × 0x01
m=65536 KiB, t=3, p=1, len=32
seed     = c309e52473a3209eb21f065c873725f397a79dc8de84d30b078f95c2a3ae8c85
root pk  = 4ecb7f7d549e39da61154177e3a6bb1002106c106df014bbc6e9fc34e8943860

delegation: uid=user-1, sess_pk=32×0x02, issued_at=1000000000000, exp=1000064800000, method=root
borsh     = 12000000746d65782f64656c65676174696f6e2f763106000000757365722d31
            0202…02 (32) 10a5d4e800000000 d581d8e800000000 00
sig       = 6b86235d9bf23a13f7c906fe3e65c90af14bf33324899ed70184884224585410
            264a7d3a6f884a060e6b64c303e2844ad2cef5b322746145ecc698962b2c210b
```

### TOTP HKDF

```
seed = 32 × 0x11, uid="user-1", epoch=0
k_totp = f5104f9232dae1a6b6d3a5b60b6263e8a55edf41484e66c7992a451555318e06
epoch=1 → 437adb4c3dc6cdaa0c8cc7cd4593aa0db668f1afb41abb9f1366cdd38b756513
```

### Peer 会话密钥（给 B1-2 / `secure-channel-link` 对拍）

```
ss            = 32 × 0x33
self (A)      = 16 × 0x01   hex = 01010101010101010101010101010101
peer (B)      = 16 × 0x02   hex = 02020202020202020202020202020202
path          = relay (u8 1)
helloA        = { node_id:A, nonce:32×0x0a, eph_x25519_pk:32×0x21, dtls_fingerprint:null }
helloB        = { node_id:B, nonce:32×0x0b, eph_x25519_pk:32×0x22, dtls_fingerprint:null }
info_send     = utf8("tmex-sc/v1/01010101010101010101010101010101->02020202020202020202020202020202")
info_recv     = utf8("tmex-sc/v1/02020202020202020202020202020202->01010101010101010101010101010101")
salt          = sha256(transcriptBytes)

transcript hex =
0c000000746d65782f706565722f763101010101010101010101010101010101010a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a01212121212121212121212121212121212121212121212121212121212121212100020202020202020202020202020202020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b01222222222222222222222222222222222222222222222222222222222222222200

sendKey (A→B) = 165c79043174233c73c91d5882f948bd2600db98d206816437287363b741eb7e
recvKey (A←B) = db3a38e82b6fc68d9bde76882b3728c29c2c43cd1eed8ee3112e7cc7a4186a3d
```

B 端 `derivePeerSessionKeys(ss, transcript, B, A)` 的 send/recv 与上面互换。未 import `link/secure-channel-link.ts`。

---

## 测试 / tsc / biome

```
# packages/shared 全量（含并发 link 测试）
 231 pass  0 fail  681 expect() calls
 Ran 231 tests across 28 files. [742.00ms]

# 仅本任务
 63 pass  0 fail  202 expect() calls
 Ran 63 tests across 10 files. [680.00ms]
```

基线 `packages/shared` 141 pass / 0 tsc。本任务新增 63 测，全绿。

tsc：`src/auth/**` **0 errors**。`bunx tsc --noEmit -p packages/shared` 当前 **18 errors，全部在 `src/link/`**（并发 B1-2），本模块未引入。基线 0 → 包级现 18，增量不在本 scope。

biome：`packages/shared/src/auth` + `package.json` 干净。

---

## 协调者需要知道的

1. **gateway (`apps/gateway/src/auth/`)** 从 `@tmex/shared/auth` 导入；passkey 验签自己填 `VerifyDelegationPasskey` / `VerifyPasskeyAssertion`（SimpleWebAuthn）。本模块不依赖 WebAuthn。
2. **inner `authorization_sig` 必须是 Ed25519 64B**（admit-node payload 固定 `bytes(64)`）。passkey 只签外层 key-log 记录。
3. **`verifyKeyLogChain` 的第一个公钥参数是 genesis 钥**，不是 join 串里的当前钥（若发生过 `rotate-root`）。join 流程要在本模块之外比对 `state.rootPublicKey`。
4. **会话吊销**不在本模块：`applyKeyLogRecord` 只返回 `effects`。
5. **对拍会话密钥**：上表向量。若 link 侧 HKDF info 的 node_id hex 大小写或分隔符不同，会对不上——本侧是 **小写无冒号 hex**。
6. 未改 `packages/shared/src/index.ts`。未碰生产 tmex / 默认 tmux session。

## 指挥官修正（commit 前）

1. `derivePeerSessionKeys` 改为直接复用 `link/secure-channel-link.ts` 的 `deriveSecureChannelKeys`，HKDF info 里 node_id 统一为 **raw 16 字节**（与 B1-2 一致），向量重算：send `76b73d81…93e2`、recv `0096914b…72cf`。
2. `verifyKeyLogChain(records, expectedRootPublicKey | null, expectedHeadHash?, options?)`：链改为自描述——首条记录必须是 seq=1 的自签 `reset-root`（genesis，payload 给出 epoch-0 根公钥，验证起始 epoch 取自该记录的 `root_epoch`），回放到头后 `state.rootPublicKey` 必须等于 `expectedRootPublicKey`（否则 `root_mismatch`；缺 genesis → `missing_genesis`）。因此 `hub user add` 的第一条记录就是 `reset-root`，用户初始 `root_epoch` 为 genesis 记录 epoch + 1。
