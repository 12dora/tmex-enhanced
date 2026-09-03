# R2 结果：中继 CLI 评审十条的核实与修复

worktree `/Users/konata/code/tmex-r23`，分支 `feat/round23-relay-legacy-removal`。全部十条findings均已核实；结论与改动如下。

---

## 一、逐条结论

### 1. BLOCKER — r3 加入无法回放含 passkey 签名的密钥日志 — 属实，已修

**核实**：`verifyKeyLogChain()` 在 `commitRelayJoin` 里没有传 `verifyPasskeyAssertion`；
`LocalAuthContext.userKeys`（`packages/app/src/lib/local-auth.ts` 的 `createAuthContextFromDb`）建
`UserKeyService` 时也没传。`packages/shared/src/auth/key-log.ts:340` 处 `!ctx.verifyPasskeyAssertion`
→ `unknown_signer`，而此时 redeem 已经把一次性 enrollment 消耗掉了。

**额外发现**：hub 加入路径（`hub.ts` 的 `commitVerifiedJoin` → `verifyKeyLogChain(records, rootPk)`
+ 同一个无验签器的 `ctx.userKeys.commitJoin`）**有完全相同的缺陷**，并不像 findings 描述的那样
「已经做对了」。也就是说仓库里没有现成的「回放期 passkey 验签器」可抄。原因是
`makeVerifyPasskeyAssertion(userStore)` 查的是**本机 UserStore**，而加入方此刻一条凭据都没有，
天然不可用。

**修法**：新增 `packages/app/src/lib/keylog-passkey-replay.ts`。

- `makeReplayPasskeyVerifier(records)`：预扫链上所有 `add-passkey` 记录，拿到 `origin` / `rp_id` /
  `counter` / `transports`（公钥由 `verifyKeyLogChain` 从投影状态里取好后作为参数传入），再调用
  gateway 的 `verifyAssertion`（`@simplewebauthn/server`）。同一 `credential_id` 被重新登记过时按
  公钥挑对应那条。验签成功后按 `newCounter` 单调推进内部计数器（等价 `updateKeyCounter`），
  重放同一条断言会被拒。
- `joinUserKeyService(ctx, records)`：`commitJoin` 内部会再回放一遍同一条链（`replayStep` 用的是
  实例上的 `this.verifyPasskeyAssertion`），所以为这次提交单独建一个带验签器的 `UserKeyService`
  （复用 ctx 的 db/stores，不改 gateway 代码）。

`relay-join.ts` 的预检与 `commitJoin` 都换成上面两者。

**hub 路径未改**：按任务边界（`hub.ts` 只在需要抽公共验签器时才动）我只加了一个可选字段，
没有改 hub 的加入逻辑。**这是留给指挥官的一条待办**：`packages/app/src/commands/hub.ts`
的 `commitVerifiedJoin` 应当同样换成 `makeReplayPasskeyVerifier(records)` + `joinUserKeyService`，
否则「hub 模式下带 passkey 签名记录的租户」加新节点同样会 `unknown_signer`。改动是两处调用点，
新 lib 已经就绪。

**测试**：`relay-join.test.ts` 的
「a chain carrying a passkey-signed record replays instead of unknown_signer」——用
`apps/gateway/src/auth/passkey-test-fixtures.ts` 的真 ES256 认证器造真断言：
root 签 `add-passkey` → 这把 passkey 签一条 `meta-key` → r3 加入成功且落库记录数一致。

### 2. r3 的 CA 指纹被解出来就丢掉 — 属实，已修

**核实**：`decodeRelayJoinToken` 解出 `caFingerprint`，`runRelayJoin` 从不读它；所有 lookup/redeem
都走系统 CA，pin 也从不落库，后续 uplink 只能靠运气。

**修法**：新增 `packages/app/src/lib/relay-ca.ts`（与 hub 的 `fetchPinnedHubCa` 同一套流程）：

- `fetchPinnedRelayCa()`：`GET <relay>/api/tls/ca.crt`，`tls: { rejectUnauthorized: false }` +
  `redirect: 'error'` + 超时 + `readBoundedResponseText`（64 KiB），`parseAndValidateCaPem` 校验是
  CA 且能签证书，SPKI 指纹必须与 join 串一致，否则 `RelayCaError('ca_fingerprint_mismatch')`。
- `pinRelayCa(fetcher, pem)`：之后所有请求带 `tls: { ca: [pem] }`。
- `storeRelayCaPin(db, …)`：写 `hub_trust`（`HubTrustStore`）。`UplinkPool.spawn()` 就是按候选
  `publicUrl` 在这张表里取 pin 的，所以 relay uplink 会自动复用同一张 CA。

顺序上，**CA 在任何带令牌的请求之前**取回并钉住；pin 只在 redeem 成功后落库（避免为一台连不上
的中继留下 pin）。指纹不符归类为**非**传输错误（不 failover，直接中止）——这是安全信号，
静默换下一台会掩盖问题。

**测试**：`describe('r3 join with a pinned CA')` 两例：自签 CA 指纹匹配 → 加入成功、第一条请求
是 `/api/tls/ca.crt`（`rejectUnauthorized:false`、不带令牌）、其余请求都带 `tls.ca`、`hub_trust`
里能查到 pin；指纹不符 → 只发生了一次 CA 请求就报错，`hub_trust` 为空、uplink 未切换。

### 3. 把 join 串里的 head 当链尾用 — 属实，已修

**核实**：`verifyKeyLogChain(records, rootPk, decoded.keyLogHeadHash)` 要求回放到头之后的 head
恰好等于建码时刻的 hash；建码之后租户任何一条合法追加（admit、meta-key、set-relays…）都会让
它 `head_hash_mismatch`——而 enrollment 已经被消耗。

**修法**：预检去掉 `expectedHeadHash`（传 `undefined`），锚点语义交给 `commitJoin(anchorHash)`
（锚必须在链里、锚之后不得换根），它本来就实现对了。

**测试**：「records appended after the join code was created are accepted」——先生成 join 串，
再追加两条根签名 `meta-key`，加入仍成功且记录数一致。原「不匹配 head hash 就拒」那条改名为
「a key log missing the anchor record is rejected」（截断链 → 锚点不在链里 → 仍然拒绝）。

### 4. 一个 tenantId/token 走遍所有中继 — 属实，已按裁决改格式

**核实**：`RelayJoinToken` 只有一份 `tenantId`/`token`，而 `set-relays` 记录本来就是每条
`{url, tenant_id, token, priority}`；每台中继各自签发租户凭据，跨中继复用必然被拒 → 有序
failover 在 r3 阶段根本不可能工作。`commitRelayJoin` 还把这份唯一凭据写给了所有中继行。

**新 r3 字节布局**（`packages/shared/src/relay/join-token.ts`）：

```
"r3." + base64url(
    enroll_sk   32
  ‖ root_pk     32
  ‖ head_hash   32
  ‖ K_log       32
  ‖ n           u8            (1..16，n=0 拒绝)
  ‖ [ len       u16 LE        (1..512)
      ‖ url     utf8[len]     (https；仅回环允许 http)
      ‖ tenant_id 16
      ‖ token     32 ] × n
) [ "." <64 hex CA 指纹> ]          // 可选后缀，语义不变
```

- 定长头 `RELAY_JOIN_TOKEN_FIXED_BYTES` 由 176 变为 **128**；新增
  `RELAY_JOIN_TOKEN_ENTRY_CRED_BYTES = 48`。
- 类型：`RelayJoinToken.relays: RelayJoinTokenEntry[]`（`{url, tenantId, token}`），
  原 `tenantId` / `token` / `relayUrls` 三个顶层字段删除；新增导出
  `RelayJoinTokenEntry`（barrel 同步）。
- 解码侧校验：n=0 拒、n>16 拒、url 长度越界拒、非 https（非回环）拒、截断拒、尾部多余字节拒；
  编码缓冲（含 enroll_sk / K_log / token）返回前 `fill(0)`。
- CLI：`orderRelayUrls` → `orderRelayEntries`，failover 每一跳用**该条自己的** tenantId/token
  拼路径与 `x-tmex-relay-token`；落库 `mesh_relays` 也按条写。

**join-material 的响应形状**（按指挥官裁决改）：`relay.enroll.create` 只落在当前 attach 的那台
中继上，别处 redeem 只会 404，所以 join 串只能带这一台。

```jsonc
GET /api/mesh/relay/join-material  →  200
{
  "logKey": "<b64url 32B>",
  "relays": [                       // 只含当前 attach 的那台（没 attach 时回落到 priority 最高的一台）
    { "url": "https://relay.example", "tenantId": "<32 hex>", "token": "<b64url 32B>" }
  ],
  "tenantId": "<32 hex>",           // 兼容字段 = relays[0].tenantId
  "token": "<b64url 32B>"           // 兼容字段 = relays[0].token
}
```

保留两个顶层兼容字段是为了不打断 `apps/gateway/src/relay/integration/relay-mesh-harness.ts`
（另一个 agent 的在制文件，只读 `tenantId`/`token`/`logKey`）。api-client 的
`RelayJoinMaterial` 类型只暴露 `{logKey, relays}`，`normalizeJoinMaterial` 校验 logKey 存在、
relays 非空、每条 url/token 非空且 tenantId 是 32 位 hex。

完整的有序中继表由加入后下载到的 `set-relays` 记录送达，failover 从那时起生效。新布局保留
每条自带凭据，将来若把 enrollment 扇出到所有中继，不必再换一次格式。

改到的文件：`packages/shared/src/relay/join-token.ts`(+test)、`index.ts` barrel、
`packages/app/src/commands/relay-join.ts`(+test)、`apps/fe/src/node/relay-join.ts`(+test)、
`apps/gateway/src/mesh/relay-routes.ts`（**只改 joinMaterial 处理器**）+ 其 test、
`packages/api-client/src/relay/tenant-api.ts`（**只改 join-material 类型与 normalize**）+ 其 test。

**测试**：shared 侧 round-trip / 每条独立凭据 / 畸形输入；CLI 侧
「falls over to the next relay with that relay own credentials」——假中继按 origin 校验令牌与
路径里的 tenantId，A 不可达时 B 上的两次请求都必须带 B 的令牌与 B 的 tenantId，且
`mesh_relays` 两条各自存对了 token。

### 5. `relay,node` 主机被写成 `TMEX_ROLES=node` — 属实，已修

新增导出 `relayJoinRoleName(current)`：读现有 roles，`node=true`、`hub=false`、`relay` 原样保留，
再经 `roleNameFromFlags` 还原成名字。env 文件分支与内存 `process.env` 分支都用它。

**测试**：`relayJoinRoleName` 单测（`relay,node`→`relay,node`，`relay`→`relay,node`，
`hub,node`→`node`，非法值→`node`）+ 一条端到端：`TMEX_ROLES=relay,node` 的主机加入后
`process.env.TMEX_ROLES` 仍是 `relay,node`。

### 6. `init --role relay` 接受空/非 https 公开地址 — 属实，已修

`packages/app/src/commands/init.ts` 新增导出 `normalizeRelayPublicUrl()`（trim → 非空 →
`normalizeRelayUrl`，与 join 串/`set-relays` 同一套规则，回环仍允许 http）。非交互路径在返回前
校验并归一化；交互路径最多重问 3 次，仍不合法则报错退出——**都在落任何配置/副作用之前**。

**测试**：`init.test.ts` 新增 `normalizeRelayPublicUrl` 两例（归一化；空值/非 https/畸形拒绝）。

### 7. head → 签 → append 没有并发处理 — 属实，已修（有一处刻意的偏离）

`packages/app/src/lib/relay-session.ts` 的 `signAndSubmitRelayRecord` 改为有界乐观重试
（`RELAY_RECORD_MAX_ATTEMPTS = 4`）：冲突码
（`seq_gap` / `prev_hash_mismatch` / `epoch_mismatch` / `fork` / `KEY_LOG_FORK` / `SEQ_MISMATCH`）
→ 重读 head、**重新向本机 gateway 取一份 payload**（新增可选 `rebuild()` 回调）、重签重发。
`relay.ts` 的 enroll 路径把 `rebuild` 接到 `exchangeRelayEnroll`（重新签 proof + 重新拿
`set-relays`），leave 路径接到 `leave/prepare`——并发那条记录可能已经改了中继表或节点集合，
拿旧 payload 重签会覆盖别人的改动。

**刻意偏离**：findings 写「根 epoch 变了就重做 proof/enroll 流程」。实际做不到：根 epoch 只会因
`reset-root`/`rotate-root`/`rotate-root-keep` 变化，这三者都换了根公钥，而 CLI 手里这把根钥是
命令开头由用户输入的密码派生的——换过之后它签什么都无效，重做 enroll 只会以更难懂的错误失败
（中继侧记的还是旧根公钥）。所以改成检测到 epoch 变化立即中止，抛
`RELAY_ROOT_ROTATED`（"the root key was rotated while this command was running; run the command
again with the new password"）。

**测试**（`relay.test.ts`，假网关新增 `appends` / `headEpochs` 两个注入点）：
浏览器抢先追加 → 重读 head 一次、重取 payload 一次、第二次 append 成功；重试用尽 → 原样抛
`seq_gap` 且恰好尝试 `RELAY_RECORD_MAX_ATTEMPTS` 次；根 epoch 中途变化 → 只 append 了一次就报
`RELAY_ROOT_ROTATED`。

### 8. 中继 CLI 没有 HTTP 超时 — 属实，已修

`requestRelayJson` 新增 `timeoutMs`（默认 `RELAY_REQUEST_TIMEOUT_MS = 15_000`）：每次尝试一个
`AbortController`，`signal` 传给 fetcher，`finally` 里 `clearTimeout`；超时抛
`RelayTimeoutError`（不是 `RelayApiError`，所以 `isRelayTransportError` 认它 → r3 会 failover、
`relay enroll` 的 health 探测不会挂死）。CA 下载（`fetchPinnedRelayCa`）同样有超时。
`HubIo` 新增可选 `relayTimeoutMs`（**这是我对 `hub.ts` 唯一的改动，纯类型字段**），r3 的
lookup / redeem / CA 三处都透传，只在测试里下调。

**测试**：`relay-shared.test.ts`「aborts a relay that accepts but never answers」（断言 signal
真的被 abort、抛 `RelayTimeoutError`、不是 `RelayApiError`）、「clears the timer on a normal
response」；`relay-join.test.ts`「a request that never answers times out and fails over」
（A 永不返回 → 25ms 超时 → 落到 B）。

### 9. 响应体没有上限 — 属实，已修

`readRelayBody` 改用 `readBoundedResponseText`（`lib/pem.ts`，流式读、超限即 `cancel()`）。
默认 `RELAY_RESPONSE_MAX_BYTES = 1 MiB`（health / lookup / 错误体都走它，**包括非 2xx 的错误体**）；
redeem 单独用 `RELAY_REDEEM_RESPONSE_MAX_BYTES = 16 MiB`（要带回整条密钥日志）。超限抛
`"<label> response exceeds <n> bytes"`。

**测试**：`relay-shared.test.ts` 正常体/错误体各一例超限；`relay-join.test.ts`
「an oversized redeem body is refused」（20 MiB → 拒绝，uplink 不切换）。

### 10. 两处 minor — 均属实，已修

- **quota 校验对齐服务端**：`parseCountFlag` 现在按 flag 取上限
  （`max-nodes` ≤ `RELAY_QUOTA_MAX_NODES_LIMIT`=4096，`max-streams` ≤
  `RELAY_QUOTA_MAX_STREAMS_LIMIT`=65536），下限 1（原来 `0` 能过，服务端 `positiveInt` 一律 400）；
  `parseBandwidthFlag` 上限 `RELAY_QUOTA_MAX_BANDWIDTH`（10 GiB/s），并拒绝非有限值——原来
  `--bandwidth 1e30` 会算出 `Infinity`，`JSON.stringify` 变成 `null`，被服务端当作**不限速**
  静默通过。
- **本机 gateway 回环地址**：新增 `loopbackHost(env)`，`TMEX_BIND_HOST` 是 IPv6 字面量
  （`::`、`[::]`、`::1`、任何含 `:` 的地址）时用 `[::1]`，否则 `127.0.0.1`；`gatewayBaseUrl` 用它。

**测试**：`relay-shared.test.ts` 两个 describe 覆盖上述全部分支。

---

## 二、改动文件清单

新增：
- `packages/app/src/lib/keylog-passkey-replay.ts`
- `packages/app/src/lib/relay-ca.ts`
- `packages/app/src/commands/relay-shared.test.ts`

修改：
- `packages/shared/src/relay/join-token.ts`、`join-token.test.ts`、`index.ts`(barrel)
- `packages/app/src/commands/relay-join.ts`、`relay-join.test.ts`
- `packages/app/src/commands/relay-shared.ts`
- `packages/app/src/commands/relay.ts`、`relay.test.ts`
- `packages/app/src/commands/init.ts`、`init.test.ts`
- `packages/app/src/commands/hub.ts`（仅 `HubIo` 加 `relayTimeoutMs?: number`）
- `packages/app/src/lib/relay-session.ts`
- `apps/fe/src/node/relay-join.ts`、`relay-join.test.ts`
- `apps/gateway/src/mesh/relay-routes.ts`（仅 joinMaterial 处理器）、`relay-routes.test.ts`
- `packages/api-client/src/relay/tenant-api.ts`（仅 join-material 类型 + normalize）、`tenant-api.test.ts`

未新增复杂度 allowlist 条目；最大文件 `relay-join.ts` 420 行。

---

## 三、验证结果

| 命令 | 结果 |
|---|---|
| `packages/app: bun test` | **796 pass / 1 fail**（797 across 72 files） |
| `packages/shared: bun test` | 616 pass / 0 fail |
| `apps/fe: bun test src/node` | 291 pass / 0 fail |
| `packages/api-client: bun test` | 199 pass / 0 fail |
| `apps/gateway: bun test src/mesh/relay-routes.test.ts src/mesh/relay-key-log-sync.test.ts` | 16 pass / 0 fail |
| `tsc --noEmit` packages/app、packages/shared、apps/fe、apps/gateway | 全部 0 error |
| `bunx biome check`（本任务改动的 21 个文件） | 干净 |
| `packages/app: bun run build:cli` | 通过（96 modules，255.44 KB） |

唯一失败：`packages/app/scripts/build-runtime.test.ts`「packaged dist/runtime/server.js does not
leave cpu-features as an external require」——它断言 `dist/runtime/server.js` 存在，而该产物只有
`bun run build:runtime`（完整 `bun run build`）才会生成，本 worktree 里从未构建过。与本次改动无关。

基线 766 → 797：新增 31 条测试（含把原 relay-join 的用例重构后仍保留的部分）。

**不是我造成、但门禁现在是红的（留给指挥官/对应 agent）**：

- `bun run lint`（仓库全量 biome）9 个错误，全部在别的 agent 的在制文件：
  `apps/fe/src/main.tsx`、`apps/gateway/src/auth/mesh-membership-store.test.ts`、
  `apps/gateway/src/mesh/auth-key-log-relay.test.ts`、
  `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`、
  `apps/gateway/src/relay/integration/relay-mesh-harness.ts`、
  `apps/gateway/src/relay/integration/relay.integration.test.ts`、
  `packages/app/src/runtime/membership-reset.test.ts`（organizeImports / format）。
- `bun scripts/complexity/gate.ts` 7 条超限，同样全在别人的文件：
  `apps/gateway/src/mesh/relay-uplink-client.ts` 608、
  `apps/gateway/src/relay/integration/relay-mesh-harness.ts` 677、
  `packages/app/src/runtime/setup-service.ts` 748>747、
  `packages/app/src/runtime/assemble-routes.ts` 604、
  `packages/app/src/tls/tls-service.ts` 746>743、
  `packages/ws-client/src/canonical-state-client.ts` 742>741、`client.ts` 862>826。
- `packages/api-client` 的 `tsc` 在 `src/client.test.ts` / `src/files-download.test.ts` 有既有报错
  （与 relay 无关，本次未碰）。

---

## 四、给指挥官的事项

1. **hub 加入路径同样缺回放期 passkey 验签器**（见第 1 条）。`packages/app/src/commands/hub.ts`
   的 `commitVerifiedJoin` 两处（`verifyKeyLogChain` 预检 + `ctx.userKeys.commitJoin`）应换成
   `makeReplayPasskeyVerifier(records)` / `joinUserKeyService(ctx, records)`。新 lib 已就位，
   我按任务边界没有动 hub 的加入逻辑。
2. **F3 worktree 必须同步的改动**：`apps/fe` 里凡是消费 `RelayTenantApi.joinMaterial()` 的地方，
   返回值已从 `{tenantId, token, logKey, relays: string[]}` 变为
   `{logKey, relays: Array<{url, tenantId, token}>}`。本仓内唯一消费者
   `apps/fe/src/node/relay-join.ts` 已改（`createEnrollmentOnRelay` 的入参与返回值签名不变，
   `hubPublicUrl` 仍是第一条地址）。若 F3 在 `apps/fe/src/pages/**` 或
   `apps/fe/src/node/relay-enroll.ts` 里另有直读 `material.tenantId`/`material.relays[0]` 字符串
   的代码，需要一并改。
3. **`docs/relay/` 目录目前不存在**，plan-00.md §1.5 里的 r3 布局已过时（少了每条的
   `tenant_id ‖ token`、`tenant_id/token` 不再在定长头里）。本文件第 4 条给出的字节图是当前
   实现的权威描述；是否回写 plan/新建 `docs/relay/` 由指挥官决定。
4. **`join-material` 的兼容字段**：顶层 `tenantId`/`token` 只为
   `apps/gateway/src/relay/integration/relay-mesh-harness.ts` 保留。等该 harness 改用
   `relays[0]` 后可以删掉。
5. **CA 指纹与多中继**：r3 仍然只有一个 CA 指纹后缀，语义是「表里每一台都必须出示指纹相符的
   CA」。当前 join-material 只发一台，问题不显；将来真要扇出到多台自签中继，需要把指纹也做成
   每条一个（届时要再改一次格式）。

---

## 六、hub join 接线（f10eef2f 之后的追加改动）

第一条 findings 里发现的「hub 加入路径同样缺回放期 passkey 验签器」已按指挥官要求补上。

### 改了什么

`packages/app/src/commands/hub.ts` 的 `commitVerifiedJoin`，两处调用点（其余一律未动）：

```ts
// 预检：原来完全不传验签器
const verifyPasskeyAssertion = makeReplayPasskeyVerifier(records);
const preview = await verifyKeyLogChain(records, input.expectedRootPublicKey, undefined, {
  verifyPasskeyAssertion,
});
...
// 提交：原来用 ctx.userKeys（LocalAuthContext 建的那个，没有验签器）
const committed = await joinUserKeyService(ctx, records).commitJoin({ ... });
```

加一行 import（`../lib/keylog-passkey-replay`）。`keylog-passkey-replay.ts` **一字未改**——
r2 那版写的时候就是按「加入路径通用」设计的（只依赖 records 与 `LocalAuthContext`，不含任何
relay 概念），hub 直接复用即可，不需要再抽公共 helper。

`hub-join-verify.ts` 也没动：改动只有 6 行，`hub.ts` 从 1242 → **1248 行**，仍在 allowlist 的
`fileLines: 1298` 之内（余量 50 行），不需要搬代码。

注意 hub 的预检**没有**像 r3 那样去掉 `expectedHeadHash`——hub 路径本来就只传两个参数
（`verifyKeyLogChain(records, expectedRootPublicKey)`），锚点校验一直是靠
`commitJoin(anchorHash)`，没有第 3 条那个缺陷。

### 测试（`packages/app/src/commands/join.test.ts` 新增 describe「hub join with passkey-signed records」）

1. **replays a chain whose revoke-node is signed by a passkey**：hub 上先 root 签一条
   `add-passkey`（真 ES256 认证器 + `verifyRegistration` 造 payload），再用**这把 passkey**
   签一条 `revoke-node`（吊销 hub 自己那个自承认节点，签名用 `authenticator.assert` +
   `encodePasskeyAssertionSig`，经带 `makeVerifyPasskeyAssertion` 的 `UserKeyService.apply`
   落到 hub 库里，确保是条真记录）。之后才生成 join 串（用最终 head 当锚），假 hub 把整条链与
   `node_certs`（含 `revoked_log_seq`）回给 `performHubJoin`。断言：加入成功、记录数一致、
   **吊销真的被回放进来了**（加入方的 `node_certs` 里有 `revokedLogSeq != null`，而不是靠跳过
   passkey 记录蒙混）。
2. **an unverifiable passkey signature still rejects the chain**：同样的链，但断言签的是另一条
   挑战 → `key log rejected`。证明新验签器不是「一律放行」。

**反向验证**（临时改回后跑，确认测试真的能抓住这个 bug）：

- 两处都改回原样 → `JoinError: key log rejected: unknown_signer`，用例 fail。
- 只把 `commitJoin` 改回 `ctx.userKeys` → 同样 `unknown_signer`，用例 fail。

即两个调用点缺一不可，随后已完整还原（`git diff` 只剩上述 6 行 + 1 行 import）。

### 验证

| 命令 | 结果 |
|---|---|
| `packages/app: bun test src/commands` | **211 pass / 0 fail**（14 files） |
| `packages/app: bun test`（全量） | 798 pass / 1 fail（仍是 `build-runtime.test.ts` 那条环境性失败，见第三节） |
| `packages/app: bunx tsc --noEmit` | 0 error |
| `bunx biome check`（hub.ts / hub-join-verify.ts / join.test.ts / keylog-passkey-replay.ts） | 干净 |
| `bun run lint`（仓库全量） | 只剩 1 个错误，在别的 agent 的在制文件 `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`（format），非本次改动 |
| `bun scripts/complexity/gate.ts` | `hub.ts` / `hub-join-verify.ts` / `keylog-passkey-replay.ts` 均无告警（其余超限项仍是别人的文件） |

第一节末尾「留给指挥官」的那条 hub 待办到此关闭。
