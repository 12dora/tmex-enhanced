# EX3：hub/mesh 多 hub 架构探索报告

调查范围：`apps/gateway`、`packages/shared`、`packages/app`、`apps/fe`、`scripts/hub-e2e`，以及两份 hub 设计文档。以下“已验证”均来自当前工作树源码或文档；“未验证”表示建议、估算或未实际运行测试的部分。

没有修改文件，也没有执行测试。

## 结论摘要

当前实现是严格的单 hub 控制面：

- 一个进程最多有一个 `HubRuntime`、一个 `UplinkServer`、一个 `NodeRegistry`。
- 一个 node 只有一个 `TMEX_HUB_URL`、一个 `UplinkClient`、一个 uplink WebSocket。
- `node.list` 只有一个 `hub` 字段。
- relay 只能在同一个 `HubRuntime.registry` 内查找目标 node，当前不存在 hub-to-hub 转发。
- `user_key_log` 不是普通可合并日志，而是带 `seq + prev_hash` 的全局严格链，因此不能简单让两个 hub 并发追加。
- enrollment token 的一次性 redeem、node ID 唯一性、证书吊销和 root epoch 都需要单一权威或明确 owner。

建议第一阶段选择“固定主备（active/standby）+ 单写者 + 有序 failover”，不要一开始实现真正的多 primary 和自动选举：

1. 两台 hub 都是现有的 `hub,node` 双角色。
2. 所有 node 保存 hub URL 列表，但运行时一次只连接当前 active hub。
3. standby 复制已签名的 key log、证书投影和注册表快照，但不接受写操作。
4. 主 hub 故障时，node 按优先级切换到 standby；切换后重新建立 registry 和 relay。
5. 首个 1–2 天增量不实现自动 promotion、不实现同时按最低 RTT 分散连接、不实现 hub-to-hub relay。
6. “每个 node 同时连接最近 hub + 任意跨 hub relay + 自动故障转移”预计明显超出 1–2 天，属于后续阶段。这个时间判断是未验证的工程估算。

---

# 1. 当前 hub 状态清单

## 1.1 数据库表

设计文档列出的 hub/node 共享表见[架构设计 v3.2:115](/Users/konata/code/tmex-enhanced-wt-r13/docs/hub/2026082700-hub-node-architecture.md:115)，实际迁移由 `0019_hub_auth.sql` 创建，后续 `0020` 增加 `node_identity.user_id`，`0021` 创建 TLS 配置，`0022` 创建 hub CA pin 表。

| 表 | 主要字段 | 写入者 | 读取者 | 一致性分类 |
|---|---|---|---|---|
| `users` | `id`、唯一 `username`、`root_public_key`、`root_epoch`、KDF、`key_log_head_seq/hash` | `UserStore.create/update*`；`UserKeyService` 在 key log 应用后更新 root/head | `UserKeyService.currentState`、登录鉴权、hub API、join | `root_epoch` 和 key-log head 必须单一权威；username 唯一；其余多数是 key log 的投影，不适合普通 LWW |
| `user_keys` | WebAuthn credential、公钥、origin、counter、对应 `log_seq` | `user-key-persistence.ts` 根据 `add-passkey/remove-passkey` 投影；`UserStore.updateCounter` 更新 assertion counter | passkey assertion 验证、`UserKeyService.currentState` | 主要是 key log 派生投影；`credential_id` 唯一；counter 是单调状态，不能盲目 LWW |
| `user_key_log` | `(user_id, seq)`、`prev_hash`、`hash`、`root_epoch`、原始 Borsh bytes、签名 | `HubKeyLogSource → UserKeyService.apply`；uplink `key.log.append`；hub revoke API | join、节点 catch-up、所有节点的 `UserKeyService`、认证投影 | 物理上 append-only，但同时是严格单写者链：`seq` 和 `prev_hash` 使并发分支成为 fork，不能直接合并 |
| `node_sessions` | 随机 `sid`、`user_id`、`via_node_id`、session 公钥、过期/续期/撤销时间 | `NodeSessionStore.issue/revoke/verify`；key log 的 rotate-root/revoke-node effect 会撤销 session | `stream-targets.ts`、登录路由、HTTP/WS 转发 | session 是本 node 的本地授权状态，不是全 mesh 全局 token；撤销必须单调传播，`via_node_id` 绑定不能被 LWW 覆盖 |
| `node_certs` | `node_id`、用户 ID、admit 序号、证书和授权 bytes/signature、`revoked_log_seq` | `user-key-persistence.ts` 应用 `admit-node/revoke-node` | uplink 握手、node-to-node handshake、relay、join 证书校验 | 证书本身是用户签名材料；表是 key log 投影。node ID 唯一和 revoked 状态需要权威决策 |
| `nodes` | node 注册信息：name、status、last_seen、version、direct、inventory、endpoints | uplink `node.status`、redeem、rename API、`node-persistence.ts` | `/api/hub/nodes`、`node.list`、mesh node list、FE Nodes 页 | 地址、inventory、版本、last_seen 可采用带版本/时间戳的 LWW；`id` 唯一；`revoked` 是终态，不应被旧写覆盖 |
| `enrollment_tokens` | enrollment 公钥、用户授权、过期时间、`used_at`、`node_id` | `HubRuntime.handleCreateEnrollment`、`UserStore.createEnrollmentToken` | redeem、状态查询、CLI/UI 轮询 | 必须单一 authority；`consumeEnrollmentToken` 使用 `used_at IS NULL AND expires_at > now` 的原子条件，不能用普通 LWW |
| `node_identity` | singleton `id=1`、node ID、一个 `hub_url`、加密 Ed/X25519 私钥、证书 | `NodeIdentityStore.save`、CLI join、bootstrap/reset-root | uplink、peer handshake、mesh runtime | 这是每台机器的本地身份，不是 hub 共享状态；当前结构明确是单行、单 hub URL；私钥不可复制到其他 hub |
| `peer_cache` | node ID、name、endpoints、inventory、direct、last_seen、`list_version` | node 收到 `node.list`；PeerManager 收到 peer `node.status` | PeerManager 建立 direct link、离线展示、mesh node list | 缓存数据，可采用带 freshness/version 的 LWW；绝不是信任根；当前还使用特殊的 `node_id='hub'` 哨兵行表示唯一 hub |
| `hub_trust` | `hub_url`、CA PEM、CA SPKI fingerprint | `HubTrustStore.put`，CLI join pin CA | CLI HTTP client、uplink WebSocket TLS | 这是本机对远程 hub TLS 的 pin，不是 mesh 成员资格；每 URL 一行，CA 轮换时可替换，但当前连接逻辑只读取一个 URL |
| `tls_config` | 本机 HTTPS CA、叶证书、私钥、ACME 状态 | TLS 配置/TLS service | hub 对外 HTTPS、`/api/tls/ca.crt` | 本机 TLS 终止配置，不属于 mesh 复制状态；singleton 但不是 hub 控制面 |

核心 schema 定义位于：

- `users`：[schema.ts:490](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:490)
- `user_keys`：[schema.ts:507](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:507)
- `user_key_log`：[schema.ts:527](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:527)
- `node_sessions`：[schema.ts:553](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:553)
- `node_certs`：[schema.ts:580](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:580)
- `nodes`：[schema.ts:597](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:597)
- `enrollment_tokens`：[schema.ts:620](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:620)
- `node_identity`：[schema.ts:637](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:637)
- `peer_cache`：[schema.ts:652](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:652)
- `tls_config`：[schema.ts:666](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:666)
- `hub_trust`：[schema.ts:711](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:711)

迁移：

- `0019_hub_auth.sql` 创建核心 hub 表：[0019:1](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/drizzle/0019_hub_auth.sql:1)
- `0020_node_identity_user.sql`：[0020:1](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/drizzle/0020_node_identity_user.sql:1)
- `0021_tls_config.sql`：[0021:1](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/drizzle/0021_tls_config.sql:1)
- `0022_hub_trust.sql`：[0022:1](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/drizzle/0022_hub_trust.sql:1)

### 重要写入路径

key log 应用不是简单插入一行，而是同时更新：

- 原始日志；
- `users` 的 root/head；
- `user_keys`；
- `node_certs`；
- session 撤销；
- peer cache 清理。

具体投影逻辑在[user-key-persistence.ts:106](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-key-persistence.ts:106)，其中 `admit-node` 写证书、`revoke-node` 标记证书并删除 peer cache：[user-key-persistence.ts:166](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-key-persistence.ts:166)。

`UserKeyService` 对批量 catch-up 使用事务和 CAS 检查当前 head：[user-key-service.ts:298](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-key-service.ts:298)、[user-key-service.ts:339](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-key-service.ts:339)。

enrollment redeem 的关键原子性在[hub-runtime.ts:612](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-runtime.ts:612)和[ user-store.ts:510](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-store.ts:510)。

## 1.2 Hub 内存状态

### `HubRuntime`

`HubRuntime` 本身主要是依赖容器，持有：

- `AuthDb`
- `UserStore`
- `HubKeyLogSource`
- `HubRuntimeConfig`
- `NodeRegistry`
- `UplinkServer`

见[hub-runtime.ts:123](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-runtime.ts:123)。

### `NodeRegistry`

这是 hub 的实时在线注册表：

```text
Map<nodeId, RegisteredNode>
global generation counter
```

每项包含：

- `nodeId`
- `userId`
- `LinkSession`
- name/version/tmux/direct/inventory/endpoints
- `lastSeen`
- `authenticated`
- generation

见[node-registry.ts:3](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/node-registry.ts:3)和[node-registry.ts:31](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/node-registry.ts:31)。

分类：临时在线状态，不应作为持久权威；进程重启后由 node 重新 uplink。当前它天然只属于一个 hub 进程，因此 relay 查找也只能在一个 hub 内完成。

### `UplinkServer` 连接状态

主要结构见[uplink-server.ts:149](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:149)：

- `pending: WeakMap<LinkSession, PendingAuth>`：等待 auth response 的 uplink。
- `live: Map<LinkSession, LiveConnection>`：已认证连接。
- `accepted: Set<LinkSession>`：已经接受但未必完成认证的连接。
- `authTimers`：握手超时。
- `ctlQueues`：每条 uplink 的控制消息串行队列和容量限制。
- `rtcSessions: Map<string, RtcSessionRegistration>`：浏览器/node RTC 授权会话。
- `listVersion`：当前 hub 全局 node list 版本。
- `lastNodeListFp`、`lastNodeListSent`：按用户缓存最近广播的 node list。
- `nodeListLatestGen`、`nodeListInflight`：按用户的 node list 广播去重。
- `inflightCtl`：正在处理的控制消息。
- key log 请求限流和认证失败日志限流状态。

其中连接认证和 node list 广播是单 hub 的状态机；RTC session 也只在当前 hub 的 `rtcSessions` 中存在。

### 限流和日志结构

`UplinkServer` 内部还拥有：

- `KeyLogReqLimiter` 的 node/user token bucket；
- `IdleLruMap`；
- `WindowedLogBudget`；
- overflow 用户和 node map；
- 拒绝日志预算。

见[uplink-rate-limit.ts:34](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-rate-limit.ts:34)和[uplink-rate-limit.ts:145](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-rate-limit.ts:145)。

分类：纯临时保护状态，不复制；切换 hub 后重新建立即可。

---

# 2. 当前拓扑和协议

## 2.1 节点如何发现和加入 hub

当前环境变量只有一个 hub URL：

- `TMEX_HUB_URL`：[operations:31](/Users/konata/code/tmex-enhanced-wt-r13/docs/hub/2026082800-hub-node-operations.md:31)
- gateway config：[config.ts:199](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/config.ts:199)
- mesh runtime 类型：[mesh-runtime.ts:65](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:65)

加入流程：

1. hub 上创建 enrollment authorization。
2. join string v1 为：

   ```text
   base64url(enroll_sk || root_public_key || key_log_head_hash)
   ```

3. self-signed HTTPS 时 v2 在末尾增加 hub CA SPKI fingerprint。
4. node 执行：

   ```bash
   tmex hub join https://hub.example --token <join-string>
   ```

5. node 使用 `enroll_sk` 创建 node certificate。
6. node 通过 `/api/hub/enrollments/redeem` 提交证书和 redeem proof。
7. hub 原子消费 enrollment token。
8. hub 返回完整 user key log 和 node certificates。
9. node 本地验证 key log、root、证书，并写入本机 `node_identity`。
10. CLI 只写入一个 `TMEX_HUB_URL` 和一个 `node_identity.hub_url`。

join string 和 CA pin 规则见[operations:111](/Users/konata/code/tmex-enhanced-wt-r13/docs/hub/2026082800-hub-node-operations.md:111)；CLI 单 URL 处理见[hub.ts:469](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/commands/hub.ts:469)和[hub.ts:508](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/commands/hub.ts:508)。

当前 CLI 写环境变量的逻辑明确只有一个值：[hub.ts:254](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/commands/hub.ts:254)。

## 2.2 uplink URL 和握手

`uplinkWsUrl()` 会把 HTTP/HTTPS 改成 WS/WSS，并强制路径为 `/hub/uplink`：

[uplink-protocol.ts:21](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-protocol.ts:21)。

node 侧 `UplinkClient` 只接受一个：

```ts
hubUrl: string
link: LinkSession | null
```

见[uplink-client.ts:63](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-client.ts:63)和[uplink-client.ts:188](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-client.ts:188)。

握手过程：

1. hub 接受 WebSocket，生成 32 字节 nonce。
2. hub 发送 `auth.challenge`。
3. node 使用自身 node Ed25519 私钥签名：

   ```text
   Borsh("tmex/uplink-auth/v1", nonce, hub_host)
   ```

4. node 返回 `auth.response { node_id, sig }`。
5. hub 从本地 `node_certs` 找 node 公钥，验证证书未吊销，再验证签名。
6. 成功后放入本 hub 的 `NodeRegistry`。

hub challenge 见[uplink-server.ts:215](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:215)；验证 node cert 和签名见[uplink-server.ts:539](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:539)。签名对象的定义见[uplink-auth.ts:3](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/auth/uplink-auth.ts:3)。

这里的 `hub_host` 把 node 的 uplink 认证绑定到具体 endpoint，但它不是 hub 的用户信任根。

## 2.3 `node.status`、`peer_cache` 和 inventory

node uplink 成功后发送 `node.status`：

- version
- tmux
- direct capability
- inventory
- peer endpoints

消息定义见[uplink codec:208](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/uplink/codec.ts:208)。

hub 收到后：

1. 更新或创建 `nodes` 行；
2. 更新 `NodeRegistry` 内存 metadata；
3. 广播新的 `node.list`。

见[uplink-server.ts:617](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:617)。

节点收到 `node.list` 后：

- 把 hub 提供的 node metadata 写入本地 `peer_cache`；
- 只接受本地 `node_certs` 中存在、同 user、未 revoked 的 node；
- 对本地没有可信证书的 metadata 不建立 peer；
- 以 `key_log_head` 触发 key log catch-up。

见[uplink-client.ts:555](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-client.ts:555)和[uplink-key-log-sync.ts:158](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-key-log-sync.ts:158)。

此外，node 之间已有有限的 peer metadata gossip：

- peer link 建立后发送 `node.status`；
- 接收方更新 `peer_cache`；
- 若对方 key log head 更高，则通过 peer link 请求 key log。

见[peer-manager.ts:1743](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:1743)。

这不是 hub-to-hub gossip，也不是完整的状态复制。它只是节点间的 metadata 和 key log catch-up。

## 2.4 `node.list` 如何组装

hub 的 `node.list`：

1. 从 `nodes` 表取同一 user 且 `status='enrolled'` 的节点；
2. 从当前 `NodeRegistry` 标记 online；
3. 合并 live registry 中的 version/direct/inventory/endpoints；
4. 附加当前唯一 hub 的 node ID、public URL、name；
5. 附加当前 user 的单个 `key_log_head`；
6. 附加单个 RTC 配置。

见[uplink-server.ts:1065](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:1065)。

wire type 也是单数：

```ts
hub?: {
  nodeId: string;
  publicUrl: string;
  name?: string;
}
```

见[shared uplink codec:172](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/uplink/codec.ts:172)和[codec:524](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/uplink/codec.ts:524)。

节点侧只有一个：

```ts
lastNodeList: UplinkNodeList | null
hubPresenceLive: boolean
hubGeneration: number
```

见[mesh-runtime.ts:607](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:607)。

节点收到 list 后还会保留一个特殊 peer cache 哨兵：

```text
peer_cache.node_id = "hub"
inventory = { nodeId, publicUrl }
```

见[user-store.ts:397](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-store.ts:397)。

## 2.5 `/n/:nodeId` relay 路由

浏览器访问任意远程 node 时：

```text
browser → entry gateway → /n/<target> → PeerManager → target node
```

Forwarder 对 `/n/:id/api/*` 和 `/n/:id/ws` 解析目标 node，然后调用 `PeerManager.getLink(nodeId)`：

[forwarder.ts:142](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/forwarder.ts:142)、[forwarder.ts:576](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/forwarder.ts:576)。

PeerManager 的连接优先级是：

```text
DataChannel > ws-secure > hub relay
```

定义见[peer-manager.ts:100](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:100)。

如果 direct/ws-secure 都失败，node 通过自己的唯一 uplink 请求：

```json
{ "to": "<target-node-id>" }
```

见[peer-manager.ts:1340](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:1340)。

hub 收到 relay stream 后：

1. 验证 source uplink 已认证；
2. 查 source node 的 user；
3. 查 target node 的 `node_certs`；
4. 检查 target 未吊销且属于同一 user；
5. 在当前 hub 的 `NodeRegistry` 查 target；
6. 从 target 的 uplink 打开另一条 stream；
7. 双向复制 stream bytes。

见[uplink-server.ts:906](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:906)。

因此当前 relay 的关键限制是：

```text
target 必须存在于同一个 HubRuntime.registry
```

如果 source 接在 hub A、target 接在 hub B，当前实现没有任何路径找到 target。

## 2.6 浏览器如何选择连接位置

当前浏览器没有 hub 选择逻辑。

`packages/api-client/src/node-url.ts` 明确规定：

- 浏览器只连接当前 entry；
- 远程 node 统一使用当前 origin 的 `/n/<nodeId>`；
- self 使用 `/ws`。

见[node-url.ts:1](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/node-url.ts:1)和[node-url.ts:113](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/node-url.ts:113)。

也就是说，浏览器当前没有：

```text
hub A / hub B / hub C endpoint pool
```

浏览器工作流是：

1. 浏览器与当前 entry 建 Gateway WebSocket。
2. 远程目标使用 `/n/<target>/ws`。
3. entry 负责通过 node peer link 找目标。
4. `DirectCarrierController` 通过目标 node 的 `/api/mesh/connection`、`/api/mesh/rtc-config`、`/api/rtc/authorize` 建 WebRTC。
5. signaling 通过当前 entry 的 `/mesh/ws`。
6. 成功后浏览器 WebSocket 的 primary carrier 切换到 DataChannel。
7. 失败时回到 entry 的 gateway/mesh relay。

`DirectCarrierController` 的完整流程说明在[direct-carrier-controller.ts:1](/Users/konata/code/tmex-enhanced-wt-r13/packages/ws-client/src/direct/direct-carrier-controller.ts:1)，RTC authorization 在[direct-carrier-controller.ts:579](/Users/konata/code/tmex-enhanced-wt-r13/packages/ws-client/src/direct/direct-carrier-controller.ts:579)。

当前 browser 的“hub”实际上只是用户当前访问的 entry node；代码不会探测所有 hub，也不会按 RTT 选择 hub。

## 2.7 LAN 升级到 direct

节点间 direct upgrade 依赖：

- `node.list` 或 peer `node.status` 提供 endpoints；
- 本地 `peer_cache` 缓存地址；
- `TMEX_PEER_PORT`；
- peer handshake；
- WebRTC RTC wake/signaling。

peer handshake 会交换：

- node ID；
- 32 字节 nonce；
- X25519 ephemeral public key；
- 可选 DTLS fingerprint；
- Ed25519 对 transcript 签名。

见[peer-protocol.ts:181](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-protocol.ts:181)。

PeerManager 的拨号顺序：

1. DataChannel；
2. `ws-secure`；
3. 已有 live link；
4. hub relay。

见[peer-manager.ts:1274](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:1274)。

LAN/direct 不是 hub 选择机制。它只是在已经确定 source/target node 后，选择 node-to-node 的最低成本承载。

---

# 3. 当前代码中所有“恰好一个 hub”的假设

| 层次 | 当前假设 | 代码/文档 |
|---|---|---|
| 角色 | 只有 `standalone`、`node`、`hub,node`，没有纯 hub | [roles.ts:1](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/roles.ts:1)、[config.ts:78](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/config.ts:78) |
| 配置 | 一个 `TMEX_HUB_URL`、一个 `TMEX_HUB_PUBLIC_URL` | [config.ts:199](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/config.ts:199) |
| 本机身份 | `node_identity` 是 `id=1` singleton，只有一个 `hub_url` | [schema.ts:637](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/db/schema.ts:637) |
| mesh runtime | `MeshRuntimeConfig.hubUrl: string|null`，只有一个 `uplink` | [mesh-runtime.ts:65](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:65)、[mesh-runtime.ts:267](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:267) |
| uplink client | 一个 URL、一个 link、一个重连 loop、一个 key-log channel | [uplink-client.ts:63](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-client.ts:63)、[uplink-client.ts:353](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-client.ts:353) |
| uplink auth | 签名绑定单个 `hub_host` | [uplink-auth.ts:13](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/auth/uplink-auth.ts:13) |
| hub TLS | `createHubFetcher` 和 runtime wiring 根据一个 `hubUrl` 查一条 pin | [hub-client.ts:63](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/lib/hub-client.ts:63)、[mesh-runtime.ts:854](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:854) |
| hub metadata | `peer_cache.node_id='hub'` 只有一条哨兵行 | [user-store.ts:149](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-store.ts:149)、[user-store.ts:416](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/user-store.ts:416) |
| wire contract | `node.list.hub` 是单数对象，不是 `hubs[]` | [codec.ts:174](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/uplink/codec.ts:174) |
| node list state | `lastNodeList`、`hubPresenceLive`、单个 `lastRtc` | [mesh-runtime.ts:607](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:607) |
| stale cache 清理 | `pruneStaleListedPeers` 特殊保留的 hub 只有一个 `hubId` | [mesh-runtime.ts:841](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:841) |
| hub registry | 每个 `HubRuntime` 只有一个 `NodeRegistry` | [hub-runtime.ts:131](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-runtime.ts:131) |
| relay | target 必须在当前 hub 的 registry 中 | [uplink-server.ts:930](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:930) |
| RTC signaling | `rtcSessions` 和 signal routing 只在一个 hub 内查找 | [uplink-server.ts:864](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:864) |
| PeerManager | 一个 `uplink`、一个 `hubHost` | [peer-manager.ts:110](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:110)、[peer-manager.ts:303](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:303) |
| relay diagnostics | relay 的 `peerAddress` 直接显示唯一 hub host | [peer-manager.ts:433](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/peer-manager.ts:433) |
| node API | `/api/mesh/nodes` 根据一个 `hubNodeId` 标记 hub | [mesh-routes.ts:263](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-routes.ts:263) |
| FE hub lookup | `findHubNodeId` 只返回一个 node | [mesh-nodes.ts:186](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/mesh-nodes.ts:186) |
| FE hub API | `HubApi` 绑定一个 `hubNodeId`，路径是 `/n/<hub>/api/hub/*` | [hub-api.ts:63](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/hub-api.ts:63) |
| FE load coordinator | 请求对象和状态都是针对单个 hub | [mesh-nodes.ts:634](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/node/mesh-nodes.ts:634) |
| CLI join | `tmex hub join <url> --token` 只接受一个 URL | [help.ts:14](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/cli/help.ts:14)、[hub.ts:589](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/commands/hub.ts:589) |
| CLI enroll | 非 hub 节点从唯一 `TMEX_HUB_URL` 创建 enrollment | [enroll.ts:312](/Users/konata/code/tmex-enhanced-wt-r13/packages/app/src/commands/enroll.ts:312) |
| join CA pin | join string 只携带一个 hub 的 fingerprint | [operations:111](/Users/konata/code/tmex-enhanced-wt-r13/docs/hub/2026082800-hub-node-operations.md:111) |
| browser URL | 浏览器始终连当前 entry origin；没有 hub endpoint pool | [node-url.ts:1](/Users/konata/code/tmex-enhanced-wt-r13/packages/api-client/src/node-url.ts:1) |

---

# 4. 信任模型与第二个 hub

## 4.1 当前信任链

设计文档的核心约束是：

> hub 不是信任根，用户持有 root key，node 成员资格由用户签发的证书证明。

见[架构设计:90](/Users/konata/code/tmex-enhanced-wt-r13/docs/hub/2026082700-hub-node-architecture.md:90)和[架构设计:94](/Users/konata/code/tmex-enhanced-wt-r13/docs/hub/2026082700-hub-node-architecture.md:94)。

当前链路如下：

```text
用户 root key
  ↓ 签名
enrollment authorization
  ↓ 授权 enrollment key 签名 node certificate
node certificate
  ↓ 被用户签名的 admit-node key-log record 接纳
node_certs 投影
  ↓
uplink / peer handshake 验证 node 身份
```

node certificate 由 enrollment key 签发，但 enrollment key 本身来自用户授权；hub 只是存储和转发这些签名对象。

## 4.2 user key log

`user_key_log` 是自描述、严格有序的 signed hash chain：

```text
record = {
  uid,
  seq,
  prev_hash,
  root_epoch,
  type,
  payload,
  signer,
  credential_id
}

hash = sha256(record_bytes || sig)
```

共享实现：

- `seq` 和 `prev_hash` 生成：[key-log.ts:161](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/auth/key-log.ts:161)
- fork 检测：[key-log.ts:205](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/auth/key-log.ts:205)
- 完整 chain 验证：[key-log.ts:490](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/auth/key-log.ts:490)

验证规则：

- 第一条必须是 `reset-root`，且 `seq=1`；
- 后续记录必须严格是本地 head 的下一条；
- `prev_hash` 必须匹配；
- signer 必须是当前 root 或已注册 passkey；
- root rotation 后必须使用新 `root_epoch`；
- 两个不同后继对应同一 `seq/prev_hash` 时报告 `fork`；
- 不由 hub 选胜者。

完整链验证会从 genesis replay 到目标 head，并检查 root/head 是否一致：[key-log.ts:524](/Users/konata/code/tmex-enhanced-wt-r13/packages/shared/src/auth/key-log.ts:524)。

## 4.3 catch-up

当前 catch-up 已经支持：

- 本地落后：向 hub 或 peer 请求后续日志；
- 本地领先：向 hub 推送缺失日志；
- 本地和远端 seq 相同但 hash 不同：硬失败；
- 收到 seq gap：拆除连接；
- 应用多个记录时使用事务和 head CAS。

见[uplink-key-log-sync.ts:273](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-key-log-sync.ts:273)、[uplink-key-log-sync.ts:338](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-key-log-sync.ts:338)和[uplink-key-log-sync.ts:450](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-key-log-sync.ts:450)。

## 4.4 第二个 hub 不成为新信任根的方式

第二个 hub 可以被建模为：

```text
一个已经被用户 admit 的普通 node
+ hub,node 服务能力
+ 对 signed state 的缓存/复制能力
```

而不是：

```text
第二套用户根密钥
第二个用户目录
第二套 hub 自己签发的证书
```

具体要求：

1. 两个 hub 都只存用户 root public key，不持有 root private key。
2. 两个 hub 复制 raw `record_bytes + sig`，不要重新签名。
3. standby 收到日志后，使用已有 `UserKeyService.applyMany` 验证并应用。
4. `node_certs` 继续由 `admit-node` key-log record 投影生成。
5. 所有 node 继续独立验证证书和 key log，不把另一个 hub 的数据库投影当成信任来源。
6. hub-to-hub 链路只能认证“这是一个已 admit 的 node”，不能赋予 hub 签发用户凭证的能力。
7. hub endpoint 的 TLS CA pin 仍然需要按 URL 保存，但 `hub_trust` 只是传输层约束，不替代用户签名链。

被攻陷的 hub 仍然可以：

- 隐藏节点；
- 返回旧数据；
- 拒绝服务；
- 伪造 metadata；
- 观察它能看到的连接元数据；
- 作为当前浏览器 entry 时，在浏览器 session 窗口内代理用户操作。

但它不能在没有用户签名的情况下：

- 创建合法 `admit-node`；
- 替换已有 node 公钥；
- 生成合法 root rotation；
- 伪造新的 key-log 后继；
- 让 node 接受一个不在用户证书链中的 node。

## 4.5 一个需要补充的授权问题

当前 `TmexRoleName` 是运行配置，不是用户签名授权。若未来任意已 admit node 都能通过改配置成为 hub，仍然不会获得用户签名能力，但它可能被列入“hub endpoint”。

建议后续增加以下之一：

- 在 key log 中增加用户签名的 `admit-hub` / `revoke-hub` 记录；
- 或让 `admit-node` 的授权 payload 带 `hub_capable`；
- 或在第一阶段只允许固定配置的 hub URL，不把 hub promotion 做成远程 UI 行为。

这部分是设计建议，当前代码没有实现。

---

# 5. 多 hub 设计选项

## 5.1 方案 A：固定 active/standby

### 核心模型

- 一个 mesh 只有一个 writer hub。
- standby hub 可读取已复制状态，但默认拒绝写。
- node 保存有序 hub URL 列表。
- node 运行时连接 active hub；失败后按顺序 failover。
- promotion 是显式操作，不自动进行。

这对应用户给出的最简单选项。

### 数据模型变化

建议新增：

```text
mesh_hubs
  hub_id
  public_url
  ca_fingerprint
  priority
  mode                 -- active / standby
  writer_epoch
  last_seen_at

hub_replication_state
  hub_id
  user_id
  source_head_seq
  source_head_hash
  applied_at
  status
```

可选：

```text
node_hub_links
  node_id
  hub_id
  last_connection_at
  last_rtt_ms
  state
```

现有表处理方式：

- `user_key_log`：保持格式不变；复制 raw signed records。
- `users`、`user_keys`、`node_certs`：由 standby 重放 key log 生成。
- `nodes`：复制 registry metadata。
- `enrollment_tokens`：复制 pending token；redeem 只允许 writer。
- `node_sessions`：首阶段可以不跨 hub 保证现有 cookie，切换后要求重新登录；若要保留 session，需要复制 session 和撤销状态。
- `peer_cache`：不再使用单个 `node_id='hub'` 哨兵，改用独立 `mesh_hubs`。
- `node_identity.hub_url`：保留为兼容字段，但运行配置改为 hub pool 或新表。

### 协议变化

在现有 `node.list` 上增加：

```ts
hubs: Array<{
  hubId: string;
  publicUrl: string;
  priority: number;
  mode: 'active' | 'standby';
  writerEpoch: number;
  rttHint?: number;
}>;
writerHubId: string;
writerEpoch: number;
```

新增 hub-to-hub 或 standby replication 消息：

```text
replication.hello
replication.snapshot.begin
replication.snapshot.chunk
replication.snapshot.commit
replication.keylog.head
replication.keylog.records
replication.nodes
replication.enrollment_tokens
replication.ack
```

所有复制消息必须有：

- `mesh_id`；
- `source_hub_id`；
- `writer_epoch`；
- `user_id`；
- source head seq/hash；
- request/idempotency ID。

### 写入策略

以下写操作只在 writer hub 执行：

- 创建 enrollment token；
- redeem enrollment token；
- rename；
- `admit-node`；
- `revoke-node`；
- root rotation；
- key-log append。

standby 收到写请求时返回：

```text
HUB_NOT_WRITER
writer_hub_id
writer_public_url
writer_epoch
```

如果 writer 不可达，首阶段不自动接受写，避免 split-brain。操作员显式执行：

```bash
tmex hub promote <hub-id>
```

promotion 必须增加 `writer_epoch`，并要求旧 writer 被确认停止或被隔离。否则旧 writer 恢复后可能继续写入旧 epoch。

### 节点如何选 hub

首阶段不按实时 RTT 选择：

```text
active priority → standby priority
```

可以在连接时测量 RTT，但只用于：

- 诊断；
- active 故障时的 standby 排序；
- UI 展示。

如果允许 active/standby 都在线，不能因为 standby RTT 更低就把写请求发给 standby。

后续增强：

- 对所有 hub 的 `/healthz` 和 uplink handshake 测 RTT；
- sticky 选择；
- 30–60 秒周期重新探测；
- 只有 RTT 优势超过 hysteresis 阈值才切换；
- 连接失败、认证失败、writer epoch 变化时立即重新选择。

### 浏览器行为

第一阶段：

- 浏览器仍连接当前 entry；
- entry 使用当前 active hub；
- hub 切换后 entry 的 uplink 重建；
- 浏览器保留 UI，但 hub entry 的 node session 可能需要重新登录。

如果浏览器当前访问 hub A，而 hub A 故障：

1. 用户切到 hub B 的 URL；
2. 浏览器在 hub B 上重新建立 session；
3. 通过 hub B 获取 node list；
4. 目标 node 重新完成登录绑定。

原因是 `node_sessions.via_node_id` 绑定 entry node，当前设计不是可跨 entry 复用的全局 bearer token。

### relay

第一阶段要求所有 node 都跟随 active hub，因此任意 source/target 都会出现在同一 hub registry 中，不需要 hub-to-hub relay。

如果后续允许 source 接 hub A、target 接 hub B，需要：

```text
hub A → hub B → target uplink
```

新增：

```text
hub.route.lookup
hub.relay.open
hub.relay.accept
hub.relay.close
```

hub A 只转发 node-to-node `SecureChannel` 的密文，hub B 负责：

- 查 target location；
- 校验 target certificate/revocation；
- 打开 target uplink stream；
- 设置 `trace_id` 和 hop limit 防循环。

### 优点

- 保持 user key log 的单序列语义；
- token redeem 不需要分布式冲突解决；
- revocation 规则简单；
- 可以复用现有 key log catch-up；
- 兼容现有 node/peer/direct 协议。

### 缺点

- 不能同时让不同 node 使用不同最近 hub；
- 自动 promotion 风险高；
- standby 可能暂时落后；
- hub 切换可能导致 entry session 重新登录；
- 真正的跨 hub relay仍需第二阶段。

---

## 5.2 方案 B：multi-primary + signed log + 确定性冲突规则

### 核心模型

多个 hub 同时接受连接和部分写入。

但这里有一个根本问题：

```text
user_key_log.seq + prev_hash
```

不允许两个 hub 同时生成不同的同序号后继。单纯使用 LWW 会破坏 key log 的安全模型。

因此必须把数据分为两类：

### 必须单 authority 的数据

- user key log 的全局顺序；
- root rotation；
- node admit/revoke；
- enrollment token redeem；
- node ID reuse；
- writer epoch。

可选实现：

1. 每个 user 固定一个 owner hub；
2. owner hub 挂掉时显式转移 owner；
3. 非 owner hub 把写请求转发给 owner；
4. owner 为每个 append 生成全局序列。

### 可采用 LWW/CRDT 的数据

- node name；
- inventory；
- endpoint；
- version；
- last_seen；
- direct capability。

建议使用：

```text
(writer_epoch, logical_clock, hub_id)
```

作为确定性排序键，而不是依赖墙上时钟。

### 数据模型变化

新增：

```text
hub_event_log
  event_id
  user_id
  source_hub_id
  writer_epoch
  logical_clock
  event_type
  payload
  signature
  applied_at

keylog_owners
  user_id
  owner_hub_id
  owner_epoch

enrollment_claims
  enrollment_id
  owner_hub_id
  claim_epoch
  claimed_at
  redeemed_at
```

`nodes` 需要 tombstone 或版本字段，防止旧 hub 恢复后把 revoked/删除状态写回来。

### 协议变化

需要：

- `hub.membership`
- `hub.owner`
- `keylog.append.propose`
- `keylog.append.commit`
- `enrollment.claim`
- `enrollment.claim.ack`
- `state.anti_entropy`
- `state.conflict`
- `node.location`

如果 key log 仍保持当前格式，则真正 append 仍必须经过 owner。若希望完全多 primary，就必须修改 key-log 模型为：

```text
每个 hub 一个 signed branch
↓
由后续 canonical merge 记录合并
```

这会改变所有 node 的验证算法，且无法简单复用现有 `seq + prev_hash` catch-up。

### 节点选择

每个 node 可以同时连接多个 hub：

- 业务 data-plane 选择最低 RTT；
- key-log 写请求路由到 owner；
- enrollment redeem 路由到 token owner；
- revocation 等安全操作不能只根据 RTT 发送。

需要在 node 上维护：

```text
HubConnectionPool
  hub_id
  url
  tls pin
  state
  rtt
  writer epoch
  capabilities
```

### 浏览器选择

浏览器可以：

1. 使用 bootstrap hub list；
2. 探测多个 hub endpoint；
3. 选择最低 RTT hub 作为 entry；
4. sticky 当前 hub；
5. hub 故障时切换；
6. 对目标 node 的认证和 session 仍需绑定新的 entry。

浏览器直连目标 node 成功后，hub 只负责 signaling，数据面不经过 hub。

### 跨 hub relay

必须实现 hub-to-hub forwarding。source hub 需要知道 target 当前挂在哪个 hub：

```text
source node
  → hub A
  → hub B
  → target node
```

目标 node 仍然进行 node-to-node signed handshake 和 `SecureChannel`，两个 hub 只转发密文。

### 优点

- 可以实现真正的最近 hub；
- 单个 hub 故障不会阻止所有非安全 metadata 写入；
- 更适合跨地域部署。

### 缺点

- 当前 key log 模型无法直接支持并发写；
- enrollment token redeem 仍需 owner/claim；
- revocation 需要 fail-closed 传播；
- hub location 需要反熵同步；
- mixed-version 兼容复杂；
- 远高于 1–2 天的实现量。

---

## 5.3 方案 C：Raft/完整共识

### 核心模型

所有 hub 作为 consensus members：

- Raft term；
- leader；
- commit index；
- quorum；
- snapshot；
- membership change；
- fencing token；
- leader lease。

以下数据由 Raft 序列化：

- key log append；
- root rotation；
- node admit/revoke；
- enrollment claim/redeem；
- writer epoch；
- hub membership。

业务数据面仍可保持现有 mesh：

```text
direct DataChannel
ws-secure
hub relay
```

Raft 只负责控制面，不负责终端/file stream。

### 主要问题

两个 hub 不能可靠处理单点故障：

```text
2 个成员时，quorum = 2
任一 hub 掉线后无法提交写操作
```

因此生产上至少需要 3 个 consensus members，或者引入第三个 witness。

还需要处理：

- 网络分区；
- 旧 leader 恢复；
- fencing；
- snapshot 和 SQLite 持久化；
- quorum 不可用时的用户体验；
- 版本升级；
- membership 变更；
- hub-to-hub 链路认证。

### 结论

这是长期最完整的方案，但与当前单机 SQLite、Bun runtime、轻量 hub 设计不匹配，明显超出本需求的第一阶段。

---

# 6. 推荐方案和第一阶段任务拆分

## 6.1 推荐范围

建议选择方案 A，但把首个可交付增量限制为：

```text
固定 active/standby
单 writer
有序 uplink failover
signed state replication
显式 promotion
```

首阶段不做：

- 自动 leader election；
- 多 primary；
- 任意 node 同时连接不同 hub；
- hub-to-hub relay；
- 透明保留所有跨 entry session；
- UI 远程自动 promote。

这样仍然能交付：

- 主 hub 掉线后 node 可连 standby；
- standby 可恢复 node list、证书和 key log；
- node-to-node direct/LAN 继续工作；
- relay 在所有 node 切换到 standby 后继续工作；
- 写操作在未 promote 时安全拒绝。

“每个 node 连接最近 hub”作为第二阶段。若把它也放入第一阶段，预计无法在 1–2 天内完成，这是未验证的工程估算。

## 6.2 后端与共享协议

### Agent A：shared contract/config

文件：

- `packages/shared/src/uplink/codec.ts`
- `apps/gateway/src/mesh/uplink-protocol.ts`
- `packages/shared/src/roles.ts`
- `apps/gateway/src/config.ts`

任务：

1. 增加 `HubEndpoint`、`HubSet`、`writerHubId`、`writerEpoch`。
2. 保持旧 `hub` 字段兼容，新增 `hubs[]`。
3. 增加 replication wire messages。
4. 增加 idempotency/request ID。
5. 保持旧 node 对新字段可忽略。
6. 为 writer epoch 增加严格比较规则。

### Agent B：uplink pool/failover

建议新增：

```text
apps/gateway/src/mesh/uplink-pool.ts
```

或在 `uplink-client.ts` 上抽象连接池。

改动：

- `UplinkClient` 从单 URL 改为单 endpoint 实例；
- 新增 `UplinkPool` 管理多个 endpoint；
- 同时只激活一个 uplink；
- 按 priority/active mode failover；
- 每个 hub 分别加载 `HubTrustStore` CA；
- active 切换时重新发送 `node.status`；
- 取消旧 hub 的 keylog catch-up task；
- 防止旧连接的 node list 覆盖新连接；
- 保存 `sourceHubId` 和 `writerEpoch`。

重点文件：

- `apps/gateway/src/mesh/uplink-client.ts`
- `apps/gateway/src/mesh/uplink-key-log-sync.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/auth/hub-trust-store.ts`

### Agent C：hub replication

建议新增：

```text
apps/gateway/src/hub/hub-replication.ts
```

改动：

- `HubRuntime`
- `UplinkServer`
- `NodeRegistry`
- `node-persistence.ts`
- `user-key-service.ts`

复制顺序建议：

1. user identity/root/head；
2. raw key log records；
3. `node_certs` 投影；
4. `nodes` 注册表；
5. pending enrollment tokens；
6. 可选 session/revocation state。

standby 应该：

- 先验证 key log record；
- 再使用 `UserKeyService.applyMany`；
- 确认本地 head 与 source head 一致；
- 再应用 nodes/token snapshot；
- 不接受本地安全写请求。

新增 migration 建议：

```text
0032_hub_membership_replication.sql
```

至少包含：

```text
mesh_hubs
hub_replication_state
```

不要复制 SQLite 文件本身。应该复制协议级 signed records 和明确的 snapshot。

### Agent D：CLI/config

文件：

- `packages/app/src/commands/hub.ts`
- `packages/app/src/commands/enroll.ts`
- `packages/app/src/lib/hub-client.ts`
- `packages/app/src/lib/install.ts`
- `packages/app/src/types.ts`
- `packages/app/src/cli/help.ts`
- `packages/app/src/lib/args.ts`
- `apps/gateway/src/config.ts`

建议兼容策略：

```text
TMEX_HUB_URL       继续支持，表示第一个 hub
TMEX_HUB_URLS      新增，逗号分隔或 JSON
```

CLI：

```bash
tmex hub join <seed-url> --token <token>
tmex hub list
tmex hub promote <hub-id>
```

第一阶段 `hub join` 可以仍然只指定 seed hub，由返回 payload 下发完整 hub set。

`hub promote` 应：

- 增加 writer epoch；
- 写入本地配置；
- 可选要求用户显式确认；
- 不自动执行。

### Agent E：FE

文件：

- `apps/fe/src/node/mesh-nodes.ts`
- `apps/fe/src/node/hub-api.ts`
- `apps/fe/src/node/hub-load-coordinator.ts`
- `apps/fe/src/node/node-runtimes.ts`
- Nodes 页面相关组件

首阶段 UI 应显示：

- hub 名称；
- active/standby；
- 当前连接 hub；
- writer hub；
- last seen；
- replication head；
- RTT/连接状态；
- 当前 hub 是否可写。

需要移除或改造这些单数假设：

- `findHubNodeId()` 只返回一个 hub；
- `HubNodeState.hubNodeId`；
- `HubApi` 绑定单一 node；
- “第一个 `isHub` 就是 hub”的逻辑。

首阶段可以暂时只允许管理 API 发往 writer hub；standby 返回 `HUB_NOT_WRITER` 后 FE 提示跳转/切换。

### Agent F：测试与 Docker harness

重点测试：

- 两个 hub 的 key log 复制；
- standby 重放后 head/hash 一致；
- standby 不接受 enrollment/revoke/rename；
- active 切换后 node list 恢复；
- 旧 writer epoch 被拒绝；
- enrollment token 不重复 redeem；
- revoked node 在 standby 上仍被拒绝；
- hub CA pin 按 URL 隔离；
- hub 切换时旧 node list 不覆盖新 list；
- relay 在所有 node 切到 standby 后仍可用；
- LAN/DC 不依赖 hub 的场景仍通过。

---

# 7. 风险清单

## 7.1 Split-brain

最严重风险。

如果 hub A 和 hub B 都认为自己是 writer，可能产生：

- 同一个 key-log seq 的不同后继；
- enrollment token 被两边同时 redeem；
- 同一个 node ID 的不同证书；
- revoke 与 re-admit 交叉；
- node list 回滚。

第一阶段必须：

- 默认只有一个 writer；
- standby 明确拒绝写；
- promotion 增加 epoch；
- 旧 writer 恢复后不能自动继续写；
- 不能只依赖墙上时钟或最后收到的 heartbeat。

## 7.2 key log divergence

当前 key log 是严格链，不是 CRDT。

任何两个不同后继都会触发 fork。必须复制原始 signed record，并在 standby 使用现有验证器应用，不能直接复制 `users.key_log_head_*` 而跳过日志。

## 7.3 duplicate node ID

当前 `nodes.id` 和 `node_certs.node_id` 都唯一。

同 node ID 不同公钥必须继续返回冲突；不能使用 LWW 覆盖。redeem 的现有冲突检查见[hub-runtime.ts:643](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-runtime.ts:643)。

## 7.4 enrollment token 一次性 redeem

必须由 writer 串行处理，或者引入 owner/claim。复制延迟期间，standby 不应接受旧 pending token 的 redeem。

## 7.5 revocation propagation

node revoked 后：

- `node_certs.revoked_log_seq`；
- `nodes.status`；
- `node_sessions`；
- uplink；
- peer links；
- relay；
- RTC sessions；

都需要收敛。

对于安全操作，复制延迟时应 fail-closed，而不是继续接受可能已吊销的 node。

## 7.6 session 与 `via_node_id`

`node_sessions` 不是全局 JWT，而是查库状态，并绑定 `viaNodeId`。hub 切换会改变浏览器 entry node，现有 session 可能无法直接复用。

首阶段应明确：

- hub entry 切换后重新登录；
- 或复制 sessions 并重新设计 via 绑定；
- 不能悄悄把 session 当成跨 entry bearer token。

## 7.7 mixed-version upgrade

旧版本只认识：

- 一个 `TMEX_HUB_URL`；
- 一个 `node.list.hub`；
- 一个 `key_log_head`；
- 一个 uplink。

因此新 hub set 必须：

- 保持旧字段；
- 老 node 至少仍能连接 seed/active hub；
- 新 hub 不应要求旧 node 发送新字段；
- writer epoch 不应被旧 node 当作普通 metadata 忽略后继续执行危险写操作。

## 7.8 hub CA pin 和 trust anchor

每个 hub 可能有自己的 self-signed CA。应按 hub URL 保存 pin，不能把一个 hub 的 CA 当作另一个 hub 的 CA。

共享 CA 更易测试，但生产上会扩大 TLS CA compromise 的影响范围。无论采用哪种方式，CA 都不是用户 key log 的信任根。

## 7.9 relay loop 和 hub location stale

后续跨 hub relay 需要：

- source hub；
- target hub；
- hop limit；
- trace ID；
- stale location 重试；
- 避免 A→B→A 循环；
- 目标证书和用户归属在最终 hub 再次验证。

## 7.10 SQLite 状态复制

不能直接复制 SQLite 文件，尤其是 WAL 状态。

需要：

- protocol-level snapshot；
- 事务边界；
- head/hash 校验；
- crash resume；
- cursor；
- idempotency；
- snapshot 与 incremental log 的一致性点。

---

# 8. 当前测试覆盖

## 8.1 Hub 和认证单元测试

现有 hub 测试：

- `hub-runtime.test.ts`：HTTP hub API、enrollment、rename、revoke、node list。
- `uplink-server.test.ts`：uplink auth、node list、heartbeat、RTC、relay。
- `node-registry.test.ts`：registry put/remove/generation。
- `uplink-protocol.test.ts`：uplink codec。
- `uplink-rate-limit.test.ts`：key log request rate limit。
- `key-log-page.test.ts`：key log 分页。
- `redeem-pop.ts`：redeem proof helper。

文件列表可见[apps/gateway/src/hub](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub)。

认证/存储测试包括：

- `key-log-store.test.ts`
- `user-key-service.test.ts`
- `user-key-persistence.test.ts`
- `node-session-store.test.ts`
- `node-identity-store.test.ts`
- `node-identity-service.test.ts`
- `hub-trust-store.test.ts`
- `schema.migration.test.ts`
- `mesh-membership-store.test.ts`

schema 测试明确覆盖了核心 hub 表：[schema.migration.test.ts:7](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/auth/schema.migration.test.ts:7)。

## 8.2 Mesh 单元测试

主要测试：

- `uplink-client.test.ts`
- `uplink-key-log-sync.test.ts`
- `peer-manager.test.ts`
- `peer-manager.upgrade.test.ts`
- `peer-protocol.test.ts`
- `peer-server.test.ts`
- `mesh-routes.test.ts`
- `mesh-runtime.test.ts`
- `mesh-runtime-node-presence.test.ts`
- `node-list-projection.test.ts`
- `forwarder.test.ts`
- `stream-targets.test.ts`
- `mesh-http.test.ts`
- `auth-routes.test.ts`
- RTC、DataChannel、carrier switch、fragmenter、liveness 等测试。

## 8.3 Mesh 集成测试

当前集成测试：

| 测试 | 覆盖 |
|---|---|
| `hub-contract.integration.test.ts` | production wiring、hub meta、targeted `ENROLL_REDEEMED` |
| `mesh.integration.test.ts` | hub + node、enrollment、peer wiring、mesh phase 2 |
| `stream-failover.integration.test.ts` | DataChannel 断开后 entry WS stream 保持连续 |
| `direct-path.integration.test.ts` | direct path |
| `rtc-wake.integration.test.ts` | authenticated uplink 上的 RTC wake |
| `dc-http-bulk.integration.test.ts` | DataChannel 上的 bulk HTTP |

例如 hub contract 测试当前只启动一个 `HubRuntime`，并断言 `lastNodeList.hub` 是单个对象：[hub-contract.integration.test.ts:163](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/integration/hub-contract.integration.test.ts:163)。

stream failover 测试也使用单个 hub/node runtime：[stream-failover.integration.test.ts:317](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/integration/stream-failover.integration.test.ts:317)。

## 8.4 Docker harness 当前拓扑

普通 harness：

```text
caddy
  ├── hub
  ├── node-a
  └── node-b

driver
```

基础 compose：

- `hub` 使用 `hub-data`；
- `node-a` 使用 `node-a-data`；
- `node-b` 使用 `node-b-data`；
- hub 和 node-a 在 `uplink-a`；
- node-b 在 `uplink-b`，故意不与 hub 直接共享网络；
- caddy 同时连接 edge、uplink-a、uplink-b。

见[docker-compose.yml:3](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/docker-compose.yml:3)和[docker-compose.yml:56](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/docker-compose.yml:56)。

现有 harness 已覆盖：

- hub health；
- 用户创建；
- node enroll/join；
- hub list；
- node-a 作为 entry；
- node-b relay；
- LAN path；
- hub down/up；
- node restart；
- direct/DataChannel；
- terminal/file；
- TOTP；
- revoke node。

测试段落见：

- enroll/join：[split/run.sh:678](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:678)
- hub list：[split/run.sh:695](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:695)
- node-a entry：[split/run.sh:890](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:890)
- LAN 和 hub down/up：[split/run.sh:984](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:984)
- hub restart：[split/run.sh:1128](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:1128)
- direct/relay：[split/run.sh:1238](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:1238)
- revoke：[split/run.sh:1640](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:1640)

split harness 当前是远端单 hub + 本地 NAT nodes：

- 远端只有一个 `hub` service；
- caddy 对外暴露 hub HTTPS；
- 本地 node-a/node-b 分别位于两个 NAT network；
- remote compose 的 hub 使用一个 `hub-data` volume；
- 本地 compose 的 node 使用各自 volume。

见[remote compose:43](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/docker-compose.remote.yml:43)和[local compose:26](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/docker-compose.local.yml:26)。

---

# 9. 如何把第二个 hub 加入 Docker topology

## 9.1 普通 compose

新增：

```text
hub-a-data
hub-b-data
hub-a
hub-b
caddy
node-a
node-b
driver
```

建议：

- `hub-a`、`hub-b` 各自使用独立 volume；
- `hub-a`、`hub-b` 各自有独立 `TMEX_HUB_PUBLIC_URL`；
- production-like 测试中每个 hub 使用独立 CA，并让 node pin 两个 CA；
- 两个 hub 加入 `hub-repl` network；
- node-a/node-b 能够访问两个 hub 的 HTTPS/uplink endpoint；
- driver 能访问两个 public URL；
- 若第一阶段只测试 active/standby，可以让两个 hub 都暴露在同一 edge network 的不同 host/port。

示意：

```text
edge
 ├── caddy-a → hub-a
 └── caddy-b → hub-b

hub-repl
 ├── hub-a
 └── hub-b

node-a ── hub-a / hub-b
node-b ── hub-a / hub-b
```

第一阶段不需要 hub-to-hub relay，因为所有 node failover 后都会接到同一个 active hub。

## 9.2 split harness

现有 remote compose 中：

- `hub` 服务暴露 TCP 39001 peer port；
- caddy 暴露 `${TMEX_E2E_HUB_PORT}`；
- hub 使用 `hub-data`；
- setup 脚本会 patch public URL 并 restart hub。

见[remote compose:23](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/docker-compose.remote.yml:23)和[setup-remote.sh:94](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/setup-remote.sh:94)。

增加第二 hub 时可采用：

```text
hub-a : 18443
hub-b : 18444
```

并增加：

```text
hub-a-data
hub-b-data
caddy-a / caddy-b
```

或者用一个 caddy，根据不同 hostname 路由：

```text
hub-a.test → hub-a
hub-b.test → hub-b
```

测试流程：

1. 在 hub-a 创建用户；
2. 在 hub-a 创建 enrollment；
3. node join 得到 `hubs[]`；
4. hub-b 完成 initial snapshot/key-log replication；
5. node 连接 hub-a；
6. 验证 hub-a/hub-b head/hash 相同；
7. 停止 hub-a；
8. node failover 到 hub-b；
9. 验证 `/api/mesh/nodes`、登录、terminal、relay；
10. hub-b 未 promotion 前验证写操作返回 `HUB_NOT_WRITER`；
11. 显式 promote hub-b；
12. 验证新 enrollment/revoke；
13. 恢复 hub-a；
14. 验证 hub-a 作为 standby 重新同步，没有 ghost node、重复 token 或 key-log fork。

现有脚本已经有 hub restart、node reconnect、ghost row 检查，可以直接扩展：

- hub restart 场景：[split/run.sh:1128](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:1128)
- node list 检查：[split/run.sh:695](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:695)
- revoke 后检查：[split/run.sh:1657](/Users/konata/code/tmex-enhanced-wt-r13/scripts/hub-e2e/split/run.sh:1657)

## 9.3 推荐新增 Docker 断言

```text
A1  两个 hub 具有相同 user key-log head/hash
A2  两个 hub 具有相同 admitted certs
A3  standby 不接受 enrollment write
A4  active hub down 后 node 连接 standby
A5  standby node.list 可恢复
A6  hub-b relay source → target 成功
A7 旧 writer epoch 的写请求被拒绝
A8 enrollment token 只有一次 redeem
A9 revoke 在两 hub 收敛
A10 hub-a 恢复后重新成为 standby 且无重复节点
A11 key-log fork 导致 standby fail-closed
A12 direct/LAN 不因 active hub 切换而退化为必须经过 hub
```

以上测试建议在当前 Docker harness 中使用独立的 compose project/network；不要依赖本机生产 tmex 或默认 `tmux` session。