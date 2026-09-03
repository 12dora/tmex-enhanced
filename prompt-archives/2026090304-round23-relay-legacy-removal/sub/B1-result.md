# B1 结果：shared 侧中继协议编解码、租户密钥、join 串 v3、新密钥日志记录、角色

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`）。所有代码只落在 `packages/shared`，未 commit。

## 一、改动文件

新增：

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/shared/src/relay/codec.ts` | 517 | `relay/v1` ctl 消息类型 + `encodeRelayCtl` / `decodeRelayCtl` + 边界常量 |
| `packages/shared/src/relay/tenant-cipher.ts` | 268 | K_log/K_meta 信封（AES-GCM）与按节点 X25519 封装 |
| `packages/shared/src/relay/join-token.ts` | 222 | join 串 v3（`r3.`）编解码 |
| `packages/shared/src/relay/blobs.ts` | 139 | `relay.status` / `relay.rtc` 明文块、relay 流 OPEN 首帧 |
| `packages/shared/src/relay/enroll-proof.ts` | 111 | `tmex/relay-enroll/v1` Borsh proof 签名/验签 |
| `packages/shared/src/relay/index.ts` | 107 | `@tmex/shared/relay` barrel（上面五个文件的导出面） |
| `packages/shared/src/auth/relay-records.ts` | 198 | `set-relays` / `meta-key` 的 Borsh schema、编解码、状态投影 |
| `packages/shared/src/auth/key-log-hub.ts` | 47 | 从 key-log.ts 抽出的 `applyAdmitHub` / `applyRetireHub` / `retireHubIfAdmitted`（行数腾挪，见 §六） |
| 测试 | — | `relay/{codec,tenant-cipher,join-token,blobs,enroll-proof}.test.ts`、`auth/relay-records.test.ts` |

修改：

- `packages/shared/src/roles.ts` + `roles.test.ts`：新增 `relay` 角色、`validateRoles`。
- `packages/shared/src/auth/encoding.ts`：`KeyLogType` 增加 `'set-relays'`、`'meta-key'`（+2 行，未动任何既有记录格式）。
- `packages/shared/src/auth/key-log.ts`：状态字段、签名矩阵、版本门禁、apply 分派（重构为分派表，见 §六）。
- `packages/shared/src/auth/index.ts`：导出 relay-records 的全部公开名与 `RELAY_RECORD_TYPES`。
- `packages/shared/src/index.ts` + `index.test.ts`：新增 `validateRoles` 导出与快照条目（各 1 行，编辑前重读过文件，未碰 L1a 的 ws-borsh 行）。
- `packages/shared/package.json`：`exports` 增加 `"./relay": "./src/relay/index.ts"`（唯一的 package.json 改动，无依赖变更）。

## 二、导出 API

### 1. `@tmex/shared`（roles）

```ts
type TmexRoleName = 'standalone' | 'node' | 'hub,node' | 'relay' | 'relay,node';
type TmexRoles = { hub: boolean; node: boolean; relay: boolean };   // ← 新增 relay 字段
const TMEX_ROLE_NAMES: readonly TmexRoleName[];                     // 仅 roles.ts 导出，未进主 barrel
function isTmexRoleName(value: string): value is TmexRoleName;
function rolesFromName(name: TmexRoleName): TmexRoles;
function roleNameFromFlags(roles: TmexRoles): TmexRoleName;         // relay 优先：relay+node → 'relay,node'
function isStandaloneRoles(roles: TmexRoles): boolean;              // 三个标志位全 false
function validateRoles(roles: TmexRoles): string | null;            // hub&&relay → 'relay cannot be combined with hub'
```

### 2. `@tmex/shared/relay` — tenant-cipher

```ts
class RelayCipherError extends Error;
type RelayEnvelope = { v: 1; epoch?: number; n: string; ct: string };      // n/ct 为 b64url
type WrapEntry = { node_id: string; eph_pk: string; nonce: string; ct: string }; // node_id 为 32 位小写 hex
const RELAY_TENANT_KEY_LENGTH = 32, RELAY_ENVELOPE_VERSION = 1,
      RELAY_ENVELOPE_NONCE_LENGTH = 12, RELAY_WRAP_NONCE_LENGTH = 12,
      RELAY_WRAP_CIPHERTEXT_LENGTH = 48, RELAY_WRAP_HKDF_SALT = 'tmex-relay-wrap/v1',
      RELAY_ENVELOPE_AAD_PREFIX = 'tmex-relay/', RELAY_ENVELOPE_AAD_SUFFIX = '/v1';
function relayEnvelopeAad(kind: string): Uint8Array;                       // = utf8("tmex-relay/<kind>/v1")
function generateTenantKey(): Uint8Array;                                  // 32B
async function sealEnvelope(key, kind: string, plaintext: Uint8Array, epoch?: number): Promise<RelayEnvelope>;
async function openEnvelope(key, kind: string, env: RelayEnvelope): Promise<Uint8Array>;
async function wrapKeyForNode(i: { key: Uint8Array; nodeId: string; nodeX25519Pk: Uint8Array }): Promise<WrapEntry>;
async function wrapKeyForNodes(i: { key: Uint8Array; nodes: readonly { nodeId: string; x25519Pk: Uint8Array }[] }): Promise<WrapEntry[]>;
function findWrapEntry(entries: readonly WrapEntry[], nodeId: string): WrapEntry | undefined;
async function unwrapKeyForNode(i: { entry: WrapEntry; nodeX25519Sk: Uint8Array }): Promise<Uint8Array>;
```

细节（与 plan 1.3 一致，不要改）：
- 信封：AES-256-GCM，nonce 12B 随机，AAD = `tmex-relay/<kind>/v1`，tag 128 位并入 `ct`。`kind` 受 `^[a-z][a-z0-9-]{0,31}$` 约束；约定用 `keylog` / `status` / `rtc` / `list`。密钥或 AAD 不对一律抛 `RelayCipherError`。
- 封装：`eph = x25519.keygen()`；`ss = X25519(eph_sk, node_x25519_pk)`；`wrapKey = HKDF-SHA256(ss, salt = utf8("tmex-relay-wrap/v1"), info = node_id 16B, 32)`；`ct = AES-256-GCM(wrapKey, nonce 12B, K)`，**无 AAD**（node_id 已经进 info），固定 48B。
- 浏览器与 Bun 共用：只用 WebCrypto `crypto.subtle` + `@noble/curves` x25519 + `@noble/hashes` hkdf/sha256（与 `link/secure-channel-link.ts` 同一套 import）。

### 3. `@tmex/shared/relay` — join 串 v3

```ts
class RelayJoinTokenError extends Error;
type RelayJoinToken = {
  enrollSk: Uint8Array; rootPublicKey: Uint8Array; keyLogHeadHash: Uint8Array;
  logKey: Uint8Array;              // K_log 32B
  tenantId: string;                // 32 位小写 hex（16B）
  token: Uint8Array;               // 租户令牌 32B 原文；上 uplink 时自己 encodeBase64url
  relayUrls: string[];             // 已归一化，顺序即 failover 顺序
  caFingerprint?: string;
};
const RELAY_JOIN_TOKEN_PREFIX = 'r3.', RELAY_JOIN_TOKEN_FIXED_BYTES = 176,
      RELAY_JOIN_TOKEN_MAX_URLS = 16, RELAY_JOIN_TOKEN_MAX_URL_LEN = 512,
      RELAY_JOIN_TOKEN_CA_FINGERPRINT_CHARS = 64;
function isRelayJoinToken(value: string): boolean;                     // 仅判前缀 'r3.'
function normalizeRelayUrl(raw: string): string;                       // canonicalHubUrl + https（回环允许 http）
function encodeRelayJoinToken(input: { enrollSk; rootPublicKey; keyLogHeadHash; logKey; tenantId; token; relayUrls: readonly string[]; caFingerprint?: string | null }): string;
function decodeRelayJoinToken(token: string): RelayJoinToken;
```

字节布局：`"r3." + base64url(enroll_sk32 ‖ root_pk32 ‖ head_hash32 ‖ K_log32 ‖ tenant_id16 ‖ token32 ‖ n(u8) ‖ [len(u16 LE) ‖ url utf8]×n)`，可选 `.<64hex>` CA 指纹后缀（与旧 hub join 串同规矩，`decodeJoinToken` 的 96B 串仍是 hub 模式）。拒绝：前缀不符、base64url 非法、长度 < 177、`n = 0`、`n > 16`、url 长度 0 或 > 512、url 非 https（`http://localhost`、`http://127.0.0.1`、`[::1]` 例外）、地址表截断或有尾部多余字节。编码缓冲（含 enroll_sk 与 K_log）在 `finally` 里清零。

### 4. `@tmex/shared/relay` — ctl 编解码

```ts
const RELAY_PROTO_VERSION = 1;
const MIN_RELAY_CLIENT_VERSION = '1.1.23';
const RELAY_CTL_TYPES: readonly RelayCtlType[];       // 18 个，见 §三
class RelayCtlError extends Error;
type RelaySeqWire = number | string;                  // u64 溢出 2^53 时走字符串
function relaySeqToWire(seq: bigint | number): RelaySeqWire;
function relaySeqFromWire(value: RelaySeqWire): bigint;
function parseRelayCtl(value: unknown): RelayCtlMessage;      // 校验 + 归一化（丢未知字段）
function encodeRelayCtl(msg: RelayCtlMessage): Uint8Array;    // 内部走 parseRelayCtl，encode 同样校验
function decodeRelayCtl(input: Uint8Array | string): RelayCtlMessage;
// 边界：RELAY_CTL_MAX_BYTES=64KiB, MAX_DEPTH=8, MAX_ARRAY_LEN=1024, MAX_STRING_LEN=48KiB,
//       MAX_SHORT_STRING_LEN=512, MAX_NODES=256, MAX_STUN=8, MAX_CERT_BYTES=2048,
//       MAX_MEMBER_BYTES=8KiB, KEYLOG_PAGE_DEFAULT_LIMIT=32, KEYLOG_PAGE_MAX_LIMIT=64,
//       RELAY_KEYLOG_SEQ_MISMATCH='SEQ_MISMATCH'
```

**seq 是 wire 形态（`number | string`），不是 bigint**：B2/B3 用 `relaySeqToWire(head + 1n)` / `relaySeqFromWire(msg.seq)` 转换。`relay.keylog.res/push` 每页最多 64 条且整帧 ≤64 KiB（超了 `encodeRelayCtl` 抛错），中继必须自己分页并置 `has_more`。

消息类型（TS 定义在 `codec.ts`，字段名即 wire 字段名）：

```ts
type RelayCtlMessage =
  | { t: 'auth.challenge'; nonce: string /*b64url 32B*/ }
  | { t: 'relay.auth'; tenant_id: string /*32hex*/; token: string /*b64url 32B*/; node_id: string /*32hex*/;
      sig: string /*b64url 64B*/; proto: number; client_version: string; member?: { bytes: string; sig: string } }
  | { t: 'auth.ok'; tenant_id: string; key_log_head_seq: RelaySeqWire; rtc: RelayRtcConfig }
  | { t: 'ping' } | { t: 'pong' }
  | { t: 'relay.status'; blob: RelayEnvelope; epoch: number; direct_capable: boolean }
  | { t: 'relay.list'; version: number; nodes: RelayListNode[]; rtc: RelayRtcConfig; key_log_head_seq: RelaySeqWire }
  | { t: 'relay.keylog.append'; id: string; seq: RelaySeqWire; blob: RelayEnvelope;
      member?: { op: 'admit' | 'revoke'; bytes: string; sig: string } }
  | { t: 'relay.keylog.ack'; id: string; ok: boolean; seq?: RelaySeqWire; error?: string; head?: RelaySeqWire; member_ignored?: boolean }
  | { t: 'relay.keylog.req'; from_seq: RelaySeqWire; limit?: number /*1..64*/ }
  | { t: 'relay.keylog.res'; records: { seq: RelaySeqWire; blob: RelayEnvelope }[]; has_more?: boolean }
  | { t: 'relay.keylog.push'; records: { seq: RelaySeqWire; blob: RelayEnvelope }[]; has_more?: boolean }
  | { t: 'relay.rtc'; rtcSession: string; from: 'browser' | 'node'; to: string /*32hex*/; enc: RelayEnvelope }
  | { t: 'relay.enroll.create'; id: string; enroll_pk: string /*32B*/; authorization: string; authorization_sig: string /*64B*/; exp: number }
  | { t: 'relay.enroll.ack'; id: string; ok: boolean; error?: string }
  | { t: 'enroll.redeemed'; certificate: string; cert_sig: string /*64B*/; enroll_pk: string /*32B*/; node_id: string /*32hex*/ }
  | ({ t: 'relay.quota' } & { maxNodes: number; maxStreams: number; bandwidthBytesPerSec: number | null })
  | { t: 'relay.kicked'; reason: 'password_rotated' | 'kicked' | 'revoked' };

type RelayListNode = { id: string; online: boolean; status: 'pending' | 'admitted' | 'revoked';
                       direct_capable: boolean; epoch?: number; blob?: RelayEnvelope };
type RelayRtcConfig = { stun: string[]; turn: { url: string; username: string; credential: string } | null };
type RelayQuota = { maxNodes: number; maxStreams: number; bandwidthBytesPerSec: number | null };
```

### 5. `@tmex/shared/relay` — 明文块与流 OPEN

```ts
type RelayOpenStream = { to: string };                        // 规范里写的 RELAY_OPEN_STREAM，实际类型名是 RelayOpenStream
function encodeRelayOpenStream(open: RelayOpenStream): Uint8Array;   // 产出 {"to":"<32hex>"}，与 hub 逐字节一致
function decodeRelayOpenStream(bytes: Uint8Array): RelayOpenStream;
type RelayStatusBlob = { name: string; version: string; tmux: boolean; inventory: unknown; endpoints: unknown };
function encodeRelayStatusBlob(b: RelayStatusBlob): Uint8Array;  // JSON，≤32KiB，endpoints ≤32，name ≤256
function decodeRelayStatusBlob(bytes: Uint8Array): RelayStatusBlob;  // inventory/endpoints 缺省归一为 null
type RelayRtcBlob = { sdp?: string; candidate?: string };
function encodeRelayRtcBlob(b: RelayRtcBlob): Uint8Array;        // JSON，≤16KiB
function decodeRelayRtcBlob(bytes: Uint8Array): RelayRtcBlob;
const RELAY_OPEN_STREAM_MAX_BYTES = 256, RELAY_STATUS_BLOB_MAX_BYTES = 32*1024,
      RELAY_RTC_BLOB_MAX_BYTES = 16*1024, RELAY_STATUS_MAX_ENDPOINTS = 32, RELAY_STATUS_MAX_NAME_LEN = 256;
```

状态块与 RTC 块都是**信封的明文**：`sealEnvelope(K_meta, 'status', encodeRelayStatusBlob(blob), epoch)` / `sealEnvelope(K_meta, 'rtc', encodeRelayRtcBlob(blob), epoch)`。错误一律 `RelayCtlError`。

### 6. `@tmex/shared/relay` — enroll proof

```ts
const DOMAIN_RELAY_ENROLL = 'tmex/relay-enroll/v1';
const RELAY_ENROLL_PROOF_MAX_SKEW_MS = 5 * 60 * 1000;
const RelayEnrollProofSchema;    // Borsh 字段顺序：domain(string) ‖ relay_host(string) ‖ root_public_key(32B) ‖ ts(u64)
type RelayEnrollProof = { domain: string; relay_host: string; root_public_key: Uint8Array; ts: bigint };
type SignedRelayEnrollProof = { bytes: Uint8Array; sig: Uint8Array };
function encodeRelayEnrollProof(i: { relayHost: string; rootPublicKey: Uint8Array; ts: number | bigint }): Uint8Array;
function decodeRelayEnrollProof(bytes: Uint8Array): RelayEnrollProof;
function signRelayEnrollProof(rootKey: { publicKey: Uint8Array; sign(m: Uint8Array): Uint8Array },
                              i: { relayHost: string; ts: number | bigint }): SignedRelayEnrollProof;
function verifyRelayEnrollProof(i: { bytes; sig; relayHost: string; rootPublicKey: Uint8Array; now?: number | bigint; maxSkewMs?: number }):
  | { ok: true; proof: RelayEnrollProof }
  | { ok: false; error: 'malformed' | 'domain_mismatch' | 'relay_host_mismatch' | 'root_public_key_mismatch' | 'ts_skew' | 'bad_signature' };
```

`verifyRelayEnrollProof` 传 `now` 才判时间窗（默认 ±5 分钟）；`relayHost` 用 `hubHostFromUrl(TMEX_RELAY_PUBLIC_URL)` 的结果。

### 7. `@tmex/shared/auth` — 新记录类型

```ts
const RELAY_RECORD_TYPES = ['set-relays', 'meta-key'] as const;   // 来自 key-log.ts
const MIN_RELAY_RECORD_VERSION = '1.1.23';
const RELAY_RECORD_MAX_RELAYS = 16, RELAY_RECORD_MAX_URL_LEN = 512, RELAY_RECORD_MAX_WRAP_ENTRIES = 1024;
const RelayListMode = { ordered: 'ordered' } as const;
const RelayWrapEntrySchema, RelayTargetSchema, MetaKeyPayloadSchema, SetRelaysPayloadSchema;
type RelayWrapEntryBytes = { node_id: Uint8Array; eph_pk: Uint8Array; nonce: Uint8Array; ct: Uint8Array };
type RelayTargetPayload = { url: string; tenant_id: Uint8Array; token: Uint8Array; priority: number };
type MetaKeyPayload = { epoch: number; entries: RelayWrapEntryBytes[] };
type SetRelaysPayload = { mode: 'ordered'; relays: RelayTargetPayload[]; log_key: RelayWrapEntryBytes[]; meta_key: MetaKeyPayload };
function encodeSetRelaysPayload(v: SetRelaysPayload): Uint8Array;
function decodeSetRelaysPayload(b: Uint8Array): SetRelaysPayload;
function encodeMetaKeyPayload(v: MetaKeyPayload): Uint8Array;
function decodeMetaKeyPayload(b: Uint8Array): MetaKeyPayload;
function wrapEntryToBytes(entry: WrapEntry): RelayWrapEntryBytes;      // wire(b64url) → Borsh(bytes)
function wrapEntryFromBytes(entry: RelayWrapEntryBytes): WrapEntry;    // Borsh(bytes) → wire(b64url)
function applyRelayKeyLogRecord(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult;  // key-log 内部已接好
function cloneRelayList(list: StoredRelayList | null): StoredRelayList | null;
type StoredRelayTarget = { url: string; tenantId: string /*32hex*/; token: Uint8Array; priority: number };
type StoredRelayList = { mode: 'ordered'; relays: StoredRelayTarget[]; logKeyEntries: WrapEntry[]; seq: bigint };
```

**Borsh 字段顺序（改一个字节就是换协议）**：

```
RelayWrapEntry  : node_id(bytes 16) ‖ eph_pk(bytes 32) ‖ nonce(bytes 12) ‖ ct(bytes 48)
RelayTarget     : url(string) ‖ tenant_id(bytes 16) ‖ token(bytes 32) ‖ priority(u8)
meta-key payload: epoch(u32) ‖ entries(vec<RelayWrapEntry>)
set-relays payload: mode(nativeEnum RelayListMode，u8，0 = 'ordered')
                  ‖ relays(vec<RelayTarget>)
                  ‖ log_key(vec<RelayWrapEntry>)
                  ‖ meta_key(MetaKeyPayload = epoch(u32) ‖ entries(vec<RelayWrapEntry>))
```

### 8. key-log 状态新增字段

`UserKeyState` 增加三个字段（`emptyUserKeyState` 初始化为 `null / 0 / []`，`cloneState` 深拷贝）：

```ts
relays: StoredRelayList | null;   // set-relays 投影；relays 为空数组时置 null（= 离开中继）
metaKeyEpoch: number;             // 已应用的 K_meta 世代，0 = 尚无
metaKeyEntries: WrapEntry[];      // 最近一次 meta-key / set-relays.meta_key 的封装条目（wire 形态，直接喂 unwrapKeyForNode）
```

应用规则：
- `set-relays`：`meta_key.epoch` 允许 `== metaKeyEpoch`（同世代补发）或更大，小于则记录判定为无效，返回 `{ ok: false, error: 'relay_epoch_regression' }`（`ApplyKeyLogError` 新增的一个取值）。`relays` 非空时写入 `{ mode, relays, logKeyEntries, seq }`，为空时 `relays = null`。url 走 `canonicalHubUrl` 归一化（**这里不强制 https**，方便 docker/LAN 实测；只有 join 串强制 https），非法 url、relays > 16、wrap 条目 > 1024 一律 `malformed_payload`。
- `meta-key`：`epoch` 必须 **严格大于** `metaKeyEpoch`，否则 `relay_epoch_regression`；`entries` 非空时 `epoch` 必须 ≥ 1。
- 签名矩阵 `KEY_LOG_SIGNER_MATRIX`：两者都是 `['root', 'passkey']`。
- `KEYLOG_RECORD_COMPAT`：两者都是 `{ minVersion: '1.1.23', allowForce: false }`。
- 既有记录格式与 `admit-node` / `revoke-node` / `rotate-root*` 的行为一字未改。

## 三、ctl wire 示例（`encodeRelayCtl` 实际产出，b64 已省略为占位符）

```json
{"t":"auth.challenge","nonce":"<b64url32>"}
{"t":"relay.auth","tenant_id":"cdcd…cd","token":"<b64url32>","node_id":"aaaa…aa","sig":"<b64url64>","proto":1,"client_version":"1.1.23","member":{"bytes":"<b64url>","sig":"<b64url64>"}}
{"t":"auth.ok","tenant_id":"cdcd…cd","key_log_head_seq":12,"rtc":{"stun":["stun:stun.example.com:3478"],"turn":null}}
{"t":"ping"}
{"t":"pong"}
{"t":"relay.status","blob":{"v":1,"epoch":4,"n":"<b64url12>","ct":"<b64url>"},"epoch":4,"direct_capable":true}
{"t":"relay.list","version":3,"nodes":[{"id":"aaaa…aa","online":true,"status":"admitted","direct_capable":true,"epoch":4,"blob":{"v":1,"epoch":4,"n":"<b64url12>","ct":"<b64url>"}},{"id":"bbbb…bb","online":false,"status":"pending","direct_capable":false}],"rtc":{"stun":["stun:stun.example.com:3478"],"turn":null},"key_log_head_seq":12}
{"t":"relay.keylog.append","id":"req-1","seq":13,"blob":{"v":1,"epoch":4,"n":"<b64url12>","ct":"<b64url>"},"member":{"op":"admit","bytes":"<b64url>","sig":"<b64url64>"}}
{"t":"relay.keylog.ack","id":"req-1","ok":false,"error":"SEQ_MISMATCH","head":12}
{"t":"relay.keylog.req","from_seq":1,"limit":32}
{"t":"relay.keylog.res","records":[{"seq":1,"blob":{"v":1,"epoch":4,"n":"<b64url12>","ct":"<b64url>"}}],"has_more":true}
{"t":"relay.keylog.push","records":[{"seq":13,"blob":{"v":1,"epoch":4,"n":"<b64url12>","ct":"<b64url>"}}]}
{"t":"relay.rtc","rtcSession":"sess-1","from":"node","to":"bbbb…bb","enc":{"v":1,"epoch":4,"n":"<b64url12>","ct":"<b64url>"}}
{"t":"relay.enroll.create","id":"enr-1","enroll_pk":"<b64url32>","authorization":"<b64url>","authorization_sig":"<b64url64>","exp":1760000000000}
{"t":"relay.enroll.ack","id":"enr-1","ok":true}
{"t":"enroll.redeemed","certificate":"<b64url>","cert_sig":"<b64url64>","enroll_pk":"<b64url32>","node_id":"bbbb…bb"}
{"t":"relay.quota","maxNodes":8,"maxStreams":32,"bandwidthBytesPerSec":null}
{"t":"relay.kicked","reason":"password_rotated"}
```

relay 流 OPEN 首帧（不是 ctl）：`{"to":"bbbb…bb"}`。

## 四、测试与验证

- `cd packages/shared && bun test`：**632 pass / 0 fail**（基线 534；本任务新增 87，其余为 L1a 并行落地的 ws-borsh 用例）。新增用例分布：codec 14、tenant-cipher 14、join-token 12、blobs 6、enroll-proof 6、auth/relay-records 14、roles 8（改写）。
- `bunx tsc --noEmit -p packages/shared`：0 error。
- `bunx biome check packages/shared/src`：clean（159 文件）。
- `bun scripts/complexity/gate.ts`：本任务文件全部合规。过程中修掉两处新增违规：
  - `key-log.ts:applyKeyLogRecord` 加两个 case 后 CC 18 > 15 → 改写为 `KEY_LOG_APPLIERS` 分派表（`Record<KeyLogType, applier>`），函数本身 CC 降到 4，顺带抽出 `applyRevokeNode`；
  - `relay/codec.ts:parseByType` CC 34 → 改写为 `PARSERS` 分派表。
  当前 gate 仅剩他人在飞的违规（`packages/ws-client/src/client.ts` 835 > 826 与 `state-machine.ts` 的 stale allowlist 条目，属 L1c），与本任务无关。

## 五、需要指挥官处理（本任务范围外的连锁改动）

### 1. `TmexRoles` 加了 `relay` 字段 → 所有对象字面量与 `toEqual` 断言要补 `relay: false`

`bunx tsc --noEmit -p apps/gateway` 因此新增 76 个错误（另 4 个 `tmux-client/metadata/hierarchy-builder.test.ts` 的错误是 L1a/L1b 的，与我无关）。按文件:行：

| 文件 | 行 |
|---|---|
| `apps/gateway/src/auth/user-key-service.ts` | 241（**唯一的生产代码站点**，见下） |
| `apps/gateway/src/config.test.ts` | 204 205 206 207 |
| `apps/gateway/src/db/local-auth-settings.test.ts` | 185 186 187 188 |
| `apps/gateway/src/mesh/auth-routes.test.ts` | 237 790 1127 1186 1292 1339 |
| `apps/gateway/src/mesh/mesh-runtime.test.ts` | 86 117 153 176 217 251 290 328 349 368 412 434 480 544 565 628 740 837 967 1047 1141 1205 1281 1408 1480 1501 1512 1544 1590 1634 1685 |
| `apps/gateway/src/mesh/session-middleware.test.ts` | 18 36 51 70 86 117 200 |
| `apps/gateway/src/mesh/mesh-http.test.ts` | 423 |
| `apps/gateway/src/mesh/mesh-routes.test.ts` | 855 914 |
| `apps/gateway/src/mesh/mesh-runtime-node-presence.test.ts` | 98 |
| `apps/gateway/src/mesh/integration/multi-hub-harness.ts` | 504 667 |
| `apps/gateway/src/mesh/integration/direct-path.integration.test.ts` | 206 502 571 766 866 932 1042 |
| `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts` | 343 444 591 718 |
| `apps/gateway/src/mesh/integration/mesh.integration.test.ts` | 325 514 1298 |
| `apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts` | 138 259 |
| `apps/gateway/src/mesh/integration/hub-contract.integration.test.ts` | 186 |

`packages/app`（tsc 有 1 个既有 `Cannot find type definition file for 'node'` 基线错误，挡住了后续报错，按 grep 统计）另有这些 `{ hub: …, node: … }` 字面量站点：`runtime/assemble.test.ts`(41)、`runtime/local-routes.test.ts`(7)、`runtime/membership-reset.test.ts`(4)、`runtime/setup-service.test.ts`(2)、`runtime/setup-routes.test.ts`(2)、`lib/roles.test.ts`(3)。另有 `apps/gateway/src/mesh/effective-site-url.test.ts`(8)、`mesh/integration/multi-hub.integration.test.ts`(5)、`mesh/integration/large-push-harness.ts`(1)、`mesh/uplink-pool.test.ts`(1) 目前没报错但断言值会在运行时 `toEqual` 失配。

全仓库共 24 个文件 183 处 `{ hub: x, node: y }` 字面量。机械改法：`{ hub: X, node: Y }` → `{ hub: X, node: Y, relay: false }`；建议由 B2（gateway）与 B4（app）各自在自己那一片顺手改掉，不要单开一次全仓 sed（会和其他 agent 冲突）。

### 2. `apps/gateway/src/auth/user-key-service.ts:241`（生产代码）

`currentState()` 手工拼 `UserKeyState` 字面量，缺 `relays / metaKeyEpoch / metaKeyEntries` 三个新字段，tsc 报 TS2739。最小修法是补 `relays: null, metaKeyEpoch: 0, metaKeyEntries: []`；**但正确修法属于 B3**：这三个字段应从密钥日志投影/落库结果读回（节点侧要靠它拿 `mesh_relays` 与 `mesh_secrets`）。请指挥官把这一处派给 B3，不要只打补丁。

### 3. 角色名解析的错误文案要更新（B2 / B4）

- `apps/gateway/src/config.ts:85` — `'TMEX_ROLES must be one of standalone | node | hub,node'`
- `packages/app/src/lib/roles.ts:19` — `'role must be one of standalone | node | hub,node'`

两处都要加 `relay | relay,node`。另外 `validateRoles(roles)` 目前没有任何调用方：**B2 需要在 gateway config 解析后调用它**（`hub && relay` 直接当配置错误退出），B4 在 `init --role` 里同样校验。

### 4. barrel 与快照

- 我在 `packages/shared/src/index.ts` 与 `index.test.ts` 各加了 1 行（`validateRoles`）。若 L1a 同时在改这两个文件，合并时注意保留这两行。
- `packages/shared/src/auth/index.ts` 新增了 relay-records 的导出块（放在文件末尾 `canonicalHubUrl` 之后），不与其它 agent 的区域重叠。
- `TMEX_ROLE_NAMES` 只在 `roles.ts` 导出，没有进主 barrel（进了要同步改 `index.test.ts` 的运行时导出快照）。

### 5. 其它给下游的提示

- 中继无法验 passkey 签名这条边界（plan 1.12）在 codec 层的体现：`relay.auth.member` 与 `relay.keylog.append.member` 只带 `bytes/sig`，**签名者类型要从记录本身（`decodeKeyLogRecord(bytes).signer`）判**，codec 不替中继下判断。
- `relay.keylog.ack.member_ignored` 已在类型里（passkey 签名的 revoke 被忽略时置 true）。
- `RELAY_KEYLOG_SEQ_MISMATCH = 'SEQ_MISMATCH'` 是 ack 的 error 取值，请统一用这个常量。
- 前端只需要 `join-token` 的话，从 `@tmex/shared/relay` 导入会连带引入 codec/tenant-cipher（都是纯 JS + WebCrypto + noble，noble 前端已在用）；如果首屏预算吃紧，可直接 `import ... from '@tmex/shared/relay/join-token'`（该子路径未写进 exports，需要时我可以补一条 package.json 导出）。
