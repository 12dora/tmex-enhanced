# 只读审计报告

未修改任何文件。以下引用均来自 `zh_CN.json`；`en_US/ja_JP` 需要同步新增或修改的键，生成文件未纳入分析。

## 数据边界

- `/api/local/status`：本机角色、直连插件、TLS、本机中继服务信息；不包含中继成员链路的 `lastError`。见 [local-routes.ts:76](/Users/konata/code/tmex-r27/packages/app/src/runtime/local-routes.ts:76)、[local/types.ts:26](/Users/konata/code/tmex-r27/packages/api-client/src/local/types.ts:26)。
- `/api/mesh/relay/status`：本机作为租户节点时的中继列表、挂载状态、租户编号、配额、密钥日志健康度。见 [relay-routes.ts:145](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:145)。
- `/api/relay/metrics`：本机作为中继服务时的运营指标，需要中继管理员权限。见 [relay-runtime.ts:227](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-runtime.ts:227)、[admin-api.ts:169](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.ts:169)。

## A. 在线但仍显示“最近错误 connect-failed”

### 来源链路

`RelayLinkStatus` 中的字段是：

```ts
lastError?: string | null;
lastErrorAt?: number | null;
```

见 [tenant-api.ts:19](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.ts:19)。

`/api/mesh/relay/status` 通过 `buildRelayStatusRow()` 生成：

- 当前已挂载的中继：读取实时客户端 `live.lastConnectError`。
- 未挂载的中继：读取 `UplinkPool` 的候选诊断信息。

见 [relay-status-row.ts:15](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-status-row.ts:15)、[relay-status-row.ts:41](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-status-row.ts:41)。

### 为什么会出现在线和旧错误同时存在

`RelayUplinkClient` 在连接失败时写入错误：

- 连接流程异常统一写为 `connect-failed`：见 [relay-uplink-client.ts:191](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:191)。
- 心跳失败写为 `missed-pong` 或 `ping-failed`：见 [relay-uplink-client.ts:139](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:139)。
- 被踢写为 `kicked:<reason>`：见 [relay-uplink-client.ts:422](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:422)。
- 停止连接写为 `stopped`：见 [relay-uplink-client.ts:237](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:237)。
- 最终统一落到 `lastConnectError`：见 [relay-uplink-client.ts:581](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:581)。

成功认证后只把状态改成 `online`，没有清空 `lastConnectError`：见 [relay-uplink-client.ts:205](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:205)。

因此后端会同时返回：

```json
{
  "online": true,
  "lastError": "connect-failed"
}
```

未挂载候选也有同样问题：`noteFailure()` 写入诊断后，`mergeUplinkDiag()` 会保留旧错误，成功时没有清除。见 [uplink-pool.ts:1421](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:1421)、[uplink-pool-diag.ts:21](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-diag.ts:21)。

### UI 渲染位置

中继行直接渲染：

```tsx
{t('relay.tenant.strip.lastError', { error: relay.lastError })}
```

见 [relay-rows.tsx:84](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:84)。

对应中文键是：

```json
"relay.tenant.strip.lastError": "最近错误：{{error}}"
```

见 [zh_CN.json:2800](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2800)。

`error` 参数没有经过错误码查表，属于原始字符串插值。现有测试明确使用 `ECONNRESET` 验证这一行为，见 [relay-ui.test.tsx:69](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx:69)。

另外，`relayFailing()` 只要发现 `lastError` 就认为该行异常，即使它已经在线，见 [relay-rows.tsx:20](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:20)。

### 当前可能出现的错误值

已知的实时客户端错误值：

- `connect-failed`
- `missed-pong`
- `ping-failed`
- `kicked:password_rotated`
- `kicked:kicked`
- `kicked:revoked`
- `stopped`

`RelayKickReason` 的完整集合见 [codec.ts:62](/Users/konata/code/tmex-r27/packages/shared/src/relay/codec.ts:62)。

未挂载候选的 `lastError` 没有封闭枚举，会直接使用底层错误消息，可能包括：

- `connect-timeout`
- `auth-timeout`
- `aborted`
- `bad-nonce`
- `auth-send-failed`
- `uplink-offline`
- `link-closed`
- `ws-closed <code> <reason>`
- `ECONNRESET`、`ECONNREFUSED`、TLS 或操作系统网络错误
- 任意底层 `Error.message`

所以当前代码不存在真正可穷举的“错误码列表”；字段类型是普通 `string`。Hub 路径已有分类器，可产生 `dns`、`refused`、`timeout`、`tls`、`auth_rejected`、`protocol`、`aborted`、`http_NNN`、`unknown`，见 [uplink-reconnect.ts:17](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-reconnect.ts:17)。

### 建议

1. 后端增加稳定的 `lastErrorCode`，不要把原始错误消息作为 UI 数据。
2. 成功认证或成功 `promote()` 时同时清空：
   - `lastConnectError`
   - 候选诊断中的 `lastError`
   - `lastErrorAt`
3. `/api/mesh/relay/status` 兜底处理：`online === true` 时不返回当前错误。
4. UI 只在 `!relay.online` 时显示错误，并修改 `relayFailing()`。
5. 新增类似 `relay.tenant.connectionErrors.*` 的 i18n 表，例如：
   - `connect-failed`、`connect-timeout`、`auth-timeout` → 连接超时/失败
   - `missed-pong`、`ping-failed` → 心跳失败
   - `kicked:*` → 令牌失效
   - `dns`、`refused`、`tls`、`protocol`、`auth_rejected` → 对应分类
   - `stopped`、`aborted` → 不显示
   - 未知值 → 通用“无法连接中继”

## B. 元数据密钥代数、密钥日志、轮换操作

### UI 渲染

这些内容全部在折叠的“连接详情”中：

- 租户编号： [connection-details.tsx:75](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:75)
- 元数据密钥代数： [connection-details.tsx:83](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:83)
- 密钥日志健康度： [connection-details.tsx:110](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:110)

对应中文键：

```json
"nodes.machine.details.metaEpoch": "元数据密钥代数",
"nodes.machine.details.keyLog": "密钥日志",
"nodes.machine.details.keyLogCaughtUp": "已追平",
"nodes.machine.details.keyLogBlocked": "卡在第 {{seq}} 条"
```

见 [zh_CN.json:1973](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:1973)。

### 数据源

`metaEpoch` 来自：

```ts
metaEpoch: secrets.currentMetaEpoch()
```

见 [relay-routes.ts:160](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:160)、[relay-secrets.ts:71](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-secrets.ts:71)。

`keyLog` 来自 `RelayUplinkClient.keyLogHealth()`，只展示 `caughtUp` 或 `blockedSeq`，`skipped` 字段没有在 UI 显示。见 [relay-routes.ts:165](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:165)、[relay-uplink-client.ts:565](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:565)。

### 轮换操作链路

操作菜单的文案：

```json
"relay.tenant.actions.menu": "中继操作",
"relay.tenant.actions.rotate": "轮换元数据密钥"
```

见 [zh_CN.json:2811](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2811)。

调用链：

1. `RelayActionRow` 选择 `rotate`：见 [relay-uplink-panel.tsx:136](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx:136)。
2. `runConfirmAction()` 调用 `appendMetaKey({ op: 'rotate' })`：见 [use-relay-actions.ts:224](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:224)。
3. 请求 `POST /api/mesh/relay/meta-key/prepare`：见 [tenant-api.ts:419](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.ts:419)。
4. 取 key-log head、签名后提交 `POST /api/auth/keylog?hub=sync`：见 [relay-enroll.ts:164](/Users/konata/code/tmex-r27/apps/fe/src/node/relay-enroll.ts:164)、[auth-api.ts:324](/Users/konata/code/tmex-r27/packages/api-client/src/auth/auth-api.ts:324)。

### 删除 UI 的影响

可以删除这些展示和手动轮换入口，但不能删除后端字段或运行时逻辑：

- `RelaySecrets.reconcile()` 仍依赖 key-log 投影及 `metaEpoch`，见 [relay-secrets.ts:124](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-secrets.ts:124)。
- 中继客户端仍需要同步和应用 key log。
- 吊销节点后的自动 `meta-key` 换代仍然存在。
- `RelayNoticeList` 还会显示“元数据密钥欠账”和“重试”按钮，见 [relay-notices.ts:50](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-notices.ts:50)、[relay-uplink-panel.tsx:89](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-uplink-panel.tsx:89)。如果目标是移除所有元数据密钥相关 UI，这部分也要一并决定。

相关中文键还包括：

```json
"relay.tenant.metaKey.rotateTitle": "轮换元数据密钥？",
"relay.tenant.metaKey.rotateDescription": "换发新一代元数据密钥，只分发给当前成员节点。",
"relay.tenant.metaKey.pending": "还有 {{count}} 条元数据密钥换代没送达……",
"relay.tenant.metaKey.retry": "重试"
```

见 [zh_CN.json:2845](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2845)。

## C. 配额字段与实时使用量

### 配额字段

`RelayQuotaView` 有：

```ts
maxNodes
maxStreams
bandwidthBytesPerSec
currentNodes?
```

见 [tenant-api.ts:33](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.ts:33)。

本机卡当前只显示：

- `maxNodes`，以及可选的 `currentNodes`
- `maxStreams`

见 [connection-details.tsx:89](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:89)、[connection-details.tsx:105](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:105)。

本机卡没有显示 `bandwidthBytesPerSec`，也没有 bandwidth 对应的详情 i18n 键。

| 配额 | 后端配置 | 当前卡片 | 后端实时使用量 |
|---|---|---|---|
| 节点数 | `maxNodes` | 已显示 | `currentNodes` 已通过 `relay.quota` 下发 |
| 并发流 | `maxStreams` | 只显示上限 | `/api/relay/metrics` 有租户/成员 `activeStreams` |
| 带宽 | `bandwidthBytesPerSec` | 未显示 | `/api/relay/metrics` 有 `bytesInPerSec`、`bytesOutPerSec` |

### 当前节点数

服务端通过 `relay.quota` 下发三项配额和 `currentNodes`，见 [relay-quota-ctl.ts:3](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-quota-ctl.ts:3)、[relay-uplink-server.ts:175](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:175)。

因此节点数是唯一已经同时具备“上限 + 当前使用量”并在本机卡展示的配额。

### 并发流和带宽

`/api/relay/metrics` 的租户指标包含：

```ts
activeStreams
bytesInPerSec
bytesOutPerSec
quota.maxNodes
quota.maxStreams
quota.bandwidthBytesPerSec
```

见 [relay-metrics.ts:36](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:36)。

成员指标还包含每个节点的：

```ts
activeStreams
bytesInPerSec
bytesOutPerSec
```

见 [relay-metrics.ts:55](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:55)。

当前本机卡上的 `RelayServiceMetrics` 使用的是中继服务总量，不是当前租户的量，见 [relay-service-metrics.tsx:20](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-service-metrics.tsx:20)、[relay-metrics-tiles.tsx:333](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx:333)。

### 要显示完整实时配额，需要补充

建议在 `/api/mesh/relay/status` 增加独立的 `usage` 对象，或让卡片以受控方式读取 `/api/relay/metrics`：

```ts
usage: {
  currentNodes: number;
  currentStreams: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  sampledAt: number;
  intervalMs: number;
}
```

数据来源：

- `currentStreams`：`RelayRegistry.streamCount(tenantId)`，见 [relay-registry.ts:125](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-registry.ts:125)。
- 带宽速率：`RelayMetricsCollector` 的租户级速率，见 [relay-metrics.ts:447](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:447)。
- 租户配额：租户覆盖值或默认值，见 [relay-quota.ts:56](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-quota.ts:56)。

注意：限速器对每个转发字节只调用一次 `take(bytes)`，但指标会同时记录 tenant `bytesIn` 和 `bytesOut`，见 [relay-stream-router.ts:125](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-stream-router.ts:125)。因此不能直接把 in/out 相加后与带宽上限比较，必须先明确产品口径。

## D. “经中继可见节点”实际统计什么

对应键：

```json
"nodes.machine.details.nodesViaRelay": "经中继可见节点"
```

见 [zh_CN.json:1974](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:1974)。

实际值来自客户端处理完最新 `relay.list` 后的：

```ts
this.nodesViaRelay = list.nodes.length;
```

见 [relay-uplink-client.ts:549](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.ts:549)。

它统计的是“客户端最终接受的远端节点列表长度”，不是在线节点数。客户端会：

- 排除 `pending`
- 排除本机自身
- 排除没有当前用户证书、用户不匹配或已撤销的节点

见 [relay-node-list.ts:72](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-node-list.ts:72)。

中继端先过滤 revoked，再最多截取 256 个节点，见 [relay-node-list.ts:20](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-node-list.ts:20)。

因此该数字表示“当前中继清单中本机能够识别的远端成员数”，不表示：

- 在线成员数；
- 中继注册表中的全部成员数；
- 当前并发连接数；
- 成功解密状态块的节点数。

## E. 本机节点编号与租户编号

### 数据源

“本机节点编号”来自 `mode.nodeId`，由 [local-machine-body.tsx:54](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/local-machine-body.tsx:54) 传入连接详情。

“租户编号”来自本机密钥存储中的第一条 relay row：

```ts
tenantId: secrets.tenantId()
```

见 [relay-routes.ts:156](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:156)、[relay-secrets.ts:83](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-secrets.ts:83)。

### 当前顺序

中继模式下的顺序是：

1. 租户编号
2. 元数据密钥代数
3. 经中继可见节点
4. 节点配额
5. 并发流上限
6. 密钥日志
7. 本机节点编号
8. Hub 明细（正常中继模式通常为空）

实现位置：

- `RelayDetails` 从租户编号开始，见 [connection-details.tsx:75](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:75)。
- 本机节点编号在 `RelayDetails` 之后，见 [connection-details.tsx:58](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.tsx:58)。

## F. 顶部“连接”区与中继列表

### 组件树

```text
NodesTab
└─ LocalMachineCard
   └─ LocalMachineBody
      └─ CardSection title="连接"
         └─ UplinkSection
            ├─ MeshUplink
            │  └─ RelayUplinkPanel
            │     ├─ RelayRows
            │     │  └─ RelayRow × N
            │     ├─ RelayNoticeList
            │     └─ RelayActionRow
            ├─ ConnectionDetails
            ├─ RelayEnrollDialog
            └─ RelayConfirmDialog
```

关键位置：

- 页面挂载本机卡：[nodes-tab.tsx:37](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:37)
- 本机卡外层：[local-machine-card.tsx:197](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:197)
- “连接”小节：[local-machine-body.tsx:54](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/local-machine-body.tsx:54)
- uplink 分派：[uplink-section.tsx:36](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/uplink-section.tsx:36)
- relay/hub 分支：[uplink-section.tsx:74](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/uplink-section.tsx:74)
- 中继面板：[relay-uplink-panel.tsx:57](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx:57)

“连接”对应：

```json
"nodes.machine.sections.uplink": "连接"
```

见 [zh_CN.json:1958](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:1958)。

### 外层盒子与地址显示

`CardSection` 只是 `<section>`，没有额外的卡片边框，见 [card-parts.tsx:10](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/card-parts.tsx:10)。

实际带边框的“大盒子”是每一条 `RelayRow`：

```tsx
className="... rounded-lg ... ring-1"
```

见 [relay-rows.tsx:42](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:42)。

中继地址只显示 `URL.host`，例如 `relay.example.com:8443`，不是完整 URL，也不是可复制控件，见 [relay-rows.tsx:10](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:10)、[relay-rows.tsx:44](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:44)。

### 在线、延迟、当前挂载

每条 relay row 都显示：

- 在线/离线 Badge：见 [relay-rows.tsx:58](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:58)
- RTT：只有 `rttMs` 为数字时显示，见 [relay-rows.tsx:61](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:61)
- 当前挂载标记：见 [relay-rows.tsx:69](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-rows.tsx:69)

对应键：

```json
"relay.tenant.strip.online": "在线",
"relay.tenant.strip.offline": "离线",
"relay.tenant.strip.attached": "当前挂载于此中继",
"relay.tenant.strip.rtt": "延迟 {{ms}} ms"
```

见 [zh_CN.json:2795](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2795)。

### 多个中继的表示方式

`RelayRows` 对 `relay.ordered` 一条一行渲染，见 [relay-uplink-panel.tsx:64](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx:64)。

列表按 `priority` 升序排列，优先级就是 failover 顺序，见 [mesh-relay.ts:113](/Users/konata/code/tmex-r27/apps/fe/src/node/mesh-relay.ts:113)。

### 是否存在“切换当前中继” API

没有面向前端的显式切换 API。

`RelayTenantApi` 当前只有：

- status
- readmit
- enroll
- leave
- remove
- meta-key
- join-material
- pack

见 [tenant-api.ts:367](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.ts:367)。

网关路由表也没有 `switch` 或 `set-priority` 路由，见 [relay-routes.ts:111](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:111)。

存在一个内部的 `UplinkPool.switchTo(publicUrl)`，见 [uplink-pool.ts:668](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:668)，但它不是 HTTP API，主要由 uplink 池的自动选择逻辑调用，见 [uplink-pool.ts:1198](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:1198)。

当前可用的近似操作：

- “追加中继”：`POST /api/mesh/relay/enroll`，见 [tenant-api.ts:392](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.ts:392)。
- “重新输入口令”：实际上也复用 enroll 流程，见 [relay-enroll.ts:202](/Users/konata/code/tmex-r27/apps/fe/src/node/relay-enroll.ts:202)。
- “移除某条中继”：`remove/prepare`，会保留其它中继并重新编号 priority，见 [relay-routes.ts:344](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.ts:344)。
- 添加、移除或重新接入后，reconcile 会停止并重启 uplink pool，见 [relay-wiring.ts:56](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-wiring.ts:56)。

如果产品需要“用户手动切换当前中继”，建议新增显式的设置优先级/立即切换操作，而不是让用户通过删除或重新接入间接实现。

## G. 现有测试

### 直接覆盖本机卡和中继 UI

- [connection-details.test.tsx:75](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/connection-details.test.tsx:75)：租户编号、代数、可见节点、配额、密钥日志、本机节点编号。
- [local-machine-card.test.tsx:250](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/local-machine-card.test.tsx:250)：本机卡各区块、relay 模式、中继服务区。
- [local-machine-header.test.tsx:44](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/local-machine-header.test.tsx:44)：角色菜单。
- [machine-status.test.ts:18](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/machine-status.test.ts:18)：顶部在线、离线、延迟、被踢状态。
- [relay/relay-ui.test.tsx:36](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx:36)：relay row、原始错误、提醒、操作菜单、移除/轮换。
- [uplink/relay-uplink-panel.test.tsx:73](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.test.tsx:73)：中继面板、提示、菜单、轮换按钮。
- [relay/relay-service-metrics.test.tsx:25](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/relay/relay-service-metrics.test.tsx:25)：中继服务指标磁贴。
- [nodes-tab.test.tsx:113](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx:113)：设置页分派与本机卡挂载。
- [uplink/hub-uplink-panel.test.tsx:195](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.test.tsx:195)：Hub 备选路径，重构共享连接区时需回归。
- [uplink/hub-strip.test.tsx:31](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/hub-strip.test.tsx:31)：Hub 候选错误与展示。

### 直接覆盖中继状态、切换和后端数据

- [relay-status-row.test.ts:4](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-status-row.test.ts:4)：挂载/未挂载时 `lastError` 的来源。
- [relay-routes.test.ts:180](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-routes.test.ts:180)：`/api/mesh/relay/status`。
- [relay-uplink-client.test.ts:457](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-client.test.ts:457)：`currentNodes`、配额、被踢。
- [relay-uplink-heartbeat.test.ts:58](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-uplink-heartbeat.test.ts:58)：`missed-pong`。
- [relay-pool-switch.test.ts:110](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-pool-switch.test.ts:110)：reconfigure 与重新建立 uplink。
- [uplink-pool.test.ts:1266](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.test.ts:1266)：候选错误和失败诊断。
- [relay-node-list.test.ts:74](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-node-list.test.ts:74)：可见节点过滤。
- [relay-secrets.test.ts:87](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-secrets.test.ts:87)：meta-key 轮换与世代。
- [auth-key-log-relay.test.ts:385](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/auth-key-log-relay.test.ts:385)：中继模式 key-log 行为。
- [management/use-node-row-actions.test.ts:86](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.test.ts:86)：吊销后自动 meta-key 换代和欠账。

### 配额和指标测试

- [relay-metrics.test.ts:200](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.test.ts:200)：租户/成员吞吐速率。
- [relay-registry.test.ts:98](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-registry.test.ts:98)：租户与成员并发流计数。
- [relay-admin.test.ts:182](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin.test.ts:182)：配额变更和下发。
- [relay-routes.test.ts:214](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-routes.test.ts:214)：中继端节点/配额行为。
- [packages/api-client/src/relay/tenant-api.test.ts:45](/Users/konata/code/tmex-r27/packages/api-client/src/relay/tenant-api.test.ts:45)：租户状态、配额默认值、meta-key API。
- [packages/api-client/src/relay/admin-api.test.ts:62](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.test.ts:62)：`/api/relay/status`、`/api/relay/metrics`。
- [packages/app/src/runtime/local-routes.test.ts:69](/Users/konata/code/tmex-r27/packages/app/src/runtime/local-routes.test.ts:69)：`/api/local/status`。
- [packages/app/src/runtime/setup-service.test.ts:1046](/Users/konata/code/tmex-r27/packages/app/src/runtime/setup-service.test.ts:1046)：本机 relay 状态块。

删除 UI 时重点更新前三个前端中继测试：`connection-details.test.tsx`、`relay-uplink-panel.test.tsx`、`relay-ui.test.tsx`。建议同时新增“先失败、后成功且在线时不显示旧错误”的回归测试。