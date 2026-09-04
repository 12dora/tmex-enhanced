# 结论先行

当前源码中，`“无边缘连接”`不是“metrics 端点不可达”的同义词。

它只会在前端收到以下状态时出现：

```ts
connector.reachable === true &&
(connector.readyConnections ?? 0) <= 0
```

对应代码见 [`tunnel-model.ts:37`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:37 )。当前后端正常情况下不会产生 `reachable: true, readyConnections: null`，因此通常意味着：

1. `/ready` 确实返回了 `readyConnections: 0`；
2. 探测到了错误的 cloudflared metrics 端点，而该端点返回 0；
3. 生产环境前端仍是 `087c0d9a` 之前的旧 bundle，把 metrics 不可达也误判成了“无边缘连接”；
4. 前端或后端正在展示上一次探测得到的旧 0 值。

另外，当前代码完全不解析 Prometheus 指标 `cloudflared_tunnel_ha_connections`，实际读取的是 cloudflared metrics 服务的 `GET /ready` JSON。

---

## 1. 完整数据路径

### 1.1 生产运行时与 API

`packages/app` 负责组装并启动生产运行时；隧道实现实际位于 `apps/gateway/src/tunnel`。

生产 server 使用 `GATEWAY_PORT`，缺省为 `9883`：[`packages/app/src/runtime/server.ts:23`]( /Users/konata/code/tmex-r27/packages/app/src/runtime/server.ts:23 )。生产环境的 `app.env` 会在运行时装配阶段作为配置来源：[`packages/app/src/runtime/setup-shared.ts:204`]( /Users/konata/code/tmex-r27/packages/app/src/runtime/setup-shared.ts:204 )。

网关启动时启动 `TunnelManager`：[`apps/gateway/src/runtime.ts:111`]( /Users/konata/code/tmex-r27/apps/gateway/src/runtime.ts:111 )。

HTTP 请求经过 `packages/app` 的装配层后进入 gateway API dispatch：[`packages/app/src/runtime/assemble-routes.ts:203`]( /Users/konata/code/tmex-r27/packages/app/src/runtime/assemble-routes.ts:203 )、[`apps/gateway/src/runtime.ts:226`]( /Users/konata/code/tmex-r27/apps/gateway/src/runtime.ts:226 )。

浏览器只访问本机节点：

```text
GET  /api/tunnel/status
POST /api/tunnel/actions
```

客户端封装见 [`packages/api-client/src/local/tunnel-api.ts:40`]( /Users/konata/code/tmex-r27/packages/api-client/src/local/tunnel-api.ts:40 )。

后端路由：

- `GET /api/tunnel/status`：
  1. 刷新外部 cloudflared 检测；
  2. 最多等待 800 ms 尝试刷新连接器；
  3. 返回 `manager.status()`。

  见 [`apps/gateway/src/api/tunnel-routes.ts:189`]( /Users/konata/code/tmex-r27/apps/gateway/src/api/tunnel-routes.ts:189 )。

- `POST /api/tunnel/actions`：
  - 启动、停止、创建、登录、检查等动作；
  - 动作响应本身也携带一个状态快照；
  - 大部分动作异步执行，最终结果仍靠轮询 `GET /api/tunnel/status`。

  见 [`apps/gateway/src/api/tunnel-routes.ts:202`]( /Users/konata/code/tmex-r27/apps/gateway/src/api/tunnel-routes.ts:202 )、[`apps/gateway/src/tunnel/manager.ts:494`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:494 )。

经 mesh 转发的 tunnel 请求会直接返回 404，只允许浏览器直连本机处理：[`apps/gateway/src/api/tunnel-routes.ts:15`]( /Users/konata/code/tmex-r27/apps/gateway/src/api/tunnel-routes.ts:15 )。

---

### 1.2 `TunnelManager.status()` 如何组装状态

`status()` 将以下信息组合进 `TunnelStatusResponse`：

- 持久化配置：quick/named、hostname、tunnelId、是否 externally managed；
- cloudflared 进程状态；
- `lastConnector` 连接器探测结果；
- external tunnel 检测结果；
- 最近日志。

见 [`apps/gateway/src/tunnel/manager.ts:300`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:300 )，其中连接器状态由：

```ts
connector: { ...this.lastConnector }
```

返回，见 [`manager.ts:343`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:343 )。

连接器状态契约是：

```ts
reachable: boolean | null
metricsAddr: string | null
readyConnections: number | null
connectorId: string | null
checkedAt: string | null
lastError: string | null
```

见 [`packages/shared/src/contracts/tunnel.ts:156`]( /Users/konata/code/tmex-r27/packages/shared/src/contracts/tunnel.ts:156 )。

`lastConnector` 是进程内内存状态，不写入数据库。停止、启动、移除 managed tunnel 时会重置为空状态：[`manager.ts:1300`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:1300 )。

---

### 1.3 managed cloudflared 的 metrics 地址

named 和 quick 两种 managed tunnel 都会尝试选择一个随机空闲本地端口，并传给 cloudflared：

```text
--metrics 127.0.0.1:<随机端口>
```

named：

[`apps/gateway/src/tunnel/provider.ts:195`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/provider.ts:195 )

quick：

[`apps/gateway/src/tunnel/provider.ts:207`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/provider.ts:207 )

端口选择逻辑：

[`apps/gateway/src/tunnel/provider.ts:220`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/provider.ts:220 )

启动后端将该地址保存到 supervisor：

[`apps/gateway/src/tunnel/supervisor.ts:120`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/supervisor.ts:120 )、[`supervisor.ts:125`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/supervisor.ts:125 )。

因此，`9883` 是 tmex gateway HTTP 端口，不是 cloudflared metrics 端口。

---

### 1.4 外部 cloudflared 的 metrics 地址发现

当配置是 `externallyManaged` 时，检测器从以下来源寻找 cloudflared：

- 当前进程列表；
- macOS LaunchAgents / LaunchDaemons；
- systemd service；
- `~/.cloudflared/config.yml`。

见 [`apps/gateway/src/tunnel/external-detect.ts:127`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/external-detect.ts:127 )、[`external-detect.ts:162`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/external-detect.ts:162 )。

metrics 地址解析优先级：

1. managed supervisor 传入的地址；
2. cloudflared 命令行 `--metrics`；
3. 配置文件顶层 `metrics:`；
4. 日志中的 metrics 地址；
5. 生产环境默认扫描 `127.0.0.1:20241` 至 `20245`。

见 [`apps/gateway/src/tunnel/connector-health.ts:48`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/connector-health.ts:48 )、[`manager.ts:1369`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:1369 )。

外部检测器自身有缓存和探测状态：

- 成功结果缓存 30 秒；
- 探测失败后 10 秒退避；
- 冷启动最多等待 1.5 秒；
- 过期缓存会先返回旧值，再后台刷新；
- `force` 探测才会强制清除缓存。

见 [`apps/gateway/src/tunnel/external-detect.ts:855`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/external-detect.ts:855 )。

---

### 1.5 `/ready` 解析逻辑

代码访问的是：

```text
http://<metricsAddr>/ready
```

URL 构造见 [`apps/gateway/src/tunnel/connector-health.ts:76`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/connector-health.ts:76 )。

只接受 HTTP `200` 或 `503`，然后要求响应体是 JSON，并且必须包含有限数值型：

```json
{
  "readyConnections": 4,
  "connectorId": "..."
}
```

解析见 [`connector-health.ts:100`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/connector-health.ts:100 )、[`connector-health.ts:123`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/connector-health.ts:123 )。

探测结果：

| `/ready` 结果 | 后端状态 |
|---|---|
| 有效 JSON，`readyConnections > 0` | `reachable: true`，有连接 |
| 有效 JSON，`readyConnections === 0` | `reachable: true`，零连接 |
| 已知地址不可达或响应格式错误 | `reachable: false` |
| 扫描默认端口，0 个命中 | `reachable: null` |
| 扫描默认端口，多个命中 | `reachable: null`，并记录无法归属 |

见 [`connector-health.ts:148`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/connector-health.ts:148 )。

当前代码没有：

```text
GET /metrics
cloudflared_tunnel_ha_connections
```

的解析逻辑。仓库搜索也没有找到 `cloudflared_tunnel_ha_connections`。因此 Prometheus `/metrics` 里的该指标不会直接影响当前 UI。

---

### 1.6 日志如何影响进程健康

`TunnelSupervisor` 会解析 cloudflared 日志：

- `Registered tunnel connection`：认为连接器恢复；
- `Unregistered tunnel connection`；
- `Connection terminated`：删除连接索引，若为空则把进程设为 `degraded`。

见 [`apps/gateway/src/tunnel/supervisor.ts:141`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/supervisor.ts:141 )。

但要注意：

`TunnelSupervisor.edgeConnections` 这个日志计数不会直接成为 API 的 `readyConnections`。API 的连接数权威来源仍是 `/ready`。

managed tunnel 的进程状态还会在以下情况下被标为 `degraded`：

```ts
supervisor.state === 'running' &&
lastConnector.reachable === true &&
lastConnector.readyConnections === 0
```

见 [`manager.ts:1234`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:1234 )。

检查动作也会在同样条件下返回 `connector_down`：

[`manager.ts:928`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/manager.ts:928 )。

---

### 1.7 “无边缘连接”的全部代码路径

当前生产代码中，唯一把连接器状态设为 `noConnections` 的逻辑是：

```ts
if (!connector.reachable) return 'unknown';
return (connector.readyConnections ?? 0) > 0 ? 'connected' : 'noConnections';
```

见 [`apps/fe/src/pages/settings/remote-access/tunnel-model.ts:37`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:37 )。

因此：

- `reachable: true, readyConnections: 4` → `connected`
- `reachable: true, readyConnections: 0` → `noConnections`
- `reachable: false` → 当前版本 `unknown`
- `reachable: null, checkedAt: null` → `unprobed`
- `reachable: null, checkedAt != null` → `unknown`

`ConnectorRow` 再把状态映射为 i18n key：[`apps/fe/src/pages/settings/remote-access/status-card.tsx:315`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/status-card.tsx:315 )。

`noConnections` 还会被 `tunnelDegraded()` 用来触发顶部 degraded 状态：[`tunnel-model.ts:52`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:52 )。

后端的 `process.state = degraded` 是另一条路径，它显示的是“无连接”，不是连接器行的“无边缘连接”。

---

### 1.8 相关 i18n 文案

源语言文件 [`packages/shared/src/i18n/locales/zh_CN.json:422`]( /Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:422 )：

```text
settings.remoteAccess.connector.label = "连接器"
settings.remoteAccess.connector.connected = "{{n}} 条边缘连接"
settings.remoteAccess.connector.noConnections = "无边缘连接"
settings.remoteAccess.connector.unknown = "无法探测（metrics 端点不可达）"
settings.remoteAccess.connector.unprobed = "未探测"

settings.remoteAccess.state.degraded = "无连接"
settings.remoteAccess.degradedNotice = "隧道进程运行中，但无边缘连接，公网地址当前不可达。"
```

其中 standalone 的“无边缘连接”来自：

```text
settings.remoteAccess.connector.noConnections
```

[`zh_CN.json:443`]( /Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:443 )。

---

## 2. 最近变更审计

我对 tunnel manager、supervisor、provider、external detector、connector health、前端 remote-access 文件执行了 `git log -p`。直接相关的提交如下。

| 提交 | 影响 |
|---|---|
| `2c082794` | 初始 tunnel manager、provider、supervisor、`/api/tunnel`；没有连接器健康判断 |
| `2068db10` | quick public URL、进程状态、外部请求 404 等；没有 `/ready` |
| `ff570208` | 外部 cloudflared 发现、LaunchAgent/systemd、token/config 检测 |
| `73ef3635` | 外部候选与 Access 检测强化；间接影响候选归属 |
| `df25e507` | token 模式、日志 ingress、外部 tunnel 识别；间接影响外部 metrics 地址 |
| `b0812794` | 外部 Access 凭证来源；不改变连接器数 |
| `27f8651f` | external detector 重构、删除旧模块级缓存 |
| `dde6bf8c` | 外部检测改为 stale-while-revalidate，冷启动最多等 1.5 秒，启动预热不阻塞 |
| `92205109` | 外部探测改异步；失败后 10 秒退避；增加 epoch，避免旧扫描覆盖新结果 |
| `982551a9` | 新增 `connector` 契约、`degraded`、`connector_down` |
| `6b4a6785` | 引入 `/ready` connector health、随机 metrics 端口、日志 degraded、外部 logfile 尾读 |
| `e41d8a3a` | 增加 config metrics 地址；多个默认 metrics 命中时改为 unknown；增加进程代次隔离 |
| `51fe3e27` | 前端首次展示连接器行、degraded 警示、检查结论 |
| `087c0d9a` | 修复前端语义：`reachable:false` 从 `noConnections` 改为 `unknown` |
| `ec63cce1` | 设置页状态预取，共享 tunnel query key；不改变连接数判定 |
| `d07550c5`、`6e92580f`、`f5b41e54` | Access、清理、表单重构；没有改变当前连接数算法 |

### 关键变更分析

#### `6b4a6785`：引入了新的“连接器健康”结论

在此之前，UI 主要依据 cloudflared 进程是否存在；此提交后，进程存活但没有边缘连接会被单独标记 degraded。

这会让此前“看起来正常”的进程首次显示为异常，是最重要的行为变化。

同时 managed quick/named 都改成动态随机 metrics 端口。如果生产中运行的是旧版本 cloudflared、外部 cloudflared，或者已有进程没有可识别的 `--metrics`，就会依赖默认端口扫描。

#### `51fe3e27` → `087c0d9a`：前端曾经误判 metrics 不可达

`51fe3e27` 初始实现把：

```ts
reachable: false
```

也当作 `noConnections`。

`087c0d9a` 明确修正为 `unknown`，并增加测试：

[`apps/fe/src/pages/settings/remote-access/tunnel-model.test.ts:159`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-model.test.ts:159 )。

如果生产前端资源早于 `087c0d9a`，那么 metrics 端口变化导致的 `reachable:false` 就会直接显示“无边缘连接”，即使 cloudflared 实际仍然能工作。

#### `e41d8a3a`：默认端口归属逻辑改变

之前默认端口扫描命中第一个端点就使用。

现在：

- 一个端点命中：使用它；
- 多个端点命中：返回 `reachable:null`；
- 没有端点命中：返回 `reachable:null`。

这是为了避免把另一个 cloudflared 的连接数误归属给当前 tunnel。见该提交对 [`connector-health.ts`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/connector-health.ts:148 ) 的修改。

这个变更本身更可能造成“无法探测”，而不是“无边缘连接”。但如果恰好只有另一个 cloudflared 端点返回合法 JSON 且连接数为 0，仍可能误报为 0。

#### `dde6bf8c` / `92205109`：缓存、退避、旧状态

这些提交没有直接把健康状态改成 0，但增加了以下旧值持续显示的可能性：

- 外部 tunnel 检测成功结果缓存 30 秒；
- 失败后 10 秒不重复尝试；
- 旧检测结果在后台刷新期间继续返回；
- connector GET 只等待 800 ms；
- 默认扫描 5 个端口，每个最多 1.5 秒，最坏可耗时 7.5 秒；
- 旧 connector 结果没有 `probing` 字段告诉前端“当前正在刷新”。

因此，如果上一次 `readyConnections` 是 0，而本次健康探测因为端口超时、进程重启或扫描较慢没有在 800 ms 内完成，前端可能继续看到旧的 0。

#### round 19 的“探测退避/熔断”

`prompt-archives/2026090205-round19-settings-mesh-ux` 中的 WebRTC 直连熔断，位于 mesh/RTC 和 ws-client 路径，不影响 `/api/tunnel/status`。

与 tunnel 相关的是 `92205109` 对 external detector 增加的：

- 异步 `ps` / 文件探测；
- epoch；
- 失败后 10 秒退避；
- stale-while-revalidate。

不要把 WebRTC `TMEX_RTC_*` 熔断状态当作 cloudflared connector 状态。

#### cloudflared 版本输出

`provider.ts` 中的 `VERSION_RE` 只用于填充 `status.binary.version`：

[`apps/gateway/src/tunnel/provider.ts:11`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/provider.ts:11 )。

它不参与 `readyConnections` 判断。因此 cloudflared `--version` 输出格式改变，不会直接产生“无边缘连接”。

真正相关的是：

- cloudflared 是否接受 `--metrics`；
- `/ready` 是否仍返回 JSON `readyConnections`；
- 日志是否仍包含 `Registered tunnel connection`；
- metrics 日志是否仍匹配 `metrics server on ...`。

---

## 3. 前端如何从 API 得到状态文字

### 页面范围

只有浏览器直连的本机节点请求 tunnel 状态：

[`apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:29`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:29 )。

远程节点只显示提示，不读取远程节点的 tunnel 状态。

### 查询与轮询

`useTunnelStatus()` 使用共享 query key：

[`apps/fe/src/pages/settings/remote-access/use-tunnel-status.ts:36`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/use-tunnel-status.ts:36 )。

轮询间隔：

- job 运行中或进程 `starting`：2 秒；
- 其他状态：10 秒。

[`apps/fe/src/pages/settings/remote-access/tunnel-model.ts:505`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:505 )。

每个 node 的 QueryClient 默认：

- `staleTime: 5000`
- `retry: 1`

[`apps/fe/src/node/node-runtimes.ts:339`]( /Users/konata/code/tmex-r27/apps/fe/src/node/node-runtimes.ts:339 )。

悬停预取也使用同一个 `['tunnel-status']` key，但不设置额外 staleTime：[`apps/fe/src/pages/settings/data-prefetch.ts:83`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/data-prefetch.ts:83 )。

### 缓存和旧值显示

`projectProtectedStatus()` 始终把 React Query 的 `data` 投影为 `status`：

```ts
status: input.data ?? null
```

见 [`apps/fe/src/pages/settings/use-protected-status-query.ts:46`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/use-protected-status-query.ts:46 )。

这意味着后台 refetch 失败时，旧的 `status` 仍会显示；只有首次没有任何数据时才显示 loading。

动作接口返回的状态会立即写入缓存：[`apps/fe/src/pages/settings/remote-access/tunnel-actions.ts:104`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-actions.ts:104 )。

因此前端展示的是“最近一次成功写入 Query Cache 的完整状态快照”，不是每次渲染都重新探测 cloudflared。

---

## 4. 回归假设与确认方法

### 先做这个分流判断

在浏览器 DevTools → Network 查看：

```text
GET /api/tunnel/status
```

重点记录：

```json
{
  "binary": { "version": "...", "path": "..." },
  "config": { "mode": "...", "externallyManaged": true },
  "process": { "state": "...", "pid": "...", "lastError": "..." },
  "connector": {
    "reachable": true,
    "metricsAddr": "127.0.0.1:xxxxx",
    "readyConnections": 0,
    "connectorId": "...",
    "checkedAt": "...",
    "lastError": "..."
  },
  "external": { "...": "..." }
}
```

- 如果是 `reachable:true, readyConnections:0`：后端认为某个合法 `/ready` 端点确实返回了 0。
- 如果是 `reachable:false` 或 `reachable:null`，但 UI 仍显示“无边缘连接”：生产前端 bundle 很可能早于 `087c0d9a`，或页面显示了旧缓存。
- 如果 `checkedAt` 很旧：优先检查缓存/探测超时。

### 排名 1：生产前端版本早于 `087c0d9a`

**证据：**

- Network 中 `connector.reachable === false` 或 `null`；
- 页面仍显示 `settings.remoteAccess.connector.noConnections`；
- 当前仓库代码对 `reachable:false` 明确返回 `unknown`；
- 检查生产 `current/resources/fe-dist` 的构建版本或浏览器加载的 JS 是否包含新逻辑。

**修复：**

- 后端与前端资源原子升级，避免 API 和 bundle 跨版本；
- 对 connector payload 做运行时校验；
- 前端只在 `reachable:true` 且 `readyConnections` 是有限非负数时显示 `noConnections`。

---

### 排名 2：探测到了错误的 metrics 端点

常见于：

- 同机存在多个 cloudflared；
- 外部 tunnel 没有显式 `--metrics`；
- metrics 端口从默认端口改成了其他端口；
- 旧 cloudflared 仍占用默认端口；
- `/ready` 返回 0 的端点属于另一个 tunnel。

**证据：**

比较以下三者：

1. API 中的 `connector.metricsAddr`；
2. `cloudflared` 进程命令行中的 `--metrics`；
3. 该地址 `/ready` 返回的 `connectorId` 和 `readyConnections`。

如果 `connectorId`、进程 tunnel name、hostname 对不上，就是归属错误。

**修复：**

- managed tunnel 使用实际 child PID 对应的 metrics 地址；
- 外部 tunnel 优先使用进程 `--metrics`，不要只扫描默认端口；
- 默认端口多个命中时保持 unknown；
- 将 metrics 来源、端点归属、进程 PID 暴露到诊断信息；
- 对外部 quick tunnel 增加更可靠的进程/URL 关联。

---

### 排名 3：cloudflared `/ready` 真实返回 0

这不是 UI 误报，而是 cloudflared 进程还活着但没有注册边缘连接。

**证据：**

- API：`reachable:true, readyConnections:0`；
- 直接访问同一 metrics 地址 `/ready` 返回 HTTP 503 或 JSON 中 `readyConnections:0`；
- 日志中出现 `Unregistered tunnel connection`、`Connection terminated`；
- `/healthz` 或公网地址可能仍显示旧缓存，或实际由另一条 tunnel 提供服务。

**修复：**

- 检查 cloudflared 凭证、网络、代理、DNS、Cloudflare tunnel 状态；
- 如果确认 cloudflared 已恢复，等待下一轮探测；
- 代码层面不要把进程存活单独当作 tunnel 可用，应继续保留 degraded 语义。

---

### 排名 4：后端探测超时，旧的 0 值被保留

**证据：**

- `connector.checkedAt` 长时间不更新；
- 连续多次 GET `/api/tunnel/status` 都返回相同旧时间和 0；
- 直接访问 metrics `/ready` 已经返回正数；
- tmex 日志或状态日志显示探测慢、进程刚重启、metrics 端口变化；
- 外部状态包含 `probing:true`，但 connector 本身没有对应的 probing 字段。

**修复：**

- 对 connector 增加 `probing`、`freshness` 或 `ageMs`；
- 已知单一 metrics 地址应在合理预算内等待，而不是 800 ms 后继续把旧 0 当当前结论；
- 默认端口扫描并行执行；
- 过期数据只能显示“上次为 0，正在重新探测”，不能继续显示确定性的 `noConnections`；
- 外部进程停止或 PID/metrics 地址变化时清空旧 connector。

---

### 排名 5：`/ready` 响应格式或 cloudflared 版本变化

**证据：**

- API 是 `reachable:false` 或 `reachable:null`；
- 直接访问 `/ready` 返回 HTML、纯文本、不同 JSON 字段，或没有数字型 `readyConnections`；
- `/metrics` 中存在 `cloudflared_tunnel_ha_connections`，但 `/ready` 不符合当前 parser；
- `binary.version` 或实际 cloudflared 路径近期变化。

**修复：**

- 为多个 cloudflared 版本增加 `/ready` fixture；
- 如果产品决定以 Prometheus 指标为权威，则明确实现 `/metrics` parser；
- 缺少字段必须是 unknown，不能转换为 0；
- 日志注册行解析也应支持版本差异，但不能把日志推断的连接数冒充 `/ready` 数值。

---

### 排名 6：前端 `readyConnections ?? 0` 把异常 payload 当成 0

当前代码：

```ts
return (connector.readyConnections ?? 0) > 0 ? 'connected' : 'noConnections';
```

见 [`tunnel-model.ts:43`]( /Users/konata/code/tmex-r27/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:43 )。

**证据：**

Network 响应必须是：

```json
{
  "connector": {
    "reachable": true,
    "readyConnections": null
  }
}
```

这不是当前正常后端探测会产生的组合，但旧后端、手工 mock、版本错配都可能产生。

**修复：**

改成：

```ts
if (
  connector.reachable !== true ||
  !Number.isFinite(connector.readyConnections) ||
  connector.readyConnections < 0
) {
  return 'unknown';
}
return connector.readyConnections === 0 ? 'noConnections' : 'connected';
```

---

## 5. 生产环境只读核查

以下命令应由维护者在生产机器执行；本次审阅没有访问、修改或重启生产 tmex。

### 5.1 查看 API 原始 payload

```sh
curl -sS -D - --max-time 5 \
  'http://127.0.0.1:9883/api/tunnel/status' |
  jq '{binary,config,process,connector,external,job}'
```

如果返回 401/403，不要据此判断 tunnel 异常；请在已登录的设置页 DevTools 中查看同一个请求的响应。

不要从公网域名或 mesh 转发地址访问该接口，因为转发请求会被 tunnel route 拒绝。

### 5.2 查看生产 app.env 的非敏感配置

```sh
grep -E '^(GATEWAY_PORT|TMEX_BIND_HOST|DATABASE_URL|TMEX_TUNNEL_DIR|TMEX_LOG_FILE|TMEX_LOG_ERR_FILE)=' \
  "$HOME/Library/Application Support/tmex/app.env"
```

不要直接打印整个 `app.env`，其中可能包含主密钥和其他敏感配置。

如果没有 `TMEX_TUNNEL_DIR`，代码会使用：

```text
DATABASE_URL 所在目录/tunnel
```

见 [`apps/gateway/src/config.ts:252`]( /Users/konata/code/tmex-r27/apps/gateway/src/config.ts:252 )。

### 5.3 查看 cloudflared 进程和监听端口

```sh
ps -axo pid=,command= |
  rg '[c]loudflared.*tunnel|[t]unnel.*[c]loudflared'
```

重点找：

```text
--metrics <host:port>
--config <path>
--logfile <path>
--log-file <path>
tunnel run ...
tunnel --url ...
```

查看监听端口：

```sh
lsof -nP -iTCP -sTCP:LISTEN |
  rg 'cloudflared|2024[1-5]'
```

不要执行 `kill`、`launchctl kickstart`、重启服务或启动新的 cloudflared。

### 5.4 直接检查 metrics `/ready`

优先使用 API 返回的：

```text
connector.metricsAddr
```

例如：

```sh
curl -sS -i --max-time 3 \
  'http://127.0.0.1:<metrics-port>/ready'
```

如果 API 没有可用端点，再只读检查默认端口：

```sh
for port in 20241 20242 20243 20244 20245; do
  curl -sS -i --max-time 2 "http://127.0.0.1:${port}/ready"
done
```

同时可对照 Prometheus 指标：

```sh
curl -sS --max-time 3 \
  'http://127.0.0.1:<metrics-port>/metrics' |
  rg 'cloudflared_tunnel_ha_connections'
```

但要注意：当前 tmex 代码不读取这个指标，真正决定 UI 的是 `/ready`。

### 5.5 查看配置文件和启动参数

managed tunnel 默认配置可能位于安装数据目录的 `tunnel/config.yml`；外部 cloudflared 默认配置通常是：

```text
~/.cloudflared/config.yml
```

只查看非敏感字段：

```sh
rg -n '^(tunnel|metrics|credentials-file|origincert):|^[[:space:]]+(-[[:space:]]+)?hostname:|^[[:space:]]+service:' \
  "$HOME/Library/Application Support/tmex" \
  "$HOME/.cloudflared" 2>/dev/null
```

检查 macOS 外部服务配置：

```sh
rg -n -i 'cloudflared|--metrics|--config|--log(file)?' \
  "$HOME/Library/LaunchAgents" \
  /Library/LaunchDaemons 2>/dev/null
```

代码扫描的 LaunchAgent/LaunchDaemon 路径见 [`external-detect.ts:680`]( /Users/konata/code/tmex-r27/apps/gateway/src/tunnel/external-detect.ts:680 )。

### 5.6 查看日志关键行

tmex 安装服务日志路径通常是：

```text
~/Library/Application Support/tmex/tmex.log
~/Library/Application Support/tmex/tmex.err.log
```

代码中的默认路径见 [`packages/app/src/lib/service.ts:109`]( /Users/konata/code/tmex-r27/packages/app/src/lib/service.ts:109 )。

只读搜索：

```sh
rg -n -i \
  'cloudflared|metrics|registered tunnel connection|unregistered tunnel connection|connection terminated|ERR|exited with code|external tunnel detection failed' \
  "$HOME/Library/Application Support/tmex/tmex.log" \
  "$HOME/Library/Application Support/tmex/tmex.err.log" 2>/dev/null
```

如果外部 cloudflared 命令行包含 `--logfile`，再查看该路径的末尾日志：

```sh
tail -n 200 '<logfile-path-from-process-args>'
```

### 5.7 检查前后端版本是否错配

从 `/api/tunnel/status` 记录：

```text
binary.version
binary.path
```

用返回的真实 binary 路径执行只读版本查询：

```sh
'<binary.path-from-api>' --version
```

同时确认浏览器加载的前端资源与当前安装版本一致。若 API 是 `reachable:false`，而 UI 显示“无边缘连接”，优先检查 `current/resources/fe-dist` 是否仍是 `087c0d9a` 之前的构建。

最有效的判据仍然是：

```text
Network 原始 connector payload
```

而不是页面上的最终文字。