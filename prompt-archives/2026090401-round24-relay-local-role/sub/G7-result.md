# G7 结果 — Hub 口令加入自承认；中继口令加入错误码

无 git 操作。未改 `apps/fe/**`、未改 allowlist。

## Bug 1：口令加入后 uplink 永远 `unknown-cert`

口令 enrollment 的 `entry_node_id = null`，Hub 不向任何人推证书；`node_certs` 只由 `admit-node` 投影写入。token 流由签发 token 的浏览器签 admit；口令流加入方持有根钥，必须自承认。

**不能等 uplink 第一次 sync 再推。** Hub 认证读 `node_certs`，先于 key-log catch-up，本地先有记录也过不了 cert 检查。因此在本机 `performHubJoin` / `commitVerifiedJoin` 之后、进程重启之前，用根钥登录 Hub，在 **Hub 链头** 上签 `admit-node`，`POST /api/auth/keylog`（Hub 的 mesh auth，不加 `?hub=sync`）。

冲突码 `KEY_LOG_FORK` / `seq_gap` / `prev_hash_mismatch` / `epoch_mismatch` / `fork`：重读 head 重签，最多 `HUB_JOIN_ADMIT_ATTEMPTS = 4`。Hub 接受后再尝试本机 `apply`；本机 `seq_gap` / `prev_hash_mismatch` / `fork` 可忽略（Hub 已有行即可连上）。

未整段复用 `joinSelfAdmitAndPersist`（它绑中继 HTTP keylog + `meta-key`）。抽出 `buildSelfAdmitRecord`，Hub 口令加入只发 `admit-node`。

`requestEnrollmentByPassword` 现在返回可选 `rootKey`（仍清零 `enrollSk`，**不再立刻清零种子**）。调用方 `finally wipeRootKey`。`resolveHubJoinToken` 仍清零（只取 token）。测试替身不返回 `rootKey` 则跳过自承认。

TOTP / passkey 二因子时 `publishHubJoinSelfAdmit` 直接 `join_failed`（口令加入 API 没有 TOTP code）。

接线：

- CLI `runHubJoin` 密码分支：enroll（留根钥）→ `performHubJoin` → `publishHubJoinSelfAdmit` → `wipeRootKey`
- Setup `joinHub` `method==='password'`：同上

Hub 侧 `POST /api/auth/keylog` 已能投影 `admit-node`，未改 `hub-password-enroll.ts` / `hub-runtime.ts`。

## Bug 2：中继口令加入错误变成 HTTP 500

`handleRelayJoinRequest` 未把 `RelayPasswordJoinError` 转成 `SetupError`，`mapError` 一律 500。增加 `asSetupRelayJoinError`。

**不可**用 `isNetworkFetchError` 当 catch-all（它对几乎所有 `Error` 都为 true，会把 `injected after unpack` 误判成 `relay_unreachable`）。不可达只认 `RelayTimeoutError`、`RelayCaError.transport`、`TypeError`、以及 econnrefused / enotfound / etimedout / fetch failed / unable to connect。

`head_hash_mismatch` 在 wrap 与 routes 两层都映射成 `relay_pack_invalid`。`pinHead` 直接抛 `relay_pack_invalid`；`relaysForPersist` 抛 `relay_not_authorized`。

### 稳定错误码（前端 `error-messages.ts` 已有同名 key）

| code | HTTP | 触发 |
|---|---|---|
| `relay_password_invalid` | 401 | 错口令 / `RELAY_BAD_PROOF` / HTTP 401 |
| `relay_tenant_unknown` | 404 | `RELAY_TENANT_NOT_FOUND` / HTTP 404 |
| `relay_pack_invalid` | 409 | 开包失败 / AAD / head 不匹配 / `RELAY_PACK_*` / `head_hash_mismatch` |
| `relay_unreachable` | 502 | 超时、传输层 CA、连接失败 |
| `local_user_exists` | 409 | 本机已有 mesh 用户 |
| `relay_not_authorized` | 403 | 该中继不在根签名的中继列表里 |
| `join_failed` | 400 | 其余（保留内层 message） |

## 改动文件

### 新增

- `packages/app/src/lib/hub-password-self-admit.ts` + `.test.ts` — `publishHubJoinSelfAdmit`
- `packages/app/src/lib/relay-password-join.test.ts` — `wrapRelayPasswordJoinError` 各码
- `apps/gateway/src/hub/hub-password-join.integration.test.ts` — 口令加入 → Hub `node_certs` 有行 → joiner uplink `online`

### 修改（app）

- `packages/app/src/lib/hub-password-join.ts` — 返回 `rootKey?`；`wipeRootKey`
- `packages/app/src/commands/hub.ts` — 密码分支自承认
- `packages/app/src/runtime/setup-service.ts` — `joinHub` 密码分支自承认
- `packages/app/src/lib/relay-password-join.ts` — `wrapRelayPasswordJoinError`
- `packages/app/src/lib/relay-password-join-flow.ts` — `pinHead` / `relaysForPersist` 错误码
- `packages/app/src/runtime/relay-join-routes.ts` — `asSetupRelayJoinError` + `RELAY_JOIN_ERROR_STATUS`
- 测试：`relay-join-routes.test.ts`、`relay-password-join-flow.test.ts`

### 修改（gateway）

- `apps/gateway/src/auth/user-key-self-admit.ts` — 抽出 `buildSelfAdmitRecord`；`buildSelfAdmitAndMetaKey` 复用
- `apps/gateway/src/auth/user-key-self-admit.test.ts` — `buildSelfAdmitRecord` 只签 admit-node
- `apps/gateway/src/relay/integration/relay-password-join.integration.test.ts` — truncated log 期望改为 `relay_pack_invalid`（见下）

## 测试与验证

- `bunx biome check`（本任务文件）：通过
- `bun scripts/complexity/gate.ts`：通过，未改 allowlist。曾把 `publishHubJoinSelfAdmit` 从 CC 18 拆到阈值内
- `bunx tsc --noEmit -p packages/app`：0
- `bunx tsc --noEmit -p apps/gateway`：1 条预存 `packages/app/src/lib/native-datachannel.ts(135,35) TS5097`（`.ts` 扩展名），非本任务文件
- `packages/app` `bun test`：**877 pass / 1 skip / 0 fail**（任务基线 850）
- `apps/gateway` `bun test`：**4213 pass / 0 fail / 2 errors**（任务基线 4211 pass / 2 errors；errors 仍是 `relay-hardening.test.ts` harness 关流 `relay-rst`，与 G5/G6 相同）
- 集成测试：joiner uplink 在 8s 内 `online`；Hub `node_certs` 有该节点且未吊销
- CLI：`runHubJoin --password` 会 `POST /api/auth/keylog` 一条 `admit-node`

## 需要指挥官处理

1. **`packages/app/src/commands/hub.ts` 已 1287 行**（allowlist 已有 fileLines）。本任务只加了密码分支接线，未拆文件。后续拆文件时注意与其它 agent 的 `hub.ts` 改动交错。
2. **`setup-service.ts` 589/600**，接近门禁。
3. **略超 scope**：`apps/gateway/src/relay/integration/relay-password-join.integration.test.ts` 把 truncated log 的期望码从旧值改为 `relay_pack_invalid`，否则 `pinHead` 改码后该集成测试红。
4. **TOTP / passkey 二因子账号无法走口令加入自承认**（无 TOTP code 通道）。会 `join_failed` 并回滚 staged env。若产品要支持，需要给 by-password enroll 或 self-admit 增加二因子。
5. **gateway tsc `native-datachannel.ts` TS5097**：不在本任务范围；G6 时 gateway tsc 为 0，属并行改动。
6. 前端错误码映射由另一 agent 负责；仓库里 `error-messages.ts` / `validation.ts` 已含上表各码，本任务未改 FE。
