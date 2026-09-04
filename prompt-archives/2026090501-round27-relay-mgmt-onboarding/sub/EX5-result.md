# 审计结论

- Relay 服务端没有持久化“成员最后错误”字段。`relay_nodes` 仅保存成员身份、令牌、状态和时间等信息；成员认证失败通常通过关闭 uplink 传递，不会写入成员表。[mesh-relay.ts](/Users/konata/code/tmex-r27/apps/gateway/src/db/schema/mesh-relay.ts:4)
- `lastError` 主要是节点侧 uplink 客户端和 `UplinkPool` 的内存诊断信息。
- Relay 配额实际只有三个字段：`maxNodes`、`maxStreams`、`bandwidthBytesPerSec`。
- 服务端已经有节点数、并发流、流量速率等实时数据，但 API 没有统一的 `quota + usage` 结构；节点状态接口尤其不完整。
- 节点支持同时配置多个 Relay，但只有一个运行时 Relay 被标记为 `attached`。已有内部 `switchTo()`，没有对外的切换 API。

## 1. Last error

### 1.1 写入位置和生命周期

| 位置 | 写入内容 | 是否成功连接后清除 |
|---|---|---|
| `RelayUplinkClient.lastConnectError` | `connect-failed`、`stopped`、`missed-pong`、`ping-failed`、`kicked:<reason>` | 否 |
| `UplinkClient.lastConnectError` | 经过分类的连接错误，如 `dns`、`refused`、`timeout`、`tls`、`auth_rejected`、`protocol`、`http_<status>`、`unknown` | 否 |
| `UplinkPool.diagByUrl[url].lastError` | 连接尝试的原始错误文本或安全化后的字符串 | 否 |
| Relay 服务端 `relay_nodes` | 没有 `lastError` 字段 | 不适用 |

`RelayUplinkClient.tearDownLink(reason)` 会无条件写入 `lastConnectError`。[relay-uplink-client.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:581)

目前这些调用会产生以下直接错误字符串：

- `connect-failed`：[relay-uplink-client.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:191)
- `stopped`：[relay-uplink-client.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:237)
- `missed-pong`、`ping-failed`：[relay-uplink-heartbeat.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-heartbeat.ts:4)
- `kicked:password_rotated`、`kicked:kicked`、`kicked:revoked`：Relay 控制消息的 reason 枚举见 [codec.ts](/Users/konata/code/tmex-r27/packages/shared/src/relay/codec.ts:489)，写入见 [relay-uplink-client.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:422)

`connectWithLink()` 成功后只重置连接状态，不重置 `lastConnectError`。[relay-uplink-client.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:205)  
因此成功重连后，状态接口仍可能展示上一次错误。

通用 `UplinkClient` 的错误分类规则为：

- `dns`
- `refused`
- `timeout`
- `tls`
- `auth_rejected`
- `protocol`
- `aborted`
- `http_<3位状态码>`
- `unknown`

分类逻辑见 [uplink-reconnect.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-reconnect.ts:17)。无法安全化的原始错误会保留为字符串，故 `UplinkPool` 的 `lastError` 实际上不是有限枚举。[uplink-pool.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:783)

Relay 服务端可能关闭连接的认证错误包括：

```text
proto-unsupported
client-too-old
tenant-kicked
unknown-tenant
token-epoch
bad-token
revoked
member-required
member-type_mismatch
member-malformed
member-bad_signature
member-node_mismatch
member-epoch_mismatch
member-seq_mismatch
member-passkey_unverifiable
auth-timeout
bad-sig
unauthorized
```

来源分别见 [relay-uplink-auth.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-auth.ts:86)、[relay-member.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-member.ts:50)。不过 `RelayUplinkClient.attemptConnect()` 失败时通常会统一写成 `connect-failed`，而 `UplinkPool` 可能记录原始或分类后的错误。

### 1.2 API 暴露位置

#### 节点侧状态：`GET /api/mesh/relay/status`

路由定义见 [relay-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:111)。

响应字段：

```text
relays[n].lastError
relays[n].lastErrorAt
relays[n].online
relays[n].attached
relays[n].rttMs
relays[n].kicked
quota.currentNodes
quota.maxNodes
quota.maxStreams
quota.bandwidthBytesPerSec
```

构造逻辑见 [relay-status-row.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-status-row.ts:32) 和 [relay-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:145)。

错误优先级：

- 当前 `attached` Relay：使用正在运行的 client 的 `clientError`。
- 非当前 Relay：使用 `UplinkPool` 按 URL 保存的候选诊断错误。
- 当前 client 错误优先于候选缓存错误。

节点侧 `packages/app` 的解析类型缺少 `lastErrorAt`，且没有把 `quota` 纳入类型化响应；原始 JSON 仍保存在 `raw` 中。[relay-session.ts](/Users/konata/code/tmex-r27/packages/app/src/lib/relay-session.ts:32)

#### `GET /api/local/status`

这是本机 Relay 服务状态，不是节点到远端 Relay 的 uplink 状态：

```text
relay.publicUrl
relay.hasPassword
relay.tenantCount
relay.nodesOnline
relay.currentNodes
```

见 [local-routes.ts](/Users/konata/code/tmex-r27/packages/app/src/runtime/local-routes.ts:61) 和 [setup-service.ts](/Users/konata/code/tmex-r27/packages/app/src/runtime/setup-service.ts:88)。它不暴露 `lastError`。

#### Relay 管理端接口

`GET /api/relay/status` 只返回租户汇总、节点数、流数量和流量，没有成员连接错误字段。[relay-admin-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin-routes.ts:26)

`GET /api/relay/metrics` 也没有 `lastError` 字段。[relay-admin-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin-routes.ts:73)

#### 通用 Hub 状态

`GET /api/mesh/hubs` 的候选项也暴露：

```text
candidates[n].lastError
candidates[n].lastAttemptAt
candidates[n].rttMs
```

这是通用 Hub/uplink 状态，不是 Relay 专用接口。[mesh-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/mesh-routes.ts:97)

### 1.3 建议

至少应在成功进入 `online` 状态时清除：

```text
RelayUplinkClient.lastConnectError
UplinkClient.lastConnectError
UplinkPool.diagByUrl[url].lastError / lastErrorAt
```

否则“最近错误”实际是“历史上一次错误”。

## 2. 配额和实时使用量

### 2.1 RelayQuota 字段

协议定义只有三个配额字段：[codec.ts](/Users/konata/code/tmex-r27/packages/shared/src/relay/codec.ts:58)

| 配额 | 默认值 | 强制位置 | 服务端实时数据 | 节点状态是否完整 |
|---|---:|---|---|---|
| `maxNodes` | 16 | redeem 时检查当前 pending + admitted 节点数 | 有：`countActiveNodes()`、metrics `memberCount`、`currentNodes` | 只有当前 Relay 的 `quota.currentNodes` |
| `maxStreams` | 64 | 建立流前 `registry.reserveStream(maxStreams)` | 有：全局、租户、成员 `activeStreams` | 只有上限，没有当前使用量 |
| `bandwidthBytesPerSec` | `null`，不限速 | `TokenBucket.take()` | 有：metering 的输入/输出速率 | 没有配额使用量 |

### 2.2 `maxNodes`

执行位置：

- 配额解析和默认值：[relay-quota.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-quota.ts:29)
- 节点上限检查：[relay-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-routes.ts:295)
- 当前节点数为 pending + admitted，排除 revoked：[relay-tenant-store.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-tenant-store.ts:302)
- 控制消息发送 `currentNodes`：[relay-uplink-server.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:175)

已有使用量：

```text
/api/relay/status.tenants[n].nodes
/api/relay/metrics.totals.members
/api/relay/metrics.tenants[n].memberCount
/api/mesh/relay/status.quota.currentNodes
```

问题是 `/api/relay/metrics.tenants[n].quota` 可能是租户原始配置 `null`，并不一定是解析后的默认配额。[relay-metrics.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:447)

### 2.3 `maxStreams`

执行位置：

- 保留租户级流额度：[relay-stream-router.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-stream-router.ts:49)
- 全局租户流计数：[relay-registry.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-registry.ts:119)
- 成员流计数：[relay-registry.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-registry.ts:146)

已有使用量：

```text
/api/relay/status.tenants[n].streams
/api/relay/metrics.totals.activeStreams
/api/relay/metrics.tenants[n].activeStreams
/api/relay/metrics.members[n].activeStreams
```

`LinkMux.stats().openStreams` 也存在，但它是链路级传输统计，不是租户配额计数；metrics 当前没有直接暴露它。[mux.ts](/Users/konata/code/tmex-r27/packages/shared/src/link/mux.ts:504)

节点侧只显示 `maxStreams`，没有 `currentStreams`。[connection-details.tsx](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:89)

### 2.4 `bandwidthBytesPerSec`

执行位置：

- 每租户 Token Bucket：[relay-uplink-server.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:163)
- 实际限速：[relay-stream-router.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-stream-router.ts:125)
- Bucket 支持不限速、延迟而非丢弃：[relay-quota.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-quota.ts:74)

已有实时数据：

```text
/api/relay/metrics.totals.bytesInPerSec
/api/relay/metrics.totals.bytesOutPerSec
/api/relay/metrics.tenants[n].bytesInPerSec
/api/relay/metrics.tenants[n].bytesOutPerSec
/api/relay/metrics.members[n].bytesInPerSec
/api/relay/metrics.members[n].bytesOutPerSec
```

来源是 `RelayMetering`，不是 LinkMux。[relay-metering.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metering.ts:53)

目前没有明确的：

```text
bandwidthUsageBytesPerSec / bandwidthQuota
```

建议增加独立的带宽消耗计数，直接在 `TokenBucket.take()` 成功消费的位置累计，避免把 `bytesInPerSec + bytesOutPerSec` 错当作限速消耗。当前同一转发数据会分别记录为成员 source `bytesIn` 和 target `bytesOut`。

### 2.5 成员配额

当前没有 member quota 字段：

- `relay_nodes` 没有 quota 列。
- `RelayNodeRecord` 没有 quota。
- metrics member 只有在线、RTT、流数、输入/输出速率、重连次数。[relay-metrics.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:471)

因此不能实现“成员配额使用量”；需要先增加成员配额模型、持久化和执行位置。

### 2.6 其他限制

以下是接入防滥用限制，不属于 `RelayQuota`：

```text
RELAY_MAX_UNUSED_ENROLLMENTS = 32
RELAY_ENROLL_CREATE_LIMIT = 16 / 60 秒
失败次数限制 = 5 / 15 分钟
RELAY_ENROLLMENT_MAX_TTL_MS = 24 小时
```

执行见 [relay-enroll-create.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-enroll-create.ts:76) 和 [relay-enroll-limiter.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-enroll-limiter.ts:8)。这些计数目前没有管理 API 或节点状态 API。

另外，API client 允许 `maxNodes` 最大 4096，而服务端协议上限是 256，存在校验不一致。[admin-api.ts](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.ts:29)、[relay-quota.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-quota.ts:4)

### 2.7 推荐的最小 API 变更

统一增加有效配额和使用量：

```json
{
  "quota": {
    "maxNodes": 16,
    "maxStreams": 64,
    "bandwidthBytesPerSec": null
  },
  "usage": {
    "currentNodes": 3,
    "currentStreams": 8,
    "bandwidthBytesPerSec": 1048576
  }
}
```

建议：

1. `/api/relay/metrics.tenants[n]` 使用解析后的 effective quota，而不是原始租户配置。
2. 增加 `usage.currentNodes/currentStreams/bandwidthBytesPerSec`。
3. 成员对象继续使用已有的 `activeStreams` 和输入/输出速率。
4. `/api/mesh/relay/status` 的当前 `quota` 扩展为 `quota + usage`。
5. 如果本地卡片需要显示每一个已配置 Relay，则不能只扩展当前 uplink 的 `relay.quota` 控制消息，因为非 `attached` Relay 不会收到控制消息。应增加 Relay 服务端租户认证的 usage 查询接口，由节点对每个配置 Relay 查询并填充 `relays[n].quota`、`relays[n].usage`。

## 3. 多 Relay 和切换

### 3.1 多 Relay 数据模型

节点支持多 Relay：

- `set-relays` 支持多个 `{url, tenantId, token, priority}`，最多 16 个。[relay-records.ts](/Users/konata/code/tmex-r27/packages/shared/src/auth/relay-records.ts:8)
- 网关数据库表 `mesh_relays` 保存每个 Relay 的 URL、租户、加密 token、priority、kicked。[mesh-relay.ts](/Users/konata/code/tmex-r27/apps/gateway/src/db/schema/mesh-relay.ts:4)
- 读取时按 priority 升序排列。[mesh-relay-store.ts](/Users/konata/code/tmex-r27/apps/gateway/src/auth/mesh-relay-store.ts:35)
- wiring 将全部 Relay 记录创建为候选 uplink。[relay-wiring.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-wiring.ts:106)

### 3.2 Active relay

运行时只有一个 Relay 是 active：

```text
relays[n].attached === true
```

状态由当前 live client 对应的 URL 计算。[relay-status-row.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-status-row.ts:32)

但没有持久化 active relay 字段：

- `nodeIdentity.uplinkKind` 只有 `hub | relay`。[mesh.ts](/Users/konata/code/tmex-r27/apps/gateway/src/db/schema/mesh.ts:37)
- `mesh_relays` 没有 active 列。
- priority 是候选顺序，不等价于当前 active。

### 3.3 已有切换能力

内部已有：

```text
UplinkPool.switchTo(publicUrl)
```

支持 make-before-break，并有测试覆盖。[uplink-pool.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:668)

现有公开接口只有：

- `GET /api/mesh/relay/status`
- `POST /api/mesh/relay/enroll`：加入/追加 Relay
- leave：清空 Relay
- remove：删除单个 Relay
- prepare/set-relays：更新签名成员列表

路由列表见 [relay-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:111)，加入逻辑见 [relay-routes.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:294)。

目前没有公开的“仅切换 active Relay”接口。

### 3.4 最小切换接口

建议增加：

```http
POST /api/mesh/relay/switch
Content-Type: application/json

{"url":"https://relay.example.com"}
```

服务端应：

1. 要求节点 session，允许本机可信状态请求除外。
2. canonicalize URL。
3. 确认 URL 存在于本机 `mesh_relays` 且未被 kicked。
4. 调用现有 `UplinkPool.switchTo(url)`。
5. 返回新的 `attached` URL 和完整 Relay 状态。

这是临时运行时切换。若要求重启后仍保持选择，则需新增持久化 active URL；当前 priority 不能安全承担这个语义。

## 4. 现有测试

已覆盖：

- 配额解析、默认值、Token Bucket：[relay-units.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-units.test.ts:54)
- 节点和流配额硬限制：[relay-hardening.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-hardening.test.ts:189)
- Registry 流计数：[relay-registry.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-registry.test.ts:100)
- Relay 认证和 `currentNodes`：[relay-uplink.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink.test.ts:38)
- 管理端 status、租户 quota、默认 quota：[relay-admin.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin.test.ts:109)
- metrics 速率、成员速率和接口结构：[relay-metrics.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.test.ts:126)
- 节点 client 接收 `relay.quota.currentNodes`：[relay-uplink-client.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.test.ts:457)
- last-error 优先级和时间戳：[relay-status-row.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-status-row.test.ts:4)
- 错误分类：[uplink-client.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-client.test.ts:2442)
- 多候选 Relay 错误记录和 failover：[uplink-pool.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.test.ts:1250)
- Relay status、加入、删除、`RELAY_LAST`：[relay-routes.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.test.ts:138)
- 多 Relay 持久化和 priority：[mesh-relay-store.test.ts](/Users/konata/code/tmex-r27/apps/gateway/src/auth/mesh-relay-store.test.ts:13)
- set-relays 编解码和最大数量：[relay-records.test.ts](/Users/konata/code/tmex-r27/packages/shared/src/auth/relay-records.test.ts:103)
- API client status 规范化：[tenant-api.test.ts](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.test.ts:45)

缺失的关键回归测试：

1. 成功连接后 `lastConnectError` 和候选 `diag.lastError` 是否清除。
2. `/api/relay/metrics` 是否返回 effective quota 和三类 usage。
3. `/api/mesh/relay/status` 是否返回 `currentStreams`、带宽使用量。
4. 非 active Relay 的 quota/usage 查询。
5. `lastErrorAt` 在 `packages/app` 类型化解析中的保留。
6. 新增 active Relay switch endpoint 的成功、未知 URL、kicked、切换失败场景。
7. 带宽 usage 的统计语义，尤其避免把输入和输出重复相加。
8. 若要支持成员配额，需要先补充成员 quota 的模型、执行和 API 测试。

## 5. 当前 i18n 相关键

源语言文件为 [`zh_CN.json`](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:1952)，`en_US`、`ja_JP` 应保持同键镜像。

当前连接详情相关键：

```json
"nodes.machine.status.relayConnected": "已连接中继"
"nodes.machine.status.relayDisconnected": "未连接中继"
"nodes.machine.status.relayKicked": "中继令牌已失效"
"nodes.machine.details.quota": "节点配额"
"nodes.machine.details.quotaValue": "{{used}} / {{total}}"
"nodes.machine.details.streams": "并发流上限"
```

来源：[zh_CN.json](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:1952)

Relay metrics 目前已有：

```json
"relay.metrics.membersOnline": "在线节点"
"relay.metrics.activeStreams": "活跃流"
"relay.metrics.bytesIn": "入站速率"
"relay.metrics.bytesOut": "出站速率"
"relay.metrics.members.columns.streams": "流"
"relay.metrics.members.columns.rate": "速率"
```

来源：[zh_CN.json](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2713)

Relay 租户错误显示已有：

```json
"relay.tenant.strip.lastError": "最近错误：{{error}}"
"relay.tenant.errors.RELAY_QUOTA_NODES": "中继的节点配额已用尽。"
"relay.tenant.errors.RELAY_OFFLINE": "中继连接已断开，请稍后重试。"
"relay.tenant.errors.RELAY_UNREACHABLE": "无法连接该中继，请检查地址。"
```

来源：[zh_CN.json](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2793)、[zh_CN.json](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2867)

已有多 Relay 操作键：

```json
"relay.tenant.actions.enroll": "接入中继"
"relay.tenant.actions.migrate": "改为接入中继"
"relay.tenant.actions.add": "追加中继"
"relay.tenant.actions.leave": "离开中继"
"relay.tenant.actions.removeOne": "移除 {{host}}"
```

目前没有“切换当前中继”对应的 i18n key。[zh_CN.json](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2810)