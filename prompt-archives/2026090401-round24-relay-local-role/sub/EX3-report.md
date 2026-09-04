只读勘察完成，未修改任何文件。以下行号基于当前工作区快照，后续代码变更后可能漂移。

结论：共享的根密钥、密钥日志验证、证书和 Relay uplink 机制基本可复用；但 Relay 密码加入不是现有 r3 join 的简单分支，必须新增：

1. Relay 侧公开 KDF 参数与不透明 sealed pack 存储。
2. Relay 密码 proof 的 `mode: 'join'` 分支，且不能触发现有 token reissue/kick 逻辑。
3. 加入节点基于既有日志追加 `admit-node` 和 `meta-key` 两条记录。
4. 首次 uplink 使用新 `admit-node` 作为 `member` sidecar。
5. 本地每次 append、root rotation 后刷新 sealed pack，同时解决 root seed 不持久化的问题。

## 1. Root key 与用户状态

### 根密钥派生

`packages/shared/src/auth/root-key.ts`：

- `L5-L9`：Argon2id 参数为：
  - memory：65536 KiB；
  - iterations：3；
  - parallelism：1；
  - hash length：32；
  - salt length：16。
- `L27-L34`：`generateKdfParams()` 生成随机 16 字节 salt。
- `L36-L48`：`deriveSeed(password, kdfParams)`：
  - 对密码执行 Unicode NFKC 规范化；
  - 使用规范化后的 UTF-8 密码和 `kdfParams.salt`；
  - 输出 32 字节 seed。
- `L50-L63`：`rootKeyFromSeed(seed)` 将 32 字节 seed 作为 Ed25519 私钥，派生 root public key，并提供签名函数。

除以下内容外，没有其它派生输入：

- 密码；
- 密码的 NFKC 规范化结果；
- salt；
- memory、iterations、parallelism、hashLength 参数。

不会进入 KDF 的内容包括 username、uid、tenant id、root epoch、域名、节点 id。

`packages/shared/src/auth/encoding.ts:L57-L63` 定义 KDF 参数编码：

```text
salt
memory_kib
iterations
parallelism
```

### `/api/auth/mode` 与 bootstrap record

`apps/gateway/src/db/local-auth-http.ts:L44-L79` 的 `meshAuthModeUserFields()` 对外返回：

- `uid`、`username`；
- `kdfParams`；
- passkey/TOTP 状态；
- `rootEpoch`；
- hub 标识；
- 有效会话下才返回 `rootPublicKey`。

`apps/gateway/src/mesh/auth-routes.ts:L254-L289` 的 `/api/auth/mode`：

- 未登录时可取得 KDF 参数；
- 未登录时 `rootPublicKey` 为 `null`；
- 这是密码加入客户端获取 KDF 参数的现有入口，但 Relay 租户不能直接依赖目标节点的 `/api/auth/mode`，因为新节点尚未有本地用户。

KDF 参数也写入 key log 的 bootstrap record：

- `packages/shared/src/auth/encoding.ts:L178-L210`：`reset-root`、`rotate-root`、`rotate-root-keep` payload 包含新 root public key 和 KDF 参数；
- `packages/shared/src/auth/key-log.ts:L617-L685`：完整 replay 从第一个 `reset-root` genesis record 建立状态；
- `apps/gateway/src/auth/user-key-service.ts:L729-L792`：加入 replay 时从第一个 `reset-root` payload 提取 KDF 参数。

### 节点本地存储

数据库：

- `apps/gateway/src/db/schema/users-auth.ts:L13-L28`：
  - `users.root_public_key`
  - `users.root_epoch`
  - `users.kdf_params_json`
  - key log head seq/hash
- `apps/gateway/src/db/schema/users-auth.ts:L50-L74`：
  - `user_key_log` 保存 record bytes、signature、hash、seq、root epoch、type 等。

状态加载：

- `apps/gateway/src/auth/user-key-service.ts:L145-L165`：解析 `kdfParamsJson`；
- `L184-L251`：`currentState()` 组装 root key state；
- `apps/gateway/src/auth/user-store.ts:L14-L25`：`UserRecord` 暴露 `kdfParamsJson`；
- `apps/gateway/src/auth/user-key-persistence.ts:L50-L57`：KDF JSON 编码；
- `L110-L149`：每次 key log 应用时更新 root public key、epoch、KDF 和 head。

Relay token/K_log 存储在本地 Relay secrets/mesh relay 表中，不等于用户 KDF：

- `packages/app/src/lib/relay-store.ts:L14-L38`；
- `apps/gateway/src/mesh/relay-secrets.ts:L83-L104`。

### root rotation 行为

`packages/app/src/lib/hub-user-passwd.ts:L78-L143`：

- `L89-L100`：用旧 KDF 派生旧 root，并校验当前 root public key；
- `L102-L110`：生成新 KDF，使用新密码派生新 root；
- `L125-L133`：旧 root 签名 `rotate-root` 或 `rotate-root-keep`；
- `L135-L137`：清除 seed。

因此：

| 操作 | 新密码 | 新 salt/KDF | passkey/TOTP | 会话 | 证书 |
|---|---|---|---|---|---|
| `rotate-root` | 重新派生 | 是 | 清除 | 撤销 | 保留 |
| `rotate-root-keep` | 重新派生 | 是 | 保留，TOTP 可重新包裹 | 保留 | 保留 |
| `reset-root` | 重新派生 | 是 | 清除 | 清除 | 清除，且只能作为 seq=1 genesis |

实现位置：

- `packages/shared/src/auth/key-log.ts:L395-L451`；
- `apps/gateway/src/auth/user-key-service.ts:L420-L482`；
- `apps/fe/src/auth/account-security-actions.ts:L171-L310`。

`reset-root` 不是普通追加式 rotation。它要求新日志从 seq=1 开始，并清空旧派生状态。

## 2. 现有 r3 Relay join 全链路

### 发起端：现有节点创建 join token

Web 侧：

- `apps/fe/src/node/relay-join.ts:L45-L103`
  - 使用现有 root password；
  - 通过已有 KDF 派生 root；
  - 调用 `/api/mesh/relay/join-material`；
  - 创建 enrollment；
  - 通过 Relay uplink 创建待加入 enrollment；
  - 生成 r3 token。

CLI/已有节点侧：

- `packages/app/src/commands/enroll.ts:L451-L517`
  - 读取现有用户；
  - 用现有 KDF 派生 root；
  - `createEnrollment(rootKey)`；
  - 生成包含 `enrollSk`、root public key、key-log head hash、K_log 和 Relay 信息的 join token。

r3 token 格式：

- `packages/shared/src/relay/join-token.ts:L29-L45`：包含 Relay URL、tenant id、token；
- `L116-L161`：编码内容为：

```text
enroll_sk
root_public_key
key_log_head_hash
K_log
relay table
CA fingerprint（可选）
```

### 新节点 CLI

`packages/app/src/commands/hub.ts:L570-L632`：

- `L578-L581`：当前要求 `--token`；
- `L582-L585`：识别 r3 token 后委托 `runRelayJoin()`；
- 非 r3 token 则走 Hub join。

`packages/app/src/commands/relay-join.ts`：

1. `L52-L72`：排序 Relay entry。
2. `L88-L123`：用 tenant token 查询 enrollment uid。
3. `L125-L169`：POST `/api/relay/tenants/:tenantId/enrollments/redeem`。
4. `L171-L219`：
   - 创建本机 node identity；
   - 用 `enrollSk` 创建 node certificate；
   - 生成 PoP。
5. `L253-L294`：遍历 Relay，做 CA pinning 和 redeem。
6. `L296-L362`：
   - 解密 key log page；
   - `verifyKeyLogChain()`；
   - replay passkey；
   - `commitJoin()`；
   - 持久化 Relay CA；
   - `persistRelayUplink()` 保存 tenant、token、K_log。
7. `L385-L430`：完整 CLI 流程、环境变量和重启。

### Relay 服务端

公共路由注册：

- `apps/gateway/src/relay/relay-runtime.ts:L198-L230`：
  - `POST /api/relay/enroll`；
  - `POST /api/relay/tenants/:tenantId/enrollments/redeem`；
  - `GET /api/relay/tenants/:tenantId/enrollments/:enrollPk`。

Relay enroll：

- `apps/gateway/src/relay/relay-routes.ts:L47-L72`：解析 root public key、root epoch、proof、可选 Relay site password；
- `L75-L86`：校验 Relay site password；
- `L88-L120`：`issueTenantToken()`；
- `L122-L151`：`handleRelayEnroll()`；
- `L145-L150`：已有 tenant 时会 reissue token；
- `apps/gateway/src/relay/relay-uplink-server.ts:L105-L108`：可能触发 `enforceTokenReissue`。

这正是新 `mode: 'join'` 必须绕过的路径。

Enrollment redeem：

- `apps/gateway/src/relay/relay-routes.ts:L172-L200`：查询 enrollment；
- `L203-L256`：解析、校验证书和 PoP；
- `L258-L308`：
  - tenant token 认证；
  - 校验 enrollment；
  - 检查 node quota；
  - 消费一次性 enrollment；
  - 返回加密 key log。

### Relay password join 的复用点

当新节点已经持有：

```text
K_log
tenant token
root key/root seed
root public key
key-log head hash
head seq
```

可以复用：

- `packages/app/src/lib/relay-keylog.ts:L13-L46`：解密并解析 key log page；
- `packages/app/src/lib/keylog-passkey-replay.ts:L25-L69`：重放 passkey；
- `packages/app/src/lib/keylog-passkey-replay.ts:L71-L85`：创建带 replay verifier 的 UserKeyService；
- `packages/shared/src/auth/key-log.ts:L617-L685`：完整链验证；
- `apps/gateway/src/auth/user-key-service.ts:L684-L727`：加入链 replay；
- `apps/gateway/src/auth/user-key-service.ts:L729-L792`：持久化 replay；
- `packages/app/src/lib/relay-store.ts:L14-L38`：保存 Relay uplink 资料；
- `packages/app/src/lib/relay-ca.ts:L27-L104`：CA 获取、指纹校验、pin；
- `apps/gateway/src/mesh/relay-uplink-auth.ts:L31-L81`：正常 uplink auth 结构；
- `apps/gateway/src/mesh/relay-uplink-server.ts:L441-L473`：Relay pending node 通过 member sidecar 自举为 admitted。

不可直接复用的部分：

- `packages/app/src/commands/relay-join.ts:L171-L219` 依赖 `enrollSk`；
- 现有 token redeem 直接返回完整用户日志，但不会为新节点追加 `admit-node`；
- 新节点必须先追加自己的 `admit-node`，再追加 `meta-key`，才能正常连接。

### CA pinning

`packages/app/src/lib/relay-ca.ts:L27-L81`：

- 请求 `/api/tls/ca.crt`；
- 解析证书；
- 与 token 中的 CA fingerprint 比较；
- 不匹配时拒绝，不回退到系统 CA。

密码 join 没有现成 token 携带 fingerprint，因此必须明确新增 CA bootstrap 策略。不能因为没有 token 就静默关闭 TLS 校验。

### Web 与 CLI 是否共用

Web Relay enroll：

- `apps/fe/src/node/relay-enroll.ts:L182-L231`；
- `packages/api-client/src/relay/tenant-api.ts:L288-L379`；
- 使用 `/api/mesh/relay/*`，需要 node-session；
- 共享 relay proof，但不共享 CLI 的 `runRelayJoin()`。

CLI：

- `packages/app/src/commands/relay-join.ts`；
- 直接访问 Relay 公共 API。

结论：两者只共享 shared protocol 和部分数据结构，不共享完整 join 流程。

## 3. Self-admit、证书和 key log replay

### 现有 self-admit bootstrap

`apps/gateway/src/auth/user-key-service.ts:L551-L645` 的 `bootstrapUserWithSelfAdmit()`：

1. `L552-L555`：使用 supplied password 生成新 KDF 和新 root。
2. `L560-L580`：创建 `reset-root` seq=1 genesis。
3. `L582-L596`：生成本机 node certificate 和 `admit-node` payload。
4. `L601-L633`：
   - 创建或覆盖 user；
   - 删除旧 key log、keys、sessions、certs；
   - 写入 genesis + admit-node；
   - 绑定 identity。
5. `L635-L644`：返回 user id、root public key、root epoch、root key。

它不能用于“已有 root + 已有 key log 的追加节点加入”，因为会：

- 重新派生新 root；
- 创建新的 reset-root；
- 清空旧日志和派生状态；
- 覆盖现有用户和证书。

需要新增非破坏性方法，例如：

```text
appendSelfAdmitToExistingLog()
```

应当在已有 replay state/head 上：

1. 生成本机 enrollment key；
2. 用现有 root key 创建 self-signed node certificate；
3. 构造 root-signed `admit-node`；
4. 持久化；
5. 生成新 K_meta；
6. 构造 `meta-key`，为所有 admitted nodes（包括自己）包裹 K_meta；
7. 再持久化第二条记录。

两条记录必须在同一把本地 key-log 写锁或事务语义下追加，避免并发 append 造成 seq/head 冲突。

### 证书签发关系

`packages/shared/src/auth/enrollment.ts`：

- `L20-L25`：`EnrollmentSigner` 可以是 RootKey 或 Passkey；
- `L56-L81`：`createEnrollment()` 生成新的 enrollment Ed25519 key，并由 root/passkey 签 authorization；
- `L145-L180`：
  - `createNodeCertificate()` 创建 node certificate；
  - certificate 由 enrollment private key 自签；
  - `verifyNodeCertificate()` 验证 enrollment signature。

证书 schema：

- `packages/shared/src/auth/encoding.ts:L120-L129`：
  - domain；
  - uid；
  - node id；
  - node Ed25519 public key；
  - node X25519 public key；
  - enrollment public key；
  - issued_at。

`admit-node` payload：

- `packages/shared/src/auth/encoding.ts:L215-L221`：
  - authorization；
  - authorization signature；
  - certificate；
  - certificate signature。

Root/passkey 的记录签名权限：

- `packages/shared/src/auth/key-log.ts:L101-L115`：
  - `admit-node`：root 或 passkey；
  - `rotate-root`、`reset-root`、`rotate-root-keep`：root；
  - `meta-key`：root 或 passkey。

### admit-node 记录验证和应用

`packages/shared/src/auth/key-log.ts:L453-L523`：

- 解码 authorization/certificate；
- 校验 authorization；
- 校验证书由 enrollment key 签名；
- 校验 uid 和 enroll_pk 一致；
- 拒绝重复 node id；
- 写入 `nodeCerts`。

`apps/gateway/src/auth/node-identity-service.ts:L58-L81` 的 `selfSignedNodeCertificate()` 已经能生成所需的自签证书和 admit payload，可作为新增追加方法的基础。

### replay verifier

`packages/app/src/lib/keylog-passkey-replay.ts:L15-L69`：

- 加入节点开始时没有本地 passkey；
- replay `add-passkey` record，收集公钥和 credential id；
- 对后续 assertion 验证 origin、rpId、counter；
- counter 必须单调递增。

完整 replay：

- `apps/gateway/src/auth/user-key-service.ts:L647-L682`：单步 decode/verify/apply；
- `L684-L727`：从 reset-root 开始重放；
- `packages/shared/src/auth/key-log.ts:L617-L685`：检查 seq、prev hash、签名、root epoch 和 expected head。

## 4. Relay 侧存储、路由和 sealed pack

### 当前 schema

`apps/gateway/src/db/schema/relay.ts:L18-L32`：

`relay_tenants` 当前字段包括：

- id；
- root public key；
- root epoch；
- token hash/token epoch；
- quota；
- label；
- kicked；
- timestamps；
- bytes；
- key log head seq。

当前 SQL：

- `apps/gateway/drizzle/0039_relay.sql:L12-L28`。

现有表没有：

- `kdf_params_json`；
- `sealed_pack`。

实现时应新增 migration，不应修改已应用的 `0039_relay.sql`。建议新增：

```text
apps/gateway/drizzle/00XX_relay_password_pack.sql
```

### Store 改动点

`apps/gateway/src/relay/relay-tenant-store.ts`：

- `L18-L33`：row 映射；
- `L90-L119`：创建 tenant；
- `L121-L141`：token reissue；
- `L143-L166`：root rotation；
- `L168-L213`：kick、patch、touch、usage。

需要补充：

```text
kdfParamsJson
sealedPack
```

并在以下操作中明确行为：

- tenant 创建；
- root rotation；
- pack 更新；
- tenant 查询；
- admin 输出。

sealed pack 不应意外出现在 admin/status 接口中。

### 新路由

建议放在 `apps/gateway/src/relay/relay-runtime.ts:L198-L230` 的公共路由区：

```text
GET  /api/relay/tenants/:tenantId/kdf
POST /api/relay/tenants/:tenantId/pack
```

其中：

#### `GET /api/relay/tenants/:id/kdf`

- 不需要 tenant token；
- 只返回公开 KDF 参数；
- 不返回 root public key、tenant token、sealed pack；
- tenant 不存在时需考虑是否允许可枚举。

#### `POST /api/relay/tenants/:id/pack`

- 使用 `x-tmex-relay-token`；
- 复用 `authenticateRelayTenant()`：`apps/gateway/src/relay/relay-routes.ts:L153-L170`；
- 接收 sealed pack 和明文 head metadata；
- 校验：
  - tenant id；
  - sealed pack 长度/版本；
  - KDF 参数；
  - head seq 是否等于 Relay 当前 head；
  - root epoch 是否匹配当前 tenant；
- 以事务方式更新 KDF 参数和 sealed pack。

Relay 无法解密 pack，因此无法验证 pack 内部 root public key、K_log 或 token 是否正确。客户端必须在加密明文外携带可校验的版本/head metadata，或者由 pack AAD 绑定 tenant id、root epoch、head seq。

### `/api/relay/enroll` 的 `mode: 'join'`

当前实现：

- `apps/gateway/src/relay/relay-routes.ts:L122-L151`；
- `L145-L150` 对已有 root public key 走 token reissue。

建议：

```text
mode: 'enroll'
```

保留当前行为；

```text
mode: 'join'
```

执行：

1. 限流；
2. 验证现有 `tmex/relay-enroll/v1` proof；
3. 根据 tenant id 查询 tenant；
4. 比较 proof 中 root public key 与 tenant 当前 root public key；
5. 检查 root epoch/时间；
6. 不检查 Relay site password；
7. 不调用 `issueTenantToken()`；
8. 不调用 `enforceTokenReissue()`；
9. 返回该 tenant 当前 sealed pack、KDF 参数或 pack 版本信息。

当前 proof：

- `packages/shared/src/relay/enroll-proof.ts:L5-L15`；
- `L63-L110`。

proof 包含：

```text
domain
relay_host
root_public_key
ts
signature
```

当前 proof 没有 tenant id。服务端必须强制执行“tenant id → 当前 root public key”的绑定；若后续需要更强的跨租户绑定，应升级 proof 编码并将 tenant id 加入签名内容。

### sealed pack 加密实现

现有 `packages/shared/src/relay/tenant-cipher.ts` 是节点间 Relay envelope，不建议直接复用为密码 pack：

- `L127-L170`：AES-GCM seal/open；
- `L172-L221`：节点包裹密钥 HKDF；
- `L231-L267`：按 node id 解包。

新 pack 应新增独立协议文件，例如：

```text
packages/shared/src/relay/relay-pack.ts
```

明确：

- pack version；
- 二进制编码；
- AAD；
- tenant id/root epoch/head seq 绑定；
- `K_log`、tenant token、head hash、head seq；
- `KEK = HKDF(root seed, "tmex-relay-pack/v1")` 的 salt/info 具体约定；
- root rotation 后旧 pack 的失效条件；
- 解密后的 seed、KEK、明文 pack 的清理。

### Relay key log 的限制

`apps/gateway/src/relay/relay-key-log-service.ts:L100-L175`：

- Relay 只保存加密记录；
- 只校验 seq/member proof；
- 不能验证 hash chain。

`apps/gateway/src/relay/relay-key-log-store.ts:L7-L75`：

- 只保存 opaque encrypted blob、seq 和 envelope 元数据。

这意味着 Relay 无法判断 sealed pack 是否和当前日志内容一致。

### pack 刷新位置

本地 append 主路径：

- `apps/gateway/src/mesh/auth-key-log-routes.ts:L138-L154`：决定 relay 模式 local-first；
- `L174-L255`：本地应用并发布；
- `apps/gateway/src/auth/user-key-service.ts:L253-L311`：事务持久化；
- `apps/gateway/src/mesh/mesh-runtime.ts:L572-L584`：`onApplied` 和 relay 通知；
- `apps/gateway/src/mesh/relay-key-log-sync.ts:L161-L207`：加密并发送 Relay append；
- `apps/gateway/src/mesh/relay-wiring.ts:L15-L44`：当前只对 `set-relays`、`meta-key` 做 Relay reconcile。

当前通知机制不足以满足“每次 local append 刷新 pack”。需要新增 head-change hook，或在以下顺序中接入：

```text
本地 key log commit
→ Relay key log append/ACK
→ 用当前 root seed 生成 sealed pack
→ POST /api/relay/tenants/:id/pack
```

关键问题：root seed 不持久化。

- CLI rotation 在 `packages/app/src/lib/hub-user-passwd.ts:L135-L138` 清除 seed；
- FE root signer 生命周期在 `apps/fe/src/auth/account-security-actions.ts:L171-L230`；
- 后台 `onApplied` 当前拿不到密码或 root seed。

因此需要明确一种方案：

1. 在同一次 root rotation/append 请求中携带短生命周期 root key，并完成 pack upload；
2. 引入受控的内存 root-seed lease；
3. 新增需要再次输入密码的 pack refresh API。

不能假设后台回调能够自行重新派生 root key。

### Relay 测试文件

现有 harness：

- `apps/gateway/src/relay/relay-test-harness.ts:L105-L184`；
- `apps/gateway/src/relay/relay-test-tenant.ts:L71-L442`。

建议扩展的 Relay 测试：

```text
apps/gateway/src/relay/relay-routes.test.ts
apps/gateway/src/relay/relay-hardening.test.ts
apps/gateway/src/relay/relay-units.test.ts
apps/gateway/src/relay/relay-uplink.test.ts
apps/gateway/src/relay/relay-admin.test.ts
apps/gateway/src/relay/integration/relay.integration.test.ts
apps/gateway/src/relay/integration/relay-membership.integration.test.ts
apps/gateway/src/relay/integration/relay-mesh-harness.ts
apps/gateway/src/relay/integration/relay-mesh-types.ts
apps/gateway/src/relay/integration/relay-tenant-ops.ts
apps/gateway/src/mesh/relay-key-log-sync.test.ts
apps/gateway/src/mesh/relay-secrets.test.ts
apps/gateway/src/mesh/relay-uplink-client.test.ts
apps/gateway/src/mesh/auth-key-log-relay.test.ts
packages/shared/src/relay/enroll-proof.test.ts
packages/shared/src/relay/tenant-cipher.test.ts
```

## 5. Hub 侧

### 当前 enrollment 创建流程

`apps/gateway/src/hub/hub-runtime.ts:L730-L782`：

- `L764-L769`：POST `/api/hub/enrollments`；
- 该路由需要 `withAuth()` 和 writer-or-forward。

`L810-L817`：

- `withAuth()` 通过 node-session 认证；
- 没有 node-session 返回 401。

创建逻辑：

- `L892-L956`：
  - 解析 enrollment public key、authorization、signature、expiry；
  - `L913-L920`：验证 authorization；
  - `L926-L927`：检查 enrollment key 重复；
  - `L934-L941`：创建 enrollment token；
  - `L942-L965`：发布 replication 并返回 hub URL/CA 信息。

authorization 验证：

- `L969-L1004`：
  - 校验 uid/root epoch/enroll_pk；
  - root public key 验证 root signature；
  - passkey authorization 可验证 passkey assertion。

共享创建逻辑：

- `packages/shared/src/auth/enrollment.ts:L56-L81`；
- join token 编码：`L94-L116`。

### 新的 password route

建议新增：

```text
POST /api/hub/enrollments/by-password
```

位置：

- `apps/gateway/src/hub/hub-runtime.ts:L730-L782` 的路由分派；
- 应放在通用 `/api/hub/enrollments/:id` 动态路由之前。

该接口不能只接收 root proof 和 `enroll_pk`，因为 Hub 只保存 root public key，没有 root private key，无法代替客户端签发 authorization。

可行协议有两种：

#### 方案一：客户端创建 enrollment

客户端：

1. 从 `/api/auth/mode` 获取 uid/KDF；
2. 用密码派生 root key；
3. 创建新的 `enrollSk`；
4. 用 root key 签 authorization；
5. 发送 root-key-signed Hub proof + enrollment authorization。

Hub：

1. 验证 password proof；
2. 复用 `verifyEnrollmentAuthorization()`；
3. 创建普通 enrollment；
4. 返回普通 join token或 enrollment 资料。

#### 方案二：Hub 生成 enrollment key

Hub 生成 enrollment private key，并返回完整普通 join token。该 private key 只存在响应中，不能写入 Hub 数据库。此方案敏感信息更多，且必须避免日志和中间层记录。

建议优先采用方案一，复用现有 enrollment 语义。

proof 应使用不同域，例如：

```text
tmex/hub-enroll/v1
```

不要把 Relay proof 的 domain 原样复用。应绑定 Hub canonical host 和 timestamp，必要时绑定 uid。

### Hub 限流

没有专门的 password enrollment limiter。

可复用或提取：

- `apps/gateway/src/mesh/auth-login-limiter.ts:L8-L79`：
  - sliding window；
  - arbitrary key；
  - failure count；
  - bounded key pruning。
- `apps/gateway/src/mesh/auth-routes.ts:L160-L163`：现有 login limiter 实例；
- `apps/gateway/src/mesh/auth-routes.ts:L309-L329`：challenge quota；
- `apps/gateway/src/hub/uplink-rate-limit.ts`：更偏向 node uplink/key-log 请求，不适合直接用于公开密码 route。

建议按 `IP + uid/root public key` 维度限流，并区分 proof 失败与成功后的 enrollment 创建频率。

## 6. CLI

### 参数和 dispatch

`packages/app/src/lib/args.ts`：

- `L7-L39`：`NestedCommandName`；
- `L101-L180`：Hub/Relay 子命令表；
- `L229-L237`：当前 `hub.join` flags 只有 token、name、insecure-local、no-restart；
- `L284-L285`：Relay tenant flags；
- `L290-L297`：未知 flag 检查。

需要增加：

```text
tmex relay join <url> --tenant <id> [--password]
tmex hub join <url> --password
```

具体：

- Relay 子命令增加 `join`；
- Relay join flags 增加 `tenant`、`password`、`name`、`no-restart`；
- Hub join 增加 `password`；
- `--token` 与 `--password` 互斥；
- Relay 的 `--tenant` 必填。

`packages/app/src/cli-auth-entry.ts:L18-L61`：

- 当前 dispatch 有 `hub.join`；
- 没有 `relay.join`；
- 需增加 Relay join handler。

测试：

- `packages/app/src/lib/args-relay.test.ts:L11-L117`；
- 现有测试假定 Relay 有 11 个命令，需要同步更新。

帮助和文案：

- `packages/app/src/cli/help.ts:L14-L69`；
- `packages/app/src/i18n/index.ts:L184-L?`、`L422-L?` 附近的 Hub join 文案。

### 密码读取

`packages/app/src/lib/password.ts:L10-L38`：

- `resolvePassword()` 优先使用显式参数；
- 否则调用 `promptPassword()`；
- `deriveRootKey()` 使用 shared `deriveSeed()` 和 `rootKeyFromSeed()`；
- `assertRootKeyMatches()` 校验 root public key。

`packages/app/src/lib/prompt.ts:L8-L64`：

- TTY 下隐藏输入；
- 非 TTY 可使用环境变量；
- 支持确认输入。

Relay site password 和 mesh root password 是两套密码：

- `packages/app/src/commands/relay.ts:L67-L81` 的 `resolveRelayPassword()`；
- `apps/gateway/src/relay/relay-password.ts:L52-L102` 的 Relay site password hash。

新 Relay password join 使用 mesh root password，不能复用 Relay site password 变量语义。

### CLI 逻辑建议

Relay：

1. 规范化 URL；
2. 请求 `GET /api/relay/tenants/:id/kdf`；
3. `resolvePassword()`；
4. 用 KDF 派生 root key；
5. 签 `tmex/relay-enroll/v1` proof；
6. `POST /api/relay/enroll`，body `mode: 'join'`；
7. 解 sealed pack；
8. 下载/解密 key log；
9. replay；
10. 追加 self-admit + meta-key；
11. 持久化本地用户、K_log、tenant token；
12. 首次 uplink 携带 member sidecar。

Hub：

1. 获取 `/api/auth/mode`；
2. 用密码派生 root key；
3. 签 Hub proof；
4. 调用 `/api/hub/enrollments/by-password`；
5. 得到普通 enrollment/join token；
6. 进入现有 `performHubJoin()`。

## 7. FE

### 独立 setup wizard

文件：

- `apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx`
- `apps/fe/src/pages/settings/nodes/setup/submit.ts`
- `apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts`
- `apps/fe/src/pages/settings/nodes/setup/validation.ts`

当前行为：

- `join-hub-form.tsx:L47-L53`：只有 hubUrl、token、name 等状态；
- `L113-L129`：token 输入；
- `submit.ts:L36-L50`：调用 `SetupApi.joinHub()`；
- `validation.ts:L92-L123`：只校验 token；
- `packages/api-client/src/local/types.ts:L83-L98`：`SetupJoinRequest` 只有 hubUrl/token/name/direct/insecure；
- `packages/api-client/src/local/setup-api.ts:L80-L112`：调用本机 `/api/setup/join`；
- `packages/app/src/runtime/setup-routes.ts:L10-L55`：本机 setup HTTP API；
- `packages/app/src/runtime/setup-service.ts:L655-L745`：当前 `joinHub()` 要求 token 并调用 `performHubJoin()`。

需要增加 join method：

```text
token | password
```

并做条件校验：

- token 模式要求 token；
- password 模式要求 password；
- 两者互斥；
- Relay join 不能直接复用 Hub setup 的请求结构，除非新增统一 setup endpoint。

`becomeHub` 的现有用户冲突：

- `packages/app/src/runtime/setup-service.ts:L610-L652`；
- `L621-L638`：username 已存在时返回 `user_exists`；
- `bootstrapUserWithSelfAdmit()` 会覆盖/清空已有用户状态。

新 password join 不能误走 `becomeHub`。

### Relay enroll dialog

当前页面不是新节点 password join：

- `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:L1-L5`：现有 Relay tenant enroll；
- `L70-L103`：需要 Relay site password + 本地 root password；
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:L35-L39`：表单同时包含 `password` 和 `rootPassword`；
- `apps/fe/src/node/relay-enroll.ts:L182-L231`：通过已有 node-session/root password 注册 Relay。

这里的 `password` 是 Relay site password，不能直接改名或复用为 mesh root password，否则会混淆两种流程。

### 接入设备 side panel

文件集合：

```text
apps/fe/src/components/side-panels/connect-devices/access-addresses.test.ts
apps/fe/src/components/side-panels/connect-devices/access-addresses.ts
apps/fe/src/components/side-panels/connect-devices/command-block.tsx
apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx
apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx
apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.tsx
apps/fe/src/components/side-panels/connect-devices/guide-step.tsx
apps/fe/src/components/side-panels/connect-devices/guide-tabs.tsx
apps/fe/src/components/side-panels/connect-devices/join-command-preview.ts
apps/fe/src/components/side-panels/connect-devices/join-token.tsx
apps/fe/src/components/side-panels/connect-devices/mobile-guide.tsx
```

当前电脑加入步骤：

- `computer-guide.tsx:L27-L86`：
  1. 准备 Hub；
  2. 生成 token；
  3. 执行命令；
  4. 确认加入。
- `join-command-preview.ts:L1-L33`：生成 `tmex hub join ... --token ...`；
- `connect-devices-panel.test.tsx:L185-L204`：测试当前 token 步骤。
- 当前 i18n namespace：
  - `connectDevices.computer.join.*`
  - `packages/shared/src/i18n/locales/zh_CN.json:L128-L197`
  - `packages/shared/src/i18n/locales/en_US.json:L128-L199`

应更新为可选择：

```text
Hub 地址 + 密码
Relay 地址 + 租户编号 + 密码
```

Relay password join 不需要“生成 enrollment token”步骤；Hub password join 虽然服务端最终生成普通 enrollment token，但用户体验上应隐藏中间 token 步骤。

### tenant id 显示位置

Relay 状态已经有 tenant id：

- `apps/fe/src/node/mesh-relay.ts:L33-L53`；
- `L91-L94`：`attachedRelay`；
- `L207-L218`：hook 返回值；
- `apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:L75-L83`：传给 `RelayStrip`；
- `apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx:L41-L80`：当前未接收 tenant id。

最小改动方案：在 `RelayStrip` 增加 tenant id，并使用：

- `apps/fe/src/pages/settings/nodes/copy-feedback.tsx` 中已有 `CopyableValue`。

不建议为了显示 tenant id 修改 `local-machine-card.tsx`、`nodes-tab.tsx`、`local-uplink-tabs.tsx`，除非产品明确要求在本机卡片上显示。

## 8. 主要风险与约束

### 8.1 Relay 可回滚 sealed pack

位置：

- `apps/gateway/src/relay/relay-key-log-service.ts:L100-L175`；
- `apps/gateway/src/relay/relay-key-log-store.ts:L7-L75`。

Relay 只能验证 seq/member，不能验证 hash chain。恶意 Relay 可以返回旧的、仍然密码可解开的 pack 和旧日志前缀。

仅凭 pack 内部 `head_seq/head_hash` 无法证明“这是当前 head”。需要：

- 已加入节点提供新鲜 head；
- 单调递增的外部 signed checkpoint；
- 或协议明确接受 Relay rollback 风险。

### 8.2 root rotation 与 KEK

位置：

- `packages/shared/src/auth/encoding.ts:L178-L210`；
- `packages/shared/src/auth/key-log.ts:L395-L451`；
- `apps/gateway/src/relay/relay-tenant-store.ts:L143-L166`。

rotation 会同时改变：

- root public key；
- root epoch；
- KDF/salt；
- KEK。

旧 pack 不能在新 root 下继续被接受。pack 应绑定 root epoch 和 root public key，并规定旧 pack 的失效行为。

### 8.3 root seed 生命周期

位置：

- `packages/app/src/lib/hub-user-passwd.ts:L102-L138`；
- `apps/fe/src/auth/account-security-actions.ts:L171-L230`。

当前代码会主动清除 root seed。后台 pack refresh 没有可用密码/seed，必须在 append/rotation 的同一安全上下文中完成，或引入受控的短期 seed lease。

### 8.4 pending 节点首次 uplink

位置：

- `apps/gateway/src/mesh/relay-uplink-server.ts:L441-L473`；
- `apps/gateway/src/mesh/relay-member.ts:L97-L142`；
- `apps/gateway/src/mesh/relay-uplink-auth.ts:L31-L81`。

pending node 必须提供有效 member proof。新节点尚未有本地 admitted cert，不能直接使用现有 `relayMemberProof()`；需要把新生成的 root-signed `admit-node` 放入首次 `relay.auth` sidecar，或者先本地持久化后再连接。

### 8.5 两条自举记录的并发性

`admit-node` 和 `meta-key` 必须连续追加。现有 key log 使用 head/seq CAS：

- `apps/gateway/src/auth/user-key-service.ts:L253-L311`；
- `apps/gateway/src/auth/user-key-persistence.ts:L110-L149`。

必须使用本地写锁或原子事务，否则其它 append 可能插入两条记录之间。

### 8.6 Relay site password 与 mesh root password 混淆

位置：

- `apps/gateway/src/relay/relay-password.ts:L52-L102`；
- `packages/app/src/commands/relay.ts:L67-L81`；
- `apps/gateway/src/relay/relay-routes.ts:L75-L86`。

Relay site password 是 Relay 服务管理员密码，不是 tenant mesh root password。`mode: 'join'` 应使用 root proof，不应把 root password 发送给 Relay，也不应调用 site password 校验。

### 8.7 token reissue/kick 副作用

位置：

- `apps/gateway/src/relay/relay-routes.ts:L88-L120`；
- `L145-L150`；
- `apps/gateway/src/mesh/relay-uplink-server.ts:L105-L108`。

新 join 必须绕过 `issueTenantToken()` 和 `enforceTokenReissue()`，否则会使所有现有节点 token 失效。

### 8.8 Hub writer/standby 一致性

位置：

- `apps/gateway/src/hub/hub-runtime.ts:L764-L769`；
- `L810-L817`；
- `L942-L965`。

新 `/by-password` 虽然不需要 node-session，但仍然是创建 enrollment 的写操作。必须保留 writer ownership、standby forwarding 和 replication 语义，不能直接在任意 standby 本地写入。

### 8.9 用户/身份冲突

位置：

- `packages/app/src/runtime/setup-service.ts:L621-L638`；
- `apps/gateway/src/auth/user-key-service.ts:L729-L792`；
- `packages/app/src/commands/hub.ts:L655-L729`。

现有 join replay 会按 user id/username 处理 stale user，有覆盖派生状态的路径。新节点本地如果已有其它用户或 node identity，应明确：

- 拒绝；
- 显式 replace；
- 或将新 mesh 作为独立 profile。

不能默认覆盖。

### 8.10 CA 信任

位置：

- `packages/app/src/lib/relay-ca.ts:L27-L104`；
- `packages/app/src/commands/hub.ts:L450-L487`。

现有 pin 来源是 join token。密码 join 没有 token 携带 fingerprint，必须增加明确的 fingerprint、首次信任确认或本地安全信任机制，不能无提示降级 TLS。

### 8.11 公开 KDF 接口的租户枚举

`GET /api/relay/tenants/:id/kdf` 不认证，会暴露 tenant 是否存在。需要决定：

- 是否接受 tenant id 枚举；
- 是否对不存在 tenant 返回统一响应；
- 是否增加访问频率限制；
- 是否让 KDF endpoint 返回固定格式的无效占位数据。

### 8.12 日志和内存泄漏

敏感数据包括：

- root seed；
- KEK；
- K_log；
- tenant token；
- sealed pack 明文；
- enrollment private key。

现有 token decoder 会清理原始 buffer：

- `packages/shared/src/relay/join-token.ts:L122-L161`。

新实现也必须避免日志打印，并在使用后清除临时 buffer。

## 可并行派发的非重叠文件集合

以下集合中的“写入文件”互不重复；各任务之间通过 shared protocol/API contract 对接。

### A. Shared protocol

```text
packages/shared/src/relay/relay-pack.ts              新建
packages/shared/src/relay/relay-pack.test.ts        新建
packages/shared/src/relay/enroll-proof.ts
packages/shared/src/relay/enroll-proof.test.ts
packages/shared/src/relay/index.ts
packages/shared/src/auth/hub-enroll-proof.ts        新建
packages/shared/src/auth/hub-enroll-proof.test.ts   新建
packages/shared/src/auth/index.ts
```

### B. Relay 服务端、存储、路由

```text
apps/gateway/src/db/schema/relay.ts
apps/gateway/drizzle/00XX_relay_password_pack.sql  新建
apps/gateway/src/relay/types.ts
apps/gateway/src/relay/relay-tenant-store.ts
apps/gateway/src/relay/relay-routes.ts
apps/gateway/src/relay/relay-runtime.ts
apps/gateway/src/relay/relay-enroll-limiter.ts
apps/gateway/src/relay/relay-http.ts
apps/gateway/src/relay/relay-routes.test.ts
apps/gateway/src/relay/relay-hardening.test.ts
apps/gateway/src/relay/relay-units.test.ts
apps/gateway/src/relay/relay-test-harness.ts
apps/gateway/src/relay/relay-test-tenant.ts
apps/gateway/src/relay/integration/relay.integration.test.ts
apps/gateway/src/relay/integration/relay-membership.integration.test.ts
apps/gateway/src/relay/integration/relay-mesh-harness.ts
apps/gateway/src/relay/integration/relay-mesh-types.ts
apps/gateway/src/relay/integration/relay-tenant-ops.ts
apps/gateway/src/tunnel/access-paths.ts
apps/gateway/src/mesh/domain-access-policy.ts
apps/gateway/src/tunnel/access-entry.test.ts
apps/gateway/src/mesh/domain-access-policy.test.ts
```

### C. Gateway 本地 self-admit、pack refresh、首次 uplink

```text
apps/gateway/src/auth/user-key-service.ts
apps/gateway/src/auth/user-key-service.test.ts
apps/gateway/src/mesh/relay-wiring.ts
apps/gateway/src/mesh/relay-key-log-sync.ts
apps/gateway/src/mesh/relay-uplink-auth.ts
apps/gateway/src/mesh/relay-uplink-client.ts
apps/gateway/src/mesh/auth-key-log-routes.ts
apps/gateway/src/mesh/mesh-runtime.ts
apps/gateway/src/mesh/auth-key-log-relay.test.ts
apps/gateway/src/mesh/relay-key-log-sync.test.ts
apps/gateway/src/mesh/relay-uplink-client.test.ts
```

### D. CLI join 协议实现

```text
packages/app/src/commands/relay-password-join.ts        新建
packages/app/src/commands/relay-password-join.test.ts   新建
packages/app/src/lib/hub-password-join.ts               新建
packages/app/src/lib/hub-password-join.test.ts          新建
packages/app/src/lib/relay-keylog.ts
packages/app/src/lib/relay-store.ts
packages/app/src/lib/keylog-passkey-replay.ts
packages/app/src/lib/relay-ca.ts
```

### E. Hub 服务端 password enrollment

```text
apps/gateway/src/hub/hub-runtime.ts
apps/gateway/src/hub/hub-enroll-limiter.ts              新建
apps/gateway/src/hub/hub-runtime.test.ts
apps/gateway/src/hub/writer-forward.test.ts
apps/gateway/src/hub/hub-tokens.test.ts
```

### F. CLI 参数和命令分派

```text
packages/app/src/commands/hub.ts
packages/app/src/lib/args.ts
packages/app/src/lib/args-relay.test.ts
packages/app/src/cli-auth-entry.ts
packages/app/src/cli/help.ts
packages/app/src/i18n/index.ts
```

密码读取可直接复用，不预计需要修改：

```text
packages/app/src/lib/password.ts
packages/app/src/lib/prompt.ts
```

### G. 本地 setup API/backend

```text
packages/api-client/src/local/types.ts
packages/api-client/src/local/setup-api.ts
packages/app/src/runtime/setup-routes.ts
packages/app/src/runtime/setup-service.ts
packages/app/src/runtime/setup-service.test.ts
packages/app/src/runtime/setup-routes.test.ts
```

### H. FE setup wizard 与接入设备指南

```text
apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx
apps/fe/src/pages/settings/nodes/setup/submit.ts
apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts
apps/fe/src/pages/settings/nodes/setup/validation.ts
apps/fe/src/pages/settings/nodes/setup/validation.test.ts
apps/fe/src/pages/settings/nodes/setup/submit.test.ts
apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx
apps/fe/src/pages/settings/nodes/setup/error-messages.ts
apps/fe/src/pages/settings/nodes/setup/error-messages.test.ts
apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx
apps/fe/src/components/side-panels/connect-devices/join-command-preview.ts
apps/fe/src/components/side-panels/connect-devices/join-token.tsx
apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx
packages/shared/src/i18n/locales/zh_CN.json
packages/shared/src/i18n/locales/en_US.json
```

不要手工修改生成文件：

```text
packages/shared/src/i18n/resources.ts
packages/shared/src/i18n/types.ts
```

### I. FE Relay tenant id 展示

```text
apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx
apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx
apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx
```

建议优先在 Relay strip 显示并复制 tenant id，因此通常无需修改：

```text
apps/fe/src/pages/settings/nodes/local-machine-card.tsx
apps/fe/src/pages/settings/nodes/nodes-tab.tsx
apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.tsx
```

### 当前不建议直接改造为新 password join 的文件

这些文件是已有“节点注册 Relay”或“生成 join token”流程，不能直接当作新节点 password join：

```text
apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx
apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts
apps/fe/src/node/relay-enroll.ts
packages/api-client/src/relay/tenant-api.ts
apps/fe/src/node/enrollment.ts
apps/fe/src/node/relay-join.ts
```

它们可以作为现有 API、UI 文案和 proof 使用方式的参考。