# E2 调查报告：Sidebar「Files」仅显示本地节点

## 结论

问题不在 `sidebarFilesVisibility`。远端设备的开关已经使用 `nodeId:deviceId` 复合键；真正原因是 Files Tab 只挂载一个 runtime，并只调用该 runtime 的 `/api/files/roots`。在普通 `/devices`、`/` 路由下，该 runtime 是 `self`，因此不会查询远端节点的文件根。

远端文件 API 本身已经支持浏览器通过 `/n/<nodeId>` 转发；缺少的是 Files Tab 的多节点聚合、节点名称展示和文件根排序 UI。

## 1. Files Tab 当前实现及问题原因

入口位于 [`app-sidebar.tsx:20`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:20)，Files Tab 从 `@tmex/panels/files` 懒加载。

关键挂载代码：

```tsx
const routeNodeId = useRouteNodeId();

<NodeRuntimeScope nodeId={routeNodeId}>
  ...
  <FilesTab nodeOffline={routeNodeOffline} />
</NodeRuntimeScope>
```

见 [`app-sidebar.tsx:29`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:29) 和 [`app-sidebar.tsx:99`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:99)。

因此：

- `/`、`/devices` 等旧路由的 `routeNodeId` 是 `self`；
- `/n/<remoteId>/...` 路由的 `routeNodeId` 才是远端节点；
- Files Tab 没有调用 `selfAgentStore()` 或 `resolveAgentStore()`；
- Files Tab 直接读取当前 `RuntimeProvider` 提供的 `useRuntime()`。

核心查询位于 [`files-tab.tsx:76`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/files-tab.tsx:76)：

```tsx
const { apiClient, nodeId } = useRuntime();

const rootsQuery = useQuery({
  queryKey: ['files', 'roots'],
  queryFn: () => fetchFileRoots(apiClient),
});

const devicesQuery = useQuery({
  queryKey: ['devices'],
  queryFn: () => fetchDevices(apiClient),
});
```

`devicesQuery` 不负责渲染设备列表，只用于计算 `localDeviceId` 等传输上下文；真正展示的是当前 runtime 返回的 `roots`：

```tsx
selectVisibleFileRoots({
  roots: rootsQuery.data?.roots ?? [],
  runtimeNodeId: nodeId,
  visibility: filesVisibility,
  deviceConnected,
})
```

见 [`files-tab.tsx:107`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/files-tab.tsx:107)。

根目录最终是一个扁平列表：

```tsx
{roots.map((root) => (
  <DirNode key={root.id} root={root} ... />
))}
```

见 [`files-tab.tsx:166`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/files-tab.tsx:166)。当前没有 node 分组，也没有 node 名称字段。

文件树展开后的请求不是 `/api/files/browse`，而是：

```tsx
queryKey: ['files', 'list', rootId, path],
queryFn: () => fetchFileList(rootId, path, runtime.apiClient),
```

见 [`use-directory-listing.ts:23`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/use-directory-listing.ts:23)。`fetchFileList()` 调用 `/api/files/list`，见 [`file-resources.ts:62`](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/file-resources.ts:62)。`/api/files/browse` 只用于设置页的图形化路径选择器，见 [`file-resources.ts:92`](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/file-resources.ts:92)。

根行显示的是设备名，不是节点名：

```tsx
{isRoot && <DeviceBadge root={root} />}
```

见 [`directory-node-view.tsx:86`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/directory-node-view.tsx:86)。`DeviceBadge` 只渲染 `root.deviceName`，见 [`node-menu.tsx:95`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/node-menu.tsx:95)。

`FileRootDto` 本身也没有 `nodeId` 或 `nodeName`，只有 `deviceId`、`deviceName`、`sortOrder` 等字段，见 [`files.ts:41`](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/contracts/files.ts:41)。

设备卡片的文件开关已经正确使用节点复合键：

```tsx
const visibilityKey = sidebarDeviceVisibilityKey(nodeId, device.id);

isSidebarFilesVisible(
  state.sidebarFilesVisibility,
  nodeId,
  device.id,
  hasRoots
)
```

见 [`device-card.tsx:254`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-management/device-card.tsx:254)。开关使用的 i18n key 是：

- `device.sidebar.files`
- `device.sidebar.filesHint`
- `device.sidebar.filesDisabledHint`

见 [`device-card.tsx:388`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-management/device-card.tsx:388)。

所以，远端开关写入的是例如：

```text
<remoteNodeId>:<deviceId>
```

但 self 路由下的 Files Tab 只拿到了 self 节点的 roots，根本不会读到远端 root。`selectVisibleFileRoots()` 只能过滤传入的 roots，不能跨 runtime 聚合，见 [`root-visibility.ts:29`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/root-visibility.ts:29)。

Files Tab 当前使用的 i18n key：

- `files.title`
- `files.refresh`
- `files.nodeOffline`
- `files.error.unknown`
- `files.noRoots`
- `common.loading`
- `common.retry`

## 2. 可复用的多节点模式

### 终端/设备侧栏

终端侧栏已经实现了多节点聚合：

```tsx
const { nodes } = useMeshNodes();

const entries = toSidebarEntries(nodes, entryNodeId, sidebarNodeOrder);
```

见 [`sidebar-device-list.tsx:93`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:93)。

`toSidebarEntries()` 将 mesh 节点映射为：

```tsx
{
  id: node.id,
  runtimeNodeId: isSelf ? SELF_NODE_ID : node.id,
  name: node.name,
  online: node.online,
  loggedIn: isSelf ? true : node.loggedIn,
  inventory: node.inventory ?? null,
}
```

见 [`sidebar-device-list.tsx:61`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:61)。

节点名称来自 `useMeshNodes()` 合并后的 `name`：

```tsx
name: hub?.name ?? node.name
```

见 [`mesh-nodes.ts:144`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-nodes.ts:144)。

每个节点分节再单独挂载自己的 runtime：

```tsx
<NodeRuntimeScope nodeId={node.runtimeNodeId}>
  <SideBarDeviceListForRuntime ... />
</NodeRuntimeScope>
```

见 [`sidebar-node-section.tsx:318`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:318)。

`NodeRuntimeScope` 同时提供：

- 对应节点的 `RuntimeProvider`；
- 对应节点的 `QueryClient`；
- 对应节点的 `GlobalDeviceProvider`。

见 [`node-runtime-scope.tsx:21`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/node-runtime-scope.tsx:21)。

`NodeConnectionManager` 为每个节点创建独立的 `apiClient`：

```tsx
const apiClient =
  this.options.createApiClient?.(nodeId) ?? createNodeApiClient(nodeId);
```

见 [`node-connection-manager.ts:154`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/node-connection-manager.ts:154)。`createNodeApiClient()` 对 self 使用空前缀，对远端使用 `/n/<nodeId>`，见 [`node-url.ts:49`](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/node-url.ts:49)。

节点显示名应复用 `NodeBadge`，其输入类型是：

```tsx
{
  nodeId,
  name,
  online,
  isSelf
}
```

设备管理页的 `nodeDeviceContext()` 也已经提供同样的映射：

```tsx
return {
  runtimeNodeId: node.runtimeNodeId,
  name: node.name,
  isSelf: node.isSelf
};
```

见 [`node-device-group.tsx:163`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/pages/devices/node-device-group.tsx:163)。

### Agent 会话

Agent 状态明确由 entry/self 网关持有，但显示按 runtime node 过滤。

`AppSidebar` 显式传入：

```tsx
<AgentTab agentStore={selfAgentStore()} nodeOffline={routeNodeOffline} />
```

见 [`app-sidebar.tsx:104`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:104)。

`useAgentTabState()` 的解析模式是：

```tsx
const agentStore = host.agentStore ?? resolveAgentStore(runtime.stores.agent);
const nodeId = normalizeAgentNodeId(runtime.nodeId);
```

见 [`use-agent-tab-state.ts:220`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/agent/use-agent-tab-state.ts:220)。

侧栏内嵌 Agent 会话则使用：

- `useSessionsForPane()`
- `useNodeSessions()`
- `sessionsOnNode()`
- `sessionsForPane()`
- `isSessionOnNode()`
- `normalizeAgentNodeId()`

见 [`use-sidebar-agent-sessions.ts:321`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:321)。测试明确验证同一 `deviceId:paneId` 在不同 node 下不会串台，见 [`use-sidebar-agent-sessions.test.ts:243`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.test.ts:243)。

### 已存在的多 client 文件根聚合

设置页已经有可直接复用的文件根聚合抽象：

- `FileRootDeviceGroup`
- `FileRootEntry`
- `collectFileRootClients()`
- `resolveFileRootClient()`
- `fetchFileRootEntries()`
- `useFileRootsQuery()`

`collectFileRootClients()` 去重不同节点的 `ApiClient`，`fetchFileRootEntries()` 对多个 client 执行 `Promise.all(fetchFileRoots(client))`，见 [`file-root-query.ts:78`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/settings/file-root-query.ts:78)。

其测试已经覆盖远端 client 选择和聚合，见 [`file-root-query.test.ts:52`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/settings/file-root-query.test.ts:52)。

## 3. 现有拖拽排序实现

依赖是：

- `@dnd-kit/core` `^6.3.1`
- `@dnd-kit/sortable` `^10.0.0`
- `@dnd-kit/utilities` `^3.2.2`

见 [`packages/panels/package.json:32`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/package.json:32)。

通用组件位于 [`device-tree-dnd.tsx:1`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-tree-dnd.tsx:1)：

- `useDeviceTreeSensors()`
- `SortableVerticalList`
- `useSortableRow()`
- `reorderIdsByDragEnd()`
- `pointerFirstCollisionDetection`

节点分节使用 `sidebar-node:<nodeId>` 前缀隔离 sortable id，见 [`sidebar-device-list.tsx:14`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:14)。

| 对象 | 拖拽入口 | 持久化方式 |
|---|---|---|
| Sidebar 节点分节 | `SortableVerticalList` + `useSortableRow` | Zustand `tmex-ui` localStorage，字段 `sidebarNodeOrder` |
| 设备 | `SortableVerticalList` | 当前 runtime 的 `PUT /api/devices/order`，body `{ deviceIds }` |
| Window | `SortableVerticalList` | tmux store 乐观更新，再发送 WS `reorder-windows` |
| Pane | `SortableVerticalList` | tmux store 乐观更新，再发送 WS `reorder-panes` |
| Agent session | 无 dnd | `sessionOrder` 按 `updatedAt`，不是手工拖拽 |

节点顺序使用的 UI store 字段和持久化 key：

```tsx
sidebarNodeOrder: string[];
setSidebarNodeOrder: (nodeIds: string[]) => void;
```

见 [`ui.ts:95`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/ui.ts:95)。实际存储名是：

```text
tmex-ui
```

由 `createUIStore()` 的 `storageKey` 生成，见 [`ui.ts:142`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/ui.ts:142)。`sidebarNodeOrder` 在 `partialize()` 中持久化，见 [`ui.ts:232`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/ui.ts:232)。

设备重排使用：

```tsx
mutationFn: (deviceIds) => reorderDevices(deviceIds, runtime.apiClient)
```

见 [`sidebar-device-list.tsx:130`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/sidebar-device-list.tsx:130)。API client 调用：

```text
PUT /api/devices/order
{ "deviceIds": [...] }
```

见 [`devices.ts:84`](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/devices.ts:84)。网关最终重写数据库 `sortOrder`，见 [`devices.ts:193`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/db/devices.ts:193)。

Window/Pane 的侧栏排序分别调用：

```tsx
stores.tmux.getState().reorderWindows(deviceId, nextIds)
stores.tmux.getState().reorderPanes(deviceId, windowId, nextIds)
```

见 [`device-window-list.tsx:77`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-window-list.tsx:77) 和 [`window-pane-list.tsx:19`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/window-pane-list.tsx:19)。底层通过 WS 发送 `reorder-windows`、`reorder-panes`，见 [`tmux.ts:285`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux.ts:285)。

文件根已有服务端排序字段：

```tsx
sortOrder: number
```

并且 `PATCH /api/files/roots/:id` 接受 `sortOrder`，见 [`file-root-routes.ts:90`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/api/file-root-routes.ts:90)。数据库查询按 `sortOrder`、路径排序，见 [`file-roots.ts:13`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/db/file-roots.ts:13)。但当前没有文件根 bulk reorder API，也没有 Files Tab 的拖拽组件。

## 4. Files API、mesh 转发与登录

网关注册了三组 Files routes，见 [`files.ts:106`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/api/files.ts:106)。

| 类型 | 路由 |
|---|---|
| 根目录 | `GET/POST /api/files/roots`、`PATCH/DELETE /api/files/roots/:id` |
| 浏览/读取 | `GET /api/files/browse`、`list`、`content`、`stat`、`raw` |
| 传输 | `GET /api/files/download`、`POST /api/files/download/prepare`、`GET/DELETE /api/files/download/:id...`、`POST/PUT/DELETE /api/files/upload...` |

普通浏览器请求远端节点时使用：

```text
/n/<remoteNodeId>/api/files/roots
/n/<remoteNodeId>/api/files/list?rootId=...&path=...
```

`Forwarder.handle()` 对普通 `/api/*` 远端请求转入 `handleRemoteHttp()`，但明确拒绝浏览器访问 `/api/mesh-internal/*`，见 [`forwarder.ts:141`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:141)。

远端 HTTP 转发流程：

```tsx
const auth = parseCookies(req.headers.get('cookie'))
  .get(nodeSessionCookieName(nodeId)) ?? null;

openHttpStream(link, {
  method: req.method,
  path: rest,
  query: search,
  headers,
  origin,
  auth,
});
```

见 [`forwarder.ts:516`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:516)。

也就是说：

1. 浏览器使用当前节点的 `ApiClient`，其 base URL 是 `/n/<nodeId>`；
2. entry 不把浏览器的 `Cookie`、`Authorization` 等头原样转发；
3. entry 从 `tmex_s_<nodeId>` 节点会话 cookie 提取 auth；
4. auth 放进 mesh HTTP stream open payload；
5. 远端通过 `NodeSessionStore.verify(auth, { viaNodeId })` 验证，见 [`stream-targets.ts:152`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/stream-targets.ts:152)；
6. 远端构造请求时加入可信的 `x-tmex-mesh-peer`，见 [`stream-targets.ts:171`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/stream-targets.ts:171)。

`x-tmex-mesh-peer` 不能由浏览器伪造；外部请求中的该 header 会被剥除，见 [`peer-request-marker.ts:21`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-request-marker.ts:21)。

`/api/mesh-internal/*` 是 peer-to-peer 内部路径，不是 Files API 的转发路径。其特点是：

- 浏览器请求会被 `Forwarder` 返回 403；
- 只有已标记的 peer inbound 请求才进入内部处理；
- `MeshHttpRuntime` 对该路径调用 `handleMeshInternalTmuxRequest()`。

见 [`mesh-http.ts:183`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-http.ts:183)。

远端节点返回 401 时，entry 会改写为：

```json
{
  "code": "NODE_LOGIN_REQUIRED",
  "nodeId": "<remoteNodeId>"
}
```

见 [`forwarder.ts:707`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.ts:707)。

因此，浏览器调用远端 Files API 已经可行。当前缺的是 Files Tab 没有遍历节点并为每个节点使用对应 client。

节点登录复用 `useNodeLoginGate()`：

```tsx
const needsLogin = row?.online === true && !row.loggedIn;
```

见 [`use-node-login.ts:76`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/auth/use-node-login.ts:76)。

现有终端侧栏在节点分节展开时使用该 gate；路由页面则由 `NodeRouteGate` 使用，见 [`node-runtime-boundary.tsx:64`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/node-runtime-boundary.tsx:64)。当前 `FilesTab` 自身没有调用 `useNodeLoginGate()`，它依赖当前路由的 `NodeRouteGate`。因此 self 路由下新增远端 Files 分组时，也必须处理远端节点的登录状态。

## 5. 现有测试覆盖

本次未运行测试，仅检查测试代码。

### Files/sidebar 单元测试

- [`files-tab.test.tsx:85`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/files-tab.test.tsx:85)
  - 本机启用 root 默认显示；
  - 未连接 SSH 设备的 root 隐藏；
  - 禁用 root 隐藏；
  - node 离线只显示 `files.nodeOffline`；
  - 单目录最多渲染 500 行，见 `files-tab.test.tsx:189`。
- [`root-visibility.test.ts:38`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/root-visibility.test.ts:38)
  - local/SSH 可达性；
  - 远端 node 默认可显示；
  - `sidebarFilesVisibility` 复合键过滤。
- [`sidebar-device-visibility.test.ts:35`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/sidebar-device-visibility.test.ts:35)
  - self 与 remote 使用相同的 `nodeId:deviceId` 文件可见性规则。
- [`ui.test.ts:121`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/ui.test.ts:121)
  - `sidebarFilesVisibility` 的 `tmex-ui` 持久化。
- [`file-root-query.test.ts:52`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/settings/file-root-query.test.ts:52)
  - 多 client 文件根聚合、按设备选择写入 client。

### Sidebar 节点/排序单元测试

- [`sidebar-device-list.test.tsx:93`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:93)
  - mesh 节点映射、self 映射为 `runtimeNodeId: 'self'`；
  - `sidebarNodeOrder` 应用逻辑；
  - 节点 sortable id；
  - 节点名称/徽标及登录状态。
- [`sidebar-device-list.test.tsx:477`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:477)
  - 节点分节标题作为拖拽手柄。
- [`ui.test.ts:230`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/ui.test.ts:230)
  - `sidebarNodeOrder` 默认值、localStorage 持久化、非法数据归一化。
- [`device-tree-dnd.test.ts:12`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-tree-dnd.test.ts:12)
  - 拖拽顺序计算、无目标/未知 id；
  - 指针优先碰撞检测。
- [`device-tree-selectors.test.ts:162`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-tree-selectors.test.ts:162)
  - 隐藏设备保持原 slot 的 `mergeReorderedVisibleIds()`。
- [`device-reorder.test.ts:14`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-tree/device-reorder.test.ts:14)
  - 设备排序乐观更新。
- [`devices.test.ts:129`](/Users/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/devices.test.ts:129)
  - `PUT /api/devices/order` 请求体。
- [`device-order.test.ts:33`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/db/device-order.test.ts:33)
  - 设备 `sortOrder` 和 window/pane 顺序持久化。

### Agent 多节点单元测试

- [`use-sidebar-agent-sessions.test.ts:243`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.test.ts:243)
  - 同一会话集合按 node 过滤。
- [`use-sidebar-agent-sessions.test.ts:342`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.test.ts:342)
  - `sessionsOnNode()` 只保留目标 node。

### E2E

- [`files-context-menu.spec.ts:18`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/tests/files-context-menu.spec.ts:18)
  - 创建本机 device/root；
  - 访问 `/`；
  - 点击 `sidebar-tab-files`；
  - 展开文件树；
  - 验证右键菜单、上传、下载。
- [`sidebar-device-disclosure.spec.ts:55`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/tests/sidebar-device-disclosure.spec.ts:55)
  - 三个 sidebar tab 互斥；
  - Files Tab 可显示；
  - 未验证远端 node 文件。
- [`settings-files.spec.ts:3`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/tests/settings-files.spec.ts:3)
  - 验证设置页文件根 query 不复用 sidebar 文件树缓存形状。
- 未发现专门覆盖以下场景的 E2E：
  - self 与 remote 节点同时出现在 Files Tab；
  - Files Tab 显示节点名称；
  - 远端 node 登录后加载 `/n/<id>/api/files/roots`；
  - Files 根目录拖拽排序；
  - Sidebar 节点/设备排序的浏览器端持久化。

Mesh 转发本身有单元测试覆盖远端 HTTP、401 `NODE_LOGIN_REQUIRED`、header 过滤和 mesh-internal 信任边界，主要见 [`forwarder.test.ts:66`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.test.ts:66)、[`forwarder.test.ts:167`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/forwarder.test.ts:167)、[`mesh-http.test.ts:223`](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-http.test.ts:223)。