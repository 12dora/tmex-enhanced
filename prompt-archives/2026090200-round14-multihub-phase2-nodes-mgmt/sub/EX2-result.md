# 总结

当前实现有三个关键事实：

1. 没有 `admit-hub` / `retire-hub` 记录，也没有 `POST /api/hub/hubs/:id/admit`。
2. Enrollment token 只存在创建它的 hub，standby 被明确禁止创建和 redeem。
3. `hub promote/demote/standby` 目前是 CLI 修改 env 后重启，不存在远程角色切换 API。

推荐方案：

- hub 授权：新增用户签名的 key-log 记录。
- enrollment：standby 同步 token，但只有被提升为 writer 后才能创建/redeem。
- 角色切换：新增带持久化 transition 状态的 `/api/hub/role` API。

## 1. `admit-hub` / `retire-hub`

### Current（files/lines）

#### Key-log 记录格式与验证

`packages/shared/src/auth/encoding.ts:29-39` 定义当前 8 种记录：

```text
add-passkey
remove-passkey
rotate-root
set-totp
clear-totp
admit-node
revoke-node
reset-root
```

外层记录字段为：

`packages/shared/src/auth/encoding.ts:126-137`

```text
domain
uid
seq
prev_hash
root_epoch
type
payload
signer
credential_id
```

所有记录统一由以下逻辑验证：

`packages/shared/src/auth/key-log.ts:218-281`

- `seq == localHead.seq + 1`
- `prev_hash == localHead.hash`
- `root_epoch` 必须匹配
- `signer` 必须符合 `KEY_LOG_SIGNER_MATRIX`
- `root`：Ed25519 验证
- `passkey`：WebAuthn assertion 验证，challenge 为 `sha256(recordBytes)`
- 记录 hash 为 `sha256(recordBytes || sig)`，见 `packages/shared/src/auth/key-log.ts:157-159`

签名矩阵：

`packages/shared/src/auth/key-log.ts:60-69`

- `add-passkey`、`remove-passkey`、`set-totp`、`clear-totp`、`admit-node`、`revoke-node`：`root` 或 `passkey`
- `rotate-root`、`reset-root`：仅 `root`

#### 现有记录映射

| 类型 | payload | 签名者 | 本地应用 |
|---|---|---|---|
| `add-passkey` | `credential_id`、`public_key`、RP/origin、counter、transport、backup 状态、device type、name；`encoding.ts:154-166` | root/passkey | 加入 `UserKeyState.passkeys`；持久化到 `user_keys`；`user-key-persistence.ts:141-158` |
| `remove-passkey` | `credential_id`；`encoding.ts:168-171` | root/passkey | 删除 passkey，并撤销该 credential 的 sessions；`key-log.ts:425-433`、`user-key-persistence.ts:160-165,188-194` |
| `rotate-root` | `root_public_key[32]`、KDF 参数；`encoding.ts:173-179` | root | 更新 root、`root_epoch + 1`，清空 passkeys/TOTP，撤销全部 sessions；`key-log.ts:301-327` |
| `set-totp` | `alg`、`nonce[12]`、`ciphertext`、`tag[16]`；`encoding.ts:181-187` | root/passkey | 设置 TOTP，并记录对应 log seq；`key-log.ts:435-437`、`user-key-persistence.ts:142` |
| `clear-totp` | 空 struct；`encoding.ts:189-190` | root/passkey | 清除 TOTP；`key-log.ts:439-442`、`user-key-persistence.ts:143` |
| `admit-node` | `authorization_bytes/sig`、`certificate_bytes`、`cert_sig`；`encoding.ts:192-198` | 外层 root/passkey；内部 authorization 也是 root/passkey；certificate 由 enrollment key 签名 | 验证 authorization、certificate、UID、`enroll_pk`，加入 `nodeCerts`；持久化到 `node_certs`；`key-log.ts:330-400`、`user-key-persistence.ts:166-178` |
| `revoke-node` | `node_id[16]`、`reason`；`encoding.ts:200-204` | root/passkey | 要求 node cert 已存在，标记 revoked，删除 peer，撤销经该 node 的 sessions；`key-log.ts:446-458`、`user-key-persistence.ts:180-184` |
| `reset-root` | 与 `rotate-root` 相同；`encoding.ts:173-179` | root，仅允许 genesis | 除 root reset 影响外，还清空全部 node cert 和 peer cache；`key-log.ts:301-327`。链首约束见 `key-log.ts:485-530` |

记录存储与应用：

- raw record 写入 `user_key_log`：`apps/gateway/src/auth/key-log-store.ts:75-90`
- payload JSON projection：`apps/gateway/src/auth/key-log-store.ts:98-126`
- `UserKeyService` 执行验证、apply、CAS 提交：`apps/gateway/src/auth/user-key-service.ts:239-356`
- 每个节点通过 `node.list.key_log_head` 发现远端 head：`apps/gateway/src/hub/uplink-server.ts:1287-1295`
- 节点按 seq 拉取记录并调用 `applyMany`：`apps/gateway/src/mesh/uplink-key-log-sync.ts:277-303,342-470`
- 节点领先时通过 `key.log.append` 推送：`apps/gateway/src/mesh/uplink-key-log-sync.ts:512-589`
- hub writer 处理 append：`apps/gateway/src/hub/uplink-server.ts:901-964`

#### 浏览器到底由谁签名

浏览器的 durable key-log 操作由用户 root key 或 passkey 签名：

- `apps/fe/src/auth/key-log-actions.ts:34-147`
- 账户安全操作调用 `/api/auth/keylog`：`apps/fe/src/auth/account-security-actions.ts:1-40`

`sk_sess` 不能签名 durable key-log 记录。

例外是 node rename：

- rename 目前不是 key-log 记录；
- hub 直接修改 `nodes` 表并广播：`apps/gateway/src/hub/hub-runtime.ts:430-440`
- 因此 rename 现在是 authenticated hub API 操作，不是浏览器用户 key 签名。

revoke 则是浏览器签名：

- FE 构造 `revoke-node`：`apps/fe/src/node/enrollment.ts:512-537`
- FE 通过 `/api/auth/keylog?hub=sync` 提交：`apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:39-106`
- hub 只校验目标 node 和链，然后 append：`apps/gateway/src/hub/hub-runtime.ts:443-475`

当前 hub API 路由只有 status、enrollment、nodes 等，没有 admit hub：

`apps/gateway/src/hub/hub-runtime.ts:290-335`

当前授权判断在：

`apps/gateway/src/hub/uplink-server.ts:1305-1314`

```ts
isAuthorizedHub(nodeId) {
  if (nodeId === self) return true;
  return TMEX_HUB_PEERS.has(nodeId);
}
```

env 注入位置：

`apps/gateway/src/mesh/mesh-runtime.ts:698-715`

其他独立使用 env allowlist 的地方：

`apps/gateway/src/hub/hub-replication.ts:50-64`

### Proposed

#### 新记录类型

在 `KeyLogType` 末尾追加，不能插入中间，以保持现有 zorsh enum ordinal：

```text
admit-hub
retire-hub
```

建议 payload：

```text
AdmitHubPayload {
  hub_node_id: bytes(16),
  public_url: option(string),
  priority: option(u32)
}

RetireHubPayload {
  hub_node_id: bytes(16)
}
```

两者都允许 `root` 或 `passkey` 签名。

`admit-hub` 应要求目标 node 已经存在未 revoked 的 `node_certs`。hub 授权不替代 node certificate；它只声明“这个已认证 node 具备 hub 身份”。

建议新增本地派生状态：

```text
user_hub_authorizations
  user_id
  hub_node_id
  status: active | retired
  public_url
  priority
  admit_record_seq
  retire_record_seq
  updated_seq
```

该表是 key-log replay 的 projection，不是独立信任根。

`applyKeyLogRecord()` 在每个 node/hub 上处理新记录，并更新该表。`mesh_hubs` 只保存在线状态、模式、epoch、CA 等运行时投影。

#### `isAuthorizedHub` 的新合并规则

对指定用户的 key-log 派生出三态授权：

```text
signed state = active  => authorized
signed state = retired => unauthorized
signed state = absent  => fallback to self/TMEX_HUB_PEERS
```

也就是：

```text
if signedAuthorization(id) == active:
  true
else if signedAuthorization(id) == retired:
  false
else:
  id == self || id in TMEX_HUB_PEERS
```

这样：

- 新版本可仅靠 `admit-hub` 工作；
- 旧部署的 env allowlist 仍可 bootstrap；
- `retire-hub` 可以压过旧 env，避免 `TMEX_HUB_PEERS` 把已撤销 hub 重新放回；
- env 不再是已知 hub 的最终 authority。

由于当前 `isAuthorizedHub(nodeId)` 没有 user 参数，而 key-log 是按 `uid` 存储的，必须明确：

- 若系统只支持单 mesh user，可由当前 mesh user 派生；
- 若支持多用户，函数应改为 `isAuthorizedHub(userId, nodeId)`，否则不同用户的 hub 授权会混在一起。

以下代码都要改为读取该派生状态：

- `apps/gateway/src/hub/uplink-server.ts:1305-1314`
- `apps/gateway/src/hub/uplink-server.ts:1316-1325`
- `apps/gateway/src/hub/uplink-server.ts:1350-1365`
- `apps/gateway/src/hub/hub-replication.ts:50-64`
- `apps/gateway/src/mesh/mesh-runtime.ts:698-715`

`retire-hub` 作用于当前 self 时，不能继续执行现有的“self 永远 authorized”逻辑。安全行为应为：

- 立即将本 hub fence 成 standby；
- 不再将其作为 writer candidate；
- 或要求先 demote，再提交 retire。

#### writer 如何追加

当前不存在：

```text
POST /api/hub/hubs/:id/admit
```

建议仍以现有 generic key-log 路径为权威：

```text
POST /api/auth/keylog?hub=sync
body: { bytes, sig }
```

流程：

1. 浏览器读取当前 key-log head。
2. 浏览器用 root key 或 passkey 构造并签名 `admit-hub`。
3. entry 通过当前 writer 提交。
4. writer 验证链、append、返回 `hubAck`。
5. 其他节点通过 key-log catch-up 应用记录。

如需 typed endpoint，可以增加：

```text
POST /api/hub/hubs/:id/admit
POST /api/hub/hubs/:id/retire
```

但 body 仍必须是用户签名的 `{bytes, sig}`，并校验：

- 路径 `:id` 与 payload `hub_node_id` 一致；
- 当前请求目标是 writer；
- record 类型正确；
- 最终仍委托给同一套 key-log append。

hub 不能自行签名，否则违背现有 trust model。

#### FE 触发流程

当前 hub 管理 UI 没有角色切换按钮：

- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:63-147`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:35-58`

entry 的“切换 primary/standby”操作应先：

1. 判断目标 hub 是否已存在 signed `active` authorization。
2. 如果没有，弹出 root/passkey signer。
3. append `admit-hub`，等待 `hubAck`。
4. 等目标 hub 出现在授权 hub projection 中。
5. 再调用远程 role API。

现有 `tmex hub standby` 会自动把当前 primary 加入本地 `TMEX_HUB_PEERS`：

`packages/app/src/commands/hub.ts:1129-1141`

在新模型中该行为不再是授权来源；standby 只消费已经复制的 `admit-hub`。env fallback 仅保留给旧版本和 bootstrap。

### Files to touch

- `packages/shared/src/auth/encoding.ts`
- `packages/shared/src/auth/key-log.ts`
- `apps/gateway/src/auth/key-log-store.ts`
- `apps/gateway/src/auth/user-key-service.ts`
- `apps/gateway/src/auth/user-key-persistence.ts`
- `apps/gateway/src/db/schema.ts`
- `apps/gateway/src/db/managed-migrations.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/hub-replication.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/fe/src/auth/key-log-actions.ts`
- `apps/fe/src/node/enrollment.ts`
- `apps/fe/src/node/hub-api.ts`
- `apps/fe/src/pages/settings/nodes/management/*`
- `packages/app/src/commands/hub.ts`

### Wire/DB/record changes

- `KeyLogType` 增加两个末尾 enum 值。
- 增加两个 Borsh payload schema 和 codec。
- 扩展 `KEY_LOG_SIGNER_MATRIX`。
- 扩展 `user_key_log_type_check`，当前 SQL 只允许旧 8 种：`apps/gateway/src/db/schema.ts:527-550`。
- 新增 hub authorization projection 表。
- `node.list.hubs` 改为来自 signed authorization 加 `mesh_hubs` 运行时信息。
- authorization record 不应包含 certificate；certificate 仍来自既有 `admit-node`。

### Compat/Risks

旧 v1.1.x 节点不能透明跳过新记录：

- `decodeKeyLogRecord()` 直接反序列化 enum：`packages/shared/src/auth/encoding.ts:240-268`
- `verifyKeyLogRecord()` 没有 unknown type skip：`packages/shared/src/auth/key-log.ts:218-235`
- chain replay 捕获 decode 错误后返回 `malformed_payload`：`packages/shared/src/auth/key-log.ts:518-523`

`@zorsh` 的 `nativeEnum` 按 ordinal 编码；旧节点收到新 ordinal 会抛 unknown enum index。因此新记录会使旧节点无法推进严格链。

结论：首条 `admit-hub` 写入前必须升级所有需要继续同步该用户 key-log 的节点。否则只能：

- 使用独立版本化 side-log；
- 或先做协议能力协商，旧节点永远不接收包含新记录的链；
- 不能简单“旧节点跳过记录”。

此外，新的 uplink control frame 也不能直接发给旧节点；当前 hub uplink 对未知 control type 会关闭协议，见 `packages/shared/src/uplink/codec.ts:841-862`、`apps/gateway/src/hub/uplink-server.ts:600-612`。

---

## 2. Enrollment token 复制到 standby

### Current（files/lines）

#### 表和创建

表结构：

`apps/gateway/src/db/schema.ts:620-635`

```text
id
user_id
enroll_public_key
authorization_json
authorization_sig
expires_at
used_at
node_id
```

创建接口为：

```text
POST /api/hub/enrollments
```

路由要求 authenticated user 和 writer：

`apps/gateway/src/hub/hub-runtime.ts:318-320`

创建逻辑：

`apps/gateway/src/hub/hub-runtime.ts:478-540`

- 校验 `enroll_pk`
- 校验 root/passkey 签名的 authorization
- 校验 UID、root epoch、expiry
- 插入 `enrollment_tokens`
- 初始 `used_at = null`

授权验证：

`apps/gateway/src/hub/hub-runtime.ts:542-577`

#### redeem

路由为：

```text
POST /api/hub/enrollments/redeem
```

standby 直接被 writer fence：

`apps/gateway/src/hub/hub-runtime.ts:314-317`

`HUB_NOT_WRITER` 的统一逻辑：

`apps/gateway/src/mesh/auth-routes.ts:689-715`

redeem 流程：

- 从 certificate 中取 `enroll_pk`
- 查 token
- 用 token 的 `enrollPublicKey` 验证 certificate signature
- 验证 authorization UID 和 token user
- `redeemInTransaction()` 原子消费 token

相关代码：

- parse/证书验证：`apps/gateway/src/hub/hub-runtime.ts:711-741`
- transaction：`apps/gateway/src/hub/hub-runtime.ts:744-828`
- 原子 `used_at IS NULL` 更新：`apps/gateway/src/auth/user-store.ts:510-533`

重复 redeem：

- 相同 certificate/cert_sig：视为 replay
- 不同 certificate：返回 `reused`

`apps/gateway/src/hub/hub-runtime.ts:762-772`

expiry：

- 过期未使用 token 会被删除：`apps/gateway/src/auth/user-store.ts:543-549`
- root rotate/reset 时未用 token 会被 invalidate：`apps/gateway/src/auth/user-store.ts:551-563`，调用路径在 `apps/gateway/src/hub/uplink-server.ts:483-498`

#### token 实际发出的 certificate 由谁签名

不是 hub 签名。

创建 enrollment 时，客户端生成 enrollment key：

`packages/shared/src/auth/enrollment.ts:56-80`

生成 node certificate 时：

`packages/shared/src/auth/enrollment.ts:145-180`

```text
cert_sig = signEd25519(enroll_sk, certificate_bytes)
```

因此信任路径是：

```text
root/passkey
  -> authorization(enroll_pk)
  -> enrollment private key signs certificate
  -> browser submits admit-node
  -> user_key_log
  -> node_certs
  -> node uplink uses certificate.ed_pk
```

redeem 本身只创建/更新 `nodes`，不会直接创建 `node_certs`：

`apps/gateway/src/hub/hub-runtime.ts:812-826`

`node_certs` 由 `admit-node` 应用时写入：

`apps/gateway/src/auth/user-key-persistence.ts:166-178`

因此 standby redeem 后，writer 恢复时能够信任该 node 的前提是：

1. 浏览器提交了 signed `admit-node`；
2. 该记录进入 user key-log；
3. 原 writer 通过 key-log catch-up 应用；
4. 原 writer 生成对应 `node_certs` projection。

redeem 返回完整 key-log 和 cert 列表：

`apps/gateway/src/hub/hub-runtime.ts:636-665`

#### 当前复制情况

当前 standby 不复制 enrollment token。架构文档也明确说明：

`docs/hub/2026090104-multi-hub-standby.md:60-67`

- `user_key_log/node_certs`：复制
- `nodes`：通过 node.list projection 复制
- `mesh_hubs`：通过 node.list 复制
- enrollment token：不复制
- standby 无法 redeem

### Proposed

推荐方案：**token 复制 + writer-only create/redeem + promotion 后继续使用现有原子 DB 语义**。

#### standby 同步 token

新增 hub-to-hub token replication frame，不放入普通 `node.list`：

```text
hub.tokens
  revision
  operation: upsert | tombstone
  token row:
    id
    user_id
    enroll_pk
    authorization
    authorization_sig
    expires_at
    used_at
    node_id
    certificate
    cert_sig
```

原因：

- `node.list` 会发送给普通 node；
- token authorization 数据不应随普通节点列表广播；
- 当前 `node.list` 只包含 nodes/hubs/head：`apps/gateway/src/hub/uplink-server.ts:1216-1296`。

复制规则：

1. writer 创建 token。
2. token row 写入本地 DB。
3. writer 发送 token delta 给 standby。
4. standby 幂等 upsert。
5. standby 返回 ACK。
6. writer 只有在至少一个配置的 standby ACK 后，才向客户端报告 token 创建成功。

必须增加单调 revision，不能只依赖 wall-clock `used_at`：

```text
token_revision
source_hub_id
```

或者使用 writer epoch 加 writer-local sequence。

过期删除应使用 tombstone 或保留已过期 row，防止旧 snapshot 把 token 重新恢复。

#### 角色和权限

- standby 可以复制 token；
- standby 未被 promote 前仍拒绝：
  - `POST /api/hub/enrollments`
  - `POST /api/hub/enrollments/redeem`
- standby 被提升为 writer 后，使用本地复制的 token 表继续现有逻辑；
- `consumeEnrollmentToken()` 的单 DB 原子更新继续作为 single-use 保证。

这样可以支持：

- writer 宕机前已成功复制的 token：新 writer 可 redeem；
- writer 宕机后创建新 token：先 promote，再通过新 writer 创建；
- 不需要让两个 active hub 同时修改同一 token。

### 三种选项评估

| 方案 | 结论 |
|---|---|
| 通过 `node.list` 或 `hub.tokens` 复制，`used_at` LWW | 不建议直接采用。`node.list` 暴露面过大；LWW 不能阻止两个 hub 同时产生副作用 |
| token 作为 signed key-log record | 可审计，但仍需解决 redeem claim 的全局 single-writer。enrollment key 可以签多个不同 certificate，不能单独提供一次性消费语义 |
| standby 只有在被 promote 后 redeem/create | 推荐。保留现有原子 DB 和 `HUB_NOT_WRITER` 语义，复杂度最低 |

LWW race 不是“按 node identity 有界”的：

`createNodeCertificate()` 在没有显式 nodeId 时会随机生成 16-byte node ID：

`packages/shared/src/auth/enrollment.ts:156-170`

两个 hub 可以用同一个 `enroll_sk` 签出不同 node ID 的 certificate。若两个 standby 同时 redeem：

- 两边都可能看到 `used_at = null`；
- 两边都能验证 certificate；
- 两边会创建不同 node；
- 最后的 LWW 只能决定 token row，不能撤销已经发出的 node projection、通知和副作用。

因此不能把“双 redeem”视为安全可接受的普通 race。

### Files to touch

- `packages/shared/src/uplink/codec.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- 新增 hub token replication service
- `apps/gateway/src/auth/user-store.ts`
- `apps/gateway/src/db/schema.ts`
- `apps/gateway/src/db/managed-migrations.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/fe/src/node/hub-api.ts`
- `apps/fe/src/node/enrollment.ts`
- enrollment 状态/重试相关 FE 代码

### Wire/DB/record changes

- 新增 authenticated `hub.tokens` uplink frame。
- 增加 revision、source hub、tombstone。
- 复制完整 token row，包括 consumed 后写入 `authorization_json` 的 certificate 信息。
- 新增 token replication ACK。
- `POST /api/hub/enrollments` 成功响应应区分：
  - 已复制并 durable；
  - 仅写入本地、尚未复制。
- 不把 `enroll_sk` 写入 hub DB、key-log 或 uplink frame；它只存在客户端 join token 中，见 `packages/shared/src/auth/enrollment.ts:94-142`。

### Compat/Risks

- 新 `hub.tokens` frame 对旧节点需要 capability negotiation；旧 decoder 对未知 control type 会拒绝。
- 若 writer 在 token 创建后、replication ACK 前宕机，该 token 不能保证存在于 standby。同步 ACK 是满足“writer 宕机前创建的 token 可 redeem”的必要条件。
- promotion 后必须先保证 token snapshot 已应用，再开放 redeem。
- standby redeem 后，浏览器仍需把 signed `admit-node` 写入新 writer 的 key-log；仅 redeem 不会建立 `node_certs` 信任。

---

## 3. Remote hub role switch

### Current（files/lines）

#### CLI 行为

CLI 命令注册：

`packages/app/src/cli-auth-entry.ts:45-72`

帮助文本：

`packages/app/src/cli/help.ts:16-21`

`hub standby`：

`packages/app/src/commands/hub.ts:1098-1158`

- 校验 hub 状态；
- 将当前 primary 加入本地 `TMEX_HUB_PEERS`；
- 写入 `TMEX_ROLES=hub,node`；
- 写入 `TMEX_HUB_MODE=standby`；
- 写入 public URL、priority、peers；
- 重启。

`hub promote`：

`packages/app/src/commands/hub.ts:1161-1190`

- 计算 `max(env epoch, mesh_hubs epoch) + 1`；
- 写入 `TMEX_HUB_MODE=active`；
- 写入新 writer epoch；
- 重启。

`hub demote`：

`packages/app/src/commands/hub.ts:1192-1205`

- 写入 `TMEX_HUB_MODE=standby`；
- 重启。

`hub allow/disallow`：

`packages/app/src/commands/hub.ts:1237-1285`

- 修改 `TMEX_HUB_PEERS`；
- 重启。

重启入口：

`packages/app/src/commands/hub.ts:293-315`

最终调用 service manager：

- systemd restart：`packages/app/src/lib/service.ts:143-150`
- launchd/systemd stop/start：`packages/app/src/lib/service.ts:211-267`

#### setup API

现有 setup 路由只有：

`packages/app/src/runtime/setup-routes.ts:10-56`

```text
POST /api/setup/precheck
POST /api/setup/hub
POST /api/setup/join
```

`becomeHub` 和 `joinHub` 都是写 env 后返回 restarting：

- `packages/app/src/runtime/setup-service.ts:610-653`
- `packages/app/src/runtime/setup-service.ts:655-745`

它们面向 standalone setup，不是已有 hub 的远程角色切换。

#### gateway 内部重启

已有 self-restart：

- `POST /api/settings/restart`：`apps/gateway/src/api/settings-routes.ts:54-62,91-95`
- `RuntimeController.requestRestart()`：`apps/gateway/src/control/runtime.ts:15-22`
- package runtime 安排 shutdown：`packages/app/src/runtime/assemble.ts:626-672`
- restart 状态下进程退出：`packages/app/src/runtime/server.ts:59-70`
- 普通 gateway loop 重建 runtime：`apps/gateway/src/index.ts:34-41`
- managed entry 热切换 runtime：`apps/gateway/src/managed-entry.ts:224-238`

当前 `UplinkServer.setMode()` 只改内存并更新 `mesh_hubs`：

`apps/gateway/src/hub/uplink-server.ts:303-309`

`hubWriterEpoch` 当前是 readonly 配置值，不能通过现有 API 持久修改。

#### 当前 FE 代理

`HubApi` 通过 entry 的 `/n/<nodeId>/api/...` 访问 hub：

`apps/fe/src/node/hub-api.ts:1-5,63-71`

网关 forwarder 负责目标 node session：

`apps/gateway/src/mesh/forwarder.ts:145-161,629-685`

当前 `HubApi` 没有 role 方法。

### Proposed

#### API

每个 hub 增加：

```text
POST /api/hub/role
```

body：

```json
{
  "mode": "active" | "standby",
  "writerEpoch": 42,
  "operationId": "uuid"
}
```

建议另加：

```text
GET /api/hub/role/status?operationId=<id>
```

POST 必须：

- 使用 `withAuth`；
- 验证用户属于目标 hub 的 user；
- 验证目标 hub 已被 signed `admit-hub` 授权；
- `active` 时要求 `writerEpoch >` 所有已知 epoch；
- 拒绝旧 epoch；
- `operationId` 作为幂等键。

不应复用 `/api/setup/*`。

#### 持久化

角色变更必须同时处理三层：

1. env：启动配置和重启后的最终来源；
2. `mesh_hubs`：运行时观察、writer selection 和 node.list projection；
3. transition 表：向 FE 报告进度和错误。

建议新增：

```text
hub_role_transitions
  operation_id primary key
  target_hub_id
  requested_mode
  requested_epoch
  phase
  error
  started_at
  updated_at
  completed_at
```

`mesh_hubs` 不能承担 transition 状态，因为 `replaceAll()` 会删除不在新列表中的行：

`apps/gateway/src/auth/mesh-hub-store.ts:90-116`

角色 API 的执行顺序：

1. 校验请求和 epoch。
2. 写 transition=`persisting`。
3. 原子写 `TMEX_HUB_MODE`、`TMEX_HUB_WRITER_EPOCH`。
4. 更新本地 `mesh_hubs`。
5. 立即更新内存 mode/epoch，使 demote 立刻停止写入。
6. 调用既有 `scheduleRestart`。
7. 进程退出，由 launchd/systemd 拉起。
8. 新进程读取 env，确认目标 mode/epoch，transition=`complete`。

`HubRuntime` 不应直接执行 service-manager shell 命令。建议通过依赖注入把 role controller / restart callback 从 `packages/app/src/runtime/assemble.ts` 传给 gateway runtime。

#### “把 X 设为 primary”的精确序列

设当前 writer 为 A，目标 hub 为 X：

1. 查询当前 hubs、writer、epoch。
2. 如果 X 没有 signed `admit-hub`：
   - 浏览器请求 root/passkey；
   - 构造并提交 `admit-hub`；
   - 通过当前 writer 等待 `hubAck=true`；
   - 确认 X 已出现在 signed authorization projection。
3. 计算：

   ```text
   newEpoch = max(
     all known mesh_hubs.writerEpoch,
     target X local/env epoch
   ) + 1
   ```

4. 调用：

   ```text
   POST /n/A/api/hub/role
   { mode: "standby", operationId }
   ```

   请求成功进入 `restarting` 即可；A 可能随后断开。

5. 调用：

   ```text
   POST /n/X/api/hub/role
   {
     mode: "active",
     writerEpoch: newEpoch,
     operationId
   }
   ```

6. X 写入 env、更新本地 `mesh_hubs`、重启。
7. 所有节点通过现有 epoch 逻辑发现 X：

   - node.list 携带 hub/writer epoch：`apps/gateway/src/hub/uplink-server.ts:1266-1295`
   - writer 选择：`apps/gateway/src/auth/mesh-hub-store.ts:156-169`
   - 高 epoch 启动时自动 fence：`apps/gateway/src/hub/uplink-server.ts:1350-1365`
   - peer 状态中发现更高 epoch 时 fence：`apps/gateway/src/hub/uplink-server.ts:1376-1400`

如果 A 不可达，不能声称 HTTP demote 成功。必须先确认 A 已停止，或由更高 epoch 的 X 让 A 被 fence；否则仍存在 split-brain 风险。

#### “把 X 设为 standby”

- X 已是 standby：返回 complete，幂等。
- X 是非 writer active hub：直接 demote。
- X 是当前 writer：
  1. 先提升另一个已授权 hub Y，epoch 使用 `max + 1`；
  2. 等 Y 成为 writer；
  3. 再 demote X。
- 如果没有替代 writer，API 可以允许 demote，但 FE 应明确显示“系统暂时没有 writer”。

不能降低 epoch；demote 只改变 mode，保留当前 epoch。

#### FE 进度和刷新恢复

FE 增加：

- `HubApi.role()`
- `HubApi.roleStatus()`
- hub row 的 promote/demote/switch primary 操作
- operation polling

相关现有 UI 位置：

- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:42-65,129-220`
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:63-147`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:35-58`

POST 返回：

```json
{
  "operationId": "...",
  "state": "accepted",
  "targetHubId": "...",
  "mode": "active",
  "writerEpoch": 42
}
```

状态至少包含：

```text
accepted
persisting
restarting
online
complete
failed
```

FE 刷新页面后：

1. 从本地保存的 `operationId` 恢复；
2. 请求目标 hub 的 `GET /api/hub/role/status`；
3. 同时刷新 `/api/mesh/hubs`；
4. 以服务端 transition 状态作为最终进度；
5. 以 `/api/hub/status` 和 writerHubId 作为最终角色确认。

自重启期间应复用现有健康检查逻辑：

`apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts:1-10,51-120`

该逻辑已经把“短暂不可达”视为正常，并通过 `/healthz.startedAt` 判断进程是否换代。

### Files to touch

- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/db/schema.ts`
- `apps/gateway/src/db/managed-migrations.ts`
- `packages/app/src/runtime/assemble.ts`
- `packages/app/src/runtime/setup-service.ts` 或新增 role controller
- `apps/gateway/src/control/runtime.ts`
- `apps/fe/src/node/hub-api.ts`
- `apps/fe/src/pages/settings/nodes/management/*`
- `apps/fe/src/node/mesh-hubs.ts`
- `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts`
- `packages/app/src/commands/hub.ts`

### Wire/DB/record changes

- 新增 `POST /api/hub/role`。
- 新增 `GET /api/hub/role/status`。
- 新增 `hub_role_transitions`。
- env 持久化：
  - `TMEX_HUB_MODE`
  - `TMEX_HUB_WRITER_EPOCH`
- `mesh_hubs` 立即更新，但不是唯一持久来源。
- `operationId` 必须具有服务端幂等语义。
- `active` 使用单调递增 epoch。
- `standby` 不降低 epoch。
- endpoint 返回 restart 前的 accepted 状态，不能等待自身进程重启完成后再返回。

### Compat/Risks

- v1.1.x hub 不认识新 endpoint，FE 应根据版本/能力隐藏按钮。
- 通过 `/n/<nodeId>` 调用要求目标 hub 存在可用 node session；目标离线时不能远程切换。
- 当前 entry 如果就是被 demote 的 A，提交成功后连接可能立即中断，FE 必须切换到 X 或其他 hub 轮询状态。
- 仅修改 `mesh_hubs` 不足以持久角色；启动时仍从 env 读取，且 mesh projection 可能被 replace。
- 远程 promote 不能单独解决旧 writer 仍运行的问题；必须依赖 higher epoch fence、显式停止或网络隔离。
- 同 epoch active hub 仍可能产生 split-brain；当前架构没有 quorum，必须在 UI 和 API 中明确展示这一限制。