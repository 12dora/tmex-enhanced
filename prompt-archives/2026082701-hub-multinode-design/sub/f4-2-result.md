# F4-2 结果：前端每 node 运行时与路由

分支 `feat/hub-node`，worktree `/Users/konata/code/tmex-enhanced-wt-hub`。输入为 `sub/e0-2-result.md` 与 `phase0-result.md` 的 E0-2 决议。

## 1. 文件清单

### 新增

| 文件 | 内容 |
|---|---|
| `packages/api-client/src/node-url.ts` | `SELF_NODE_ID` / `isSelfNode` / `normalizeNodeId` / `nodePathPrefix` / `resolveNodeUrl` / `nodeWsUrl` / `createNodeApiClient` / `nodeAppPath` / `parseNodeIdFromPath` |
| `packages/api-client/src/node-url.test.ts` | 上述全部 + 带 nodeId 的 `fileRawUrl` / `fileDownloadUrl`（15 test） |
| `packages/stores/src/node-connection-manager.ts` | `NodeConnectionManager`、`nodeRuntimes`、`nodeStoragePrefix`、`useNodeRuntime` |
| `packages/stores/src/node-connection-manager.test.ts` | get/acquire/release/宽限期/隔离/list/disposeAll（13 test） |
| `packages/stores/src/flow-bridges.test.ts` | 栈式桥接注册（5 test） |
| `apps/fe/src/node/node-runtimes.ts` | 宿主的 `appNodeRuntimes`（注入 sonner sink）与每 node `QueryClient` |
| `apps/fe/src/node/node-runtime-boundary.tsx` | `NodeRuntimeBoundary`、`useRouteNodeId` |
| `apps/fe/src/node/node-runtime-boundary.test.tsx` | 边界路由 → 运行时映射、query 缓存隔离（5 test） |
| `apps/fe/src/pages/FilePage.test.tsx` | FilePage 媒体 / raw URL 的 node 前缀（5 test） |

### 修改

- api-client：`file-urls.ts`（`fileRawUrl` / `fileDownloadUrl` 首参改 nodeId）、`index.ts`（导出 node-url）。
- stores：`runtime.ts`（`RuntimeCore.nodeId`、`createBrowserHostServices`、删除 `setDefaultNotificationSink` / `proxyDefaultNotificationSink`）、`app-runtime.ts` 不变、`react.tsx`（context 默认值改 `null`，`useRuntime()` 缺 Provider 抛错，新增 `useOptionalRuntime`）、`default-runtime.ts`（默认 runtime + 原名 store 移到此模块）、`index.ts`（主入口不再构造默认 runtime）、`flow-bridges.ts`（栈式注册，返回注销函数）、`site-fallback.ts`（改为注册式读取器）、`use-pane-agent-state.ts`（删除默认 runtime 版 hook）、`app-navigation.ts`（选择事件带 nodeId，导出 `toAppPath` / `dispatchUserInitiatedSelection`）、`tmux-device-events.ts`（通知跳转经 `hostAppPath`）。
- stores 测试：`app-navigation.test.ts`（detail 增加 nodeId）、`site-theme.test.ts` / `tmux-sync-theme.test.ts`（默认 store 改从 `./default-runtime` 导入）。
- ws-client：**无改动**（`createGatewayConnection({ wsUrl })` 已可注入，`connection.test.ts` 已覆盖 client / registry / state machine 的按连接隔离）。
- panels（仅 e0-2 列出的调用点）：`files/file-node-actions.tsx`（拖拽下载 URL 带 `runtime.nodeId`）、`device-tree/device-tree-navigation.ts`（选择事件带 nodeId）、`device-console/page-actions.tsx`（jump 事件 detail 带 nodeId）。
- apps/fe：`main.tsx`（路由 + Provider 全面改造）、`components/global-device-provider.tsx`、`components/flow-bridges.tsx`、`components/page-layouts/components/{nav-link,app-sidebar,sidebar-title,sidebar-device-list,sidebar-agent-sessions}.tsx`、`lib/fonts/useAppMonoFont.ts`、`pages/FilePage.tsx`、`pages/SettingsPage.tsx`、`pages/settings/{use-site-settings-form.ts,general-settings-tab.tsx}`；删除 `lib/runtime-setup.ts`。
- i18n locale JSON：**未新增 key**（本任务无新文案）。

## 2. 公共 API

```ts
// @tmex/api-client
const SELF_NODE_ID = 'self';
isSelfNode(nodeId?): boolean
normalizeNodeId(nodeId?): string              // 空 / undefined → 'self'
nodePathPrefix(nodeId): string                // 'self' → ''，其余 → '/n/<encoded>'
resolveNodeUrl(nodeId, path): string          // 'self' → path 原样；其余 → '/n/<id>' + path
nodeWsUrl(nodeId, location?): string          // 绝对 ws(s)://host/ws 或 .../n/<id>/ws
createNodeApiClient(nodeId): ApiClient        // baseUrl = nodePathPrefix(nodeId)
nodeAppPath(nodeId, path): string             // SPA 路由前缀（语义与 resolveNodeUrl 同形）
parseNodeIdFromPath(pathname): string
fileRawUrl(nodeId, rootId, path, download=false): string   // 签名变更
fileDownloadUrl(nodeId, rootId, path): string              // 签名变更

// @tmex/stores
class NodeConnectionManager {
  constructor(options?: NodeConnectionManagerOptions)
  get(nodeId): NodeRuntimeEntry        // 懒建，不改引用计数；未 acquire 者宽限期后自动回收
  acquire(nodeId): NodeRuntimeEntry    // 引用计数 +1，取消待释放
  release(nodeId): void                // 引用计数 -1，归零后 30 s 释放
  refCount(nodeId): number
  has(nodeId): boolean
  list(): NodeRuntimeEntry[]
  dispose(nodeId): void                // 引用计数 > 0 时不生效
  disposeAll(): void
}
interface NodeRuntimeEntry { nodeId; connection; apiClient; runtime }
const nodeRuntimes: NodeConnectionManager
nodeStoragePrefix(nodeId): string            // self → ''，其余 → 'n:<id>:'
useNodeRuntime(nodeId?, manager?): AppRuntime
RuntimeCore.nodeId: string                   // 全包可经 useRuntime().nodeId 取当前 node
createBrowserHostServices({ nodeId?, appPath? }): HostServices
setSiteFallbackReader(fn): () => void
dispatchUserInitiatedSelection({ nodeId, deviceId, windowId, paneId })

// apps/fe
<NodeRuntimeBoundary>{children}</NodeRuntimeBoundary>   // RuntimeProvider + 该 node 的 QueryClient + GlobalDeviceProvider
useRouteNodeId(): string
appNodeRuntimes: NodeConnectionManager
nodeQueryClient(nodeId): QueryClient
```

## 3. 关键设计

### 3.1 `host.appPath` 承载 `/n/:nodeId` 路由前缀

`NodeConnectionManager` 给每个 node 的 runtime 注入 `host.appPath = p => nodeAppPath(nodeId, p)`。`hostAppPath()` 早已是「包内构造应用内路径 + matchPath pattern」的唯一出口，因此 `device-tree-navigation`（pane/device 路径的构造与解析）、`page-actions`、`files-tab`、`rsync-install-flow`、`watch-events-init`、`useTerminalFileLinks` 全部**零改动**变成 node-aware。`self` 时是恒等变换，旧路由逐字节不变。

### 3.2 QueryClient：按 node 一份客户端，而不是给 key 加前缀

任务书原定「query key 加 `['node', nodeId, ...]` 前缀」。实际实现改为**每 node 一个 `QueryClient`**，理由：

1. 约 30 个 query key 根散在 `packages/panels/src/settings/**`、`files/**`、`watch/**`、`agent/**`、`terminal-ui`，这些文件**不在 F4-2 的文件范围**内（范围只含 e0-2 列出的 4 个 panels 调用点）。
2. 只给范围内的调用点加前缀会**引入 bug**：`panels/files/files-tab.tsx` 的 `invalidateQueries(['files'])` 依赖前缀匹配 `['files','list'|'stat'|'content',…]`，一旦 FilePage 的 key 变成 `['node',id,'files',…]`，跨包失效链就断了。
3. 每 node 一个 client 的隔离更彻底（缓存、进行中的请求、`useIsFetching`、`clear()` 全部按 node 分离），且 key 语义完全不变，零调用点改动。

已在 `node-runtime-boundary.test.tsx` 用「两 node 写同一 key、互不可见、一方 `clear()` 不影响另一方」验证。

### 3.3 Provider 结构

```
AppRoot                                    // useNodeRuntime('self')：entry 运行时常驻
  RuntimeProvider(self) + QueryClientProvider(self)
    ThemePresetSync                        // 取代原模块级 useUIStore.subscribe
    RouterProvider
      /n/:nodeId  → NodeShell              // NodeRuntimeBoundary → RootLayout
      /           → NodeShell              // 同一套页面路由，nodeId 缺省即 self
    ThemedToaster
```

`NodeRuntimeBoundary` = `RuntimeProvider(node)` + `QueryClientProvider(node)` + `GlobalDeviceProvider`，并在挂载期注册 `setSiteFallbackReader`（`buildBrowserTitle` 的 siteName 跟随当前活跃 node）。`RootLayout` 内含 `WatchEventsInit`、`SidebarProvider`、`FlowBridges`、`AppSidebar`、`MainInset`、`ConnectionIndicator`——全部落在当前 node 的运行时下。

路由：`/n/:nodeId[/devices/:deviceId[/windows/:windowId/panes/:paneId]]`、`/n/:nodeId/settings`、`/n/:nodeId/file/:ref`；旧路由 `/devices/...`、`/settings`、`/file/:ref` 在 `self` 边界内渲染，**不做重定向**。

### 3.4 去默认 runtime 耦合

- `@tmex/stores` 主入口**不再构造** `defaultRuntime`：默认 runtime 与 `useUIStore/useSiteStore/useTmuxStore/useAgentStore/useFileTreeStore` 原名导出移到 `@tmex/stores/default-runtime`（仅测试与单实例宿主使用）。fe 全部改用 `@tmex/stores/react` 的 context hook。
- `react.tsx` 的 context 默认值改为 `null`，`useRuntime()` 缺 Provider 直接抛错（漏包不再静默落到别的 node）；另给外壳组件留了 `useOptionalRuntime()`。
- `flow-bridges.ts` 改栈式注册：`setNavigateBridge/setSidebarBridge` 返回自身的注销函数，node 切换时新旧边界短暂并存不会互相抹掉（router / sidebar 本身按宿主外壳唯一，不按 node 分身）。
- `site-fallback.ts` 改为注册式读取器，由活跃边界注册。
- `use-pane-agent-state.ts` 的默认 runtime 版 hook 删除（消费方 `terminal-ui/SplitPaneView` 早已用 context 版）。
- `setDefaultNotificationSink` / `proxyDefaultNotificationSink` 删除；sonner sink 由 `appNodeRuntimes` 的构造选项注入到每个 node runtime，`apps/fe/src/lib/runtime-setup.ts` 删除。
- `sidebar-agent-sessions.tsx` 里 4 处 `useXxxStore.getState()` 改为 `useRuntime().stores.*`；`sidebarAgentAdapter` 常量改为 `useSidebarAgentAdapter()` hook（`onCreateSessionForPane` 非 hook，只能闭包捕获 runtime）。
- `NavLink` 对以 `/` 开头的 `to` 套 `hostAppPath`，侧栏「设备管理 / 设置 / 首页」链接自动带 node 前缀。
- `GlobalDeviceProvider` 改用 `useRuntime().apiClient` + `matchPath(hostAppPath(host, '/devices/:deviceId'))`：`self` 不认领 `/n/x/devices/...`，node-a 也不认领 `/devices/...`（新增 `routeDeviceId` 并加测试）。

### 3.5 storage / UI 偏好

`storagePrefix`：`self` → `''`（旧 key 逐字节不变），其余 → `n:<id>:`（agent / file-tree 等按 node 隔离）。UI 偏好（主题、侧栏分区、终端字号、编辑器草稿）是**宿主级**偏好，所有 node 共用同一个 `UIStore`（key 仍为 `tmex-ui`，`main.tsx` 首屏裸读该 key 依旧有效）。`tmex_sidebar_width` 与 `sidebar_state` cookie 按任务书要求保持全局不变。

### 3.6 绕过 ApiClient 的点

全部迁移完毕：`SettingsPage.tsx` 的 `/api/settings/restart`、`use-site-settings-form.ts` 的两处 `/api/settings/site` 改 `runtime.apiClient.fetch()`；`FilePage.tsx` 的 img/audio/video/iframe/markdown resolver/`<a href>` 改 `fileRawUrl(nodeId, …)`；`fetchFileContent` / `fetchFileStat` / `downloadFileWithProgress` 改传 `runtime.apiClient`，`triggerDownload` 改用 `runtime.host.saveFile`（原先落 `defaultRuntime.host`）；`file-node-actions.tsx` 拖拽下载 URL 带 `runtime.nodeId`。

验收 grep：

```
grep -rn "fetch('/api\|\"/api/\|'/api/" apps/fe/src packages/panels/src packages/stores/src
```

剩余命中全部是 `apiClient.fetch('/api/...')`（不算 bypass）或测试文件里的断言字符串。

## 4. 测试与 tsc

| 包 | 测试（前 → 后） | tsc error（前 → 后） |
|---|---|---|
| `packages/api-client` | 34 → 69（其中 F4-1 的 auth 测试 ~20，本任务新增 15） | 5 → 5（均为既有 `client.test.ts` / `files-download.test.ts` 基线错误） |
| `packages/stores` | 101 → 119（新增 13 + 5） | 1 → 1（既有 `host-services.test.ts`） |
| `packages/ws-client` | 75 → 75 | 0 → 0 |
| `packages/panels` | 196 → 196 | 0 → 0 |
| `apps/fe` | 9 → 49（本任务新增 13 = 边界 5 + FilePage 5 + `routeDeviceId` 3，其余 27 为 F4-1 的 LoginPage/auth 测试） | 0 → 0（本任务文件）；当前 `bunx tsc -p apps/fe` 另有 11 个 error 全部来自 F4-1 正在改的 `pages/LoginPage.tsx`、`pages/AccountSecurityPage.tsx`，与本任务无关 |

`bunx biome check` 覆盖全部改动文件：仅剩 `main.tsx` 的 `StatusBarSync` `useExhaustiveDependencies`——用 `git show HEAD:apps/fe/src/main.tsx` 复核确认为**改动前既有**告警，未动该 hook。

新增测试要点：
- `resolveNodeUrl` / `nodeWsUrl` / `nodePathPrefix` / `createNodeApiClient` / `nodeAppPath` / `parseNodeIdFromPath`；`fileRawUrl` / `fileDownloadUrl` 的 self 与非 self。
- `NodeConnectionManager`：同 id 复用、空 id 归一 self、两 node 的 connection/apiClient/store/storagePrefix 隔离且共用 UIStore、`host.appPath` 前缀、宽限期（29 s 未释放 / 31 s 释放且 `runtime.dispose()` + `connection.dispose()` 各一次）、引用计数未归零不释放、宽限期内重 acquire 复用、只 `get` 未 `acquire` 者自动回收、`list()` / `disposeAll()` / 引用计数 > 0 时 `dispose` 无效。
- `NodeRuntimeBoundary`（`react-dom/server` 静态渲染 + `MemoryRouter`）：`/n/node-a/...` 与 `/n/node-b/...` 渲染不同 runtime；旧路由 → self 且 baseUrl / storagePrefix / appPath 与单 node 时一致；`/n/self/...` 与旧路由同一 runtime。
- 每 node QueryClient 缓存隔离。
- `FilePage`：非 self node 的 image / video / pdf `src`、markdown 图片 resolver、`PageActions` 的 raw `<a href>` 均带 `/n/<id>` 前缀；self 无前缀且不含 `/n/`。
- `routeDeviceId`：self 与 node runtime 各自只认领自己的路径。
- `flow-bridges`：栈式注册、旧边界卸载不抹掉新注册、注销后回落、全空即 no-op。

> 说明：仓库没有 React DOM 测试环境（`apps/fe` / `packages/panels` 均无 `@testing-library/react` 或 happy-dom，且禁止 `bun install`），因此组件级测试改用 `react-dom/server` 的 `renderToStaticMarkup` 做静态渲染断言——运行时在渲染期即已解析，effect 只负责引用计数，断言不受影响。

## 5. 未完成 / 需后续处理

1. **Bell store 按 `nodeId + paneId` 键控** —— 未做。`useBellStore` 在 `packages/notifications`，消费方在 `packages/terminal-ui/src/components/split/SplitPaneView.tsx`、`packages/panels/src/device-tree/{pane-row,window-row}.tsx`、`packages/panels/src/device-console/page-title.tsx`，全部**不在 F4-2 文件范围**内。生产者 `stores/tmux-device-events.ts` 在范围内，但单改生产者会与消费者的裸 `paneId` 读取对不上。后续需一并改这 5 个文件（建议：`ringingPanes` 键改 `${nodeId}:${paneId}`，各组件从 `useRuntime().nodeId` 取前缀）。
2. **ws-client 模块级单例未删除** —— `getBorshClient()`、`getSelectStateMachine()`、`pane-sink-registry` 的模块级代理仍在。它们只是 `resolveRuntimeCore` 在**没有 connection** 时的回退路径；`NodeConnectionManager` 永远注入 connection，因此任何 node runtime 都不会碰到它们（`connection.test.ts` 已断言每个 connection 有独立 client / registry / state machine）。删除会连带重写 `packages/stores` 的 4 个 mock 了 `getBorshClient` 的测试文件与 `ws-client/pane-sink-registry.test.ts`，属于纯清理，建议单独一轮做。
3. **全局事件的接收侧过滤** —— `tmex:user-initiated-selection` 与 `tmex:jump-to-latest` 的 detail 已带 `nodeId`（范围内的两个派发点 `device-tree-navigation.ts`、`app-navigation.ts`、`page-actions.tsx`），但接收侧 `panels/device-console/use-pane-active-follow.ts`、`use-device-console-effects.ts` 未加 nodeId 过滤，`panels/watch/watch-events-init.tsx` 的派发也未带 nodeId——三者均不在范围内。当前同一时刻只有一个 node 边界挂载，行为无差异；将来做「侧边栏聚合视图 / 多 node 面板并存」前必须补上。
4. **`OPEN_ADD_DEVICE_EVENT` 未带 nodeId** —— 派发与接收都在 `packages/panels/src/device-management/**`，不在范围内。
5. **`document.title`** —— 仍由 `panels/device-console/use-device-console-effects.ts` 设置（不在范围内）。因为路由同一时刻只挂一个 node 边界，不会互相覆盖；站点名兜底已通过 `setSiteFallbackReader` 跟随活跃 node。
6. **非 self node 的 theme localStorage 兜底** —— `createSiteStore` 的 `writeThemeToLocalStorage` 用 `core.storagePrefix`，非 self 会写 `n:<id>:tmex-ui`，而共享 UIStore 持久化到 `tmex-ui`。内存态正确（`setState({theme})` 落共享 store），该兜底 key 目前无人读取，属无害冗余；若要彻底统一需给 site store 单独传「UI 偏好前缀」。

## 6. 协调方必须知道的事

1. **路由表新增页面的挂载位置**：`apps/fe/src/main.tsx` 现在只有两条顶层路由（`/n/:nodeId` 与 `/`），两者都走 `NodeShell`（= `NodeRuntimeBoundary` + `RootLayout`）。F4-1 的 `/login` 与 F4-3 的 `/nodes` 需要显式加进去：`/login` 应放在 **node 边界之外**（登录时还没有可用会话，且它不属于任何 node），`/nodes` 属于 entry，建议作为 `/` 分支下的一个子路由（在 self 边界内）。`AppRoot` 已经在最外层提供了 self 的 `RuntimeProvider` + `QueryClientProvider`，因此边界外的页面照样能用 `useRuntime()`。
2. **`useRuntime()` 现在会抛错**：context 不再有默认值。任何在 `AppRoot` 之外渲染的 React 树（含新写的测试）必须自带 `RuntimeProvider`。
3. **`@tmex/stores` 主入口不再导出** `defaultRuntime` / `useUIStore` / `useSiteStore` / `useTmuxStore` / `useAgentStore` / `useFileTreeStore`；需要单实例语义请 `import { … } from '@tmex/stores/default-runtime'`，React 子树请用 `@tmex/stores/react`。
4. **破坏性签名变更**：`fileRawUrl(nodeId, rootId, path, download?)`、`fileDownloadUrl(nodeId, rootId, path)`；`setNavigateBridge` / `setSidebarBridge` 现在返回注销函数（传 `null` 仍表示清空全部）；`navigateToAppUrl(url, nodeId?)`；`setDefaultNotificationSink` 已删除。
5. **后端依赖**：本任务假定 entry 侧已经/将会提供 `/n/:id/api/*` 与 `/n/:id/ws`（B2-2）。在这些路由落地前，非 `self` 的 node 页面会 404——`self` 与旧路由行为完全不变，可先合入。
6. **e2e**：未跑（任务禁止）。改动面涉及 Provider 结构与 `main.tsx`，合入后建议先跑一轮 fe e2e 对齐 `e2e-baseline-failures` 的既有 9 个失败。
7. **并发冲突面**：与 F4-1 的接触点只有 `packages/api-client/src/index.ts`（我加了 `export * from './node-url'`）和 `apps/fe/src/main.tsx` 的路由表；`packages/api-client/src/client.ts` 的 response hook 是 F4-1 改的，与 node-url 无冲突。
