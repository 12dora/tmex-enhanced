# EX2：远程节点升级功能探索报告

## 结论

当前仓库已经具备完整的“本机升级”执行链路，也具备将 HTTP API 转发到远程 Mesh 节点的能力。

推荐方案是：

> 节点管理页调用本地 Gateway 的 `/api/mesh/nodes/:id/upgrade`，本地 Gateway 通过现有的 `/n/:id/*` HTTP stream，将请求转发到目标节点现有的 `/api/system/upgrade`。

不建议第一版新增 Mesh `ctl` 消息。现有 HTTP 转发已经支持：

- 直连 `ws-secure`
- WebRTC DataChannel
- Hub relay
- 目标节点 session 鉴权
- GET 重试和远程响应适配

远程节点只需要复用现有 `UpgradeController`，无需新增目标侧升级执行逻辑。

---

## 1. 现有本机升级基础设施

### 1.1 API 合约

主要实现位于：

- [`apps/gateway/src/api/system.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/api/system.ts:25)
- [`apps/gateway/src/api/system-routes.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/api/system-routes.ts:61)
- [`packages/shared/src/contracts/system.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/contracts/system.ts:1)

现有接口：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/system/info` | 返回本机安装和升级能力 |
| GET | `/api/system/update-check` | 查询 GitHub 最新 Release |
| GET | `/api/system/upgrade` | 查询本机升级状态 |
| POST | `/api/system/upgrade` | 启动本机后台升级 |

`POST /api/system/upgrade` 请求体：

```json
{
  "version": "1.2.3"
}
```

版本必须匹配：

```text
数字.数字.数字[-可选预发布后缀]
```

因此 `latest`、路径、任意字符串都不会被直接接受。调用方需要先解析出具体版本号。

主要响应状态：

```ts
type UpgradeState = "idle" | "downloading" | "executing";

type UpgradeStatus = {
  state: UpgradeState;
  targetVersion: string | null;
  error: string | null;
  startedAt: string | null;
};
```

当前 `UpgradeController` 位于：

- [`apps/gateway/src/system/upgrade.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/upgrade.ts:38)

它的行为是：

1. `idle` → `downloading`
2. 创建临时目录
3. 从 GitHub 下载指定版本 tarball
4. 解压并校验 Release 内容
5. `downloading` → `executing`
6. detached spawn `tmex-cli upgrade --apply-current-package`
7. 当前 Gateway 进程由升级 CLI 停止、替换并重启

升级控制器是当前进程内的 singleton，状态不持久化。进程重启后状态重新变成 `idle`。

### 1.2 错误和前置条件

现有 API 主要返回：

- `400`：版本缺失或格式不合法
- `403`：禁止自更新、外部管理
- `409`：已有升级正在进行
- `502`：查询更新失败

权限流程：

- 本地 UI 请求首先经过 `MeshHttpRuntime.localUiGuard`
- `/api/*` 默认需要本地 session
- `handleSystemApiRequest` 本身不重复调用 `requireSession`
- 远程 HTTP stream 则由目标侧 `acceptHttpStream` 校验目标节点 session

关键能力字段由：

- [`apps/gateway/src/system/info-public.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/info-public.ts:26)

返回：

```ts
{
  displayVersion,
  baseVersion,
  isProd,
  installedViaCli,
  deployment,
  canSelfUpdate,
  serviceName,
  managementMode,
  updateOwner
}
```

这里需要特别说明：用户描述中的 `serviceMode` 当前代码中不存在。实际使用的是：

- `managementMode`: `none | app | companion-cli`
- `updateOwner`: `self | app | companion`
- `deployment`: `launchd | systemd | none`
- `canSelfUpdate`

相关实现：

- [`apps/gateway/src/system/managed.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/managed.ts:1)
- [`apps/gateway/src/system/install-info.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/install-info.ts:30)

当前 `canSelfUpdate` 基本要求：

```text
生产环境
+ CLI 安装
+ deployment 不是 none
+ managementMode === none
+ updateOwner === self
```

`install-info.ts` 的安装目录检测顺序：

1. `TMEX_INSTALL_DIR`
2. 根据 `TMEX_FE_DIST_DIR` 推导
3. 特殊处理 `current` / `versions`
4. 最后回退到 `process.cwd()`

生产环境如果没有有效 `install-meta.json`，会被视为非 CLI 安装，不能自更新。

目前没有显式的 `serviceMode` 字段，也没有额外验证服务 PID 归属。`deployment === none` 是主要保护条件。

### 1.3 FE 当前如何触发和跟踪升级

BIOS 风格升级入口不是直接放在 `apps/fe/src/pages/settings`，而是在 panels：

- [`apps/fe/src/pages/settings/general-settings-tab.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/general-settings-tab.tsx:1)
- [`packages/panels/src/settings/version-tab.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/version-tab.tsx:1)
- [`packages/panels/src/settings/use-version-tab.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/use-version-tab.ts:1)

当前 FE 流程：

1. 查询 `/api/system/info`
2. 查询 `/api/system/update-check`
3. 用户确认具体版本
4. POST `/api/system/upgrade`
5. 轮询 `/api/system/upgrade`
6. 每 2 秒检查状态
7. 观察到过非 `idle` 后，再次回到 `idle` 时判断完成或失败
8. 成功后刷新系统信息和更新检查结果

进度只有：

- `downloading`
- `executing`

没有下载百分比，也没有跨进程持久化的 Job ID。

UI 已经明确提示升级会：

- 重启服务
- 中断当前会话
- 连接可能短暂断开后恢复

相关展示逻辑：

- [`packages/panels/src/settings/version-tab-sections.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/version-tab-sections.tsx:1)

---

## 2. Mesh 节点清单和控制通道

### 2.1 `/api/mesh/nodes` 数据形状

接口实现：

- [`apps/gateway/src/mesh/mesh-routes.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/mesh-routes.ts:1)
- [`apps/gateway/src/mesh/node-list-projection.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/node-list-projection.ts:1)
- [`packages/api-client/src/auth/types.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/api-client/src/auth/types.ts:178)

返回：

```json
{
  "nodes": [
    {
      "id": "node-id",
      "name": "node-name",
      "publicKey": "...",
      "online": true,
      "reach": "lan",
      "transport": "ws-secure",
      "rttMs": 12,
      "peerAddress": "192.168.1.20:9883",
      "linkSinceAt": 1720000000000,
      "endpoints": ["wss://..."],
      "directFailure": {
        "at": 1720000000000,
        "ws": "...",
        "dc": "..."
      },
      "version": "1.2.3",
      "direct_capable": true,
      "inventory": {
        "version": "1.2.3"
      },
      "loggedIn": true,
      "isHub": false
    }
  ]
}
```

round9 新增或强化的字段：

- `peerAddress`
- `linkSinceAt`
- `endpoints`
- `directFailure`

这些字段描述的是当前连接路径和直连失败情况，不是升级状态。

`online` 的判断并不只依赖 Hub：

```text
本机
或 Hub 观测在线
或当前 PeerLink 可达
```

因此 Hub 离线时，节点仍可能通过直连继续可用。

### 2.2 节点通信拓扑

架构文档：

- [`docs/hub/2026082700-hub-node-architecture.md`](/Users/konata/code/tmex-enhanced-wt-r10/docs/hub/2026082700-hub-node-architecture.md:53)

每台机器都是完整 Gateway：

```text
浏览器
  │
  ▼
入口节点 Gateway
  │
  ├─ direct ws-secure
  ├─ WebRTC DataChannel
  └─ Hub relay
       │
       ▼
目标节点 Gateway
```

控制和业务请求共用 multiplexed peer link：

- `http`
- `ws`
- `ctl`

普通远程 API 路径：

```text
/n/:nodeId/api/...
```

由：

- [`apps/gateway/src/mesh/forwarder.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/forwarder.ts:1)
- [`apps/gateway/src/mesh/stream-targets.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/stream-targets.ts:1)

完成转发。

入口节点发送的 HTTP stream OPEN 包含：

```ts
{
  method,
  path,
  query,
  headers,
  origin,
  auth
}
```

目标节点收到后：

1. 校验目标节点 session
2. 构造 Request
3. 调用目标 Gateway 的正常 API dispatch
4. 流式返回响应

因此远程节点 API 调用本质上已经存在。

### 2.3 是否存在“节点调用另一节点 API”的机制

存在，Files 功能就是现成例子。

FE 的：

- [`packages/panels/src/files/files-node-section.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/files/files-node-section.tsx:1)
- [`apps/fe/src/node/node-runtimes.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/node/node-runtimes.ts:1)
- [`packages/api-client/src/node-url.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/api-client/src/node-url.ts:1)

为每个节点创建不同的 `RuntimeProvider` 和 `ApiClient`：

```text
本机:  /api/files/roots
远程:  /n/:nodeId/api/files/roots
```

Files API 客户端：

- [`packages/api-client/src/file-resources.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/api-client/src/file-resources.ts:1)

Gateway 目标路由：

- [`apps/gateway/src/api/file-root-routes.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/api/file-root-routes.ts:1)

文件根目录请求通过普通 HTTP stream 到达目标节点，并由目标节点自己的数据库处理。

大文件传输另有优化路径：

- [`packages/panels/src/files/bulk-transfer.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/files/bulk-transfer.ts:1)

可使用 DataChannel 直传，失败时回退到 REST/relay。但文件根目录、目录列表等控制 API 仍然走普通 HTTP。

### 2.4 当前没有的机制

当前没有通用的“远程操作”控制消息，例如：

```text
node.action
node.upgrade
command.request
command.response
```

现有 `ctl` 消息主要是：

- `auth.challenge`
- `auth.response`
- `ping`
- `pong`
- `node.status`
- `node.list`
- key log 相关消息
- `rtc.signal`

相关代码：

- [`packages/shared/src/uplink/codec.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/uplink/codec.ts:1)
- [`apps/gateway/src/mesh/uplink-protocol.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/uplink-protocol.ts:1)
- [`apps/gateway/src/mesh/peer-manager.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/peer-manager.ts:779)

`peer-manager.ts` 中的 `PEER_UPGRADE` 是连接传输层升级，不是应用版本升级。

Hub 的 `sendTo()` 也只发送现有 uplink control message。Hub 的职责主要是：

- 节点注册
- 节点清单
- 信令
- relay 字节流

它不是远程业务 API 的执行方。

---

## 3. 节点管理设置 UI

### 3.1 页面和组件

设置页面入口：

- [`apps/fe/src/pages/settings/nodes/nodes-tab.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:89)

节点管理组件：

- [`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:1)
- [`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:1)
- [`apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:1)
- [`apps/fe/src/pages/settings/nodes/management/types.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/types.ts:1)

当前数据来源：

1. `useMeshNodes()` 获取 `/api/mesh/nodes`
2. 如果当前模式有 Hub，再通过 `/n/<hub>/api/hub/nodes` 获取 Hub 节点信息
3. `mergeNodes()` 合并两边的数据
4. `NodesTable` 展示最终行

当前 Actions：

- 重命名
- 撤销节点
- 远程节点未登录时显示登录入口
- 本机不能撤销自身

当前节点表列包括：

- 名称
- 状态
- Reach
- Version
- Last Seen
- Direct
- Login
- Fingerprint
- Actions

### 3.2 Hub 离线时的现状

`NodesManagement` 当前把 Hub API 是否在线作为管理操作开关：

- 添加节点禁用
- 重命名禁用
- 撤销禁用

这是合理的，因为这些操作确实属于 Hub 控制面。

升级不同：它应当是目标节点自身的 Gateway 操作。如果入口节点仍能通过 PeerLink 直达目标，升级不应被 `hubOnline` 机械禁用。

### 3.3 i18n

规范源文件：

- [`packages/shared/src/i18n/locales/zh_CN.json`](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/i18n/locales/zh_CN.json)
- [`packages/shared/src/i18n/locales/en_US.json`](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/i18n/locales/en_US.json)
- [`packages/shared/src/i18n/locales/ja_JP.json`](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/i18n/locales/ja_JP.json)

相关 key 位于：

```text
nodes.management
nodes.columns
nodes.actions
nodes.revoke
```

新增建议放在：

```text
nodes.upgrade
```

需要包括：

- 升级
- 升级到最新版本
- 下载中
- 执行中
- 正在重启
- 升级成功
- 升级失败
- 节点未登录
- 节点不可达
- 当前已是最新版本
- 目标节点不支持远程升级

`types.ts` 和 `resources.ts` 是生成文件，不应手工编辑。源文件修改后运行 `bun run build:i18n`。

---

## 4. 版本信息和 latest 的来源

### 4.1 节点当前版本

本机版本由：

- [`apps/gateway/src/system/version.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/version.ts:1)

计算。

优先级大致为：

1. 构建时 `TMEX_MONOREPO_VERSION`
2. 生产环境 `install-meta.json.cliVersion`
3. 开发/测试环境 `packages/app/package.json`
4. fallback unknown

Mesh 节点之间的版本来源是 `node.status`：

- `MeshRuntime.statusProvider` 读取 `getDisplayVersion()`
- `PeerManager` 发送 `node.status`
- UplinkClient 发送给 Hub
- Hub 将其放入 `node.list`
- 入口节点保存到 peer cache
- FE 从 `/api/mesh/nodes` 和 Mesh events 获得版本

相关发送位置在：

- [`apps/gateway/src/mesh/mesh-runtime.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/mesh-runtime.ts:766)
- [`apps/gateway/src/mesh/peer-manager.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/peer-manager.ts:1)
- [`apps/gateway/src/mesh/uplink-client.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/uplink-client.ts:1)

`/healthz` 也返回：

```json
{
  "status": "ok",
  "version": "...",
  "startedAt": "...",
  "restarting": false
}
```

但当前节点清单不会主动通过 `/healthz` 探测版本。因此 Mesh 版本可能短暂陈旧。升级完成后应以目标 `/healthz` 作为最终确认来源。

### 4.2 latest 的确定方式

共享 Release 配置：

- [`packages/shared/src/release/source.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/release/source.ts:1)

仓库：

```text
12dora/tmex-enhanced
```

Gateway 更新检查：

- [`apps/gateway/src/system/update-check.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/update-check.ts:1)

CLI 版本解析：

- [`packages/app/src/lib/release-fetch.ts`](/Users/konata/code/tmex-enhanced-wt-r10/packages/app/src/lib/release-fetch.ts:1)

两者都查询 GitHub Releases，并下载：

```text
tmex-cli-${version}.tgz
```

Gateway 的 `checkForUpdate()` 返回：

```ts
{
  currentVersion,
  latestVersion,
  hasUpdate,
  changelog,
  publishedAt
}
```

注意：`hasUpdate` 是相对于“当前入口节点版本”计算的。不能直接用它判断远程目标节点是否需要升级。

例如：

```text
入口节点：1.3.0
远程节点：1.1.0
GitHub latest：1.2.0

入口 hasUpdate = false
远程节点实际仍需要升级
```

因此远程升级应使用 `latestVersion`，而不是入口节点的 `hasUpdate`。

---

# 推荐实现设计

## 端到端链路

```text
FE 节点管理行
  │
  ├─ GET /api/mesh/upgrade/latest
  │
  └─ POST /api/mesh/nodes/:id/upgrade
        │
        ├─ 校验本地用户 session
        ├─ 校验目标节点已加入且未撤销
        ├─ 取得目标节点 session cookie
        ├─ 解析 GitHub latest 具体版本
        └─ 通过现有 PeerLink 转发
              POST /api/system/upgrade
              { version: "1.2.3" }
                    │
                    ▼
              目标节点 Gateway
                    │
                    └─ UpgradeController.start()
                          │
                          └─ detached tmex-cli upgrade
```

## 建议新增的本地 Gateway API

### `GET /api/mesh/upgrade/latest`

建议新增，用于节点管理页展示确认信息。

返回：

```json
{
  "latestVersion": "1.2.3",
  "changelog": "...",
  "publishedAt": "2026-08-30T00:00:00.000Z"
}
```

此接口应该：

- 要求本地用户 session
- 查询 GitHub latest Release
- 确认对应 tarball asset 存在
- 返回具体版本号
- 不返回或不依赖入口节点的 `hasUpdate`

可以从 `update-check.ts` 提取共享的 GitHub Release 查询函数，供现有更新检查和新接口复用。

### `POST /api/mesh/nodes/:nodeId/upgrade`

建议请求体为空：

```json
{}
```

由本地 Gateway 自己解析 latest 版本，避免客户端请求任意版本或降级版本。

流程：

1. 检查本地 session
2. 检查 `nodeId` 是否为已登记、未撤销节点
3. 如果是远程节点，读取目标节点 session cookie
4. 没有目标 session 时返回：

```json
{
  "code": "NODE_LOGIN_REQUIRED",
  "nodeId": "..."
}
```

5. 获取 latest 具体版本
6. 可选：先调用目标 `/api/system/info`
7. 如果目标版本已经不低于 latest，返回：

```json
{
  "code": "UPGRADE_ALREADY_LATEST",
  "nodeId": "...",
  "version": "1.2.3"
}
```

8. 将请求转发到目标：

```text
POST /api/system/upgrade
```

请求体：

```json
{
  "version": "1.2.3"
}
```

9. 返回目标节点的 `UpgradeStatus`

建议统一错误码：

```text
NODE_LOGIN_REQUIRED
NODE_UNREACHABLE
UPGRADE_NOT_ALLOWED
UPGRADE_IN_PROGRESS
UPGRADE_ALREADY_LATEST
UPGRADE_UNSUPPORTED
RELEASE_UNAVAILABLE
```

### `GET /api/mesh/nodes/:nodeId/upgrade`

用于查询目标节点状态。

- 本机目标：直接读取本机 `upgradeController.status()`
- 远程目标：通过 HTTP stream 转发到目标的：

```text
GET /api/system/upgrade
```

响应仍然是目标节点的 `UpgradeStatus`。

---

## 为什么复用 HTTP，而不是新增 ctl 消息

推荐复用：

- [`apps/gateway/src/mesh/forwarder.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/forwarder.ts:1)
- [`apps/gateway/src/mesh/stream-targets.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/stream-targets.ts:1)
- [`apps/gateway/src/mesh/mesh-deps.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/mesh-deps.ts:1)

理由：

- 已有 direct/relay 多种传输
- 已有请求响应生命周期
- 已有目标 session 鉴权
- 已有 401、503 等错误处理
- 目标 API 已经存在
- 不需要修改 uplink codec 和 Hub 协议

不建议使用现有的：

```text
/api/mesh-internal/*
```

因为它使用 `x-tmex-mesh-peer` marker，并跳过普通用户 session。该通道目前用于 tmux 内部操作。如果把升级加入其中，仅凭可信 PeerLink 就能启动破坏性操作，不符合现有 Mesh 安全模型。

---

# 后端工作包

后端 Agent 负责以下文件：

- [`apps/gateway/src/mesh/mesh-routes.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/mesh-routes.ts)
  - 新增 latest、upgrade start、upgrade status 路由
  - 节点存在性和撤销状态校验
  - 目标 session 检查
  - 错误码映射

- [`apps/gateway/src/mesh/forwarder.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/forwarder.ts)
  - 新增带目标 session 的授权 HTTP 转发 helper
  - GET 可重试
  - POST 不自动重试
  - 复用现有 response adaptation

- [`apps/gateway/src/mesh/mesh-http.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/mesh-http.ts)
  - 将 authorized forwarding callback 注入 `MeshRoutes`

- [`apps/gateway/src/api/system.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/api/system.ts)
  - 抽取版本校验、`canSelfUpdate` 检查和启动逻辑

- 新文件，例如：

```text
apps/gateway/src/system/upgrade-service.ts
```

  - 提供本机和远程管理 API 共同使用的 start/status 服务

- [`apps/gateway/src/system/update-check.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/system/update-check.ts)
  - 抽取 latest Release 和 tarball 校验逻辑

- 可选：

```text
packages/shared/src/contracts/system.ts
```

  - 增加 latest Release 和远程升级响应类型

测试建议：

- `apps/gateway/src/mesh/mesh-routes.test.ts`
- `apps/gateway/src/mesh/forwarder.test.ts`
- `apps/gateway/src/api/system.test.ts`
- `apps/gateway/src/system/update-check.test.ts`
- `apps/gateway/src/system/upgrade.test.ts`
- Mesh integration test

推荐覆盖：

- 远程升级成功
- 目标未登录
- 目标不可达
- 目标返回 409
- 目标旧版本返回 404
- POST 不重复发送
- relay 和 direct transport
- 升级过程中连接断开
- 重连后通过 `/healthz` 确认版本

推荐方案不需要修改：

- `packages/shared/src/uplink/codec.ts`
- `apps/gateway/src/mesh/uplink-protocol.ts`
- `apps/gateway/src/mesh/peer-manager.ts`
- `apps/gateway/src/hub/uplink-server.ts`

如果改用 ctl 方案，则这些文件都需要扩展，并额外设计：

- action request/response correlation ID
- 用户授权传递
- 超时和重连
- Hub relay 行为
- 老版本协议兼容

---

# 前端工作包

前端 Agent 负责以下文件：

- [`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx)
  - Actions 列增加 Upgrade 按钮
  - 展示 downloading、executing、restarting
  - 根据节点 online、loggedIn、isSelf 控制可用性

- [`apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts)
  - 可继续扩展，或拆出新的 `use-node-upgrade.ts`
  - 建议升级 busy 状态与 rename/revoke 分开

- [`apps/fe/src/pages/settings/nodes/management/types.ts`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/types.ts)
  - 增加升级 API 和状态类型

- [`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx)
  - 注入节点升级 API
  - 获取 latest 信息
  - 向表格传递升级依赖

- 新文件，例如：

```text
apps/fe/src/node/node-upgrade-api.ts
```

或：

```text
packages/api-client/src/mesh-upgrade.ts
```

建议使用入口节点 API：

```text
/api/mesh/upgrade/latest
/api/mesh/nodes/:id/upgrade
```

不要使用当前节点 runtime 的 `/n/:id` client 直接拼接升级接口，因为节点管理页需要统一处理入口鉴权、latest 解析和错误映射。

- [`apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx)
  - 增加升级按钮和状态测试
  - Hub 离线但目标 direct reachable 时仍允许升级
  - 未登录目标显示登录提示或禁用升级
  - self 节点升级行为

- i18n 源文件：

```text
packages/shared/src/i18n/locales/zh_CN.json
packages/shared/src/i18n/locales/en_US.json
packages/shared/src/i18n/locales/ja_JP.json
```

不要手工编辑生成的：

```text
packages/shared/src/i18n/types.ts
packages/shared/src/i18n/resources.ts
```

---

# FE 状态跟踪建议

远程升级不能简单复用“POST 成功即完成”的逻辑。

建议：

1. 点击升级后先记录 `pending` 和 `sawActive`
2. POST 返回后开始轮询：

```text
GET /api/mesh/nodes/:id/upgrade
```

3. 状态显示：

```text
downloading → executing → restarting/reconnecting
```

4. 如果执行阶段连接断开：

   - 不立即视为失败
   - 认为目标节点正在停止和重启
   - 在限定时间内继续重试查询

5. 节点重新可达后：

   - 查询目标 `/healthz`
   - 比较 `healthz.version` 与目标版本
   - 刷新 `/api/mesh/nodes`

6. 只有版本确认成功才显示升级成功。

现有 `use-version-tab.ts` 已经有“观察到 active 后等待回到 idle”的基础逻辑，但远程节点需要额外处理：

- 目标 Gateway 重启
- relay/direct link 断开
- 状态重新变成 `idle`
- 目标节点版本刷新延迟

---

# 风险和注意事项

- **升级会主动杀掉目标 Gateway。** POST 可能在目标已经开始升级后没有响应，不能因为请求失败就自动重试 POST。

- **升级状态不持久化。** 目标进程重启后，`UpgradeController` 的错误和执行状态会丢失，必须用重新连接和 `/healthz.version` 做最终判断。

- **当前没有 `serviceMode`。** 现有代码只有 `managementMode`、`updateOwner` 和 `deployment`。如果需求要求更严格的服务归属检查，需要另行补充安装元数据和运行时校验。

- **目标节点必须能访问 GitHub。** 入口节点不会代替目标节点下载 Release。

- **GitHub latest 可能变化。** 本地 Gateway 应解析出具体版本后再转发，目标节点仍会重新校验对应 tarball。

- **远程节点的 `loggedIn` 不是实时鉴权结果。** 它主要表示目标 session cookie 是否存在。真正调用时仍需由目标节点验证 session。

- **Hub 离线不等于目标不可达。** 升级应根据实际 PeerLink 可达性判断，不应绑定 Hub 管理 API 是否在线。

- **Hub 本身也是完整 Gateway。** Hub 节点不需要特殊升级协议；通过同样的目标 API 即可升级。

- **老版本节点可能没有 `/api/system/upgrade`。** 应将目标 404 映射为 `UPGRADE_UNSUPPORTED`，不能默认认为网络故障。

- **外部托管节点不能自更新。** 目标节点仍必须通过自己的 `canSelfUpdate` 检查；入口节点不能绕过它。

- **版本清单可能滞后。** Mesh `node.status` 和 Hub cache 适合作为展示数据，升级后的最终事实应以目标 `/healthz` 为准。

本次仅完成只读探索，没有修改文件，也没有运行测试。