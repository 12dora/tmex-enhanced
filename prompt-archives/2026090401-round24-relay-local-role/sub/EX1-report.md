# tmex 后端实现地图

只读完成，未修改任何文件。一个关键结论是：`/api/local/*` 不在 `apps/gateway/src/api`，而在 `packages/app/src/runtime`。

角色定义位于 [`packages/shared/src/roles.ts:1`](/Users/konata/code/tmex-r24/packages/shared/src/roles.ts:1)，当前支持：

`standalone`、`node`、`hub,node`、`relay`、`relay,node`；`hub` 与 `relay` 不能组合。

## 派单边界

为避免并行任务编辑同一文件：

- A1–A4 作为一个 `A-ROLE` 任务。
- B2/B3/B4/B6 中的 [`apps/gateway/src/mesh/relay-routes.ts:70`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:70) 与对应测试归一个 `B-RELAY-ROUTES` owner。
- B1 负责迁移注册文件 [`apps/gateway/src/db/managed-migrations.ts:7`](/Users/konata/code/tmex-r24/apps/gateway/src/db/managed-migrations.ts:7) 与 `_journal.json`；B5 只新增自己的 SQL 迁移。
- 生成文件 `packages/shared/src/i18n/resources.ts`、`types.ts` 不手工编辑。

---

# A. 本机角色切换

## A1. 当前 standalone → hub/node 链路

### standalone → hub,node

网页请求：

- `POST /api/setup/hub`
- 路由入口：[`packages/app/src/runtime/setup-routes.ts:10`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-routes.ts:10)
- 仅 `isStandaloneRoles(deps.roles)` 可用：[`packages/app/src/runtime/setup-routes.ts:18`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-routes.ts:18)

执行：

1. `becomeHub()` 校验 URL、用户名、密码。
2. `ensureNodeIdentity()` 创建本机节点身份。
3. `bootstrapUserWithSelfAdmit()` 创建本机用户并自签 `admit-node`。
4. 写入 `TMEX_ROLES=hub,node`、`TMEX_HUB_PUBLIC_URL`。
5. 成功后调度重启。

核心代码：

- 校验：[`packages/app/src/runtime/setup-service.ts:205`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:205)、[`packages/app/src/runtime/setup-service.ts:211`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:211)、[`packages/app/src/runtime/setup-service.ts:228`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:228)
- DB 初始化与环境变量写入：[`packages/app/src/runtime/setup-service.ts:610`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:610)
- 写入 `TMEX_ROLES`：[`packages/app/src/runtime/setup-service.ts:640`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:640)
- 环境文件路径：production 为安装目录下的 `app.env`：[`packages/app/src/runtime/setup-service.ts:406`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:406)

### standalone → node

网页请求：

- `POST /api/setup/join`
- 路由入口：[`packages/app/src/runtime/setup-routes.ts:46`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-routes.ts:46)

执行：

1. 校验 join token、节点名、Hub URL。
2. 先写临时环境文件：
   - `TMEX_ROLES=node`
   - `TMEX_HUB_URL=<hubUrl>`
   - `TMEX_HUB_PUBLIC_URL=`
3. 调用 [`performHubJoin()`](/Users/konata/code/tmex-r24/packages/app/src/commands/hub.ts:489)，完成证书、节点身份、密钥日志提交。
4. 成功后将临时环境文件提升为正式环境文件。
5. 调度重启。

核心代码：

- 参数校验与 staged env：[`packages/app/src/runtime/setup-service.ts:655`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:655)
- 写入 `TMEX_ROLES=node`：[`packages/app/src/runtime/setup-service.ts:677`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:677)
- 执行 join：[`packages/app/src/runtime/setup-service.ts:700`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:700)
- 提升环境文件：[`packages/app/src/runtime/setup-service.ts:722`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:722)

### 重启机制

网页流程不是调用 CLI 的 `restartService()`。统一路径是：

- `withSetupTransition()` 调用 `scheduleRestart()`：[`packages/app/src/runtime/setup-service.ts:325`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:325)
- 运行时设置 `restartRequested`，延迟执行 shutdown：[`packages/app/src/runtime/assemble.ts:416`](/Users/konata/code/tmex-r24/packages/app/src/runtime/assemble.ts:416)
- server 以退出码 0 退出，交给 supervisor/service manager 拉起：[`packages/app/src/runtime/server.ts:59`](/Users/konata/code/tmex-r24/packages/app/src/runtime/server.ts:59)

`apps/gateway/src/system/*` 不负责网页角色切换；`restartService()` 仅由 CLI 升级/运维路径使用：[`packages/app/src/lib/service.ts:389`](/Users/konata/code/tmex-r24/packages/app/src/lib/service.ts:389)。

### A1 修改文件

`A-ROLE` 独占文件：

- `packages/app/src/runtime/local-routes.ts`
- `packages/app/src/runtime/setup-routes.ts`
- `packages/app/src/runtime/setup-service.ts`
- `packages/app/src/runtime/membership-reset.ts`
- `packages/app/src/runtime/assemble-routes.ts`
- `packages/app/src/runtime/assemble.ts`
- `apps/gateway/src/auth/mesh-membership-store.ts`
- `apps/gateway/src/relay/relay-config-store.ts`
- `apps/gateway/src/relay/relay-password.ts`
- `packages/app/src/runtime/local-routes.test.ts`
- `packages/app/src/runtime/setup-routes.test.ts`
- `packages/app/src/runtime/setup-service.test.ts`
- `packages/app/src/runtime/membership-reset.test.ts`
- `packages/app/src/runtime/assemble.test.ts`
- `apps/gateway/src/auth/mesh-membership-store.test.ts`

---

## A2. CLI init relay 与网页等价方案

### CLI 当前行为

角色与公网地址解析：

- [`packages/app/src/commands/init.ts:190`](/Users/konata/code/tmex-r24/packages/app/src/commands/init.ts:190)
- relay 角色会强制 `hubUrl=''`：[`packages/app/src/commands/init.ts:204`](/Users/konata/code/tmex-r24/packages/app/src/commands/init.ts:204)
- 非交互模式必须提供 `--relay-public-url`：[`packages/app/src/commands/init.ts:227`](/Users/konata/code/tmex-r24/packages/app/src/commands/init.ts:227)

环境变量生成：

- Hub 默认键：[`packages/app/src/lib/install.ts:69`](/Users/konata/code/tmex-r24/packages/app/src/lib/install.ts:69)
- Relay 默认键：[`packages/app/src/lib/install.ts:90`](/Users/konata/code/tmex-r24/packages/app/src/lib/install.ts:90)
- 最终环境变量合并：[`packages/app/src/lib/install.ts:103`](/Users/konata/code/tmex-r24/packages/app/src/lib/install.ts:103)
- `runInit()` 写入 `app.env` 并启动服务：[`packages/app/src/commands/init.ts:425`](/Users/konata/code/tmex-r24/packages/app/src/commands/init.ts:425)

`tmex init --role relay` 实际写入：

```text
TMEX_ROLES=relay
TMEX_HUB_URL=
TMEX_HUB_PUBLIC_URL=
TMEX_PEER_PORT=<默认或参数>
TMEX_STUN_SERVERS=<默认或参数>
TMEX_RELAY_PUBLIC_URL=<--relay-public-url>
TMEX_RELAY_ADMIN_TOKEN=<随机 32 字节 base64url>
```

当前 `runInit()` 没有传入 `relayAdminToken`，因此由 [`relayEnvDefaults()`](/Users/konata/code/tmex-r24/packages/app/src/lib/install.ts:90) 生成。

注意：relay 管理 token 与 relay 运营口令不是同一个东西。

- 管理 token：`TMEX_RELAY_ADMIN_TOKEN`，用于本机 `tmex relay status/passwd/...`。
- 运营口令：数据库 `relay_config.password_hash`，用于租户 `relay enroll`。
- 运营口令通过 `POST /api/relay/password` 设置：[`apps/gateway/src/relay/relay-admin-routes.ts:69`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-admin-routes.ts:69)
- 密码使用 Argon2id 存储：[`apps/gateway/src/relay/relay-password.ts:52`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-password.ts:52)
- CLI `tmex relay passwd` 只把密码发到该接口：[`packages/app/src/commands/relay-admin.ts:191`](/Users/konata/code/tmex-r24/packages/app/src/commands/relay-admin.ts:191)

启动时若缺少管理 token，RelayRuntime 会生成并在 production 尝试回写 `app.env`：

- [`apps/gateway/src/relay/relay-admin-auth.ts:38`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-admin-auth.ts:38)
- [`packages/app/src/runtime/assemble-relay.ts:34`](/Users/konata/code/tmex-r24/packages/app/src/runtime/assemble-relay.ts:34)

### 当前是否有网页 relay 角色切换路由

没有。

现有路由只有：

- `/api/setup/precheck`
- `/api/setup/hub`
- `/api/setup/join`

以及：

- `/api/local/status`
- `/api/local/leave`
- `/api/local/direct`

纯 `relay` 本身没有用户、mesh、前端，启动后前端请求统一 404：[`packages/app/src/runtime/assemble.ts:329`](/Users/konata/code/tmex-r24/packages/app/src/runtime/assemble.ts:329)。

### 建议网页接口

推荐新增：

```text
POST /api/setup/relay
```

请求体：

```json
{
  "role": "relay" | "relay,node",
  "relayPublicUrl": "https://relay.example",
  "relayPassword": "optional",
  "username": "required for relay,node",
  "password": "required for relay,node"
}
```

行为：

- 写入 `TMEX_ROLES`。
- 写入 `TMEX_RELAY_PUBLIC_URL`。
- 清空 `TMEX_HUB_URL`、`TMEX_HUB_PUBLIC_URL`。
- 保留或生成 `TMEX_RELAY_ADMIN_TOKEN`。
- `relayPassword` 只 hash 后写入 `relay_config.password_hash`，绝不写入 `app.env`。
- `relay,node` 还要创建本机 node identity/user。
- 使用现有 `withSetupTransition()`、`quiesceMesh()`、`scheduleRestart()`。
- 推荐网页把目标设为 `relay,node`，因为纯 `relay` 重启后没有网页管理入口。

完整角色矩阵则应再提供：

```text
POST /api/local/role
```

统一接收 `targetRole`，而不是继续让 `/api/local/leave` 只隐式转成 standalone。

---

## A3. 角色转换矩阵

状态定义：

- `M`：本机 mesh 成员状态，包括 users、node identity、certs、sessions、nodes、peer_cache、hub trust、mesh relay secrets。
- `R`：relay 运营者状态，包括 `relay_config`、`relay_tenants`、`relay_nodes`、`relay_enrollments`、`relay_key_log`。
- `D`：停止当前 uplink/hub，解除运行态连接。
- `L`：清除全部 mesh 成员状态。
- `R+`：保留 relay 运营者状态。
- `R-`：清除 relay 运营者状态。
- `J`：执行 Hub join。
- `H`：执行 Hub bootstrap。
- `N`：保留或创建本机 node/user 状态。
- 成功后都需要 staged env + restart。

| 当前 \ 目标 | standalone | node | hub,node | relay | relay,node |
|---|---|---|---|---|---|
| standalone | 无操作 | `J` | `H` | `R+` | `R+ + N` |
| node | `L` | 无操作 | `D + H` | `L + R+` | `D + R+` |
| hub,node | `L` | `D + J`，需新的 Hub URL | 无操作 | `L + R+` | `D + R+`，保留 node |
| relay | `D + R-` | `D + R- + J` | `D + R- + H` | 无操作 | `R+ + N` |
| relay,node | `D + L + R-` | `D + R- + J` | `D + R- + H` | `D + L + R+` | 无操作 |

当前实现限制：

- [`isLeavableRoleName()`](/Users/konata/code/tmex-r24/packages/app/src/runtime/membership-reset.ts:21) 只接受 `node`、`hub,node`、`relay,node`。
- 纯 `relay` 在 [`/api/local/leave`](/Users/konata/code/tmex-r24/packages/app/src/runtime/local-routes.ts:35) 直接返回 400 `not_member`。
- `leaveMesh()` 固定写成 standalone：[`packages/app/src/runtime/membership-reset.ts:37`](/Users/konata/code/tmex-r24/packages/app/src/runtime/membership-reset.ts:37)
- `MeshMembershipStore.clearAll()` 只清 mesh 表，不清 `relay_*` 运营者表：[`apps/gateway/src/auth/mesh-membership-store.ts:21`](/Users/konata/code/tmex-r24/apps/gateway/src/auth/mesh-membership-store.ts:21)
- 因此当前 `relay,node → standalone` 会遗留 `relay_config`、`relay_tenants` 等数据库状态；同时当前 leave 也不会清除 `TMEX_RELAY_PUBLIC_URL` 和 `TMEX_RELAY_ADMIN_TOKEN`，只覆盖 Hub 键。

最小后端修改：

```json
{
  "expectedRole": "relay,node",
  "targetRole": "relay"
}
```

具体需要：

1. 扩展 `LeaveMeshInput` 增加 `targetRole`。
2. 将 `clearAll()` 拆成：
   - `clearMeshMembership()`
   - `clearRelayOperatorState()`
   - 或 `clearAll({ keepRelayOperatorState })`
3. `targetRole` 含 relay 时保留 `R`，否则清除 `R`。
4. 目标为 relay 时写入 relay 环境键并清空 Hub 键。
5. 纯 relay 的转换不能继续依赖 node-session；需要允许本机可信调用或管理 token 调用。
6. `/api/local/role` 负责真正的跨角色转换；`/api/local/leave` 最小只需要支持 `targetRole=standalone|relay`。

---

## A4. `/api/local/status` 当前响应

当前 `LocalStatus` 只有：

- `role`
- `nodeEnv`
- `hubUrl`
- `hubPublicUrl`
- `direct`
- `tls`

定义：[`packages/app/src/runtime/setup-service.ts:67`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:67)

生成：[`packages/app/src/runtime/setup-service.ts:462`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:462)

目前没有：

- relay public URL
- relay tenant count
- relay nodes online/current
- relay password 是否设置
- relay quota

建议增加：

```json
{
  "relay": {
    "publicUrl": "https://relay.example",
    "tenantCount": 3,
    "nodesOnline": 5,
    "currentNodes": 8,
    "hasPassword": true
  }
}
```

不要暴露：

- `TMEX_RELAY_ADMIN_TOKEN`
- relay password hash
- tenant token
- tenant root key

租户侧的 `/api/mesh/relay/status` 仍负责返回本机作为租户接入上级 relay 的状态；本机 relay 运营状态应从 `RelayRuntime.tenants`、`registry`、`configStore` 读取：

- [`apps/gateway/src/relay/relay-runtime.ts:116`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-runtime.ts:116)
- tenant count：[`apps/gateway/src/relay/relay-tenant-store.ts:82`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-tenant-store.ts:82)

---

# B. Round-23 遗留

## B1. `peer_cache` 缺 `version`

### 当前代码

表结构没有 `version`：

[`apps/gateway/src/db/schema/mesh.ts:54`](/Users/konata/code/tmex-r24/apps/gateway/src/db/schema/mesh.ts:54)

类型没有 `version`：

[`apps/gateway/src/auth/user-store.ts:113`](/Users/konata/code/tmex-r24/apps/gateway/src/auth/user-store.ts:113)

CRUD 写入/转换没有 `version`：

- [`apps/gateway/src/auth/user-store.ts:464`](/Users/konata/code/tmex-r24/apps/gateway/src/auth/user-store.ts:464)
- [`apps/gateway/src/auth/user-store.ts:863`](/Users/konata/code/tmex-r24/apps/gateway/src/auth/user-store.ts:863)

relay 状态块已经有版本：

[`packages/shared/src/relay/blobs.ts:20`](/Users/konata/code/tmex-r24/packages/shared/src/relay/blobs.ts:20)

但 relay list 当前丢弃：

- fallback 固定返回 `version:null`：[`apps/gateway/src/mesh/relay-node-list.ts:49`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-node-list.ts:49)
- 解密状态块时没有写入 cache：[`apps/gateway/src/mesh/relay-node-list.ts:81`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-node-list.ts:81)

Hub 路径也需要同步写入：

[`apps/gateway/src/mesh/uplink-client.ts:583`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/uplink-client.ts:583)

### 最小设计

- 新增 nullable `peer_cache.version TEXT`。
- `PeerCacheRecord`、`UpsertPeerCacheInput`、`toPeer()` 增加 `version`。
- `relayListToNodeList()` 写入 `blob.version`。
- cache fallback 返回 `peer.version`。
- Hub 的 `persistAdmittedPeers()` 与 `persistHubPeer()` 写入 node version。
- 新迁移编号为 `0041`；当前迁移注册最新为 `0040`：[`apps/gateway/src/db/managed-migrations.ts:46`](/Users/konata/code/tmex-r24/apps/gateway/src/db/managed-migrations.ts:46)

建议 SQL：

```sql
ALTER TABLE peer_cache ADD COLUMN version TEXT;
```

### 修改文件

B1 独占文件：

- `apps/gateway/src/db/schema/mesh.ts`
- `apps/gateway/src/auth/user-store.ts`
- `apps/gateway/src/mesh/relay-node-list.ts`
- `apps/gateway/src/mesh/uplink-client.ts`
- `apps/gateway/drizzle/0041_peer_cache_version.sql`
- `apps/gateway/src/db/managed-migrations.ts`
- `apps/gateway/drizzle/meta/_journal.json`
- `apps/gateway/src/auth/user-store.test.ts`
- `apps/gateway/src/auth/schema.migration.test.ts`
- `apps/gateway/src/mesh/relay-uplink-client.test.ts`
- `apps/gateway/src/mesh/uplink-client.test.ts`

### 测试

- relay 状态块版本写入 `peer_cache.version`。
- fallback 使用 cache 中的旧版本。
- Hub node list 仍写入版本。
- migration 后 `PRAGMA table_info(peer_cache)` 包含 `version`。
- 版本门禁读取 relay-mode peer cache 时不再把未知版本当成 null。

---

## B2. Enrollment 扇出到全部 relay

### 当前代码

`join-material` 目前只挑一台 relay：

[`apps/gateway/src/mesh/relay-routes.ts:349`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:349)

返回的 `relays` 只有一个元素，并保留顶层兼容字段：

[`apps/gateway/src/mesh/relay-routes.ts:360`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:360)

`createEnrollment()` 只调用当前 attached relay：

[`apps/gateway/src/mesh/relay-routes.ts:373`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:373)

底层 `RelayUplinkClient.createEnrollment()` 也只通过当前认证连接发送：

[`apps/gateway/src/mesh/relay-uplink-client.ts:292`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-uplink-client.ts:292)

r3 凭据布局本身已经是逐 relay 的：

- entry 类型：[`packages/shared/src/relay/join-token.ts:29`](/Users/konata/code/tmex-r24/packages/shared/src/relay/join-token.ts:29)
- 编码布局：[`packages/shared/src/relay/join-token.ts:116`](/Users/konata/code/tmex-r24/packages/shared/src/relay/join-token.ts:116)

但 CA fingerprint 目前是一个全局后缀：

- [`packages/shared/src/relay/join-token.ts:45`](/Users/konata/code/tmex-r24/packages/shared/src/relay/join-token.ts:45)
- [`packages/app/src/commands/relay-join.ts:232`](/Users/konata/code/tmex-r24/packages/app/src/commands/relay-join.ts:232)
- 所有 failover entry 都使用同一个 fingerprint：[`packages/app/src/commands/relay-join.ts:260`](/Users/konata/code/tmex-r24/packages/app/src/commands/relay-join.ts:260)

### 最小设计

1. 创建一个 enrollment 时生成同一个：
   - enrollment id
   - enroll public key
   - authorization bytes/signature
   - expiry
2. 对 `mesh_relays` 中每个 relay 执行 `relay.enroll.create`。
3. 当前只有 attached relay 有 uplink，因此需要：
   - 为每个 relay 临时建立独立认证控制连接，或
   - 增加 relay-side 管理/控制 HTTP API。
4. 任一 relay 创建失败时，不应发出不完整的 join 串；需要部分失败清理或明确返回失败。
5. `join-material` 返回全部 relay：

```json
{
  "logKey": "...",
  "relays": [
    { "url": "...", "tenantId": "...", "token": "..." },
    { "url": "...", "tenantId": "...", "token": "..." }
  ]
}
```

6. CA fingerprint 必须逐 entry 保存。不要直接给现有 r3 尾部追加多个 fingerprint，因为旧 decoder 会在 `offset !== raw.byteLength` 时拒绝：[`packages/shared/src/relay/join-token.ts:215`](/Users/konata/code/tmex-r24/packages/shared/src/relay/join-token.ts:215)。推荐：
   - 保留旧 r3；
   - 新增带逐 entry CA 的 r4；或
   - 明确定义 r3 extension marker。

### 修改文件

B2 独占文件：

- `apps/gateway/src/mesh/relay-routes.ts`（B-RELAY-ROUTES owner）
- `apps/gateway/src/mesh/relay-enrollment-fanout.ts`（建议新增）
- `packages/shared/src/relay/join-token.ts`
- `packages/app/src/commands/relay-join.ts`
- `apps/gateway/src/mesh/relay-routes.test.ts`（B-RELAY-ROUTES owner）
- `apps/gateway/src/mesh/relay-enrollment-fanout.test.ts`（建议新增）
- `packages/shared/src/relay/join-token.test.ts`
- `packages/app/src/commands/relay-join.test.ts`
- `apps/gateway/src/relay/integration/relay-multi-relay.integration.test.ts`（建议新增）

### 测试

- 两台 relay 都出现同一 enrollment。
- 任一 relay redeem 成功。
- join 串包含每台 relay 自己的 tenant id/token。
- 不同 CA fingerprint 的 relay failover 使用各自 pin。
- 任一 relay 扇出失败时不生成不完整 join 串。
- 旧 r3 单 fingerprint 仍可解码。

---

## B3. `tmex relay list/leave` 的本机密码与 status 免密

### 当前代码

CLI 已经会打开本机 node-session，并提示输入本机用户密码：

[`packages/app/src/lib/relay-session.ts:124`](/Users/konata/code/tmex-r24/packages/app/src/lib/relay-session.ts:124)

`relay list` 与 `relay leave` 都通过该 session：

- [`packages/app/src/commands/relay.ts:222`](/Users/konata/code/tmex-r24/packages/app/src/commands/relay.ts:222)
- [`packages/app/src/commands/relay.ts:276`](/Users/konata/code/tmex-r24/packages/app/src/commands/relay.ts:276)

当前 `/api/mesh/relay/*` 所有路由都经过 `requireSession()`：

[`apps/gateway/src/mesh/relay-routes.ts:79`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:79)

Round-20 已有可信本机判断：

- [`apps/gateway/src/mesh/client-source.ts:23`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/client-source.ts:23)
- forwarded request 会重新打上 `x-tmex-client-source: local`：[`apps/gateway/src/mesh/forwarder.ts:871`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/forwarder.ts:871)

但 `waivesPasskeySecondFactor()` 只影响通行密钥二次验证，不是一般 session 免密：

[`apps/gateway/src/mesh/client-source.ts:45`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/client-source.ts:45)

### 最小设计

只对：

```text
GET /api/mesh/relay/status
```

增加可信本机免密门：

1. `MeshHttpRuntime.localUiGuard()` 对该路径调用 `isTrustedLocalClient(req)`，通过则不返回 401。
2. `RelayRoutes.handle()` 对同一个 GET status 路由使用同一判断，绕过 `requireSession()`。
3. 不放行：
   - `POST /leave/prepare`
   - `POST /enroll`
   - `POST /enrollments`
   - `POST /meta-key/prepare`
4. 不信任浏览器直接提交的 `x-tmex-client-source`。
5. 不把 `isPeerRequest()` 当成本机可信。

### 修改文件

B3 独占文件：

- `apps/gateway/src/mesh/mesh-http.ts`
- `apps/gateway/src/mesh/mesh-http.test.ts`

共享逻辑由 B-RELAY-ROUTES owner 修改：

- `apps/gateway/src/mesh/relay-routes.ts`
- `apps/gateway/src/mesh/relay-routes.test.ts`

### 测试

- loopback/内网 GET status 无密码成功。
- 公网客户端 GET status 仍 401。
- peer 转发请求不能伪造本机免密。
- POST leave/enroll 仍要求 node-session。
- 代理头规则与 Round-20 测试保持一致。

---

## B4. RTT 与当前节点数

### RTT 当前代码

`/api/mesh/relay/status` 固定返回 `rttMs:null`：

[`apps/gateway/src/mesh/relay-routes.ts:117`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:117)

relay uplink 已有 heartbeat ping/pong：

- 收到 pong：[`apps/gateway/src/mesh/relay-uplink-client.ts:366`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-uplink-client.ts:366)
- 发送 ping：[`apps/gateway/src/mesh/relay-uplink-client.ts:542`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-uplink-client.ts:542)

Hub pool 的 RTT 只测 HTTP healthz：

[`apps/gateway/src/mesh/uplink-pool.ts:1381`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/uplink-pool.ts:1381)

relay candidate 没有 `hubNodeId`，不会进入该套 nearest RTT 诊断。

### 节点数当前代码

relay redeem 的配额判断使用：

```text
countActiveNodes(tenantId)
```

其中 pending + admitted 计数，revoked 不计：

- [`apps/gateway/src/relay/relay-tenant-store.ts:238`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-tenant-store.ts:238)
- [`apps/gateway/src/relay/relay-routes.ts:275`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-routes.ts:275)

`GET /api/relay/status` 并非完全没有节点数：

- 每个 tenant 已有 `nodes`：[`apps/gateway/src/relay/relay-admin-routes.ts:41`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-admin-routes.ts:41)
- 但 `totals` 只有 `nodesOnline`，没有总的当前配额占用数：[`apps/gateway/src/relay/relay-admin-routes.ts:24`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-admin-routes.ts:24)
- API 类型同样缺少 `RelayTotals.nodes`：[`packages/api-client/src/relay/admin-api.ts:56`](/Users/konata/code/tmex-r24/packages/api-client/src/relay/admin-api.ts:56)
- 租户侧 `/api/mesh/relay/status` 只有 quota 与 `nodesViaRelay`：[`packages/api-client/src/relay/tenant-api.ts:38`](/Users/konata/code/tmex-r24/packages/api-client/src/relay/tenant-api.ts:38)

### 最小设计

RTT：

- 在 `RelayUplinkClient.startHeartbeat()` 发送 ping 前记录 `scheduler.now()`。
- 匹配 pong 时计算差值。
- 连接重置时清空。
- status 返回 attached relay 的 RTT；standby relay 没有实际连接时仍可为 null。
- 可采用 latest 或 EWMA。

节点数：

- relay server 在 `auth.ok` 和节点状态变化时计算 `countActiveNodes(tenantId)`。
- 扩展 `relay.quota` 控制消息，例如新增 `currentNodes`。
- 客户端保存并由 `/api/mesh/relay/status` 返回。
- `/api/relay/status` 增加：
  - tenant 行继续使用已有 `nodes`；
  - `totals.nodes` 作为所有租户当前占用总数。
- 不使用 `nodesOnline` 代替配额占用数。

### 修改文件

B4 独占文件：

- `apps/gateway/src/mesh/relay-uplink-client.ts`
- `apps/gateway/src/relay/relay-uplink-server.ts`
- `packages/shared/src/relay/codec.ts`
- `apps/gateway/src/relay/relay-admin-routes.ts`
- `packages/api-client/src/relay/admin-api.ts`
- `packages/api-client/src/relay/tenant-api.ts`
- `apps/gateway/src/mesh/relay-uplink-client.test.ts`
- `apps/gateway/src/relay/relay-uplink.test.ts`
- `apps/gateway/src/relay/relay-admin.test.ts`
- `packages/shared/src/relay/codec.test.ts`

`/api/mesh/relay/status` 响应字段由 B-RELAY-ROUTES owner 修改：

- `apps/gateway/src/mesh/relay-routes.ts`
- `apps/gateway/src/mesh/relay-routes.test.ts`

---

## B5. Relay 模式改名其他节点：`rename-node` keylog

### Hub 当前改名

Hub API 当前直接：

1. 校验用户与节点。
2. 更新 `nodes.name`。
3. 更新内存 registry。
4. 广播 node list。
5. 如果是自身，同步本机 site name。

代码：

[`apps/gateway/src/hub/hub-runtime.ts:873`](/Users/konata/code/tmex-r24/apps/gateway/src/hub/hub-runtime.ts:873)

数据库 patch：

[`apps/gateway/src/hub/node-persistence.ts:5`](/Users/konata/code/tmex-r24/apps/gateway/src/hub/node-persistence.ts:5)

广播路径：

[`apps/gateway/src/hub/hub-runtime.ts:880`](/Users/konata/code/tmex-r24/apps/gateway/src/hub/hub-runtime.ts:880)

Relay 文档明确说明当前不支持改其他节点：

[`docs/relay/2026090304-relay-role.md:461`](/Users/konata/code/tmex-r24/docs/relay/2026090304-relay-role.md:461)

### 现有 keylog 结构

类型、签名者矩阵：

- [`packages/shared/src/auth/encoding.ts:29`](/Users/konata/code/tmex-r24/packages/shared/src/auth/encoding.ts:29)
- [`packages/shared/src/auth/key-log.ts:85`](/Users/konata/code/tmex-r24/packages/shared/src/auth/key-log.ts:85)
- [`packages/shared/src/auth/key-log.ts:101`](/Users/konata/code/tmex-r24/packages/shared/src/auth/key-log.ts:101)

relay 记录：

- `set-relays` / `meta-key`
- min version `1.1.23`
- `allowForce:false`

定义与应用：

- [`packages/shared/src/auth/relay-records.ts:8`](/Users/konata/code/tmex-r24/packages/shared/src/auth/relay-records.ts:8)
- [`packages/shared/src/auth/relay-records.ts:154`](/Users/konata/code/tmex-r24/packages/shared/src/auth/relay-records.ts:154)
- applier 注册：[`packages/shared/src/auth/key-log.ts:548`](/Users/konata/code/tmex-r24/packages/shared/src/auth/key-log.ts:548)

### `rename-node` 设计

建议 payload：

```text
node_id: bytes(16)
name: string
```

要求：

- UTF-8、长度上限、trim/空字符串校验。
- 签名者建议 `root` 与 `passkey`，与 `admit-node` 等节点管理记录一致。
- `minVersion` 应是首次包含此记录实现的版本；若下一版实现，应使用 `1.1.24`，不能直接复用 `MIN_RELAY_RECORD_VERSION=1.1.23`。
- `allowForce:false`。
- `user_key_log.type` 的 SQLite check constraint 必须增加 `rename-node`；当前约束位于：
  - [`apps/gateway/src/db/schema/users-auth.ts:69`](/Users/konata/code/tmex-r24/apps/gateway/src/db/schema/users-auth.ts:69)
  - [`apps/gateway/drizzle/0040_mesh_relay.sql:22`](/Users/konata/code/tmex-r24/apps/gateway/drizzle/0040_mesh_relay.sql:22)

应用路径：

1. `packages/shared/src/auth/encoding.ts` 增加类型、schema、编解码。
2. `packages/shared/src/auth/index.ts` 导出。
3. `packages/shared/src/auth/key-log.ts` 增加 signer/minVersion/applier。
4. `apps/gateway/src/auth/user-key-persistence.ts` 在记录应用时更新：
   - `nodes.name`
   - `peer_cache.name`
5. 如果目标是本机，更新 `node_identity.name`，并同步站点名。
6. `apps/gateway/src/mesh/mesh-runtime.ts` 的 `onApplied` 回调触发 node event。
7. 复用已有 `NODE_EVENT` 的 `nodeId/name` 字段：
   - 后端编码：[`apps/gateway/src/mesh/mesh-routes.ts:529`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/mesh-routes.ts:529)
   - 后端 node list event：[`apps/gateway/src/mesh/node-list-apply.ts:144`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/node-list-apply.ts:144)
   - 前端已有 name 投影：[`apps/fe/src/node/mesh-nodes.ts:76`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-nodes.ts:76)

当前 keylog 落库与应用入口：

- [`apps/gateway/src/auth/user-key-persistence.ts:110`](/Users/konata/code/tmex-r24/apps/gateway/src/auth/user-key-persistence.ts:110)
- [`apps/gateway/src/auth/user-key-persistence.ts:151`](/Users/konata/code/tmex-r24/apps/gateway/src/auth/user-key-persistence.ts:151)
- [`apps/gateway/src/mesh/mesh-runtime.ts:572`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/mesh-runtime.ts:572)

### 修改文件

B5 独占文件：

- `packages/shared/src/auth/encoding.ts`
- `packages/shared/src/auth/index.ts`
- `packages/shared/src/auth/key-log.ts`
- `apps/gateway/src/db/schema/users-auth.ts`
- `apps/gateway/src/auth/key-log-store.ts`
- `apps/gateway/src/auth/user-key-persistence.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/mesh/node-list-apply.ts`
- `apps/gateway/drizzle/0042_rename_node_keylog.sql`
- `packages/shared/src/auth/encoding.test.ts`
- `packages/shared/src/auth/key-log.test.ts`
- `apps/gateway/src/auth/user-key-persistence.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.test.ts`
- `apps/gateway/src/mesh/node-list-apply.test.ts`

迁移注册由 B1 的 migration owner 统一修改：

- `apps/gateway/src/db/managed-migrations.ts`
- `apps/gateway/drizzle/meta/_journal.json`

### 测试

- root/passkey 两种签名都能生成并应用。
- 低版本节点被 `minVersion` 门禁拦截。
- `nodes` 与 `peer_cache` 都更新名称。
- relay mode 下其他节点收到 keylog 后产生 `NODE_EVENT(name)`。
- 本机改名同步 `node_identity.name` 与 site name。
- SQLite migration 接受 `rename-node`。

---

## B6. 删除 join-material 顶层兼容字段

### 当前代码

服务端仍返回：

```json
{
  "logKey": "...",
  "relays": [...],
  "tenantId": "...",
  "token": "..."
}
```

代码：

[`apps/gateway/src/mesh/relay-routes.ts:364`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:364)

集成 harness 仍直接读取顶层字段：

- 类型：[`apps/gateway/src/relay/integration/relay-tenant-ops.ts:146`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/integration/relay-tenant-ops.ts:146)
- 写入 relay store：[`apps/gateway/src/relay/integration/relay-tenant-ops.ts:230`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/integration/relay-tenant-ops.ts:230)
- enrollment lookup：[`apps/gateway/src/relay/integration/relay-tenant-ops.ts:317`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/integration/relay-tenant-ops.ts:317)
- redeem：[`apps/gateway/src/relay/integration/relay-tenant-ops.ts:333`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/integration/relay-tenant-ops.ts:333)

测试也依赖顶层字段：

- [`apps/gateway/src/relay/integration/relay.integration.test.ts:213`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/integration/relay.integration.test.ts:213)
- [`apps/gateway/src/relay/integration/relay-membership.integration.test.ts:168`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/integration/relay-membership.integration.test.ts:168)
- [`apps/gateway/src/mesh/relay-routes.test.ts:489`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.test.ts:489)

### 最小设计

服务端只返回：

```json
{
  "logKey": "...",
  "relays": [
    { "url": "...", "tenantId": "...", "token": "..." }
  ]
}
```

harness 改为：

```ts
const primary = material.relays[0];
const tenantId = primary.tenantId;
const token = primary.token;
```

删除：

- 顶层 `tenantId`
- 顶层 `token`
- 对应 harness 类型与断言

### 修改文件

B6 独占文件：

- `apps/gateway/src/relay/integration/relay-tenant-ops.ts`
- `apps/gateway/src/relay/integration/relay.integration.test.ts`
- `apps/gateway/src/relay/integration/relay-membership.integration.test.ts`

服务端字段删除由 B-RELAY-ROUTES owner 处理：

- `apps/gateway/src/mesh/relay-routes.ts`
- `apps/gateway/src/mesh/relay-routes.test.ts`

---

# C. Canonical v1.1 版本门禁

## C1. 实际互操作下限是 1.1.23

当前常量仍为：

[`packages/shared/src/ws-borsh/canonical-version.ts:11`](/Users/konata/code/tmex-r24/packages/shared/src/ws-borsh/canonical-version.ts:11)

```ts
CANONICAL_V11_MIN_PEER_VERSION = '1.1.22'
```

但客户端实际要求三项同时满足：

- capability `canonical-state-v1.1`
- 版本达到门槛
- frame size 达标

代码：

[`packages/ws-client/src/client.ts:427`](/Users/konata/code/tmex-r24/packages/ws-client/src/client.ts:427)

`canonical-state-v1.1` 定义于：

[`packages/shared/src/capabilities.ts:6`](/Users/konata/code/tmex-r24/packages/shared/src/capabilities.ts:6)

由于 1.1.22 没有该 capability，真实互操作下限是 1.1.23。

### 必须修改的常量/测试/文档

核心实现：

- `packages/shared/src/ws-borsh/canonical-version.ts:11`

测试：

- `packages/shared/src/ws-borsh/canonical-version.test.ts:12`
- `apps/gateway/src/ws/canonical-gate.test.ts:28`
- `apps/gateway/src/mesh/forwarder.test.ts:654`
- `apps/gateway/src/mesh/stream-replay-state.test.ts:147`
- `packages/ws-client/src/client.test.ts:514`
- `packages/ws-client/src/transport-message-decoder.test.ts:143`
- `packages/ws-client/src/websocket-canonical-gate.test.ts:205`
- `packages/stores/src/tmux-event-router.test.ts:449`

具体调整：

- 1.1.22 的 accepted boundary 改成 1.1.23。
- `1.1.22_dev` 改为不支持。
- `<1.1.22` 文案改为 `<1.1.23`。
- `forwarder.test.ts:654` 当前使用 1.1.22 作为可接受版本，必须改为 1.1.23。
- `stream-replay-state.test.ts:147` 测试描述必须改为 `>=1.1.23`。

文档：

- `docs/hub/2026082800-hub-node-operations.md:239`
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md:217`
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md:779`
- `docs/ws-protocol/2026021403-ws-state-machines.md:19`
- `docs/terminal/2026021404-terminal-switch-barrier-design.md:89`

changelog：

- `packages/app/CHANGELOG.md:16`
- `packages/app/CHANGELOG.md:43`

e2e helper：

- `apps/fe/tests/helpers/site-theme.ts:52`
- `scripts/hub-e2e/driver/terminal.ts:284`

这两个 helper 已经引用常量，通常不需要改源码，但行为会随常量变化；应纳入回归验证。

### 应保留的 1.1.22 夹具

以下不是 canonical 门槛本身，不应机械替换：

- `apps/gateway/src/hub/hub-authorization.test.ts:346`：用于构造旧节点，验证 relay keylog 版本门禁拒绝。
- `apps/gateway/src/relay/relay-uplink.test.ts:74`：明确测试 relay 拒绝旧客户端。
- `apps/gateway/src/relay/relay-units.test.ts:181`、`:186`：明确测试接受 1.1.23、拒绝 1.1.22。
- `bun.lock:87`：是 `tmex-cli` 包版本元数据，不是 canonical 门禁引用。

仅引用常量、无需因常量变化而修改逻辑的文件：

- `apps/gateway/src/ws/canonical-gate.ts:13`
- `apps/gateway/src/ws/canonical-gate.ts:17`
- `apps/gateway/src/ws/index.ts:529`
- `packages/ws-client/src/transport-message-decoder.ts:132`
- `packages/ws-client/src/websocket-transport.ts:171`
- `packages/ws-client/src/client.ts:430`
- `packages/shared/src/ws-borsh/index.ts:128`
- `packages/shared/src/capabilities.ts:8`

---

## C2. `server-too-old` toast 当前缺少节点信息

### 当前事件链

服务端向客户端发送旧版本错误：

[`apps/gateway/src/ws/index.ts:529`](/Users/konata/code/tmex-r24/apps/gateway/src/ws/index.ts:529)

服务端正常 HELLO 会带 `serverVersion`：

[`apps/gateway/src/ws/index.ts:551`](/Users/konata/code/tmex-r24/apps/gateway/src/ws/index.ts:551)

客户端在收到旧 Gateway 的 HELLO 后可以得到版本：

[`packages/ws-client/src/client.ts:424`](/Users/konata/code/tmex-r24/packages/ws-client/src/client.ts:424)

并在 READY 状态产生：

[`packages/ws-client/src/websocket-transport.ts:160`](/Users/konata/code/tmex-r24/packages/ws-client/src/websocket-transport.ts:160)

但如果是 ERROR 帧，decoder 固定产生：

```ts
{
  type: 'server-too-old',
  minVersion,
  serverVersion: null
}
```

代码：

[`packages/ws-client/src/transport-message-decoder.ts:120`](/Users/konata/code/tmex-r24/packages/ws-client/src/transport-message-decoder.ts:120)

随后只尝试用已缓存的 `client.serverVersion` 补齐：

[`packages/ws-client/src/websocket-transport.ts:203`](/Users/konata/code/tmex-r24/packages/ws-client/src/websocket-transport.ts:203)

事件类型本身没有 node id：

[`packages/ws-client/src/transport-types.ts:74`](/Users/konata/code/tmex-r24/packages/ws-client/src/transport-types.ts:74)

toast 目前只传 `minVersion`：

[`packages/stores/src/tmux-event-router.ts:120`](/Users/konata/code/tmex-r24/packages/stores/src/tmux-event-router.ts:120)

### downstream peer 过旧路径

`rejectStaleNodeStream()` 实际知道：

- `pump.nodeId`
- `pump.replay.peerVersion`

[`apps/gateway/src/mesh/stream-replay-state.ts:22`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/stream-replay-state.ts:22)

但当前消息只包含版本：

[`apps/gateway/src/ws/canonical-gate.ts:16`](/Users/konata/code/tmex-r24/apps/gateway/src/ws/canonical-gate.ts:16)

发送时 node id 被丢弃：

[`apps/gateway/src/mesh/stream-replay-state.ts:32`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/stream-replay-state.ts:32)

### 浏览器是否已经知道 nodeId

是。每个 runtime 都有 node id：

[`packages/stores/src/runtime.ts:141`](/Users/konata/code/tmex-r24/packages/stores/src/runtime.ts:141)

多节点 manager 也按 node id 创建独立 runtime：

[`packages/stores/src/node-connection-manager.ts:154`](/Users/konata/code/tmex-r24/packages/stores/src/node-connection-manager.ts:154)

因此对于“浏览器连接的目标 Gateway”，`tmux-event-router` 可以直接使用：

```ts
ctx.core.nodeId
```

但对于 entry 转发的下游 peer，当前浏览器只知道 entry 的 node id，不一定知道被拒绝的 downstream peer id；服务端必须把 `pump.nodeId` 放进消息或事件。

### 建议消息/事件契约

推荐扩展事件：

```ts
{
  type: 'server-too-old',
  minVersion: string,
  serverVersion: string | null,
  nodeId?: string | null
}
```

服务端 downstream 消息改为：

```text
canonical-state-v1.1 required: node <nodeId> version <peerVersion> < <minVersion>
```

客户端 decoder 解析 node id/version；普通旧 Gateway 路径则使用 HELLO 的 `serverVersion`。

如果需要在“未收到 HELLO 的 ERROR 路径”获得真实 Gateway 版本，服务端还必须把自己的 `getDisplayVersion()` 写入错误消息。当前 `ErrorSchema` 只有：

- `refSeq`
- `code`
- `message`
- `retryable`

见 [`packages/shared/src/ws-borsh/schema.ts:46`](/Users/konata/code/tmex-r24/packages/shared/src/ws-borsh/schema.ts:46)。

### toast 文案建议

例如中文：

```text
终端连接失败：节点 {{nodeId}} 的 Gateway 版本 {{serverVersion}} 过低，请升级到 {{minVersion}} 或更新版本。
```

缺失值使用 `unknown`。

需要更新的 i18n 源文件：

- `packages/shared/src/i18n/locales/zh_CN.json:1104`
- `packages/shared/src/i18n/locales/en_US.json:1104`
- `packages/shared/src/i18n/locales/ja_JP.json:1104`

生成输出由 i18n 脚本重建：

- `packages/shared/src/i18n/locales/generated/*.core.json`
- `packages/shared/src/i18n/resources.ts`
- `packages/shared/src/i18n/types.ts`

### 修改文件

C-GATE/C-TOAST owner 文件：

- `packages/shared/src/ws-borsh/canonical-version.ts`
- `apps/gateway/src/ws/canonical-gate.ts`
- `apps/gateway/src/mesh/stream-replay-state.ts`
- `packages/ws-client/src/transport-types.ts`
- `packages/ws-client/src/transport-message-decoder.ts`
- `packages/ws-client/src/websocket-transport.ts`
- `packages/stores/src/tmux-event-router.ts`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/ja_JP.json`
- `apps/gateway/src/ws/canonical-gate.test.ts`
- `apps/gateway/src/mesh/stream-replay-state.test.ts`
- `packages/ws-client/src/transport-message-decoder.test.ts`
- `packages/ws-client/src/websocket-canonical-gate.test.ts`
- `packages/ws-client/src/client.test.ts`
- `packages/stores/src/tmux-event-router.test.ts`

前端现有 hook 位置供另一 explorer 接续：

- `apps/fe/src/node/mesh-nodes.ts:76`
- `apps/fe/src/pages/settings/use-site-settings-save.ts:60`
- `apps/fe/src/node/hub-api.ts:97`

