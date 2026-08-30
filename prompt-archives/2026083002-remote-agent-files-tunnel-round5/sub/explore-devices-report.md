当前会话文件系统为只读，且你明确要求不修改文件，因此无法写入目标路径。以下为可直接保存至：

`/Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-devices-report.md`

# Topic B：设备、文件目录、侧栏可见性与连接徽章

## 结论摘要

- “设备与文件”设置页由 `SettingsPage` 渲染 `DevicesAndFilesTab`，其中包含设备管理入口和文件根目录管理。
- 文件根目录存储在当前 gateway 节点数据库的 `file_roots` 表中，每条记录绑定一个 `devices.id`。
- 文件根目录设置目前只有绝对路径文本输入。前端和 CRUD API 只校验“绝对路径格式”，目录存在性、目录类型和越界访问在实际浏览时校验。
- 文件侧栏按当前路由节点获取 `/api/files/roots`，按 `enabled` 过滤后平铺显示，并通过 `root.deviceName` 显示所属设备；不会使用 `sidebarDeviceVisibility`。
- 终端侧栏使用 `sidebarDeviceVisibility`；远程节点默认隐藏，用户可在设备卡片中开启。
- 节点离线时，终端侧栏保留缓存的设备清单；文件侧栏不会主动删除根目录，但请求失败时显示错误，已有 React Query 数据可能继续显示。
- 网关的 `reach` 计算把所有非 relay 的 live peer（包括 `dc`、`ws-secure`）都投影成 `lan`。虽然 API 同时返回 `transport`，前端的 `NodeRow` 会丢弃该字段。
- RTT 不是网关 peer heartbeat RTT。顶部设备徽章的 RTT 来自浏览器侧 direct/WebRTC `getStats()`；没有 direct 诊断时显示“延迟未知”。

## 1. “设备与文件”设置页

### 页面入口

`apps/fe/src/pages/SettingsPage.tsx:40-55` 定义设置 tab，其中包含 `devicesAndFiles`。

`apps/fe/src/pages/SettingsPage.tsx:105-109` 使用：

```tsx
t('settings.tabGroup.devicesAndFiles')
```

`apps/fe/src/pages/SettingsPage.tsx:157-162` 渲染：

```tsx
<DevicesAndFilesTab />
```

`apps/fe/src/pages/settings/devices-and-files-tab.tsx:1-9`：

```tsx
<DeviceEntryCard />
<FilesSettingsTab />
```

设备管理入口为 `packages/panels/src/settings/device-entry-card.tsx:8-27`，跳转到 `/devices`。

### 添加目录表单

`packages/panels/src/settings/files-tab.tsx:104-155`：

- 通过“添加目录”按钮打开 `FileRootFormModal`
- 通过 `useFileRootsQuery(deviceGroups)`获取根目录
- 每条记录由 `FileRootRow` 渲染
- 添加、编辑、删除后刷新文件相关 query

路径输入位于：

`packages/panels/src/settings/file-root-form-sections.tsx:121-137`

```tsx
<label>{t('settings.files.path')}</label>
<input
  data-testid="settings-files-path-input"
  value={form.path}
  onChange={(event) => form.setPath(event.target.value)}
  placeholder={t('settings.files.pathPlaceholder')}
/>
```

表单同时包含设备选择器和启用开关：

- 设备：`file-root-form-sections.tsx:97-119`
- 路径：`file-root-form-sections.tsx:121-137`
- 启用状态：`file-root-form-sections.tsx:141-153`

`packages/panels/src/settings/use-file-root-form.ts:25-29` 的提交条件：

```ts
draft.path.trim().startsWith('/')
```

新建记录还要求 `deviceId`。提交时路径会在 `use-file-root-form.ts:107` 处 trim。

### 文件根目录数据库模型

`apps/gateway/src/db/schema.ts:403-418`：

```ts
export const fileRoots = sqliteTable('file_roots', {
  id: text('id').primaryKey(),
  deviceId: text('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  unique('file_roots_device_path_unique').on(table.deviceId, table.path),
]);
```

设备表在 `apps/gateway/src/db/schema.ts:97-124`。设备类型包含 `local` 和 `ssh`，并保存连接信息、默认工作目录等。

数据库访问封装在 `apps/gateway/src/db/file-roots.ts`：

- 查询全部：`:15-23`
- 创建：`:25-47`
- 更新：`:49-70`
- 删除：`:73-82`

每个 gateway 节点使用自己的数据库。因此远程节点的文件根目录应存储在远程节点对应的 gateway 数据库中，而不是由 hub 统一保存。

### Gateway 文件根目录 API

路由定义：

`apps/gateway/src/api/file-root-routes.ts:109-121`

```text
GET    /api/files/roots
POST   /api/files/roots
PATCH  /api/files/roots/:id
DELETE /api/files/roots/:id
```

GET 会把设备信息投影到 DTO：

`file-root-routes.ts:23-34`

```ts
{
  ...root,
  deviceName: device?.name ?? null,
  deviceType: device?.type ?? null,
  name: path.basename(root.path),
}
```

POST 校验逻辑位于 `file-root-routes.ts:41-66`：

- 请求体必须是对象
- `deviceId` 必须存在
- 路径 trim 后必须以 `/` 开头
- 同一设备下的相同路径不能重复

PATCH 的路径、重复和字段校验位于 `file-root-routes.ts:68-100`。

API 客户端封装在 `packages/api-client/src/file-resources.ts:16-59`：

```text
fetchFileRoots()
createFileRoot()
updateFileRoot()
deleteFileRoot()
```

### Stores 与 query 缓存

文件根目录不是由 Zustand store 持久化保存的。设置页通过 React Query 获取：

`packages/panels/src/settings/file-root-query.ts:26-27`

```ts
['files', 'settings', 'roots']
```

该文件支持多个 `deviceGroups`，可以把多个 runtime 的根目录聚合到一起：

- 类型定义：`:29-48`
- 收集客户端：`:68-90`
- 并行获取根目录：`:93-98`
- query hook：`:100-105`

但当前设置页没有传入 `deviceGroups`；检索 `<FilesSettingsTab>` 调用点后，实际使用的是当前 runtime 的 API client。因此：

```text
/settings       → 当前本地节点的 /api/files/roots
/n/:id/settings → 该远程节点的 /api/files/roots
```

文件树 Zustand store `packages/stores/src/file-tree.ts:22-72` 只保存展开状态，不保存根目录本身。

设置事件会刷新相关 query：

`packages/panels/src/settings/settings-events-init.tsx:24-37`

```ts
'file-roots' → [['files'], ['terminal-file-links', 'roots']]
'devices'    → [['devices']]
```

### 验证边界

设置表单和 root CRUD API 只验证路径字符串是绝对路径。存在性及安全访问校验在：

`apps/gateway/src/files/device-storage.ts:60-94`

`checkAndNormalize()`会：

- 要求绝对路径
- 限制目标位于配置根目录或其子目录
- local 设备额外进行 realpath 检查，防止符号链接逃逸
- SSH 设备主要使用文本路径 containment 检查

根目录解析在 `device-storage.ts:101-109`，会检查：

- 根目录是否存在
- 根目录是否启用
- 绑定设备是否存在

错误映射在 `apps/gateway/src/api/file-http.ts:4-22`。

对应 i18n 位于 `packages/shared/src/i18n/locales/zh_CN.json`：

- `settings.files`：`:334-356`
- `apiError.fileRootInvalid`、`fileOutsideRoots` 等：`:634-640`

## 2. 文件侧栏如何列出设备和节点

`packages/panels/src/files/files-tab.tsx:56-101`：

```tsx
const rootsQuery = useQuery({
  queryKey: ['files', 'roots'],
  queryFn: () => fetchFileRoots(runtime.apiClient),
});

const roots = rootsQuery.data?.roots.filter((root) => root.enabled) ?? [];
```

渲染根目录：

`files-tab.tsx:103-177`

```tsx
roots.map((root) => (
  <DirNode
    key={root.id}
    rootId={root.id}
    rootPath={root.path}
    ...
  />
))
```

根目录行通过：

`packages/panels/src/files/directory-node-view.tsx:80-87`

```tsx
<DeviceBadge root={root} />
```

`packages/panels/src/files/node-menu.tsx:73-103`显示：

- `root.deviceName ?? root.deviceId`
- 根目录绝对路径
- 设备图标

因此文件侧栏是：

```text
当前 routeNodeId
  → 当前 NodeRuntimeScope
  → GET /api/files/roots
  → enabled 过滤
  → 按 root 平铺
  → 通过 deviceName 显示所属设备
```

它没有按设备单独分组，也没有应用 `sidebarDeviceVisibility` 或节点在线状态过滤。

目录子项通过：

`packages/panels/src/files/use-directory-listing.ts:23-38`

```ts
fetchFileList(rootId, path, runtime.apiClient)
```

query key 为：

```ts
['files', 'list', rootId, path]
```

展开目录默认每 30 秒轮询；请求出错时停止轮询。实现位于 `use-directory-listing.ts:23-38`。

## 3. 设备管理页、卡片与侧栏可见性

### 页面与节点分组

`apps/fe/src/pages/DevicesPage.tsx:62-89`：

```tsx
const meshNodes = useMeshNodes();
const groups = toNodeDeviceGroups(meshNodes);
return <DeviceFoldersView groups={groups} />;
```

`apps/fe/src/pages/DevicesPage.tsx:107-111`使用：

```tsx
t('sidebar.manageDevices')
```

节点设备分组实现于 `apps/fe/src/pages/devices/node-device-group.tsx:53-77`。

该文件注释和实现表明：

- ready：使用远程 runtime 的实时面板
- offline：保留 runtime，使用缓存、snapshot 或 inventory
- signedOut：只显示登录引导

### 设备卡片

`packages/panels/src/device-management/device-card.tsx:184-204`：

```tsx
const sidebarVisible = isSidebarDeviceVisible(
  state.sidebarDeviceVisibility,
  nodeId,
  device.id,
);
```

卡片上的“显示在侧栏”开关位于 `device-card.tsx:252-292`，写入：

```ts
sidebarDeviceVisibilityKey(nodeId, device.id)
```

3-dot 菜单位于 `device-card.tsx:115-182`：

1. 编辑设备：`:151-158`
2. 测试连接：仅 SSH 设备，`:159-167`
3. 删除设备：危险操作，`:169-178`

菜单触发按钮 test id：

```text
device-card-actions-${device.id}
```

设备卡片另有连接/断开和打开设备页面等主操作，位于 `device-card.tsx:208-249`。

离线状态下：

- 编辑、测试连接、删除被禁用
- 卡片显示节点离线状态
- 仍可展示设备信息

### 可见性 store

`packages/stores/src/sidebar-device-visibility.ts:1-20`：

```ts
sidebarDeviceVisibilityKey(runtimeNodeId, deviceId)
  → `${runtimeNodeId}:${deviceId}`
```

默认策略：

- 本地节点设备默认显示
- 远程节点设备默认隐藏
- 显式保存的 boolean 覆盖默认值

UI 状态定义和持久化：

`packages/stores/src/ui.ts:95-120`：字段定义  
`packages/stores/src/ui.ts:138-170`：初始化与 setter  
`packages/stores/src/ui.ts:223-265`：持久化、boolean 规范化

### 终端侧栏过滤

`packages/panels/src/device-tree/sidebar-device-list.tsx:52-82`获取当前 runtime 的设备和可见性状态。

过滤位于 `sidebar-device-list.tsx:161-174`：

```tsx
selectSidebarVisibleDevices(
  devices,
  visibility,
  runtime.nodeId,
  selectedDeviceId,
)
```

选择器位于 `packages/panels/src/device-tree/device-tree-selectors.ts:54-71`。

特别行为：

- 已选设备即使被隐藏也会保留
- 普通设备按复合 key 过滤
- 没有可见设备时可隐藏整个 section

跨节点侧栏由：

- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:55-80`
- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:181-273`

组成。

离线节点使用 inventory 显示缓存设备，并继续应用 visibility。离线设备行显示为灰色链接，不会启动远程 runtime 请求。

### 文件侧栏不使用该开关

`apps/fe/src/components/page-layouts/components/app-sidebar.tsx:74-92`显示：

- panes/终端 tab：设备侧栏
- files tab：`NodeRuntimeScope` + `FilesTab`

`FilesTab`只按 `root.enabled`过滤，不读取：

```text
sidebarDeviceVisibility
MeshNode.online
MeshNode.reach
```

因此“隐藏设备”只影响终端侧栏，不影响该设备对应的文件根目录。

## 4. 文件浏览 API 与图形化路径选择器

### 现有文件浏览 API

`apps/gateway/src/api/file-browser-routes.ts:7-50`：

```text
GET /api/files/list?rootId=<id>&path=<path>
GET /api/files/content?rootId=<id>&path=<path>
GET /api/files/stat?rootId=<id>&path=<path>
GET /api/files/raw?rootId=<id>&path=<path>
```

路由注册在 `file-browser-routes.ts:53-62`，统一入口在：

- `apps/gateway/src/api/files.ts:106-110`
- `apps/gateway/src/api/index.ts:27-53`

目录列表实现：

`apps/gateway/src/files/device-storage.ts:154-179`

特点：

- 必须提供已配置的 `rootId`
- `path`只能位于该 root 下
- local 使用 rsync/本地路径安全检查
- SSH 通过远程设备执行列表
- 有超时和最大条目限制

### 是否存在任意路径选择器 API

没有发现用于“在尚未配置 root 前，枚举任意目录”的独立 API。

`apps/gateway/src/api/system-routes.ts:44-66`只处理 system/capability 等接口，没有目录枚举接口。

现有 `/api/files/list`不能直接承担任意路径选择器，因为它要求 `rootId`，并且强制路径位于该 root 下。

当前添加表单也只有文本输入，没有目录选择器。

### 远程节点代理

API 客户端通过：

`packages/api-client/src/node-url.ts:49-60`

生成远程前缀：

```text
本地节点 → /api/...
远程节点 → /n/<nodeId>/api/...
```

mesh forwarder：

`apps/gateway/src/mesh/forwarder.ts:126-139`

识别 `/n/:id`，远程 HTTP 转发在 `forwarder.ts:400-456`。节点不可达时返回：

```json
{
  "code": "NODE_UNREACHABLE",
  "nodeId": "..."
}
```

因此远程文件列表请求会自动代理到目标节点，但目标节点必须先有自己的 root 配置。

## 5. 在线/离线状态与断开行为

### Gateway 节点状态投影

共享 DTO：

`packages/api-client/src/auth/types.ts:139-159`

```ts
interface MeshNode {
  id: string;
  online: boolean;
  reach: 'lan' | 'relay' | null;
  transport?: 'ws-secure' | 'relay' | 'dc' | null;
  inventory?: ...
  loggedIn?: boolean;
}
```

网关投影：

`apps/gateway/src/mesh/node-list-projection.ts:100-150`

核心逻辑：

```ts
core.online =
  isSelf ||
  hubOnline.has(id) ||
  reach === 'lan' ||
  reach === 'relay';
```

节点事件和列表：

- `apps/gateway/src/mesh/mesh-routes.ts:195-228`
- `apps/gateway/src/mesh/mesh-routes.ts:296-316`
- `apps/gateway/src/mesh/mesh-runtime.ts:803-827`
- `apps/fe/src/node/mesh-events.ts:13-25, 358-417`
- `apps/fe/src/node/mesh-nodes.ts:254-277, 320-337`

前端事件只更新 `online`、`reach`、inventory 等字段：

`apps/fe/src/node/mesh-nodes.ts:35-58`

### 前端丢弃 transport

虽然 gateway `/api/mesh/nodes`返回 `transport`，但：

`apps/fe/src/node/mesh-nodes.ts:84-105`的 `NodeRow`没有该字段。

`apps/fe/src/node/mesh-nodes.ts:111-143`的 `mergeNodes()`也没有复制 `transport`。

因此前端后续只能使用 `online` 和 `reach`，不能依据实际 `transport` 区分 `dc`、`ws-secure`、`relay`。

### 终端侧栏断开

远程节点离线时：

- 节点不会从清单立即删除
- 侧栏读取缓存的 `inventory`
- 继续应用设备可见性
- 可见设备保留为灰色离线链接
- 不发起远程 runtime 请求

代码：`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:181-235`。

已选设备会继续保留，避免当前页面突然消失。

### 文件侧栏断开

文件根目录不会因节点离线主动删除。

`FilesTab`的行为：

1. 已有缓存根目录时，React Query 失败后仍可保留旧数据
2. 同时显示请求错误和重试入口
3. 没有缓存时，显示错误且没有根目录行
4. 目录子项查询失败后停止轮询，但已有查询数据可能仍被渲染
5. 只有成功返回的新根目录列表缺少旧 root 时，才可能通过 query 逻辑清理陈旧展开状态

相关代码：

- `packages/panels/src/files/files-tab.tsx:87-90, 134-168`
- `packages/panels/src/files/use-directory-listing.ts:23-42`
- `packages/panels/src/settings/file-root-query.ts:26-27`

测试明确覆盖“后台重取失败仍保留旧数据”：

`packages/panels/src/settings/file-root-query.test.ts:38-45`。

需要区分 gateway 节点断开和单个 tmux 设备连接断开。后者由：

- `packages/stores/src/tmux-event-router.ts:35-69`
- `apps/fe/src/components/global-device-provider.tsx:133-140`

更新 `deviceConnected`，并清理 pane 状态；它不会删除 `file_roots`记录。

## 6. 顶部连接徽章、LAN/relay 与 RTT

### 徽章位置

设备页面：

`apps/fe/src/pages/DevicePage.tsx:38-47`

```tsx
<DeviceNodeBadges nodeId={useRouteNodeId()} />
```

实现：

`apps/fe/src/node/device-node-badges.tsx:1-5, 49-100`

该组件实际显示两个来源不同的徽章：

1. 浏览器到节点的 primary/direct 路径和 RTT
2. mesh entry 到节点的 `reach`

核心代码：

`device-node-badges.tsx:69-80`

```tsx
const pathLabel =
  diagnostics.path === 'direct'
    ? t('nodes.badge.direct')
    : t('nodes.badge.primary');

const rttLabel =
  diagnostics.rtt == null
    ? t('nodes.badge.rttUnknown')
    : `${Math.round(diagnostics.rtt)}ms`;

const reachLabel =
  reach === 'lan'
    ? t('nodes.reach.lan')
    : reach === 'relay'
      ? t('nodes.reach.relay')
      : t('nodes.reach.none');
```

i18n：

`packages/shared/src/i18n/locales/zh_CN.json:1422-1430`

```json
"nodes": {
  "reach": {
    "lan": "局域网",
    "relay": "经 Hub 中转",
    "none": "不可达"
  }
}
```

`zh_CN.json:1469-1480`：

```json
"badge": {
  "direct": "直连",
  "primary": "中转",
  "rttUnknown": "延迟未知"
}
```

侧栏标题中的 `WsLatency`是另一种指标：

`apps/fe/src/components/page-layouts/components/sidebar-title.tsx:45-85`

它读取：

```ts
useTmuxStore((state) => state.wsLatencyMs)
```

只表示浏览器到当前 gateway WebSocket 的心跳延迟，不表示 mesh peer 链路类型。

### RTT来源

前端 direct 诊断：

`apps/fe/src/node/direct-diagnostics.ts:14-31`

- RTT来自 `appNodeRuntimes.get(nodeId).connection`
- `reach`来自 mesh node store

WebRTC 统计：

`packages/ws-client/src/direct/ice-stats.ts:5-17, 38-93`

从 `RTCPeerConnection.getStats()`读取：

- selected candidate pair
- candidate 地址和协议
- `currentRoundTripTime`
- route 类型：`lan`、`v6`、`v4-p2p`、`turn`、`relay`

控制器发布诊断：

`packages/ws-client/src/direct/direct-carrier-controller.ts:930-1018`

当 direct 连接有效时发布 RTT；否则发布：

```text
path = primary
rtt = null
```

因此 `rttUnknown`是预期状态，不代表 gateway peer heartbeat 没有存活。

浏览器到 gateway WebSocket RTT的实现：

- `packages/ws-client/src/heartbeat-controller.ts:39-54`
- `packages/ws-client/src/client.ts:320-340`
- `apps/gateway/src/ws/index.ts:468-475, 538-545`
- `packages/ws-client/src/websocket-transport.ts:28-33`

### Gateway 如何计算 reach 与 transport

类型定义：

`apps/gateway/src/mesh/types.ts:50-67`

```ts
type PeerTransportKind = 'ws-secure' | 'relay' | 'dc';
type PeerReach = 'lan' | 'relay' | null;
```

实际 transport：

`apps/gateway/src/mesh/peer-manager.ts:415-427`

```ts
transportOf(peerId)
```

live peer 保存 transport：

`peer-manager.ts:121-130, 1473-1520`

`listReach()`：

`peer-manager.ts:579-592`

```ts
return live.transport === 'relay' ? 'relay' : 'lan';
```

这意味着：

```text
transport = relay    → reach = relay
transport = dc       → reach = lan
transport = ws-secure → reach = lan
```

`reach`不是根据 peer 地址、隧道类型或实际公网/内网拓扑计算的兼容性标签。

API列表会分别返回：

- `reach`
- `transport`

代码：

`apps/gateway/src/mesh/mesh-routes.ts:195-228`

但节点事件广播只包含 `reach`，不包含 `transport`：

`apps/gateway/src/mesh/mesh-routes.ts:296-316`

Gateway peer heartbeat只用于存活检测：

- ping/pong：`apps/gateway/src/mesh/peer-manager.ts:1617-1629`
- 周期心跳：`peer-manager.ts:1762-1773`
- uplink heartbeat：`apps/gateway/src/mesh/uplink-client.ts:1131-1147`
- hub heartbeat：`apps/gateway/src/hub/uplink-server.ts:1160-1181`

没有发现 gateway 将 peer RTT写入 Node DTO、node event 或 `node.status`。

### 为什么会出现“局域网 + 延迟未知”

实际数据链路是：

```text
Gateway peer-manager.transport
  → listReach()
  → reach = lan/relay
  → /api/mesh/nodes
  → FE mesh-nodes.ts 丢弃 transport
  → DeviceNodeBadges 使用 reach

浏览器 direct controller
  → WebRTC getStats()
  → diagnostics.rtt
  → DeviceNodeBadges 显示 RTT
```

因此非 relay 的 `dc` 或 `ws-secure`连接会被 gateway 标成 `reach=lan`；如果浏览器侧没有 active direct diagnostics，RTT仍为 `null`，于是会显示：

```text
独立的 reach 徽章：局域网
独立的 browser 徽章：中转 · 延迟未知
```

这里的“局域网”和“延迟未知”来自两个独立字段，并非同一个 gateway RTT 计算结果。

## 7. 现有测试覆盖

### 文件根目录和文件浏览

- `packages/panels/src/settings/file-root-query.test.ts:38-45`
  - 覆盖根目录列表缓存和后台重取失败保留旧数据。
- `apps/fe/tests/settings-files.spec.ts`
  - 覆盖设置文件根目录页面的数据形状和空状态。
- `apps/fe/tests/files-context-menu.spec.ts:18-92`
  - 覆盖文件节点上下文菜单。
- `apps/gateway/src/api/files.test.ts:128-145`
  - 覆盖文件 root 请求体校验。
- `apps/gateway/src/files/path-safety.test.ts:29-88`
  - 覆盖路径越界、根目录安全校验。

### 设备卡片和侧栏可见性

- `packages/stores/src/sidebar-device-visibility.test.ts:6-28`
  - 覆盖复合 key、默认可见性、不同节点相同设备 ID隔离。
- `packages/stores/src/ui.test.ts:93-134`
  - 覆盖可见性持久化和非法 boolean 规范化。
- `packages/panels/src/device-management/device-card.test.tsx:251-295`
  - 覆盖本地/远程默认可见性及复合 key。
- `packages/panels/src/device-management/device-management-panel.test.tsx:64-100`
  - 覆盖离线、缓存和 fallback 设备列表。
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:226-309`
  - 覆盖离线节点隐藏、可见设备、选中设备保留、signed-out 节点。
- `apps/fe/tests/sidebar-device-disclosure.spec.ts`
  - 覆盖 panes/files tab 和离线显示。
- `apps/fe/src/pages/DevicesPage.test.tsx`
  - 覆盖 mesh 节点及离线设备页行为。

### Mesh transport/reach 与徽章数据

- `apps/gateway/src/mesh/mesh-routes.test.ts:29-121`
  - 覆盖 `/api/mesh/nodes`返回 `reach`、`transport`、`online`、`loggedIn`。
- `apps/gateway/src/mesh/peer-manager.test.ts:274-322`
  - 覆盖不可用直连后切换 relay。
- `apps/gateway/src/mesh/peer-manager.test.ts:790-806`
  - 覆盖 relay 升级为 dc。
- `apps/gateway/src/mesh/peer-manager.test.ts:1023-1082`
  - 覆盖 relay 到 ws-secure 后 reach 变为 lan。
- `apps/gateway/src/mesh/forwarder.test.ts:56-74`
  - 覆盖远程节点不可达返回 503。
- `apps/gateway/src/mesh/forwarder.test.ts:381-451`
  - 覆盖远程 WebSocket 的 dc/relay 故障切换。
- `packages/ws-client/src/direct/ice-stats.test.ts:131-179`
  - 覆盖 host-host、IPv6、srflx、TURN route 推导。
- `packages/ws-client/src/direct/direct-carrier-controller.test.ts:883-959`
  - 覆盖 WebRTC RTT和 route 发布。
- 未发现专门覆盖 `device-node-badges.tsx`渲染文案的前端单元测试。

## suggested implementation plan

如果要支持“远程节点真实链路类型 + 图形化目录选择器”，建议按以下文件推进：

1. 统一 mesh 链路模型

   - 修改 `apps/gateway/src/mesh/peer-manager.ts`
   - 修改 `apps/gateway/src/mesh/node-list-projection.ts`
   - 修改 `apps/gateway/src/mesh/mesh-routes.ts`
   - 修改 `apps/gateway/src/mesh/mesh-deps.ts`
   - 修改 `packages/api-client/src/auth/types.ts`
   - 修改 `apps/fe/src/node/mesh-nodes.ts`

   将 `transport`完整保留到前端 `NodeRow`和 node event，避免只依赖 `reach`。

2. 修正 reach/transport 展示语义

   - 修改 `apps/fe/src/node/device-node-badges.tsx`
   - 修改 `packages/shared/src/i18n/locales/zh_CN.json`
   - 增加 `device-node-badges`前端测试

   不要直接把 `reach=lan`解释为物理局域网。应明确区分：

   - `transport=relay`
   - `transport=ws-secure`
   - `transport=dc`
   - direct WebRTC route
   - RTT未知

   RTT应继续明确标注其测量端点，避免误认为 gateway peer RTT。

3. 增加图形化目录选择器 API

   - 新增 gateway 路由，建议放在 `apps/gateway/src/api/file-browser-routes.ts`或独立 `directory-picker-routes.ts`
   - 增加 `packages/shared/src/contracts/files.ts` DTO
   - 增加 `packages/api-client/src/file-resources.ts`客户端方法
   - 修改 `packages/panels/src/settings/file-root-form-modal.tsx`
   - 修改 `packages/panels/src/settings/file-root-form-sections.tsx`

   关键约束：

   - 不能允许任意路径枚举绕过 root 安全模型
   - 需要明确“选择器起始目录”的权限
   - local 和 SSH 设备的目录枚举能力不同
   - 必须复用 `checkAndNormalize`或等价安全校验
   - 远程请求必须支持 `/n/:id`代理
   - 需要处理超时、权限错误、符号链接和超大目录

4. 明确文件侧栏离线产品行为

   - 修改 `packages/panels/src/files/files-tab.tsx`
   - 修改 `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`
   - 必要时修改 `packages/panels/src/files/use-directory-listing.ts`
   - 增加远程节点离线且已有 root 缓存时的测试

   需要先决定：

   - 离线时保留根目录并标记离线
   - 还是隐藏根目录
   - 是否继续允许查看缓存目录内容
   - 是否让 `sidebarDeviceVisibility`同时影响文件根目录

5. 补充测试

   - gateway：transport/reach 投影、node event、远程文件 picker 代理
   - frontend：transport 字段保留、badge 文案、离线文件根目录行为
   - settings：路径选择器、非法路径、远程设备切换
   - 不要对 `packages/shared/src/i18n/resources.ts`、`types.ts`等生成文件直接编辑或格式化。