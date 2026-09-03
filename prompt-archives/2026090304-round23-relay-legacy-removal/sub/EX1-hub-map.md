# tmex hub / mesh 现状架构报告

以下内容只描述当前实现事实；末尾“对 relay 设计的硬约束”是由现有代码产生的约束，不是方案设计。

## 1. HubRuntime、角色组装与 HTTP 路由

### 1.1 角色与运行时组装

当前没有 `relay` 角色。

- 角色类型只有 `standalone`、`node`、`hub,node`：`packages/shared/src/roles.ts:1-23`
- Gateway 配置解析同样只接受上述角色：`apps/gateway/src/config.ts:79-88`
- `TMEX_ROLES` 由配置解析为角色集合，`hub,node` 才会同时启用 Hub 与 Node。
- 应用入口只负责读取配置、调用组装器并启动 Bun server：`packages/app/src/runtime/server.ts:23-49`
- 实际角色组装在 `packages/app/src/runtime/assemble.ts:279-392`：
  - `roles.node` 创建 Node mesh runtime；
  - `roles.hub` 创建 `HubRuntime`；
  - 当前 Hub 运行时依附在 mesh runtime 中，hub 角色实际是完整 `hub,node`。
- HTTP、WebSocket 路由顺序：`packages/app/src/runtime/assemble-routes.ts:448-482`
  1. TLS/本地路由；
  2. setup 路由；
  3. `hub.handleRequest`；
  4. mesh HTTP；
  5. Gateway；
  6. 前端静态资源。
- `/hub/uplink` WebSocket 在普通 mesh/Gateway 路由之前处理：`packages/app/src/runtime/assemble-routes.ts:224-306`

HubRuntime 构造参数包括数据库、用户存储、key log、配置、认证函数、mesh hub 存储、hub 信任、环境修改与重启回调等：`apps/gateway/src/hub/hub-runtime.ts:102-124`。

构造过程会创建 `NodeRegistry`、`UplinkServer`、hub peer poller，并注册 key log、写转发、hub stream/ctl 等回调：`apps/gateway/src/hub/hub-runtime.ts:236-313`。

### 1.2 Hub HTTP 路由

完整分发在 `apps/gateway/src/hub/hub-runtime.ts:740-797`。

| 路由 | 认证 | 行为 |
|---|---|---|
| `GET /hub/uplink` | WebSocket 升级 | 接受节点或 hub 的 uplink；非升级请求返回错误：`hub-runtime.ts:740-755` |
| `GET /api/hub/status` | 无 | 返回当前 hub 集群元数据、模式、优先级、writer epoch、CA 指纹和 writer 视图：`hub-runtime.ts:681-696` |
| `GET /api/hub/role/status` | 用户认证 | 返回 active/standby 角色转换状态：`hub-runtime.ts:757-760`；角色语义见 `apps/gateway/src/hub/hub-role-routes.ts:108-197` |
| `POST /api/hub/role` | 用户认证 | 切换 active/standby：`hub-runtime.ts:761-764` |
| `POST /api/hub/enrollments/redeem` | 不要求浏览器用户认证 | 节点用证书、签名和 enrollment token 兑换入网材料：`hub-runtime.ts:765-772` |
| `POST /api/hub/enrollments` | 用户认证 | 创建 enrollment token；非 writer 时转发：`hub-runtime.ts:773-778`、`943-1017` |
| `GET /api/hub/enrollments/:id` | 用户认证、按 user scope | 查询本人 token：`hub-runtime.ts:779-782`、`863-887` |
| `GET /api/hub/nodes` | 用户认证、按 user scope | 返回本人节点清单：`hub-runtime.ts:783-785`、`835-860` |
| `POST /api/hub/nodes/:id/rename` | 用户认证、writer | 写入 rename-node key log：`hub-runtime.ts:786-789`、`889-909` |
| `POST /api/hub/nodes/:id/revoke` | 用户认证、writer | 写入 revoke-node key log：`hub-runtime.ts:790-793`、`910-941` |

`withAuth` 从请求认证上下文取得 user，失败返回 401：`apps/gateway/src/hub/hub-runtime.ts:826-833`。

`GET /api/hub/nodes` 返回：

- `id`
- `name`
- `status`
- `online`
- `version`
- `last_seen_at`
- `direct_capable`
- `cert`
- `cert_sig`

实现会按 `n.userId === auth.userId` 过滤：`apps/gateway/src/hub/hub-runtime.ts:835-860`。

`/api/hub/status` 不包含租户节点清单，但会暴露 hub 自身的 `hubNodeId`、`publicUrl`、`mode`、`priority`、`writerEpoch`、`name`、`caFingerprint`、writer view 等：`apps/gateway/src/hub/hub-runtime.ts:681-696`。

### 1.3 调用方

FE 直接使用：

- `/api/auth/mode`、`/api/auth/nodes`、`/api/auth/hubs` 等 API client：`packages/api-client/src/auth/auth-api.ts:91-147`
- `/api/mesh/nodes`、`/api/mesh/hubs`、`/mesh/ws`、`/api/mesh/rtc-config`：`apps/gateway/src/mesh/mesh-routes.ts:146-179`
- 通过 entry hub 访问目标 hub：`/n/<hub-id>/api/hub/*`，封装在 `apps/fe/src/node/hub-api.ts:1-5`
- 当前 FE 没有直接调用 `/api/hub/status`；hub 状态主要来自 `/api/mesh/hubs` 和节点清单：`apps/fe/src/node/mesh-hubs.ts:36-47`、`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:82-160`

CLI 使用：

- enrollment 创建、兑换及 hub join 使用 `/api/auth/mode`、`/api/hub/enrollments`、`/api/hub/enrollments/redeem`：`packages/app/src/lib/hub-client.ts:144-166`、`318-395`
- hub 节点列表使用 `/api/hub/nodes`：`packages/app/src/lib/hub-client.ts:397-417`
- 角色、standby/promote、allow/disallow 通过本地 Gateway API：`packages/app/src/commands/hub.ts:1092-1294`

其他 hub 之间使用：

- `/api/hub/status` peer polling：`apps/gateway/src/hub/hub-peer-poller.ts:1-42`
- `hub.write-forward` 转发写请求；
- `hub.tokens`、`hub.attachments`、`hub.forward` 控制面消息。

## 2. Uplink 协议

### 2.1 类型总表

协议类型完整列表定义于 `packages/shared/src/uplink/codec.ts:5-23`：

```text
auth.challenge
auth.response
auth.ok
ping
pong
node.status
node.list
key.log.req
key.log.res
key.log.append
key.log.ack
rtc.signal
enroll.redeemed
hub.tokens
hub.attachments
hub.forward
hub.write-forward
```

`apps/gateway/src/mesh/uplink-protocol.ts:1-41` 重新导出共享类型和编解码器。

协议限制包括：

- ctl 最大 64 KiB；
- 嵌套深度 8；
- 数组最多 1024；
- 字符串最多 4 KiB；
- endpoints 最多 32；
- hubs 最多 16；
- 证书字段最多 2048 bytes；
- `hub.tokens` 最低兼容版本为 `1.1.13`；
- attachment/write frame 最大 48 KiB；
- token JSON 最大 16 KiB。

定义见 `packages/shared/src/uplink/codec.ts:33-60`。

### 2.2 认证与心跳

| 类型 | 发送方向 | Payload | Hub 行为 |
|---|---|---|---|
| `auth.challenge` | Hub → Node/Hub | `{ t: "auth.challenge", nonce }` | Hub 接受连接后随机生成 32-byte nonce：`apps/gateway/src/hub/uplink-server.ts:430-459` |
| `auth.response` | Node/Hub → Hub | `{ t: "auth.response", node_id, sig }` | 只有未认证连接允许发送；校验 node cert、撤销状态、Ed25519 签名：`uplink-server.ts:1168-1184`、`1281-1358` |
| `auth.ok` | Hub → Node/Hub | `{ t: "auth.ok" }` | 认证成功后发送，同时发送 node list：`uplink-server.ts:1281-1358` |
| `ping` | 双向 | `{ t: "ping" }` | 心跳和连接保活 |
| `pong` | 双向 | `{ t: "pong" }` | 响应 ping；节点默认每 15 秒发送，连续 3 次失败断开：`apps/gateway/src/mesh/uplink-client.ts:52-62` |

认证签名消息绑定：

```text
nonce + hubHostFromUrl(config.publicUrl)
```

节点侧用自身 Ed25519 私钥签名：`apps/gateway/src/mesh/uplink-client.ts:475-565`。

Hub 侧：

1. 从 `node_certs` 按 `nodeId` 查证书；
2. 拒绝不存在、revoked 的证书；
3. 解码证书中的 `ed_pk`；
4. 验证 uplink challenge 签名；
5. 取证书中的 `userId` 作为连接的 `live.userId`。

实现：`apps/gateway/src/hub/uplink-server.ts:1281-1358`。

### 2.3 `node.status`

定义：`packages/shared/src/uplink/codec.ts:971-1010`

```ts
{
  t: "node.status",
  version: string,
  tmux: boolean,
  direct_capable: boolean,
  inventory: ...,
  endpoints: ...,
  hub?: ...
}
```

发送方：Node → Hub。

节点发送实现：`apps/gateway/src/mesh/uplink-client.ts:292-331`；状态内容由 `mesh-runtime` 提供，包括：

- 当前版本；
- tmux 状态；
- direct capability；
- peer inventory；
- endpoint 列表；
- 本地 hub 广告。

`apps/gateway/src/mesh/mesh-runtime.ts:923-959`。

Hub 读取并解释全部字段：

- 序列化 inventory/endpoints；
- 创建或更新 `nodes`；
- 使用 `live.userId` 写入 user scope；
- 更新 `NodeRegistry`；
- 更新 hub advertisement；
- 广播新的 node list；
- 可能发送 token snapshot。

实现：`apps/gateway/src/hub/uplink-server.ts:1360-1421`。

因此当前 Hub 明确读取并持久化租户的节点版本、设备清单、endpoint、direct capability 等明文元数据。

### 2.4 `node.list`

定义：`packages/shared/src/uplink/codec.ts:986-1035`

```ts
{
  t: "node.list",
  version,
  key_log_head: { seq, hash },
  rtc: { stun, turn },
  nodes: NodeListEntry[],
  hub?,
  hubs?,
  writerHubId?,
  writerEpoch?
}
```

每个节点项包括：

```ts
{
  id,
  name,
  online,
  endpoints,
  inventory,
  direct_capable,
  version,
  attachedHubId?
}
```

定义：`packages/shared/src/uplink/codec.ts:971-1005`。

发送方：Hub → Node。

Hub 构造 node list 时读取：

- Registry/DB 中的节点；
- 节点名称；
- inventory；
- endpoints；
- 版本；
- online/direct 状态；
- key log head；
- STUN/TURN；
- hub 元数据和 writer 元数据。

实现：`apps/gateway/src/hub/uplink-server.ts:1930-2014`。

Hub 发送 node list 的时机：

- uplink 认证完成后；
- node.status 更新后；
- key log 变化后；
- hub attachment 或 hub 元数据变化后。

实现相关代码：`uplink-server.ts:1281-1358`、`1360-1421`、`1081-1107`。

节点消费逻辑：

- 忽略自身节点；
- 只接受已有、同 user、未撤销证书的节点；
- 将 name/endpoints/inventory/direct/version 写入 `peer_cache`；
- 保存 node list 版本和 key log head；
- 触发 key log catch-up。

实现：`apps/gateway/src/mesh/uplink-client.ts:567-639`、`apps/gateway/src/mesh/uplink-key-log-sync.ts:156-180`。

Hub 侧把 node list 当作明文结构生成和解释；它不是 blind 数据。

### 2.5 Key log 协议

当前代码没有单一的 `key.log` ctl；实际拆成四类：

```text
key.log.req
key.log.res
key.log.append
key.log.ack
```

类型定义：`packages/shared/src/uplink/codec.ts:1012-1068`。

#### `key.log.req`

Node → Hub：

```ts
{
  t: "key.log.req",
  from_seq: number,
  id?: string,
  limit?: number
}
```

Hub 读取 `live.userId`，按用户查询 key log，并返回记录：`apps/gateway/src/hub/uplink-server.ts:1423-1453`。

#### `key.log.res`

Hub → Node：

```ts
{
  t: "key.log.res",
  records: { seq, bytes, sig }[],
  id?,
  error?,
  has_more?,
  retry_after_ms?
}
```

Node 侧接收后交给 `UplinkKeyLogSync`：`apps/gateway/src/mesh/uplink-client.ts:521-564`。

Hub 的 `keyLogSource.list()` 返回原始记录，但 Hub 端会进一步解码和处理 key log：`apps/gateway/src/auth/key-log-store.ts:41-136`。

#### `key.log.append`

Node → Hub：

```ts
{
  t: "key.log.append",
  bytes,
  sig,
  id?,
  force?
}
```

Hub 行为：

1. 解码 bytes/sig；
2. standby 进行 replay/forward；
3. writer 检查兼容性；
4. 按 `live.userId` append；
5. 返回 ACK；
6. 对记录进行解释和副作用处理。

实现：`apps/gateway/src/hub/uplink-server.ts:1536-1649`。

#### `key.log.ack`

Hub → Node：

```ts
{
  t: "key.log.ack",
  id?,
  ok,
  seq?,
  error?
}
```

Node 侧处理：`apps/gateway/src/mesh/uplink-client.ts:521-564`。

#### Hub 读取的 key log 明文

Hub 不仅转发 bytes：

- `key-log-store.ts:101-136` 的 `projectPayloadJson` 会解码记录 payload；
- `apps/gateway/src/auth/user-key-persistence.ts:195-208` 处理 `admit-node`，解析证书并写入 `node_certs`；
- `user-key-persistence.ts:209-224` 处理撤销、删除 peer、退休 hub authorization；
- `apps/gateway/src/auth/user-key-service.ts:647-681` 验证记录、root/passkey 签名并应用。

因此当前 Hub 会读取：

- 节点名称；
- 节点证书；
- 节点授权；
- revoke/admit 记录；
- hub authorization；
- root rotation 等 key log 业务记录。

### 2.6 `rtc.signal`

类型定义：`packages/shared/src/uplink/codec.ts:1069-1094`

```ts
{
  t: "rtc.signal",
  rtcSession,
  from: "browser" | "node",
  to,
  sdp?,
  candidate?
}
```

浏览器 → Entry Gateway：

- `/mesh/ws` 接收浏览器 RTC signal；
- 强制 `from: "browser"`；
- 拒绝伪造 node-origin signal；
- 转换为 uplink ctl 或本地投递。

实现：`apps/gateway/src/mesh/mesh-routes.ts:196-218`、`apps/gateway/src/mesh/mesh-runtime.ts:1181-1299`。

Hub → Node：

- Hub 校验 `rtcSession`；
- 校验来源连接 user；
- 校验 `from`、`to` 对应证书属于同一用户；
- 根据目标节点本地或跨 hub 转发。

实现：`apps/gateway/src/hub/uplink-server.ts:1674-1723`。

Hub 读取：

- `rtcSession`；
- `from`；
- `to`；
- `sdp`；
- `candidate`；
- 跨 hub 的 origin/return/visited 信息。

因此当前 Hub 能看到完整 SDP 和 ICE candidate，不能称为 blind signaling。

### 2.7 `relay OPEN` 与数据面

普通 relay stream 不是 ctl，而是 uplink stream 的首帧 JSON：

```json
{ "to": "<nodeId>" }
```

Node 侧 `openRelay(to)`：`apps/gateway/src/mesh/uplink-client.ts:292-331`。

Hub 侧：

1. 解析 OPEN；
2. 读取 `to`；
3. 根据连接证书确定 source；
4. 查询 source/target cert；
5. 要求 target 存在、未撤销、与 source 的 `userId` 相同；
6. 给目标 stream 添加 `from`；
7. 双向 pump 字节流。

实现：`apps/gateway/src/hub/uplink-server.ts:1725-1783`、`2200-2210`。

节点侧 peer manager 在 direct 失败后调用：

```text
uplink.openRelay(nodeId)
handshakeRelay(...)
```

实现：`apps/gateway/src/mesh/peer-manager.ts:910-950`。

内层使用 `SecureChannelLink`，通过节点间握手派生加密通道：`apps/gateway/src/mesh/peer-protocol.ts:398-455`。

因此：

- Hub 会读取 relay OPEN 的目标节点 ID；
- Hub 不读取建立后的 SecureChannelLink 内部数据；
- “密文 relay”只适用于数据面，不适用于当前控制面和 OPEN 元数据。

### 2.8 `hub-relay`

跨 hub relay 的 OPEN：

```ts
{
  kind: "hub-relay",
  to,
  from,
  originHubId,
  visitedHubIds,
  hop
}
```

定义与解析：`apps/gateway/src/hub/hub-relay.ts:1-72`。

Hub 读取并校验：

- origin/peer hub 是否授权；
- hop 是否超过 2；
- visited 是否形成环；
- source 是否撤销；
- target 是否存在；
- source、target、fromHub 是否属于同一用户；
- target 是否连接到本 hub。

实现：`hub-relay.ts:74-129`、`apps/gateway/src/hub/uplink-server.ts:884-1007`。

### 2.9 `enroll.redeemed`

Hub → enrollment entry node：

```ts
{
  t: "enroll.redeemed",
  certificate,
  cert_sig,
  enroll_pk,
  node_id,
  entry_sid?,
  already_admitted?
}
```

类型：`packages/shared/src/uplink/codec.ts:1096-1110`。

Hub 在 redeem 成功后发送给保存的 entry node：`apps/gateway/src/hub/hub-runtime.ts:1073-1114`。

### 2.10 `hub.tokens`

Hub ↔ Hub。

类型包括：

```ts
HubTokenRow {
  id,
  user_id,
  enroll_public_key,
  authorization_json,
  authorization_sig,
  expires_at,
  used_at,
  node_id
}
```

定义：`packages/shared/src/uplink/codec.ts:1112-1160`。

当前 Hub 会读取并同步：

- `user_id`；
- enrollment public key；
- authorization JSON；
- authorization signature；
- token 生命周期；
- node id。

实现：`apps/gateway/src/hub/hub-tokens.ts:21-45`、`57-132`、`209-234`。

### 2.11 `hub.attachments`

Hub ↔ Hub，传递节点与 hub 的连接归属：

```ts
{
  nodeId,
  attached,
  hubId,
  revision,
  full?,
  snapshot?,
  page?,
  final?
}
```

类型：`packages/shared/src/uplink/codec.ts:1162-1190`。

Hub 维护内存路由 `nodeId → hubId/version/lastSeen`，并将 attachment 广播给其他 hub：`apps/gateway/src/hub/uplink-server.ts:696-845`。

### 2.12 `hub.forward`

Hub ↔ Hub，当前主要用于 RTC signal：

```ts
{
  kind: "rtc.signal",
  originHubId,
  returnHubId?,
  visitedHubIds,
  signal
}
```

类型：`packages/shared/src/uplink/codec.ts:1162-1190`。

Hub 会解析并路由其中的 RTC signal，因此 SDP/candidate 仍然是 hub 可见明文：`apps/gateway/src/hub/uplink-server.ts:696-845`、`1674-1723`。

### 2.13 `hub.write-forward`

Standby → Writer，Writer → Standby ACK。

Payload 包括：

```ts
{
  path,
  method,
  headers?,
  body?,
  uid?,
  status?,
  writerHubId?,
  writerEpoch?
}
```

定义：`packages/shared/src/uplink/codec.ts:1192-1244`。

用途：

- enrollment create/redeem；
- rename/revoke；
- `/api/auth/keylog?hub=sync`；
- 其他 writer-only 写入。

设计文档说明：`docs/hub/2026090104-multi-hub-standby.md:116-135`。

代码校验 body 大小、writer epoch、幂等 ID，然后在 writer 上重建 Request 执行：`apps/gateway/src/hub/uplink-server.ts:614-688`、`apps/gateway/src/hub/hub-runtime.ts:550-680`。

## 3. Hub-side 持久化

### 3.1 Schema

Schema 汇总：`apps/gateway/src/db/schema.ts:1-6`。

#### Mesh 表

`apps/gateway/src/db/schema/mesh.ts:14-132`

- `nodes`
  - `id`
  - `user_id`
  - `name`
  - `status`
  - `last_seen_at`
  - `version`
  - `direct_capable`
  - `inventory_json`
  - `inventory_version`
  - `endpoints_json`
- `node_identity`
  - 单例 `id=1`
  - `node_id`
  - `hub_url`
  - 加密私钥
  - x25519 key
  - cert/cert_sig
  - `user_id`
- `peer_cache`
  - 全局 `node_id` 主键
  - name/endpoints/inventory/direct/last_seen/list_version
  - 无 `user_id`
- `hub_trust`
  - 按 hub URL 全局存储
- `mesh_hubs`
  - 全局 `hub_node_id` 主键
  - URL/name/mode/priority/writer_epoch/CA/online/last_seen
- `hub_role_transitions`
  - 全局角色转换状态
- `user_hub_authorizations`
  - `(user_id, hub_node_id)` 复合主键

#### 用户与认证表

`apps/gateway/src/db/schema/users-auth.ts:13-135`

- `users`
  - root public key；
  - root epoch；
  - KDF 参数；
  - key log head。
- `user_keys`
  - 按 `user_id` 保存用户密钥。
- `user_key_log`
  - `(user_id, seq)` 复合主键；
  - 原始 `record_bytes`；
  - `sig`；
  - `payload_json`。
- `node_sessions`
  - 按 user 保存会话。
- `node_certs`
  - `node_id` 主键；
  - `user_id`；
  - certificate/auth；
  - revoked seq。
- `enrollment_tokens`
  - token id；
  - `user_id`；
  - enroll public key；
  - authorization JSON/sig；
  - expires/used/node。

#### 其他

- `gateway_kv` 是全局 key/value：`apps/gateway/src/db/schema/settings.ts:40-45`
- Gateway 启动时创建 replication 辅助表：`apps/gateway/src/auth/user-store.ts:769-785`

### 3.2 迁移

迁移目录：`apps/gateway/drizzle/`

命名为数字前缀加描述性 slug，例如：

```text
0019_hub_auth.sql
0020_...
0022_...
0032_...
0033_...
0034_...
```

受管迁移清单：`apps/gateway/src/db/managed-migrations.ts:7-47`。

相关迁移：

- hub auth 初始表：`apps/gateway/drizzle/0019_hub_auth.sql:1-130`
- node identity user 字段：`0020...:1`
- hub trust：`0022...:1-6`
- mesh hubs：`0032...:1-12`
- auth 扩展：`0033...:1-37`
- role transitions：`0034...:1-14`
- root rotation keep：`0036...`
- node access：`0038...`

### 3.3 user_id 作用域

已经按用户作用域的主要数据：

- `users`
- `user_keys`
- `user_key_log`
- `node_sessions`
- `node_certs`
- `enrollment_tokens`
- `nodes`
- `user_hub_authorizations`

`KeyLogStore` 的 list/get/append 均接收 `userId`：`apps/gateway/src/auth/key-log-store.ts:41-99`。

节点存取由 `NodePersistence` 按 node id 操作，但新建/更新时写入 user id：`apps/gateway/src/hub/node-persistence.ts:5-90`。

仍然是全局或缺少 user scope 的主要数据：

- `node_identity` 单例；
- `peer_cache`；
- `mesh_hubs`；
- `hub_trust`；
- hub attachment 内存路由；
- hub role transition；
- `node_certs.node_id` 全局唯一；
- `gateway_kv`；
- Registry 以 node id 为主键。

## 4. Hub uplink 认证与 relay 授权

### 4.1 节点认证

Hub 在 `auth.response` 中取得 `node_id`，执行：

```text
node_id
  → node_certs 查证书
  → 检查 revoked
  → certificate.ed_pk
  → verifyEd25519(sig, nonce + hubHost, ed_pk)
  → certificate.user_id 作为 live.userId
```

代码：`apps/gateway/src/hub/uplink-server.ts:1281-1358`。

连接状态包含：

- `nodeId`
- `userId`
- `link`
- `generation`
- heartbeat 状态

定义：`apps/gateway/src/hub/uplink-server.ts:175-183`。

### 4.2 node_certs 的来源

`node_certs` 不是单纯通过 enrollment redeem 建立完整授权关系。

完整流程是：

1. 用户或已有节点生成/签署 `admit-node` key log；
2. Hub 读取并验证 key log；
3. `user-key-persistence` 解码该记录中的证书；
4. upsert 到 `node_certs`。

实现：`apps/gateway/src/auth/user-key-persistence.ts:195-208`。

key log 的签名验证和应用入口：`apps/gateway/src/auth/user-key-service.ts:647-681`。

撤销节点时：

- 标记证书 revoked；
- 删除 peer cache；
- 可能退休 hub authorization。

实现：`apps/gateway/src/auth/user-key-persistence.ts:209-224`。

### 4.3 Enrollment redeem 与 node_certs 的关系

Redeem handler 主要验证：

- cert/cert_sig；
- token；
- enroll public key；
- authorization 中的 uid；
- token expiry/used；
- root epoch；
- 节点是否已存在；
- PoP 签名；
- revoked 状态。

实现：`apps/gateway/src/hub/hub-runtime.ts:1191-1308`。

Redeem 会创建或更新 `nodes`，但完整的 `node_certs` 授权通常来自 `admit-node` key log。Redeem 成功后将 cert/cert_sig 转发到 entry node：`hub-runtime.ts:1073-1114`。

### 4.4 relay stream 授权

普通 relay OPEN：

1. source 来自已认证 uplink 的 `live.nodeId`；
2. source cert 必须存在且未撤销；
3. target cert 必须存在且未撤销；
4. `targetCert.userId === live.userId`；
5. 才允许打开目标 stream。

实现：`apps/gateway/src/hub/uplink-server.ts:1725-1783`。

跨 hub relay 额外要求：

- origin/peer hub 在授权列表；
- source cert、target cert、fromHub cert 属于同一 user；
- hop 不超过 2；
- visited hub 不重复；
- target 最终连接在目标 hub。

实现：`apps/gateway/src/hub/uplink-server.ts:884-1007`、`apps/gateway/src/hub/hub-relay.ts:74-129`。

所以当前 relay 的授权粒度是证书和 `user_id`，而不是租户外部 password/session。

## 5. Node 侧 UplinkClient、UplinkPool 与数据流

### 5.1 UplinkClient

`UplinkClient` 位于 `apps/gateway/src/mesh/uplink-client.ts`。

构造参数包括：

- `hubUrl`
- node identity
- `userId`
- key log applier/store
- status provider
- node list、RTC、enrollment、relay 等回调

定义：`uplink-client.ts:64-92`。

主要行为：

- challenge-response auth：`475-565`
- ctl 编解码和分发：`521-564`
- 发送 node.status：`292-331`
- 接收 node.list：`567-639`
- key log catch-up：`622-639`
- relay OPEN：`292-331`
- 接收普通 relay stream：`442-473`
- 接收 `hub-relay`：`442-473`

### 5.2 UplinkPool

`UplinkPool` 位于 `apps/gateway/src/mesh/uplink-pool.ts`。

候选 hub 来源：

1. 数据库 `mesh_hubs` endpoint；
2. `TMEX_HUB_URLS`；
3. `TMEX_HUB_URL`；
4. 相关 legacy seed。

合并、排序和优先级：`uplink-pool.ts:245-304`。

运行时使用：

- `orderedEndpoints`；
- `hubSeedUrls`；
- retired 过滤；
- priority/epoch 排序。

`apps/gateway/src/mesh/mesh-runtime.ts:969-1080`。

Pool 支持：

- make-before-break；
- 当前 hub 切换；
- auth deadline 20 秒；
- 连续失败后切候选；
- 节点列表回调；
- RTC 回调；
- relay stream 回调。

实现：`apps/gateway/src/mesh/uplink-pool.ts:592-915`。

### 5.3 环境配置

配置定义：

- `TMEX_HUB_URL`：单个 seed；
- `TMEX_HUB_URLS`：逗号分隔的多个 seed；
- `TMEX_HUB_PEERS`：hub peer；
- mesh STUN/TURN 等配置。

解析：`apps/gateway/src/config.ts:173-205`、`250-329`。

节点身份表：

```text
node_identity.id = 1
node_id
hub_url
user_id
cert_json
cert_sig
encrypted private keys
```

Schema：`apps/gateway/src/db/schema/mesh.ts:37-50`。

### 5.4 node.list → peer_cache

节点收到 `node.list` 后：

1. 读取节点项；
2. 跳过自身；
3. 要求本地已有对应 node cert；
4. 要求 cert.userId 等于当前节点 userId；
5. 要求证书未撤销；
6. upsert `peer_cache`；
7. 保存 name/endpoints/inventory/direct/version；
8. 根据 key log head 触发 catch-up。

实现：`apps/gateway/src/mesh/uplink-client.ts:567-639`。

`peer_cache` 本身没有 `user_id`，隔离依赖调用方预先检查证书。

### 5.5 key log catch-up

`UplinkKeyLogSync` 维护：

- hub URL；
- generation；
- auth state；
- user id；
- persisted list；
- event emitter。

定义：`apps/gateway/src/mesh/uplink-key-log-sync.ts:14-86`。

收到 node list 后：

1. 比较 list version；
2. 读取本地 key log head；
3. 对比远端 key log head；
4. 请求缺失序列；
5. 应用并持久化；
6. 处理 fork、ACK、force、missing id。

实现：`uplink-key-log-sync.ts:111-180`。

### 5.6 RTC 路由

完整链路：

```text
Browser
  → /mesh/ws
  → Entry Gateway
  → 当前 Node uplink
  → Hub
  → 目标 Node uplink
  → 目标 Node / browser
```

浏览器入口和校验：`apps/gateway/src/mesh/mesh-routes.ts:196-218`。

Node 侧：

- 当前 live peer 存在时直接发 ctl；
- 否则交给 uplink；
- Hub 返回的 RTC signal 再投递给 PeerManager/browser。

实现：`apps/gateway/src/mesh/mesh-runtime.ts:1181-1299`。

Hub 侧解析并校验完整 RTC signal：`apps/gateway/src/hub/uplink-server.ts:1674-1723`。

### 5.7 Relay stream 与 SecureChannelLink

Node-to-node 建链：

1. PeerManager 尝试 direct；
2. direct 失败时 `uplink.openRelay(nodeId)`；
3. 通过 uplink stream 转发；
4. 节点两端执行 `handshakeRelay`；
5. 创建 `SecureChannelLink`；
6. 加入 LinkMux。

代码：`apps/gateway/src/mesh/peer-manager.ts:910-950`、`apps/gateway/src/mesh/peer-protocol.ts:398-455`。

如果目标节点连接在其他 hub：

```text
Node A → Hub A → hub-relay → Hub B → Node B
```

相关代码：`apps/gateway/src/hub/uplink-server.ts:884-1007`。

### 5.8 relay 目标的当前差异点

当前节点只把 hub 当作已认证、可读取 node metadata 和 key log 的 mesh hub。

若目标是 blind `relay`，现有 Node 端逻辑中与普通 hub 绑定的事实包括：

- uplink auth 依赖 hub hostname 签名；
- node list 是明文结构；
- node list 被写入 peer cache；
- key log 由 hub 提供和同步；
- RTC signal 由 hub 解析；
- relay OPEN 依赖 hub 查询 source/target cert；
- UplinkPool 假设候选 endpoint 是 hub；
- `mesh_hubs` 保存 hub metadata 和 writer 状态。

这些都是现有实现的耦合点。

## 6. Enrollment / join 端到端流程

### 6.1 Enrollment 创建

FE 先从 `/api/auth/mode` 获取：

- root public key；
- root epoch；
- key log head；
- KDF 和认证模式。

实现：`apps/fe/src/node/enrollment.ts:587-616`。

创建 enrollment：

1. 生成 enroll key pair；
2. 使用 root key 或 passkey 对 authorization 签名；
3. POST `/api/hub/enrollments`；
4. 保存 pending enrollment；
5. 清理本地 enroll private key；
6. 生成 join token。

实现：`apps/fe/src/node/enrollment.ts:641-733`。

Hub 创建 handler：

- 读取 `enroll_pk`；
- 读取 authorization/authorization_sig；
- 解码并验证；
- 验证 uid、root epoch、enroll_pk；
- 写入 `enrollment_tokens`。

实现：`apps/gateway/src/hub/hub-runtime.ts:943-1055`。

Hub 验证 authorization：

```text
authorization.uid == user.id
authorization.root_epoch == current root epoch
authorization.enroll_pk == request enroll_pk
root signature verifies with user.rootPublicKey
```

实现：`hub-runtime.ts:1020-1055`。

### 6.2 Join string 格式

FE 生成的 join token 为：

```text
enroll_sk || root_public_key || key_log_head_hash
```

总长 96 bytes，编码后为 token；可附加 `.64hex` 格式 CA fingerprint：`apps/fe/src/node/enrollment.ts:699-755`。

CLI 会解析 token、规范化 URL、读取 CA pin，并访问 `/api/auth/mode`：`packages/app/src/commands/hub.ts:446-482`。

### 6.3 CLI redeem

CLI `tmex enroll`：

- 非 hub 模式要求 `TMEX_HUB_URL`：`packages/app/src/commands/enroll.ts:300-310`
- 支持远端 auth mode、TOTP、root login：`enroll.ts:312-365`
- 轮询证书；
- 若节点尚未 admitted，则使用 root key 签署 `admit-node`：`enroll.ts:395-445`
- 最终构造 join command：`enroll.ts:447-513`

CLI `tmex hub join`：

1. 解析 join token；
2. 从 token 取得 enroll secret、root public key、key log anchor；
3. 生成本机 identity key；
4. 构造 node certificate；
5. 用 node Ed25519 key 签署 redeem PoP；
6. POST `/api/hub/enrollments/redeem`；
7. 验证返回证书、用户 ID、key log；
8. 提交本地 identity/config。

实现：`packages/app/src/commands/hub.ts:485-644`。

Redeem handler：

- 通过 cert 的 `enroll_pk` 找 token；
- 验证 cert signature；
- 验证 authorization；
- 检查 token expiry/used；
- 检查 epoch；
- 检查已有节点及撤销状态；
- 消费 token；
- 创建/更新 `nodes`；
- 返回 cert、用户材料和 key log。

实现：`apps/gateway/src/hub/hub-runtime.ts:1057-1308`。

### 6.4 Redeem 返回内容

Hub 返回：

- 用户 ID；
- username；
- root public key；
- root epoch；
- KDF 参数；
- 全部 user key log bytes/signatures；
- 全部 node certs；
- user_id；
- authorization；
- revocation 信息。

实现：`apps/gateway/src/hub/hub-runtime.ts:1116-1146`。

这意味着当前 redeem Hub 能够读取并返回整个租户的 root public key、key log 和证书集合。

### 6.5 Node 侧 enrollment-engine

Entry node 通过 hub uplink 接收 `enroll.redeemed`，再推送到本地 `/mesh/ws`：`apps/fe/src/node/enrollment-engine.ts:407-420`。

若实时通知失败，会轮询：

```text
/n/<hub>/api/hub/enrollments/:id
```

实现：`enrollment-engine.ts:431-457`。

FE 对 `admit-node` 的签名规则：

- root key 或 passkey 可签；
- session key 不能签；
- 根据已有节点/登录模式判断是否自动签名。

实现：`apps/fe/src/auth/key-log-actions.ts:1-87`、`apps/fe/src/node/enrollment-engine.ts:623-715`。

### 6.6 哪些步骤必须读取 root public key / authorization

当前必须读取的步骤：

1. 创建 enrollment 时，Hub 读取 root public key 对 authorization 的验证材料：`hub-runtime.ts:943-1055`
2. 远端登录/auth mode 时，Gateway 读取 root/passkey/TOTP 认证材料：`packages/app/src/lib/hub-client.ts:144-247`
3. redeem 时，Hub 读取 token 中存储的 authorization、cert、cert_sig 和 uid/epoch：`hub-runtime.ts:1191-1308`
4. key log catch-up/applier 时，Hub 解码、验证和应用 root-signed 记录：`key-log-store.ts:101-136`、`user-key-service.ts:647-681`
5. CLI join commit 时，节点本地使用 token 中的 root public key 验证完整 key log 链：`packages/app/src/commands/hub.ts:646-704`

当前 Hub 不是只处理不可解释的授权 opaque blob，而是直接验证并投影授权和 key log。

## 7. FE Nodes / 多节点互联页面

### 7.1 页面入口

Settings 的 `nodes` tab：

- tab 配置：`apps/fe/src/pages/SettingsPage.tsx:69-120`
- Nodes tab：
  - standalone 显示 setup wizard；
  - mesh 显示 `NodesManagement`。

实现：`apps/fe/src/pages/settings/nodes/nodes-tab.tsx:1-95`。

### 7.2 NodesManagement

`NodesManagement` 同时读取：

- `/api/mesh/nodes`
- `/n/<hub>/api/hub/nodes`
- `/api/mesh/hubs`

实现：`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:82-160`、`193-220`。

standby 状态下写操作会被禁止或引导到 writer。

### 7.3 HubStrip 与状态 badge

`HubStrip` 显示：

- hub URL；
- priority；
- epoch；
- online；
- attached；
- active/standby。

实现：`apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:19-52`、`118-190`。

只有两个或以上 hub 时显示多 hub strip。

### 7.4 FE store

#### mesh-nodes

模块 store：`apps/fe/src/node/mesh-nodes.ts:1-6`。

来源：

- REST `/api/mesh/nodes`
- WebSocket `/mesh/ws`

事件会更新：

- online/reachability；
- inventory；
- version；
- direct；
- name；
- revoked。

实现：`mesh-nodes.ts:58-120`。

mesh 与 hub node rows 合并时，hub 数据覆盖：

- name；
- version；
- direct；
- status；
- cert。

实现：`mesh-nodes.ts:172-208`。

#### mesh-hubs

模块单例 store：

- REST `/api/mesh/hubs`
- 默认 30 秒轮询；
- 维护 attached/writer/writesBlocked。

实现：`apps/fe/src/node/mesh-hubs.ts:1-7`、`36-47`、`76-104`、`112-137`、`192-241`。

#### HubApi

所有目标 hub admin API 通过 entry node 的 `/n/<hub>/api/hub/*` 访问：`apps/fe/src/node/hub-api.ts:1-5`、`80-151`。

### 7.5 API client

`packages/api-client/src/auth/auth-api.ts`：

- auth mode：`91-98`
- hub node list：`100-108`
- hub list：`110-133`
- public nodes：`137-147`

Gateway mesh routes：`apps/gateway/src/mesh/mesh-routes.ts:146-179`。

### 7.6 i18n

源 locale：

```text
packages/shared/src/i18n/locales/en_US.json
packages/shared/src/i18n/locales/zh_CN.json
packages/shared/src/i18n/locales/ja_JP.json
```

中文 Nodes/hub/role 相关 key：`packages/shared/src/i18n/locales/zh_CN.json:1705-1793`。

Enrollment、rename、revoke：`zh_CN.json:2167-2215`。

Setup/join：`zh_CN.json:2275-2371`。

构建脚本：

- 读取源 locale；
- 生成 `resources.ts`、`types.ts`；
- 生成 `locales/generated/*.core.json` 和 `*.rest.json`。

实现：`packages/shared/scripts/build-i18n.ts:1-105`。

FE 通过 Vite glob 加载生成的 core/rest namespace：`apps/fe/src/i18n/index.ts:9-99`。

## 8. CLI 结构

### 8.1 命令注册

CLI 主入口：

- 参数解析和命令 dispatch：`packages/app/src/index.ts:32-102`
- 嵌套命令解析：`packages/app/src/lib/args.ts:7-28`、`90-207`

命令目录：

```text
packages/app/src/commands/
```

### 8.2 `tmex hub ...`

主要子命令在：

```text
packages/app/src/commands/hub.ts
```

包括：

- `hub join`
- `hub leave`
- `hub role`
- `hub standby`
- `hub promote`
- `hub demote`
- `hub list`
- `hub allow`
- `hub disallow`

join：`hub.ts:446-825`。

standby/promote/demote：`hub.ts:1092-1205`。

list/allow/disallow：`hub.ts:1207-1294`。

### 8.3 Node bootstrap → Bun cli-auth.js

认证相关命令由 bootstrap 过程启动：

- `cli-auth-entry.ts` 动态加载 auth/hub/enroll 命令：`packages/app/src/cli-auth-entry.ts:7-93`
- 设置 `TMEX_CLI_AUTH_RUNTIME`：`cli-auth-entry.ts:95-117`
- `auth-spawn.ts` 查找 Bun/runtime CLI 并生成子进程：`packages/app/src/lib/auth-spawn.ts:17-32`、`52-109`、`221-258`

项目运行时为 Bun；只有 npm `tmex-cli` 安装/升级 bootstrap 使用 Node-compatible build。

### 8.4 CLI 到本地 Gateway 的调用

本地认证上下文主要直接读本地 SQLite 和安装配置：

- `packages/app/src/lib/local-auth.ts:11-27`、`36-168`
- `with-auth.ts` 复用注入的 auth context 或读取安装版 auth：`packages/app/src/commands/with-auth.ts:4-17`

远端 hub HTTP 请求封装在：

```text
packages/app/src/lib/hub-client.ts
```

典型调用：

- auth mode：`144-166`
- login/challenge：`168-247`
- create enrollment：`318-355`
- redeem：`357-395`
- list nodes：`397-417`

### 8.5 app.env 写入

安装配置操作：

- env key 和安装目录：`packages/app/src/lib/install.ts:16-26`
- 读取/修改 app.env：`install.ts:43-95`
- run script/config：`install.ts:127-174`

hub 命令使用锁、加载安装 env、patch env 并重启：`packages/app/src/commands/hub.ts:893-917`。

## 9. 现有 per-user scoping 与单用户假设

### 9.1 已存在的 user_id 路径

主要路径：

- uplink auth 从 `node_certs.user_id` 得到 `live.userId`：`apps/gateway/src/hub/uplink-server.ts:1281-1358`
- `node.status` 写 `nodes.user_id`：`uplink-server.ts:1360-1421`
- node list 按 live user 过滤；
- relay 按 source/target cert 的 `userId` 检查；
- key log req/append 使用 `live.userId`：`uplink-server.ts:1423-1453`、`1536-1649`
- `/api/hub/nodes` 按请求用户过滤：`hub-runtime.ts:835-860`
- enrollment token 带 `user_id`；
- user key log/certs/sessions 使用复合 user scope。

### 9.2 单用户假设

#### user resolver 的唯一用户假设

`resolveMeshUserId` 的顺序：

1. 显式 user；
2. node cert；
3. node row；
4. 如果数据库恰好只有一个用户，则取该用户；
5. 否则返回 null。

实现：`apps/gateway/src/hub/hub-authorization.ts:119-142`。

#### auth mode 的 first-row fallback

`AuthModeCache.findPrimaryUser` fallback 顺序：

1. first cert；
2. first node；
3. `listUsers()[0]`。

实现：`apps/gateway/src/mesh/auth-mode-cache.ts:61-75`。

#### CLI 的 first user

`tmex enroll` 直接读取用户列表并使用 `users[0]`：`packages/app/src/commands/enroll.ts:447-513`。

#### 全局单例和全局主键

- `node_identity` 是单例；
- `node_certs` 以 `node_id` 为全局主键；
- `peer_cache` 以 `node_id` 为全局主键且无 user_id；
- `mesh_hubs` 以 hubNodeId 为全局主键；
- `hub_trust` 按 URL 全局保存；
- attachment/router 以 nodeId 全局路由；
- role transition 是进程级/实例级状态；
- `gateway_kv` 无租户维度。

#### 全局 reset

`MeshMembershipStore.clearAll()` 会一次性删除所有用户、key、session、cert、node、token、peer cache、hub trust、mesh hub、node identity：`apps/gateway/src/auth/mesh-membership-store.ts:16-33`。

### 9.3 对多租户最敏感的现有代码

1. `node_identity` 单例无法自然表达一个进程连接多个独立租户。
2. `node_certs.node_id` 全局唯一，证书和 node ID 之间没有 tenant namespace。
3. `peer_cache` 无 user_id，依赖调用方证书检查保证隔离。
4. `mesh_hubs`、`hub_trust`、attachment routing 没有 user 维度。
5. `resolveMeshUserId`、`AuthModeCache`、CLI 使用“唯一用户/第一个用户”回退。
6. `HubRuntime` 的 `NodeRegistry` 按 node id 管理连接，但 live entry 才附带 userId。
7. `hub.tokens` 同步结构直接包含 user_id 和 authorization JSON。
8. Hub node list 生成依赖数据库中的明文 name/inventory/endpoints。
9. Hub key log service 会解码、验证并应用整个用户 key log。
10. RTC 路由直接解析 SDP/candidate 和用户归属。

## 10. 测试与可复用 harness

### 10.1 Multi-hub harness

主 harness：

```text
apps/gateway/src/mesh/integration/multi-hub-harness.ts
```

关键 helper：

- `HubRouter.register` / `takeDown` / `bringUp` / `sendCtl`：`80-169`
- `memoryHubRoleHooks`：`181-203`
- `meshHubsOf`、`keyLogList`：`253-259`
- `sidFromResponse`、`callMesh`：`261-289`
- `loginSelf`：`291-330`
- `loginRemote`：`332-372`
- `wireReplication`：`374-388`
- `waitUntil`、`waitOnline`：`390-405`
- `callHub`：`408-422`
- `createPendingNode`：`424-458`
- `bootHubA`：`460-546`
- `enrollAndStart`：约 `548` 起
- `bootAbcdTopology`：`713-739`
- `attachedUrl`、`attachedHubId`：`822-828`
- `stampNodeVersions`：`830-837`
- `reconstructHubRuntime`：`839-875`
- `getMeshHubs`、`getMeshNodes`：`877-917`
- `stampHubCtlVersions`：`919-928`
- `attachSplitAbcd`：`930-948`
- `craftNodeList`：`950-961`

测试文件：

```text
apps/gateway/src/mesh/integration/multi-hub.integration.test.ts
```

覆盖：

- node list propagation：约 `70`
- standby replication：约 `120`
- standby enrollment：约 `151`
- token crash/promote：约 `220`
- failover relay：约 `286`
- failback：约 `320`
- fencing：约 `341`、`412`
- stale list：约 `466`
- legacy compatibility：约 `502`
- unauthorized high epoch：约 `531`
- key log append：约 `652`、`682`
- auth：约 `732`
- old-node version gate：约 `814`
- role API：约 `862`
- cross-hub HTTP/RTC：约 `1023`
- smoke：约 `1103`

### 10.2 UplinkServer 测试

```text
apps/gateway/src/hub/uplink-server.test.ts
```

关键区域：

- `authNode` helper：约 `102`
- auth：`302`
- node.status/node.list：`546`
- key log：`634`
- relay：`975`
- cross hub：`1086`
- RTC：`1139`
- multi-hub：`1981`
- standby append：`2375`
- forwarding：`2483`
- tokens：`2694`
- hardening：`2761`

### 10.3 HubRuntime 测试

```text
apps/gateway/src/hub/hub-runtime.test.ts
```

覆盖：

- uplink：`199`
- enrollment：`226`
- rename/revoke：`1282`
- standby routes：`1889`
- status：`2092`

### 10.4 Node UplinkClient / Pool / key log 测试

```text
apps/gateway/src/mesh/uplink-client.test.ts
```

关键区域：

- auth/status/list/keylog：`57`
- challenge：`250`
- hub metadata：`682`
- cross-user/revoked list：`781`
- pre-auth：`1167`
- persistence：`2192`

```text
apps/gateway/src/mesh/uplink-pool.test.ts
```

- endpoint merge：`363`
- pool：`491`
- failover：约 `593` 起

```text
apps/gateway/src/mesh/uplink-key-log-sync.test.ts
```

- matching：`78`
- fork：`98`
- not writer：`170`
- catch-up：`226`
- force：`274`
- missing id：`298`

### 10.5 其他 mesh 集成测试

- `apps/gateway/src/mesh/integration/large-push-harness.ts`
  - `installBackpressuredUplink`：`141`
  - `installByteCountHandler`：`184`
  - `makeForwarder`：`217`
  - `bootHubAndLeaf`：`256`
  - `loginEntryToLeaf`：`303`
  - `adoptWsSecure`：`313`
- `large-push.integration.test.ts:13-58`
- `direct-path.integration.test.ts:161-180`、`738`、`903`
- `hub-peer-poll.integration.test.ts:24-38`
- `hub-contract.integration.test.ts:153-163`
- `rtc-wake.integration.test.ts:223-233`
- `stream-failover.integration.test.ts:307-317`
- `mesh.integration.test.ts:290-1333`

这些测试覆盖真实的 in-process hub/node、uplink、failover、RTC、direct/relay 和 replication 场景。

## 11. 版本门禁

当前 package 版本：

```text
1.1.22
```

来源：`packages/app/package.json:1-12`。

运行时版本：

- build 版本；
- dev 版本 fallback；
- display/base version。

实现：`apps/gateway/src/system/version.ts:7-58`。

semver helper：

- `compareSemver`
- `requireSemver`

实现：`packages/shared/src/semver.ts:50-78`。

关键最低版本常量：

- `MIN_HUB_AUTH_RECORD_VERSION = 1.1.13`
- `MIN_ROTATE_ROOT_KEEP_RECORD_VERSION = 1.1.16`

定义：`packages/shared/src/auth/key-log.ts:67-84`。

`MIN_HUB_TOKENS_VERSION = 1.1.13`：`packages/shared/src/uplink/codec.ts:42`。

Hub 节点版本校验：

- 规范化 `_dev`；
- 与最低版本比较；
- 拒绝不兼容的 hub/node uplink 或写入。

实现：`apps/gateway/src/hub/hub-authorization.ts:156-190`。

---

## 对 relay 设计的硬约束

- 当前角色解析没有 `relay`，只有 `standalone`、`node`、`hub,node`：`packages/shared/src/roles.ts:1-23`。
- Hub 的 uplink 身份来自 `node_certs`，并由 cert 中的 `user_id` 建立连接归属：`apps/gateway/src/hub/uplink-server.ts:1281-1358`。
- 当前 relay 授权依赖 source/target cert 存在、未撤销且 `user_id` 相同：`uplink-server.ts:1725-1783`。
- `nodes` 表的 node list 数据包含 name、inventory、endpoints、version，并由 Hub 生成：`apps/gateway/src/hub/uplink-server.ts:1930-2014`。
- 节点侧 `peer_cache` 依赖 node list 更新 peer name、endpoints、inventory、direct capability 和 version：`apps/gateway/src/mesh/uplink-client.ts:567-639`。
- `peer_cache` 本身没有 `user_id`，隔离依赖证书校验和调用路径。
- Hub 当前会读取和持久化 `node.status` 中的 inventory、endpoints、version：`apps/gateway/src/hub/uplink-server.ts:1360-1421`。
- Hub 当前会解码、验证、投影和应用 key log，而不是只转发 bytes：`apps/gateway/src/auth/key-log-store.ts:101-136`、`apps/gateway/src/auth/user-key-service.ts:647-681`。
- Hub 当前会读取 `rtc.signal` 中的 SDP、candidate、from、to、rtcSession：`apps/gateway/src/hub/uplink-server.ts:1674-1723`。
- 当前“密文 relay”只覆盖 `SecureChannelLink` 建立后的数据面；Hub 仍然读取 relay OPEN 的 `to` 和连接身份。
- Enrollment redeem 返回 root public key、完整 key log 和 node certs：`apps/gateway/src/hub/hub-runtime.ts:1116-1146`。
- Enrollment authorization 会在 Hub 侧用用户 root public key 校验：`hub-runtime.ts:1020-1055`。
- `hub.tokens` 明文包含 `user_id`、authorization JSON、enroll key 和 token 生命周期：`apps/gateway/src/hub/hub-tokens.ts:21-45`。
- `mesh_hubs`、`hub_trust`、attachment 路由和 role transition 当前不是按租户隔离的。
- `node_identity` 是单例，CLI 和 auth mode 仍存在 `users[0]`/唯一用户假设：`apps/gateway/src/mesh/auth-mode-cache.ts:61-75`、`packages/app/src/commands/enroll.ts:447-513`。
- UplinkPool 当前假设候选 endpoint 是可进行完整 hub auth、node list、key log、RTC 和 relay 的 hub：`apps/gateway/src/mesh/uplink-pool.ts:245-304`、`apps/gateway/src/mesh/mesh-runtime.ts:969-1080`。
- 多 hub 的跨 hub relay 依赖 hub allowlist、origin/return/visited ID 和 hop ≤ 2：`apps/gateway/src/hub/hub-relay.ts:74-129`。
- 当前没有 relay-wide password、password rotation、kick-all/keep-existing tenant session 的现有实现。