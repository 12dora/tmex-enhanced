由于当前环境是只读沙箱，写入目标路径被系统拒绝；未修改任何源文件。以下为可直接保存到目标路径的完整报告正文。

# Agent 与远程会话代码勘察报告

## 结论摘要

当前 Agent 是“哪个网关的前端 runtime 处理请求，就在哪个网关执行 LLM 与 tmux I/O”。进入远程节点路由后，Agent 面板、REST、Agent WebSocket、数据库和 supervisor 都走远程网关；不存在“本地 hub LLM + 远程 Pane”的现成链路。

目标实现应让 hub 持有 `nodeId + deviceId + paneId`，在 hub 执行 LLM，通过带认证的 mesh RPC 调用目标节点的 `getPaneInfo/capturePaneText/sendInput`。现有 mesh 提供通用 HTTP/WS stream，但没有现成的 server-to-server tmux RPC。

## 1. Agent 前端到后端链路

### 1.1 UI、路由与 Pane 选择

- 路由只有根页面和 `/n/:nodeId` 两套相同页面树，没有独立 Agent URL：`apps/fe/src/main.tsx:L275-L286`。
- Agent 是侧栏 tab，由 `AppSidebar` 无条件注册：`apps/fe/src/components/page-layouts/components/app-sidebar.tsx:L15-L18,L41-L91`。
- 主内容由 `NodeRuntimeBoundary` 按 URL 选择 runtime：`apps/fe/src/node/node-runtime-boundary.tsx:L30-L69`。
- 每个在线且已登录节点的设备树注入 Agent adapter：`apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:L39-L61`。
- Pane 行、窗口菜单和 Pane 菜单分别调用 `PaneSessions` 与 `onCreateSessionForPane`：`packages/panels/src/device-tree/pane-row.tsx:L10-L31`、`packages/panels/src/device-tree/use-row-action-items.ts:L18-L60`。
- 从 Pane 创建 Agent 时，先导航到 Pane，再调用：

  ```tsx
  runtime.stores.agent.startDraft(deviceId, pane.id, title)
  ```

  位置：`apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:L56-L66`。

- Agent 空状态文本来自：

  ```tsx
  emptyText={
    model.hasContext
      ? t('agent.panel.empty')
      : t('agent.session.selectPaneHint')
  }
  ```

  位置：`packages/panels/src/agent/agent-tab.tsx:L39-L49`。

- 简体中文 key 位于 `packages/shared/src/i18n/locales/zh_CN.json:L770`：

  ```json
  "selectPaneHint": "请在「终端」标签中选择一个 Pane 来开启会话"
  ```

- 类型声明位于 `packages/shared/src/i18n/types.ts:L708-L742`。`packages/shared/src/i18n/resources.ts:L2406` 是生成文件，不应手工修改。

### 1.2 Remote Agent 当前行为

- 远程路由使用远程 `NodeRuntimeBoundary`；侧栏 Agent 也通过 `NodeRuntimeScope nodeId={routeNodeId}` 使用该节点的 API/WS：`app-sidebar.tsx:L74-L91`、`packages/stores/src/node-connection-manager.ts:L154-L183`。
- 因此远程 Agent 的创建、列表、消息、确认、历史和 WS 订阅全部发往远程网关，而不是 hub。
- 远程 Pane 树入口可用，因为树本身运行在远程 runtime 上。
- Agent 面板的路由解析存在明确缺口：`useRoutePane` 只匹配：

  ```text
  /devices/:deviceId/windows/:windowId/panes/:paneId
  ```

  位置：`packages/panels/src/agent/use-agent-tab-state.ts:L61-L69`。它没有使用 `host.appPath`，因此没有匹配 `/n/:nodeId/devices/...` 的代码路径。远程路径下，自动 draft、当前 Pane context 和由路由驱动的 New Session 逻辑无法正常获得远程 Pane。
- Agent 绑定跳转也直接拼接无节点前缀路径：`packages/panels/src/agent/use-agent-tab-actions.ts:L32-L47`。设备树导航已有正确的 `hostAppPath/nodeAppPath` 机制：`packages/panels/src/device-tree/device-tree-navigation.ts:L44-L88`。
- Agent tab 没有远程节点专门的隐藏或禁用分支。无 context 时显示选择 Pane 文案；孤儿、Pane mismatch、请求错误分别由 `packages/panels/src/agent/agent-status-banners.tsx:L34-L95` 处理。

### 1.3 Store、REST 与 WebSocket

- `DraftSession`、`CreateSessionOptions` 和 Agent state 只有 `deviceId/paneId`，没有 `nodeId`：`packages/stores/src/agent-state.ts:L19-L40`。
- CRUD、draft materialize、rebind 均使用当前 runtime 的 API client：`packages/stores/src/agent-session-crud-actions.ts:L33-L70,L81-L119,L133-L218`。
- REST client 使用相对路径 `/api/agent/...`：`packages/api-client/src/agent.ts:L31-L40,L58-L115,L122-L189`。
- 节点前缀由 `createNodeApiClient(nodeId)` 注入：`packages/api-client/src/node-url.ts:L49-L60,L117-L163`。
- Agent store 使用当前 runtime client 创建 WS 连接；READY 后重新订阅并加载历史：`packages/stores/src/agent.ts:L24-L33,L76-L128`。
- Agent WS 订阅只携带 `sessionId`：`packages/ws-client/src/message-builder.ts:L339-L350`。
- gateway 将订阅交给 `agentWsHub`：`apps/gateway/src/ws/agent-kind-handlers.ts:L7-L16`、`apps/gateway/src/agent/ws-hub.ts:L85-L125,L192-L205`。
- 消息通过 REST 发送，实时状态、增量、确认通过 Agent WS：`packages/stores/src/agent-session-message-actions.ts:L49-L95`、`packages/stores/src/agent-event-router.ts:L118-L373`。
- 历史通过 `/messages` 增量同步：`packages/stores/src/agent-history-sync.ts:L54-L102`。

## 2. Gateway Agent 与 tmux 绑定

- Agent API 在 gateway 总路由注册：`apps/gateway/src/api/index.ts:L27-L53`。
- 创建 session 的入口是 `apps/gateway/src/api/agent-session-routes.ts:L63-L118`：
  - 使用本地 `getDeviceById(deviceId)` 校验设备；
  - 读取 Pane 信息和 origin title/process；
  - 写入 Agent session。
- `captureSessionOrigin` 位于 `agent-session-routes.ts:L39-L61`，当前通过本地 `tmuxRuntimeRegistry.acquire(deviceId)` 获取 Pane 信息。
- session 列表位于 `agent-session-routes.ts:L63-L77`；更新只允许 `title/paneId` 等字段，不能改变设备节点：`L20,L121-L155`。
- supervisor 从数据库 session 的 `deviceId/paneId` 启动 run：`apps/gateway/src/agent/supervisor.ts:L504-L567`。
- run 获取 runtime 的位置：`apps/gateway/src/agent/run.ts:L116-L153`。
- LLM provider/model 根据执行该请求的 gateway 的设置和 provider registry 解析：`apps/gateway/src/llm/provider-registry.ts:L33-L77`。因此 Agent API 若留在 hub，LLM 会在 hub 执行。

### 2.1 Pane 读取

terminal tools 绑定 `deviceId/paneId/runtime`：`apps/gateway/src/agent/build-run-request.ts:L119-L186`、`apps/gateway/src/agent/tools/terminal-context.ts:L4-L27`。

精确调用链：

```text
read_screen
  -> runtime.getPaneInfo(paneId)
  -> runtime.capturePaneText(paneId, { historyLines })
```

位置：`apps/gateway/src/agent/tools/read-screen.ts:L27-L67`。

Pane 元信息校验使用：

```text
findPaneInSnapshot(deviceId, paneId)
```

位置：`apps/gateway/src/agent/tools/pane-info.ts:L23-L50,L84-L107`。

### 2.2 发送按键

`send_input` 位于 `apps/gateway/src/agent/tools/send-input.ts:L76-L158`，最终调用：

```text
runtime.sendInput(ctx.paneId, data)
```

之后会重新读取 Pane 信息和文本生成工具结果。

资源获取与释放位于 `apps/gateway/src/agent/run-resource-scope.ts:L25-L75,L115-L145`。

底层 runtime 由 `tmuxRuntimeRegistry.acquire(deviceId)` 创建和缓存：`apps/gateway/src/tmux-client/registry.ts:L6-L16`。对外方法位于：

- `sendInput`：`apps/gateway/src/tmux-client/device-session-runtime.ts:L308-L318`
- `capturePaneText`：`L410-L412`
- `getPaneInfo`：`L414-L416`

`DeviceSessionRuntime` 内部根据设备类型选择本地 tmux 或 SSH 连接：`L104-L117`。

## 3. Mesh 与远程节点数据流

### 3.1 前端节点 URL/runtime

- 远程 REST 路径为 `/n/:nodeId/api/...`，远程 WS 路径为 `/n/:nodeId/ws`：`packages/api-client/src/node-url.ts:L49-L60,L117-L127`。
- 每个节点拥有独立 API client、WS、storage prefix 和 app path：`packages/stores/src/node-connection-manager.ts:L154-L183`。
- 远程 runtime 的连接、重连、订阅恢复位于 `apps/fe/src/node/node-runtimes.ts:L195-L234`。
- 节点离线事件会保留 inventory，但设置 `online=false/reach=null`：`apps/fe/src/node/mesh-nodes.ts:L30-L57,L83-L143`。

### 3.2 HTTP、终端 WS 与 mesh stream

- `MeshHttp` 识别 `/n/:id`，本地路径直接 dispatch，远程 API/WS 交给 `Forwarder`：`apps/gateway/src/mesh/mesh-http.ts:L144-L191,L254-L360`。
- 远程 HTTP 流程：

  ```text
  hub Forwarder.forwardHttp
    -> streams.openHttpStream(...)
    -> remote acceptHttpStream
    -> remote gateway dispatch
  ```

  位置：`apps/gateway/src/mesh/forwarder.ts:L400-L457`、`apps/gateway/src/mesh/stream-targets.ts:L165-L225,L276-L287`。

- 远程终端 WS 流程：

  ```text
  hub handleRemoteWs/openWsStream
    -> remote acceptWsStream
    -> remote WebSocketServer GatewaySession
  ```

  位置：`forwarder.ts:L459-L500`、`stream-targets.ts:L446-L564`。
- 终端输入命令携带 `deviceId`，目标 gateway 最终执行 `entry.runtime.sendInput`：`packages/ws-client/src/transport-command-encoder.ts:L39-L79`、`apps/gateway/src/ws/tmux-command-handlers.ts:L150-L159`。
- `/api/tmux/tree` 在目标 gateway 查询本地 device/snapshot，返回 session、window、pane 树：`apps/gateway/src/api/tmux-tree.ts:L10-L55`。现有 mesh HTTP 可以代理此 API。
- `StreamOpener` 只提供通用 HTTP/WS stream：`apps/gateway/src/mesh/mesh-deps.ts:L85-L109`。没有现成的 `capturePaneText/getPaneInfo/sendInput` server-to-server RPC。
- 浏览器 `/n/:id/ws` 不能直接作为 Agent 同步 RPC，因为它依赖浏览器 GatewaySession、Borsh 命令和异步事件回传。

## 4. 需要增加 nodeId 的函数边界

| 当前函数 | 当前目标 | 需要的修改 |
|---|---|---|
| `agent-session-routes.ts:L39-L61` `captureSessionOrigin` | 当前 gateway 的 runtime | 接收 `nodeId`，选择本地 runtime 或 mesh RPC。 |
| `agent-session-routes.ts:L63-L118` create/list/get/update | 当前 gateway 本地 DB/device | hub API 接收并持久化 `nodeId`，远程设备不能用 hub 的 `getDeviceById` 校验。 |
| `supervisor.ts:L504-L567`、`run.ts:L116-L153` | `deviceId` 唯一决定 runtime | session 使用 `(nodeId,deviceId,paneId)`，LLM 仍在 hub。 |
| `run-deps.ts:L17-L48`、`run-resource-scope.ts:L25-L75` | `acquireRuntime(deviceId)` | 改为 `acquireRuntime(nodeId,deviceId)` 或注入 node-aware runtime。 |
| `read-screen.ts:L27-L67` | 当前 snapshot/runtime | 通过目标节点 RPC 查询。 |
| `pane-info.ts:L23-L50,L84-L107` | 当前 snapshot | 按目标节点查询 snapshot/pane。 |
| `send-input.ts:L76-L158` | 当前 runtime.sendInput | 通过 mesh RPC 发按键，远端继续调用本地 runtime。 |
| `tmux-tree.ts:L31-L55` | 当前 gateway DB/snapshot | hub picker 需要按 node 代理设备树，或使用前端各节点 runtime 的树数据。 |

`DeviceSessionRuntime` 的底层方法本身不一定需要增加 `nodeId`；它代表单个具体 device runtime。关键是要在 runtime registry/Agent run 的选择边界引入 nodeId。

## 5. 持久化与离线行为

- `agentSessions`、`agentMessages`、`agentQueuedMessages`、`agentConfirmations` 位于 `apps/gateway/src/db/schema.ts:L202-L297`。
- `agentSessions` 当前包含 `deviceId/paneId`，没有 `nodeId`。
- 初始 migration 同样只有本地 `device_id/pane_id`：`apps/gateway/drizzle/0004_smiling_layla_miller.sql:L26-L58`。
- DB helper 的创建输入、写入和列表位于 `apps/gateway/src/db/agent.ts:L93-L149`；列表按 `updatedAt desc`。
- DTO 映射位于 `apps/gateway/src/api/agent-dtos.ts:L25-L80`；shared contract 位于 `packages/shared/src/contracts/agent.ts:L14-L137`。
- 前端 `loadSessions` 只请求当前 runtime/gateway 的 `/api/agent/sessions`：`packages/stores/src/agent-session-crud-actions.ts:L133-L184`。hub 和远程节点的 session 不会自动聚合。
- 远程节点离线时，侧栏只显示灰色 inventory link，不加载 Agent sessions：`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:L181-L234,L238-L272`。
- `use-node-login` 只对 online 且未登录节点阻塞；offline 节点不会被登录 gate 阻塞：`apps/fe/src/auth/use-node-login.ts:L76-L106`。页面请求仍可能失败。
- mesh 不可达返回 503 `NODE_UNREACHABLE`：`apps/gateway/src/mesh/forwarder.ts:L400-L457`。
- Agent 错误 banner 目前只做通用错误和重试：`packages/panels/src/agent/agent-status-banners.tsx:L76-L95`。
- 设备断连时，拥有该 session 的 gateway 的 `stopSessionsForDevice` 会停止 active run，并将无 active run 的 running/waiting session 标记为 error：`apps/gateway/src/agent/supervisor.ts:L392-L428`。
- 当前 hub 不持有远程 Agent session，也没有统一的 node-offline 到 Agent session 状态传播。
- `isSessionAttached` 在 snapshot 缺失时暂时视为 attached，只有未知 device 或明确缺失 Pane 才判 orphan：`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:L77-L95`。

## 6. 相关测试

- Agent API、CRUD、消息、停止、确认：`apps/gateway/src/api/agent.test.ts:L122-L226,L226-L317,L317-L391,L391-L488`。
- supervisor 基本流程、确认、停止、设备断连、恢复：`apps/gateway/src/agent/supervisor.test.ts:L228-L375,L400-L476,L476-L876,L876-L1008`。
- run 主循环、工具失败、重试、停止：`apps/gateway/src/agent/run.test.ts:L277-L776`。
- runtime/emulator 资源管理：`apps/gateway/src/agent/run-resource-scope.test.ts:L59-L172,L186-L291`。
- terminal tools 的 send/read/getPaneInfo：`apps/gateway/src/agent/tools/terminal.test.ts:L122-L234,L267-L393`。
- Agent store/history/event：`packages/stores/src/agent-session-crud-actions.test.ts:L114-L219`、`agent-history-sync.test.ts:L74-L166`、`agent-event-router.test.ts:L118-L373`。
- Agent UI binding/orphan/rebind：`packages/panels/src/agent/agent-route-sync.test.ts:L5-L50`、`agent-tab-view.test.ts:L75-L113`、`use-agent-tab-model.test.ts:L25-L49`。
- 侧栏创建 Agent 的 E2E：`apps/fe/tests/sidebar-pane-menu-alignment.spec.ts:L8-L51`。
- mesh 不可达、HTTP/WS relay、failover：`apps/gateway/src/mesh/forwarder.test.ts:L56-L70,L210-L283,L381-L443,L630-L704`；`stream-targets.test.ts:L31-L55,L135-L231,L354-L412,L511-L556,L698-L729`。
- 节点离线事件和状态：`apps/fe/src/node/mesh-events.test.ts:L145-L166`、`mesh-nodes.test.ts:L53-L90`。
- 离线设备 inventory/snapshot fallback：`apps/fe/src/pages/devices/device-snapshot-store.test.ts:L52-L114`、`apps/fe/src/pages/DevicesPage.test.tsx:L188-L307`、`apps/fe/src/pages/devices/device-folders-view.test.tsx:L176-L197`。

## suggested implementation plan

1. 在 `packages/shared/src/contracts/agent.ts`、`packages/api-client/src/agent.ts`、`packages/stores/src/agent-state.ts` 增加 `nodeId`；在 `apps/gateway/src/db/schema.ts`、新 migration、`db/agent.ts`、`agent-dtos.ts` 增加并索引 `agent_sessions.node_id`。
2. 修改 `packages/panels/src/agent/use-agent-tab-state.ts` 和 `use-agent-tab-actions.ts`，统一使用 `host.appPath`；修改 `sidebar-agent-sessions.tsx`、Agent store/draft actions，使远程 Pane 创建请求发往 hub Agent API。
3. 修改 `agent-session-routes.ts`、message/confirmation routes、`supervisor.ts`、`run.ts`、`run-deps.ts`、`run-resource-scope.ts`。LLM provider registry保留在 hub，tmux runtime 改为 node-aware。
4. 增加 mesh 内部 tmux RPC，优先复用 `Forwarder.forwardHttp`、`openHttpStream/acceptHttpStream`；目标节点 handler 复用 `tmuxRuntimeRegistry`、snapshot 和 `DeviceSessionRuntime`。
5. 在 `apps/fe/src/node/mesh-events.ts`、Agent store、Agent 面板中传播 node offline 状态，使远程 session 全局可见，并进入 unavailable/read-only/retry 状态。
6. 增加跨节点 create/list/message/read/send 集成测试、hub 执行 LLM 的断言、remote offline/failover 测试，以及远程 route matcher/navigation 测试。

主要陷阱：

- `deviceId` 不是全局唯一，hub 不能直接调用本地 `getDeviceById` 或 `tmuxRuntimeRegistry.acquire(deviceId)`。
- 浏览器 `/n/:id/ws` 是 terminal relay，不是 Agent RPC。
- Agent 当前有两个无节点前缀的 route matcher/navigation。
- `resources.ts` 是生成文件，应修改 locale 源文件后重新生成。