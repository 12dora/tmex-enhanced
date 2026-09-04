# G6 结果 — 后端安全审查（R1）确认项修复

按指挥官 triage 修完 R1-#1/#2/#3/#5/#6/#8/#9/#7（限流，不含 proxy CIDR）/#10/#11。未动 R1-#4、R1-#7 proxy CIDR。无 git 操作。

## 行为摘要

| 编号 | 处理 |
|---|---|
| **#1** | `finishAuth` 注册 live 前重读租户（kicked / token hash / `tokenEpoch < minTokenEpoch`）。`dispatchAuthenticated` 每条消息比连接 epoch 与全局 `min_token_epoch`、租户 `token_epoch`。HTTP `/pack`、`/keylog` POST 先读 body，再在写事务内重鉴权。`authBarrier` 竞态：precondition 与注册之间 kick / `passwd --kick`。 |
| **#2** | 先向中继 append admit-node（admit sidecar）再 meta-key；`SEQ_MISMATCH` 重下日志重建，最多 4 次；`member_ignored` 硬失败。两条都成功后才本机 `commitJoin` / 证书 / relays / secrets。第二条失败报 orphan `node_id`，不写本机。 |
| **#3** | `relaysForPersist`：键入的规范化 `(url, tenantId)` 必须在根签 `set-relays` 投影里，否则 `join_failed`「该中继不在根签名的中继列表里」；只替换命中行 token，不再 `unshift`。 |
| **#5** | 每台中继各自密封（KEK info=该 tenant id，明文 token=该 token）。节点 `POST /api/mesh/relay/pack` 体为 `{ kdf_params, root_epoch, head_seq, packs: [{ url, sealed_pack }] }`，按 url 对照 `mesh_relays` 转发。旧单包体保留一轮（同一包转发给 `urls` 或全部已配置中继）。 |
| **#6** | standby 先验自己 host 的 proof + 限流，再经已授权 hub→hub 写通道转发，body 带 `proof_verified_by` / `client_ip`。写者 `dispatchForwardedWrite` 收该路由，跳过 host-bound proof，仍验 enrollment authorization；转发 IP 不参与限流。无 writer 仍 409 `HUB_NOT_WRITER`。 |
| **#8** | `commitRelayPasswordJoinEnv` / `applyRelayPasswordJoinEnv`（setup-shared）：`TMEX_ROLES=node` 或已有 relay 则为 `relay,node`，清空两个 Hub URL；网页 staged-env/promote，CLI 共用。 |
| **#9** | `assertKdfParamsWithinBudget`（`root-key.ts`）：`memory_kib ≤ 262144`、`iterations ≤ 10`、`parallelism ≤ 4`、salt 16B。`kdfParamsFromWire`、中继 join、hub password join、`deriveSeed` 均在 Argon2 前校验。 |
| **#7** | Hub：IP 桶与 UID 桶分离，请求须过两桶；`tryReserveSuccess` / `releaseSuccess` 在 persist 前占位。驱逐只清过期桶。Relay enroll 驱逐同样不删窗口内桶。未改 proxy CIDR。 |
| **#10** | `performRelayPasswordJoin` 将 `log_key` / `token` / seed / `K_meta` 提到同一 `finally` 清零；`afterUnpack` 注入失败可测。 |
| **#11** | 非空中继口令最短 8（空=无密码仍允许）：`RELAY_PASSWORD_MIN_LENGTH` + `relayPasswordTooShort`，admin 路由与 `becomeRelay` 共用。 |

文档 `docs/relay/2026090304-relay-role.md` §5b：按中继密封、远程先于本地、orphan pending node id、KDF 预算、未授权 URL。

## 改动文件

### 新增
- `apps/gateway/src/relay/relay-uplink-auth.ts`
- `apps/gateway/src/relay/relay-enroll-limiter.test.ts`
- `packages/app/src/lib/relay-password-join-append.ts` + `.test.ts`

### 修改（gateway）
- `relay-uplink-server.ts`、`relay-runtime.ts`、`relay-test-harness.ts`、`relay-pack-http.ts`、`relay-public-routes.ts`、`relay-enroll-limiter.ts`、`relay-password.ts`、`relay-admin-routes.ts`
- `mesh/relay-pack-routes.ts`
- `hub/hub-password-enroll.ts`、`hub-enroll-limiter.ts`、`hub-runtime.ts`（dispatch 内联 by-password；未加 allowlist）
- 测试：`relay-uplink.test.ts`、`relay-admin.test.ts`、`relay-pack-routes.test.ts`、`hub-password-enroll.test.ts`、`hub-enroll-limiter.test.ts`、`integration/relay-password-join.integration.test.ts`

### 修改（app / shared / docs）
- `relay-password-join.ts`、`relay-password-join-flow.ts`、`relay-pack-upload.ts`、`hub-password-join.ts`
- `commands/relay-password-join.ts`、`runtime/relay-join-routes.ts`、`relay-setup-service.ts`、`setup-shared.ts`
- `packages/shared/src/auth/root-key.ts`、`packages/shared/src/relay/relay-pack.ts`
- `docs/relay/2026090304-relay-role.md`

## 测试（相对任务基线）

- shared `bun test`：**649 pass**（基线 646）
- app `bun test`：**850 pass / 1 skip / 0 fail**（基线 841；另有一次全量跑遇到 `tmux.test.ts` 5s 超时，单跑通过）
- gateway `bun test`：**4211 pass / 0 fail / 2 errors**（基线 4202 pass / 2 errors；errors 仍是 `relay-hardening` harness 关流 `relay-rst`，与 G5 相同）
- `tsc --noEmit` shared / app / gateway：0
- `bun run lint`（biome + complexity）：通过，未改 allowlist

覆盖：authBarrier kick / token reissue；head race 重试；admit 拒绝 / `member_ignored` / 第二条失败；未授权 URL；`packs[]` 分中继转发；standby 验 proof 后 409、写者 `executeForwardedWrite` → 201；env 文件 `node` / `relay,node`；KDF 超预算；限流分桶 + reserve/release + 不驱逐窗口内桶；unpack 后注入失败清零；口令 &lt; 8。

## 需要指挥官处理

1. **`packages/api-client` / FE `packs[]`（F3b）**  
   节点 `POST /api/mesh/relay/pack` 新体：
   ```jsonc
   {
     "kdf_params": { "salt": "<b64url 16B>", "memory_kib": 65536, "iterations": 3, "parallelism": 1 },
     "root_epoch": 0,
     "head_seq": 4,
     "packs": [
       { "url": "https://relay-a.example", "sealed_pack": "<b64url>" },
       { "url": "https://relay-b.example", "sealed_pack": "<b64url>" }
     ]
   }
   ```
   各 `sealed_pack` 必须用**该 url 对应**的 tenant id（KEK info）与 token 密封。旧单包 `{ sealed_pack, kdf_params, root_epoch, head_seq, urls? }` 仍接受一轮。工作区里 F3b 已在改 `tenant-api.ts`，请对齐上述形状。

2. **`GET /api/mesh/relay/join-material` 仍只返回当前 attach 的一台**（`relay-routes.ts` 不在本任务可改范围）。网页/CLI 经 join-material 密封时拿不到其它中继的 token/tenant。本机已接入多中继时，CLI `uploadRelayPackFromLocal` 走 `MeshRelayStore.listRelayRows()` 可以封全表；经 gateway 的 `sealAndUploadRelayPack` 受 join-material 限制。若要网页一次刷新全部中继的密封包，需要把 join-material 扩成返回 `mesh_relays` 全表（含各 token）。

3. **R1-#4 / proxy CIDR**：按指令未动。
