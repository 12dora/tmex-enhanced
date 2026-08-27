# E0-2 前端 URL 与运行时只读审计报告

审计范围：`apps/fe/src/**`、`packages/api-client/src/**`、`packages/ws-client/src/**`、`packages/stores/src/**`、`packages/panels/src/**`、`packages/terminal-ui/src/**`、`packages/ui/src/**`、`packages/notifications/src/**`。

本次未修改文件。

## 1. 绕过 `ApiClient` 的 URL 构造点

以下为实际绕过 `ApiClient` 或直接把 gateway URL 放入 DOM/浏览器 API 的位置。

| 文件:行号 | 类型 | 路径 | 迁移建议 |
|---|---|---|---|
| `apps/fe/src/pages/SettingsPage.tsx:128` | 全局 `fetch` | `/api/settings/restart` | 改为当前 runtime 的 `apiClient.fetch()`；由 `new ApiClient('/n/:nodeId')` 注入节点前缀。 |
| `apps/fe/src/pages/settings/use-site-settings-form.ts:37` | 全局 `fetch` | `/api/settings/site` | 改为 `useRuntime().apiClient.fetch()`。当前同时使用默认 `useSiteStore`，需改为 runtime-aware hook。 |
| `apps/fe/src/pages/settings/use-site-settings-form.ts:56-62` | 全局 `fetch` | `/api/settings/site` | 同上，使用当前 runtime 的 `ApiClient`。 |
| `packages/ws-client/src/client.ts:12-13` | WS 默认 URL 构造 | `/ws` | 由节点管理器先调用 `resolveNodeUrl(nodeId, '/ws')`，再生成 `ws:`/`wss:` URL 并注入 `wsUrl`。 |
| `packages/ws-client/src/client.ts:40` | `new WebSocket(url)` | 动态 `url` | 保留为底层 transport primitive；调用者必须传入已解析的 node-aware URL。 |
| `packages/api-client/src/file-urls.ts:16` | 原始媒体 URL helper | `/api/files/raw?...` | 作为 DOM `src`/`href` 使用时包裹 `resolveNodeUrl(nodeId, fileRawUrl(...))`。 |
| `packages/api-client/src/file-urls.ts:22` | 原始下载 URL helper | `/api/files/download?...` | 作为拖拽下载 URL 使用时包裹 `resolveNodeUrl(nodeId, fileDownloadUrl(...))`。 |
| `apps/fe/src/pages/FilePage.tsx:98` | `<img src>` | `fileRawUrl(rootId, path)` | 改为 node-aware raw URL。 |
| `apps/fe/src/pages/FilePage.tsx:116` | `<audio src>` | `fileRawUrl(rootId, path)` | 改为 node-aware raw URL。 |
| `apps/fe/src/pages/FilePage.tsx:123` | `<video src>` | `fileRawUrl(rootId, path)` | 改为 node-aware raw URL。 |
| `apps/fe/src/pages/FilePage.tsx:129` | `<iframe src>` | `fileRawUrl(rootId, path)` | 改为 node-aware raw URL。 |
| `apps/fe/src/pages/FilePage.tsx:177` | Markdown 图片 resolver | `fileRawUrl(rootId, imgPath)` | resolver 必须接收 `nodeId`，返回 `resolveNodeUrl(nodeId, fileRawUrl(...))`。 |
| `apps/fe/src/pages/FilePage.tsx:279` | `<a href>` | `fileRawUrl(rootId, path)` | 改为 node-aware raw URL。 |
| `packages/panels/src/files/file-node-actions.tsx:52-53` | OS 拖拽下载 URL | `origin + fileDownloadUrl(...)` | 改为 `origin + resolveNodeUrl(nodeId, fileDownloadUrl(...))`。当前函数没有 `nodeId` 参数，需要从 runtime/context 获取。 |
| `packages/stores/src/runtime.ts:185` | `window.open` | 动态 `url` | 保留为宿主外链 primitive；若调用方传 gateway URL，调用方必须先解析 node URL。 |
| `packages/stores/src/runtime.ts:203-210` | `<a href download>` | `blob:` object URL | 本地 blob 保存，不涉及 gateway，保留。 |
| `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:50` | `<img src>` | `/logo.png` | 静态入口资源，entry-local，保留。 |
| `packages/panels/src/markdown/markdown-preview.tsx:38-50` | Markdown `<a href>` / `<img src>` | Markdown 动态 URL | 外链和 `data:` URL 保留；本地图片已交给 resolver，resolver 应负责 node 前缀。Markdown 普通链接当前不会自动解析 `/api`。 |
| `packages/panels/src/markdown/streaming-markdown.tsx:41-49` | Markdown `<a href>` | Markdown 动态 URL | 当前为外链展示，保留；若未来允许本地 gateway 链接，需要显式 resolver。 |
| `packages/panels/src/agent/messages/tool-call-card.tsx:162-170` | 工具结果 `<a href>` | `item.url` | 当前是搜索结果外链，保留。 |
| `packages/panels/src/agent/messages/tool-call-card.tsx:198-206` | 工具结果 `<a href>` | `input.url` | 当前是抓取 URL 外链，保留。 |
| `packages/panels/src/agent/messages/tool-call-card.tsx:259-272` | 工具结果 `<a href>` / `<img src>` | 动态图片 URL | 当前仅支持外部或 `data:` 图片，保留。 |
| `packages/terminal-ui/src/components/hooks/useTerminalFileLinks.ts:54-55` | 应用路由 URL | `/file/:ref` | 这是 entry-local SPA 路由，不是 gateway URL；通过 `hostAppPath` 保留。 |
| `packages/stores/src/app-navigation.ts:14-15` | URL 解析 | 动态 app URL | 只提取应用 pathname，不访问 gateway，保留。 |

以下 `/api/...` 虽然是字符串构造，但已通过 `ApiClient.fetch()`，不属于 bypass：

- `packages/api-client/src/file-resources.ts:19-86`
- `packages/api-client/src/terminal-shortcuts.ts:9-21`
- `packages/api-client/src/download-transfer.ts:52-99`
- `packages/api-client/src/site.ts:9`
- `packages/api-client/src/capabilities.ts:16`
- `packages/api-client/src/llm-providers.ts:20-60`
- `packages/api-client/src/agent.ts:34-216`
- `packages/api-client/src/watch.ts:24-101`
- `packages/api-client/src/devices.ts:27-103`
- `packages/api-client/src/upload-transfer.ts:26-85`

未发现：

- `new EventSource(...)`
- `location.assign()` / `location.replace()`
- `navigator.serviceWorker`
- `PushManager.subscribe()`
- service-worker 或 push gateway endpoint
- `/ws` 字符串字面量以外的浏览器直连点

## 2. `ApiClient` 与 `createGatewayConnection`

### `ApiClient`

构造参数只有：

```ts
new ApiClient(baseUrl?: string, transport?: FetchLike)
```

定义于 `packages/api-client/src/client.ts:7-11`。

URL 通过简单字符串拼接生成：`packages/api-client/src/client.ts:13-23`。

当前行为：

- `baseUrl=''` 时，`/api/x` 仍为 `/api/x`。
- `baseUrl='/n/node-a'` 时，`/api/x` 会变成 `/n/node-a/api/x`。
- `baseUrl='http://gateway'` 时，生成绝对 URL。
- 不做 slash normalization，要求 `baseUrl` 不以 `/` 结尾、path 以 `/` 开头。
- transport 可注入，且收到已拼接的 URL：`packages/api-client/src/client.test.ts:11-29`。
- 所有 endpoint helper 默认使用全局 `defaultApiClient`：`packages/api-client/src/client.ts:27`、`packages/api-client/src/file-resources.ts:16-18`。

结论：前缀已经可以通过 `new ApiClient('/n/:nodeId')` 注入，但没有显式 `nodeId` 或 URL resolver 概念。

### `createGatewayConnection`

选项定义于 `packages/ws-client/src/connection.ts:9-23`：

- `wsUrl?: string`
- `socketFactory?: SocketFactory`
- `maxFrameBytes?: number`
- `clientOptions?: Partial<Omit<BorshClientOptions, 'url' | 'socketFactory'>>`
- `selectCallbacks?: SelectCallbacks`
- `transport?: GatewayTransport`

它创建独立的 client、pane sink registry、select state machine 和 transport：`packages/ws-client/src/connection.ts:33-59`。

WS URL 当前流程：

1. `createGatewayConnection({ wsUrl })` 把 URL 传给 `BorshWebSocketClient`：`packages/ws-client/src/connection.ts:34-42`。
2. 未提供 `wsUrl` 时，`defaultWsUrl()` 根据当前页面协议和 host 生成 `/ws`：`packages/ws-client/src/client.ts:12-13`。
3. 建立连接时调用 `socketFactory(url)`；默认 factory 执行 `new WebSocket(url)`：`packages/ws-client/src/client.ts:217-220`、`packages/ws-client/src/client.ts:40`。
4. 运行中可用 `updateUrl()` 修改下次连接地址：`packages/ws-client/src/client.ts:475-482`。

因此 `/n/:nodeId/ws` 不需要修改底层 socket API，但需要由 `NodeConnectionManager` 计算并注入 `wsUrl`。当前 `createGatewayConnection` 不知道 `nodeId`，也不会从 `ApiClient.baseUrl` 推导 WS URL。

### Cookie

代码中没有读取 `tmex_s_*`、`document.cookie` 读取或手动设置 session cookie。

唯一的 cookie 操作是 UI 侧边栏写入非认证 cookie `sidebar_state`：`packages/ui/src/components/sidebar/sidebar-provider.tsx:84-85`。

`ApiClient` 原样转发 `RequestInit`，没有设置 `credentials`：`packages/api-client/src/client.ts:17-23`。因此同源请求的 HttpOnly cookie 由浏览器自动处理；客户端不需要、也不能读取 `tmex_s_<id>`。

## 3. Runtime、Provider、存储前缀与全局单例

### Runtime 创建方式

`createAppRuntime()` 的流程是：

1. `resolveRuntimeCore(options)`。
2. 创建 UI、site、tmux、agent、file-tree 五个 store。
3. 返回包含 `dispose()` 的 runtime。

实现见 `packages/stores/src/app-runtime.ts:23-45`。

可注入的关键依赖见 `packages/stores/src/runtime.ts:122-145`：

- `connection`
- `transport`
- `apiClient`
- `notifications`
- `bell`
- `t`
- `host`
- `storagePrefix`
- `features`
- `terminalFileLinks`

`RuntimeProvider` 只是 React Context provider：`packages/stores/src/react.tsx:15-29`。没有 Provider 时，Context 默认值是全局 `defaultRuntime`。

当前 FE 没有使用 `RuntimeProvider`。`main.tsx` 通过 `@tmex/stores` 导入默认 store：`apps/fe/src/main.tsx:20`、`apps/fe/src/main.tsx:125-132`。

### 当前全局单例与碰撞点

| 单例/全局状态 | 文件:行号 | 多 runtime 风险 |
|---|---|---|
| `defaultRuntime` | `packages/stores/src/default-runtime.ts:4-6` | 首次 import 时创建一个完整 runtime。 |
| 默认 store 导出 | `packages/stores/src/index.ts:46-52` | `useUIStore`、`useSiteStore`、`useTmuxStore`、`useAgentStore`、`useFileTreeStore` 永远指向默认 runtime。 |
| 默认 Context 值 | `packages/stores/src/react.tsx:15` | 未包裹 Provider 的组件仍落到默认 runtime。 |
| 默认通知 sink 可变引用 | `packages/stores/src/runtime.ts:235-246` | `setDefaultNotificationSink()` 会改变所有默认 runtime 的通知出口。 |
| 默认 host / bell / pane sink | `packages/stores/src/runtime.ts:214-228`、`packages/stores/src/runtime.ts:248-262` | 默认 host 操作全局 DOM；默认 pane sink 连接到 WS 包的默认 registry。 |
| 导航 bridge | `packages/stores/src/flow-bridges.ts:6-12` | 多个 `FlowBridges` 会互相覆盖 `navigateFn`。 |
| Sidebar bridge | `packages/stores/src/flow-bridges.ts:19-30` | 多个 runtime 会互相覆盖移动端侧栏控制器。 |
| 默认 runtime 硬编码读取 | `packages/stores/src/site-fallback.ts:1-10`、`packages/stores/src/use-pane-agent-state.ts:35-37` | 即使 React 子树有 Provider，这些函数仍读取默认 runtime。 |
| FE 全局 `QueryClient` | `apps/fe/src/main.tsx:62-69`、`apps/fe/src/main.tsx:281-285` | 所有节点共享缓存；大量 query key 没有 nodeId。 |
| FE 全局 router | `apps/fe/src/main.tsx:234-266` | 当前只有一套路由和一个 RootLayout。 |
| 无清理的主题订阅 | `apps/fe/src/main.tsx:58-60` | 订阅默认 UI store，不能随 runtime 子树隔离。 |
| 全局 i18next 状态 | `apps/fe/src/i18n/index.ts:29-55` | `language`、资源和切换事件是全局的。 |
| 全局通知注册 | `apps/fe/src/lib/runtime-setup.ts:3-6` | 启动时覆盖默认通知 sink。 |
| 全局浏览器 DOM 主题 | `packages/stores/src/site.ts:42-58`、`apps/fe/src/main.tsx:26-57` | 多 runtime 修改同一个 `document.documentElement` 和同一个 storage key。 |
| 全局页面标题 | `packages/panels/src/device-console/use-device-console-effects.ts:89-96` | 多终端实例会互相覆盖 `document.title`。 |

严格来说，`packages/stores` 中其他 `Map`、`Set` 和订阅集合主要位于 factory 内部，例如 `createAgentStore()` 的 `initialized` / `subscribedSessions`：`packages/stores/src/agent.ts:24-29`，以及 tmux 连接去重状态：`packages/stores/src/tmux.ts:23-29`。这些每次创建 runtime 都独立，不是模块级 singleton。

### Storage key

当前支持 `storagePrefix` 的 key：

| Key | 文件:行号 |
|---|---|
| `${storagePrefix}tmex-ui` | `packages/stores/src/ui.ts:162-178` |
| `${storagePrefix}tmex-agent` | `packages/stores/src/agent.ts:122-128` |
| `${storagePrefix}tmex-file-tree` | `packages/stores/src/file-tree.ts:69-71` |
| site theme 对 `${storagePrefix}tmex-ui` 的手动写入 | `packages/stores/src/site.ts:52-58` |

仍未使用 runtime prefix 的 key：

- `localStorage.getItem('tmex-ui')`：`apps/fe/src/main.tsx:26-40`
- `localStorage.getItem('tmex-ui')`：`apps/fe/src/main.tsx:46-57`
- `tmex_sidebar_width`：`packages/ui/src/components/sidebar/sidebar-provider.tsx:40-60`
- `sidebar_state` cookie：`packages/ui/src/components/sidebar/sidebar-provider.tsx:84-85`

因此两个 runtime 即使传入不同 `storagePrefix`，FE 启动主题读取、侧栏宽度、侧栏 cookie 仍会共享。

### 其他相关全局单例

| 单例 | 文件:行号 | 风险 |
|---|---|---|
| Bell Zustand store 与 timer map | `packages/notifications/src/bell-store.ts:11-43` | 以 `paneId` 为 key，没有 nodeId；不同节点同名 pane 会碰撞。 |
| 全局 `AudioContext` | `packages/notifications/src/bell-sound.ts:1-24` | 声音资源全页面共享。 |
| WS 全局 client | `packages/ws-client/src/client.ts:508-516` | 没有 connection 时 runtime 回退到同一个 client。 |
| WS 全局 select machine | `packages/ws-client/src/state-machine.ts:649-660` | 没有 connection 时多个 runtime 共享选择事务。 |
| WS 默认 pane registry | `packages/ws-client/src/pane-sink-registry.ts:332-406` | 默认 runtime 路径共享 pane sink。 |
| watch client 注册 WeakSet | `packages/panels/src/watch/watch-events-init.tsx:22`、`133-140` | 按 client 防重，但注册没有 runtime/node 维度。 |
| 全局 selection event | `packages/panels/src/device-tree/device-tree-navigation.ts:153-157` | event detail 只有 device/window/pane，没有 nodeId。 |
| 全局 jump event | `packages/panels/src/device-console/page-actions.tsx:177-179`、`use-device-console-effects.ts:98-107` | 不区分 node/runtime。 |
| 全局 add-device event | `packages/panels/src/device-management/device-management-actions.tsx:15-21`、`device-management-panel.tsx:65-70` | 多节点面板可能同时响应。 |

React Query 也存在明显碰撞，例如 `['devices']`：`apps/fe/src/components/global-device-provider.tsx:40-44`、`packages/panels/src/device-console/use-console-targets.ts:45-49`，以及文件/设置/LLM/watch 等 query key。

## 4. 当前路由与参数流

当前 `apps/fe/src/main.tsx:235-266` 的路由表：

| 路径 | 页面 |
|---|---|
| `/` | `DevicesPage` |
| `/devices` | `DevicesPage` |
| `/devices/:deviceId` | `DevicePage` |
| `/devices/:deviceId/windows/:windowId/panes/:paneId` | `DevicePage` |
| `/settings` | `SettingsPage` |
| `/file/:ref` | `FilePage` |

`PageWrapper` 通过 `useParams()` 获取参数，并把参数传给 `PageTitle` / `PageActions`：`apps/fe/src/main.tsx:184-215`。

设备页再读取 `deviceId`、`windowId`、`paneId`：`apps/fe/src/pages/DevicePage.tsx:11-20`。

`DeviceConsole` 的参数流：

- 解析 pane ID：`packages/panels/src/device-console/device-console.tsx:48-72`
- 查询快照、设备连接状态：`packages/panels/src/device-console/use-console-targets.ts:28-49`
- 终端选择、输入、快捷键、标题副作用继续使用这些参数：`packages/panels/src/device-console/device-console.tsx:80-118`

当前根设备订阅逻辑不支持 node：

- 使用默认 `useTmuxStore`：`apps/fe/src/components/global-device-provider.tsx:34-38`
- 使用默认 `fetchDevices()`：`apps/fe/src/components/global-device-provider.tsx:40-44`
- 只匹配 `^/devices/:deviceId`：`apps/fe/src/components/global-device-provider.tsx:55-60`

panel 内部路径也写死为旧路由：

- `PANE_ROUTE_PATH` / `DEVICE_ROUTE_PATH`：`packages/panels/src/device-tree/device-tree-navigation.ts:10-11`
- 路径构造：`packages/panels/src/device-tree/device-tree-navigation.ts:46-55`
- 路径解析：`packages/panels/src/device-tree/device-tree-navigation.ts:58-72`
- 页面动作导航：`packages/panels/src/device-console/page-actions.tsx:128-140`

`hostAppPath()` 只能增加宿主挂载前缀，不能自动增加 nodeId：`packages/stores/src/runtime.ts:316-319`。

### `/n/:nodeId` 所需结构

设计文档要求路由改为 `/n/:nodeId/...`：`docs/hub/2026082700-hub-node-architecture.md:254-258`。

建议将 node route 作为 runtime 边界：

```text
/n/:nodeId
  NodeRuntimeBoundary
    RuntimeProvider
      RootLayout
        children:
          devices
          devices/:deviceId
          devices/:deviceId/windows/:windowId/panes/:paneId
          settings
          file/:ref
```

同时保留旧路由映射到 `self`。

`NodeRuntimeBoundary` 需要：

1. 从 route params 取得 `nodeId`。
2. 调用 `NodeConnectionManager.get(nodeId)`。
3. 注入 `connection`、带前缀的 `ApiClient`、`storagePrefix`。
4. 在子树上挂载 `RuntimeProvider`。
5. 卸载时释放 runtime 引用。

`GlobalDeviceProvider` 必须位于 `RuntimeProvider` 内部，并改用 `useRuntime().apiClient`、`useTmuxStore`，同时 route matcher 要识别 `/n/:nodeId/devices/...`。

selection event、watch URL、页面导航都必须携带 nodeId；现有 event detail 不含 nodeId：`packages/panels/src/device-tree/device-tree-navigation.ts:153-157`。

## 5. 文件 URL 与 `FilePage`

### `file-urls.ts`

| 函数 | 文件:行号 | 结果 |
|---|---|---|
| `filesApiUrl()` | `packages/api-client/src/file-urls.ts:3-10` | `/api/files/{list|content|stat}?…`，用于 `ApiClient.fetch()`。 |
| `fileRawUrl()` | `packages/api-client/src/file-urls.ts:13-16` | `/api/files/raw?...`，当前直接用于 DOM URL。 |
| `fileDownloadUrl()` | `packages/api-client/src/file-urls.ts:19-22` | `/api/files/download?...`，当前用于 OS 拖拽下载。 |

普通文件 API 已经通过注入 client：

- roots/list/stat/content：`packages/api-client/src/file-resources.ts:16-86`
- 下载 prepare/content/delete：`packages/api-client/src/download-transfer.ts:30-105`

### `FilePage`

| 文件:行号 | 用途 | 当前方式 | 迁移 |
|---|---|---|---|
| `apps/fe/src/pages/FilePage.tsx:98` | 图片预览 | `<img src>` | `resolveNodeUrl(nodeId, fileRawUrl(...))` |
| `apps/fe/src/pages/FilePage.tsx:116` | 音频预览 | `<audio src>` | 同上 |
| `apps/fe/src/pages/FilePage.tsx:123` | 视频预览 | `<video src>` | 同上 |
| `apps/fe/src/pages/FilePage.tsx:129` | PDF 预览 | `<iframe src>` | 同上 |
| `apps/fe/src/pages/FilePage.tsx:141` | 文本/Markdown 内容 | `fetchFileContent()`，但未传 client | 传入当前 runtime 的 `apiClient` |
| `apps/fe/src/pages/FilePage.tsx:177` | Markdown 图片 | resolver 返回 `fileRawUrl()` | resolver 内增加 node 前缀 |
| `apps/fe/src/pages/FilePage.tsx:193` | 文件 stat | `fetchFileStat()`，但未传 client | 传入当前 runtime 的 `apiClient` |
| `apps/fe/src/pages/FilePage.tsx:279` | 打开原始文件 | `<a href>` | node-aware raw URL |
| `apps/fe/src/pages/FilePage.tsx:293` | 下载按钮 | 调用 `triggerDownload()` | `triggerDownload()` 传入当前 runtime 的 `apiClient` |

当前 `triggerDownload()` 未传 client，因此会回退到 `defaultApiClient`：`apps/fe/src/pages/FilePage.tsx:28-38`。它还固定使用 `defaultRuntime.host.saveFile`，同样需要改成当前 runtime。

Markdown 图片组件最终在 `<img src>` 使用 resolver：`packages/panels/src/markdown/markdown-preview.tsx:46-50`。

## 6. Push、通知与设置页面

### 直接绕过 `ApiClient`

- 重启接口：`apps/fe/src/pages/SettingsPage.tsx:126-132`
- site settings GET：`apps/fe/src/pages/settings/use-site-settings-form.ts:34-43`
- site settings PATCH：`apps/fe/src/pages/settings/use-site-settings-form.ts:54-67`

`useSiteSettingsForm` 还从默认 store 导入 `useSiteStore`：`apps/fe/src/pages/settings/use-site-settings-form.ts:2-5`，多 runtime 下会读写错误节点。

### 已使用 runtime `ApiClient` 的设置页面

这些调用本身不是 bypass，但必须确保组件处在正确的 `RuntimeProvider` 下：

- 文件设置及多 client 聚合：`packages/panels/src/settings/files-tab.tsx:108-141`、`219-231`、`375-398`
- LLM provider：`packages/panels/src/settings/llm-provider-row.tsx:43-86`、`llm-providers-tab.tsx:20-27`、`94-127`
- 搜索设置：`packages/panels/src/settings/search-tab.tsx:28-94`
- Telegram：`packages/panels/src/settings/telegram-bots-tab.tsx:17-25`、`telegram-bot-form-modal.tsx:27-91`、`telegram-bot-row.tsx:23-55`、`telegram-bot-chats-modal.tsx:35-105`
- Weixin：`packages/panels/src/settings/weixin-accounts-tab.tsx:17-28`、`weixin-account-form-modal.tsx:38-98`、`weixin-account-row.tsx:24-75`、`weixin-account-login-modal.tsx:44-221`
- Webhook：`packages/panels/src/settings/webhooks-tab.tsx:39-97`
- 系统版本：`packages/panels/src/settings/use-version-tab.ts:34-103`
- 终端快捷键：`packages/panels/src/settings/TerminalShortcutsEditor.tsx:210-218`、`266-274`
- 文件面板系统信息：`packages/panels/src/files/files-tab.tsx:56-83`

### 通知与 Push

当前没有真实 Push API 或 service worker subscription。

设置表单中的 `enableNotificationPush` 只是站点设置字段：`apps/fe/src/pages/settings/site-settings-form.ts:7-11`、`24-33`。对应 UI 只是修改草稿：`apps/fe/src/pages/settings/notification-settings-tab.tsx:24-68`。

浏览器通知是本地 API：

- 请求权限：`packages/panels/src/watch/watch-dialog.tsx:105-107`、`148-153`
- 创建通知：`packages/panels/src/watch/watch-events-init.tsx:89-100`

Watch 规则请求使用当前 runtime 的 API client：`packages/panels/src/watch/watch-events-init.tsx:80-83`。通知 sink 的默认注册是全局副作用：`apps/fe/src/lib/runtime-setup.ts:3-6`。

## 7. 现有测试

### URL / WS 测试

| 测试 | 覆盖内容 |
|---|---|
| `packages/api-client/src/client.test.ts:5-70` | 空 base URL、绝对 base URL、transport 注入、global fetch late binding。 |
| `packages/api-client/src/devices.test.ts:37-166` | 设备 REST endpoint 路径。 |
| `packages/api-client/src/files-upload.test.ts:9-136` | 上传 endpoint、分块和清理。 |
| `packages/api-client/src/files-download.test.ts:18-225` | 下载 endpoint、绝对 base URL、失败清理。 |
| `packages/ws-client/src/client.test.ts:127-275` | socket factory、默认 URL、注入 URL、`new WebSocket`。 |
| `packages/ws-client/src/connection.test.ts:17-82` | `createGatewayConnection` 的独立 registry、`wsUrl`、dispose、独立 state machine。 |
| `packages/panels/src/markdown/markdown-preview.test.ts:4-37` | Markdown 图片 resolver 生成 `/api/files/raw`。 |
| `packages/stores/src/app-navigation.test.ts:49-110` | app route 导航和全局 selection event。 |
| `packages/panels/src/device-tree/device-tree-navigation.test.ts:20-82` | device/window/pane 路径解析与构造。 |
| `apps/fe/src/components/global-device-provider.test.ts:4-28` | 从当前路径订阅 device。 |
| `packages/stores/src/tmux-url.test.ts:3-12` | pane ID 编码。 |

### Runtime / storage 测试

| 测试 | 覆盖内容 |
|---|---|
| `packages/stores/src/runtime-features.test.ts:1-50` | runtime feature 默认值和开关。 |
| `packages/stores/src/tmux-shared-transport.test.ts:37-113` | `createAppRuntime`、共享 transport、dispose。 |
| `packages/stores/src/tmux-host-managed-notifications.test.ts:57-143` | 两个 runtime 并存、通知 feature、dispose。 |
| `packages/stores/src/tmux-clipboard-host.test.ts:66-115` | runtime host 注入、storage prefix、dispose。 |
| `packages/stores/src/host-services.test.ts:139-223` | `window.open`、reload、object URL、`a[download]`。 |
| `packages/stores/src/ui.test.ts:49-72` | `${storagePrefix}tmex-ui` 持久化。 |
| `packages/stores/src/site-theme.test.ts:75-224` | 默认 store、site API、theme localStorage、capabilities。 |
| `packages/stores/src/agent-history-sync.test.ts:38-156` | Agent API URL 和注入 ApiClient。 |
| `packages/stores/src/agent-session-actions.test.ts:112-297` | Agent session API URL 和注入 ApiClient。 |
| `packages/terminal-ui/src/components/terminalFileLinks.test.ts:11-78` | 文件链接根路径解析，不涉及 HTTP URL。 |

当前缺少的测试：

- `resolveNodeUrl(nodeId, path)`。
- `/n/:nodeId/api/...` 和 `/n/:nodeId/ws`。
- `NodeConnectionManager` 与 `RuntimeProvider` 并存。
- `FilePage` 的媒体 `src`、raw `href` 和拖拽下载 URL。
- `FilePage` 使用非默认 runtime 的 `apiClient`。
- 多 node 下 QueryClient key 隔离。
- selection/watch/notification event 携带 nodeId。
- `tmex_s_<id>` cookie 的浏览器自动附带行为。
- 未使用 `storagePrefix` 的 `tmex-ui`、`tmex_sidebar_width` 和 sidebar cookie 隔离。