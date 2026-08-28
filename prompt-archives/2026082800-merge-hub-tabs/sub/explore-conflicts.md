## 全局风险

本报告基于共同祖先 `bf5b99858cee`，对照：

- ours / hub：`feat/hub-node`，`b0b0683fd...`
- theirs / tabs：`feat/sidebar-tabs-ui`，`223103f33...`

当前 worktree 仍处于未解决 merge 状态，以下是人工 review checklist，不代表合并结果已通过编译或测试。全程未修改文件、未执行 git 写操作。

最高风险集中在：

1. `GatewaySession`/`Carrier` 替换旧 `ServerWebSocket` 身份。
2. 多 node runtime 与 tabs 的连接持久化、侧栏聚合同时改动。
3. 两侧都生成了 `0018` 数据库迁移。
4. 文件传输单体实现与 route 拆分发生结构冲突。
5. 自动合并后仍有旧 `ClientState`、`ServerWebSocket` API 残留。
6. i18n、stores、ws-client 等无冲突文件可能已经发生静默语义丢失。

标记含义：

- `[hub]`：hub 分支引入的行为。
- `[tabs]`：tabs 分支引入的行为。
- `真冲突`：两侧诉求不能直接同时保留。
- `隐性耦合`：需要联动其他文件确认。

## 逐文件 checklist

### `apps/fe/src/components/global-device-provider.tsx`

- [hub] 当前路由是 `/devices/:deviceId` 时，只为 self runtime 订阅设备；当前路由是 `/n/node-b/devices/:deviceId` 时，self provider 不得误订阅 node-b 的设备。
- [hub] 获取设备列表必须调用当前 `runtime.apiClient`，不能固定调用 entry gateway。
- [hub] `routeDeviceId()` 必须根据当前 runtime 的 `appPath()` 解析路径，避免跨 node provider 抢占路由。
- [tabs] 用户点击连接后，设备 ID 写入“持久连接意图”；点击断开后，从持久连接集合移除并写入显式断开集合。
- [tabs] 设备列表返回后，已删除设备的连接意图和已有订阅必须清理；仍存在且未被显式断开的设备自动恢复连接。
- [tabs] 状态计算必须保持优先级：显式断开 > 重连中 > 错误 > 已连接 > 连接中 > 未连接。
- [tabs] 连接 adapter 的 `connect()`、`disconnect()` 必须同时更新意图、清理错误并调用 tmux store。
- **真冲突**：hub 要求 runtime 隔离和 node-aware 路由，tabs 要求全局连接持久化和状态 adapter。融合时应保留 tabs 的意图/状态逻辑，但将查询、路由解析、store 操作全部绑定到当前 `RuntimeProvider`。
- **隐性耦合**：`apps/fe/src/node/node-runtime-boundary.tsx`、`sidebar-device-list-runtime.tsx`、`packages/panels/src/device-tree/sidebar-device-list.tsx` 必须使用同一套 runtime、QueryClient 和 connection adapter。

### `apps/fe/src/components/global-device-provider.test.ts`

- [hub] `/devices/device-a` 和其子路径只能命中 self；`/n/node-a/devices/device-a` 只能命中 node-a；其他 node 路由必须返回 `undefined`。
- [tabs] 空设备列表、已连接设备、显式断开设备必须分别得到正确的订阅决策。
- [tabs] malformed localStorage、非数组、空字符串、非字符串元素不能导致 provider 崩溃。
- [tabs] 状态优先级、原型链属性名、持久化集合增删和未知设备清理必须覆盖。
- **真冲突**：测试必须同时保留 node route 隔离和 tabs 的持久化状态测试；不能只选择一侧测试集。
- **隐性耦合**：测试 fixture 需要能构造“当前 node runtime”，否则测试通过但实际可能读取 entry API。

### `apps/fe/src/components/page-layouts/components/app-sidebar.tsx`

- [hub] panes、agent、files 侧栏内容可以在同一侧栏容器内按 section 展示。
- [tabs] 侧栏使用 `sidebarTab` 控制三选一；选中 panes 时只渲染设备树，选中 agent/files 时才懒加载对应模块。
- [tabs] Agent 和 Files 模块未选中时不应触发对应重型组件链和查询。
- **真冲突**：hub 的多 node 聚合设备树与 tabs 的单活动 tab 不能并列套两套容器。应保留 tabs 作为外层结构，把 mesh 聚合设备树完整放入 panes tab。
- **隐性耦合**：`SidebarContent`、`sidebar-device-list.tsx`、`SidebarNodeSection` 必须处于同一个侧栏布局层级；否则 node 分节可能被 tabs 容器截断或无法滚动。

### `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx`

- [hub] runtime 从 node-a 切换到 node-b 后，会话列表、tmux snapshot、UI 状态和新建会话动作必须全部切换到 node-b 的 store。
- [hub] 选择、删除、重命名、创建 agent session 必须操作当前 runtime，而不是默认 singleton。
- [hub] `useSidebarAgentAdapter()` 必须按 runtime 创建闭包，避免 node-a 的 adapter 继续调用 node-b 以外的 store。
- [tabs] 本文件无独立行为改动，但 tabs 设备树原本使用静态 `sidebarAgentAdapter`。
- **隐性耦合**：`sidebar-device-list-runtime.tsx` 必须调用 `useSidebarAgentAdapter()`，不能保留静态 adapter；Agent provider 只能挂在对应 node runtime 下。

### `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`

- [hub] mesh 节点列表必须映射为 node 分节；self 使用 `SELF_NODE_ID`，其他 node 使用真实 node ID。
- [hub] 在线且已登录 node 才建立 `NodeRuntimeScope`、查询设备和建立连接。
- [hub] 在线但未登录 node 只显示登录按钮，不应因为渲染侧栏而反复请求并触发 4401。
- [hub] 离线 node 只显示最近一次 inventory 中的灰显设备，不建立连接、不发 API 请求。
- [hub] mesh 列表尚未返回时暂时显示 self 设备树，避免首屏空白。
- [tabs] 设备树需要接收 connection adapter；展开设备时连接，收起设备只隐藏树，不自动断开。
- [tabs] Agent UI 开启时挂载 `SidebarAgentSessionsProvider` 和 adapter，关闭时不挂载以避免 agent 查询。
- **真冲突**：hub 的 mesh wrapper 与 tabs 的 connection/agent wrapper 都替换了原有实现。应采用 hub 的 node 聚合结构，并将 tabs 的 runtime-specific 设备树能力放入 `SideBarDeviceListForRuntime`。
- **隐性耦合**：`SidebarNodeSection` 的 `online/loggedIn/inventory` 判断必须与 `NodeRuntimeScope`、`GlobalDeviceProvider` 生命周期一致。

### `apps/fe/src/main.tsx`

- [hub] 应用根层使用 self `RuntimeProvider`；每个 `/n/:nodeId/*` 路由使用对应 node runtime、QueryClient 和 GlobalDeviceProvider。
- [hub] 登录页、账号安全页、Nodes 页等全局路由不得错误包在普通 node runtime 内。
- [hub] 旧 `/devices/...` 路由必须继续等价于 self node。
- [hub] node-aware session interceptor、主题同步、节点切换必须在正确 provider 层级执行。
- [tabs] 保留 `PageLoadFallback`、`usePageModule` 动态页面加载失败后的 retry 行为。
- [tabs] 保留 `SettingsEventsInit`，确保设置事件到达后 store 能重新加载。
- [tabs] 桌面侧栏由 `sidebarCollapsed` 控制，刷新后状态仍需保持。
- **真冲突**：hub 的 per-node provider/router 架构与 tabs 的 root singleton `runtime-setup`、单 QueryClient、全局 GlobalDeviceProvider 不能直接叠加。应保留 hub provider 层级，把 tabs 的页面 fallback、设置事件和侧栏受控逻辑迁入 node shell。
- **隐性耦合**：Provider 层级直接决定 `useRuntime()`、设备查询、设置重启 API、主题和动态页面模块读取哪个 node。

### `apps/fe/src/pages/DevicePage.tsx`

- [hub] 当前 node 不是 self 时，设备页操作区显示 node badge；self 页面保持原有无 badge 形态。
- [hub] badge 的 node ID 必须来自当前 route/runtime，不能从设备 ID 推断。
- [tabs] 本文件无独立改动。
- **隐性耦合**：`useRouteNodeId()`、`DeviceConsoleActions` 的 `nodeId` 事件和侧栏 node badge 必须使用同一 node 标识。

### `apps/gateway/drizzle/meta/0018_snapshot.json`

- [hub] 合并后的 schema 必须包含用户、节点、认证和会话数据：`users`、`user_keys`、`user_key_log`、`node_sessions`、`node_certs`、`nodes`、`enrollment_tokens`、`node_identity`、`peer_cache`。
- [hub] 用户根密钥、passkey、key log、节点证书、session 生命周期等数据必须可持久化。
- [tabs] agent 查询必须保留 `agent_confirmations_session_status_created_at_idx` 和 `agent_queued_messages_session_seq_idx`。
- **真冲突**：两侧都生成了不同的 `0018` snapshot，不能选择整个文件的一侧。
- **隐性耦合**：snapshot 的 `id`、`prevId`、journal 序号和实际 SQL 文件必须互相匹配。应先确定最终迁移顺序，再由最终 schema 重新生成，不能手工拼 JSON。

### `apps/gateway/drizzle/meta/_journal.json`

- [hub] `0018_hub_auth` 必须记录 hub 认证 schema 迁移。
- [tabs] `0018_agent_query_indexes` 必须记录 agent 索引迁移。
- **真冲突**：同一 migration 序号不能同时对应两个不同迁移。需要拍板为“合并成一个 0018”或“一个保留 0018、另一个顺延为 0019”。
- **隐性耦合**：最终 journal 必须与 `managed-migrations.ts`、SQL 文件名、snapshot `prevId` 一致；否则已有数据库和新数据库会走出不同 schema。

### `apps/gateway/src/api/files.ts`

- [hub] 上传/下载初始化时，从 request dispatch context 记录 UID；后续 bulk transfer 根据 transfer ID 可以取得归属用户。
- [hub] `getTransferOwner()` 输入有效 transfer ID 时返回临时文件路径、期望大小、传输类型和 UID。
- [hub] `openDownload()`、`appendUpload()`、`abortTransfer()` 为 mesh/DataChannel 提供文件传输入口。
- [hub] 上传完成、下载结束、异常和 abort 都必须同时清理 transfer session 与 UID 映射。
- [tabs] 文件 API 实现拆分为 `file-root-routes.ts`、`file-browser-routes.ts`、`file-transfer-routes.ts`，`files.ts` 只负责 route 聚合。
- [tabs] upload offset 必须是完整的非负十进制整数；`12garbage`、`12.5`、缺失 offset、空格、`0x10`、`1e2` 都返回 invalid request。
- [tabs] JSON body 为 `null` 或数组时必须返回 400，而不是在读取属性时抛异常。
- **真冲突**：不能选择 hub 的旧单体文件而丢失 tabs 的 route 拆分，也不能直接采用 tabs 的薄聚合而丢失 hub 的 bulk hooks。
- **融合方式**：保留 tabs 的 route 拆分，将 UID 记录、bulk hooks 和清理逻辑下沉到 `file-transfer-routes.ts` 或共享 transfer 层。
- **隐性耦合**：`apps/gateway/src/mesh/` 对 `filesBulkHooks` 的导入、权限检查和临时文件生命周期必须一起确认。

### `apps/gateway/src/db/managed-migrations.ts`

- [hub] managed build/runtime 必须包含 hub 认证迁移。
- [tabs] 本文件无独立行为改动，但 tabs SQL 文件已自动带入工作区。
- **真冲突**：最终 managed migration 列表必须同时覆盖 hub auth 和 agent indexes，并使用已拍板的顺序。
- **隐性耦合**：列表顺序必须与 journal、snapshot、SQL 文件名同步；不能仅把 `'0018_hub_auth.sql'` 加入数组而忽略另一个迁移。

### `apps/gateway/src/db/schema.ts`

- [hub] 创建用户、root key、passkey、key log、node、node certificate、node session、enrollment token、peer cache 等表及约束。
- [hub] 用户 key log 的序号、前 hash、root epoch、签名和记录类型必须可用于防 fork/重放校验。
- [tabs] 查询 agent session 状态和 queued message 序列时，使用新增复合索引。
- **真冲突**：schema 变化表面上是 additive，但只保留一侧会导致另一侧迁移和 snapshot 不匹配。
- **隐性耦合**：schema、SQL、snapshot、类型导出和认证 API 必须作为一个整体核对。

### `apps/gateway/src/ws/borsh/session-state.ts`

- [hub] session state 的 Map key 必须是 `GatewaySession`，同一用户的 primary/direct carrier 共享同一个状态。
- [hub] `createSessionState()` 创建独立的 ws/device/select/output/throttle 状态，并挂到 GatewaySession。
- [tabs] 输出门控默认限制为 1000 帧或 8 MiB；达到任一限制时清空缓冲并标记 overflow。
- [tabs] 输出缓冲溢出时发送 `SourceGap{reason: RESOURCE_EXHAUSTED, scope: Stream}`，而不是继续无限积压。
- [tabs] notification throttle 使用注入的 `now` 并周期性清理过期记录。
- **真冲突**：旧 `ServerWebSocket` key 与 hub 的 `GatewaySession` key 不能并存为两个事实来源，否则 primary/direct carrier 会产生两份状态。
- **隐性耦合**：overflow gap 必须通过当前 `session.activeCarrier` 发送；`device-connection-registry`、`switch-barrier`、`legacy-feed-broadcaster` 必须使用同一 session state。
- **人工核对**：当前代码中部分时间戳仍使用 `Date.now()`，需确认是否绕过了注入的 `now`，导致测试时钟和生产行为不一致。

### `apps/gateway/src/ws/device-connection-registry.ts`

- [hub] 设备连接、canonical client、snapshot 和 session state 按 `GatewaySession` 归属，不按单个 carrier 归属。
- [hub] 同一个 session 的 primary/direct carrier 不得互相顶掉设备连接。
- [tabs] connect 请求发出后若在异步 acquire 完成前执行 disconnect，最终只能发出 disconnected，不得晚到一个 connected。
- [tabs] 异步 connect 被取消后，旧 entry 必须进入 idle release，不能残留设备 runtime。
- [tabs] 成功 connect、disconnect、reconnect finalize 时必须同步/释放 legacy pane observer。
- **真冲突**：tabs 的 connect generation 保护必须迁移到 GatewaySession；不能简单保留 `WeakMap<ServerWebSocket,...>`。
- **隐性耦合**：`index.ts` 的 session close、`legacy-feed-broadcaster` 的 observer 计数和 registry 的 generation 必须共享同一对象身份。

### `apps/gateway/src/ws/device-connection-registry.test.ts`

- [hub] 测试必须用 `GatewaySession` 构造设备连接，验证 session 级 canonical/client/state 清理。
- [tabs] pending connect + disconnect 的测试必须保证不会出现迟到的 connected 事件。
- [tabs] observer sync/release 测试必须验证选择 pane、订阅 pane、断连和 reconnect 后计数准确。
- **真冲突**：测试 fixture 不能继续只伪造 `ServerWebSocket<ClientState>`；需要同时覆盖 carrier/session 生命周期。

### `apps/gateway/src/ws/index.test.ts`

- [hub] active carrier 发送正常帧时可以 drain；旧 carrier drain 不得清空 active carrier 的 backpressure 状态。
- [hub] direct carrier 关闭时回落 primary；primary 关闭且 direct 存在时 direct 继续服务；两者都关闭时才清理整个 session。
- [hub] session close 必须同时清理 canonical session、session state、agent、barrier、connected clients、设备 entry。
- [hub] late carrier close/message/drain 必须成为 no-op，不能重新创建或污染已关闭 session。
- [tabs] 没有 legacy observer 时不应推送 legacy terminal output。
- [tabs] select/subscribe/focus 建立观察关系后才推送对应 pane；release 后计数回到零。
- **真冲突**：必须把 tabs 的 observer 生命周期测试嵌入 hub 的 carrier/session 生命周期测试，不能让 direct carrier close 误释放整个 session 的观察者。

### `apps/gateway/src/ws/index.ts`

- [hub] upgrade 后创建 `BunSocketCarrier + GatewaySession`，并将 `{session, carrier}` 写入 socket data。
- [hub] 一个 GatewaySession 可以同时拥有 primary 和 direct carrier，发送、drain、close 都按 active carrier 处理。
- [hub] direct carrier 被替换时，旧 carrier 关闭但 canonical session、设备连接和 session state 保留。
- [hub] primary carrier 关闭时，如果 direct carrier 仍有效，session 不得被整体关闭。
- [tabs] inbound Buffer 必须按实际 view 的 byteOffset/byteLength 处理，不能把更大的 backing buffer 一并解析。
- [tabs] socket close、abandon、observer release 必须防止异步 connect 在关闭后再次写入 connected。
- [tabs] 对外暴露 `syncLegacyPaneObservers` 和 `releaseLegacyPaneObservers`，供 command handler/registry 调用。
- **真冲突**：hub 的 carrier/session close 状态机和 tabs 的旧 socket close 清理逻辑必须融合；不能让 `handleClose()` 在 direct carrier 关闭时清掉整个 GatewaySession。
- **隐性耦合**：`GatewaySession.activeCarrier`、`sessionStateStore`、`WebSocketSendGuard`、canonical feed、legacy feed、switch barrier 必须统一以 session/carrier 维度工作。

### `apps/gateway/src/ws/legacy-feed-broadcaster.ts`

- [hub] legacy feed 的 client、canonical client 和 switch barrier 统一使用 `GatewaySession`。
- [tabs] selected pane 或 subscribed pane 被观察时，才允许产生对应 legacy output batch。
- [tabs] 没有观察者时，终端输出不得进入 legacy broadcast。
- [tabs] notification 标题和正文都为空时，不发送通知。
- [tabs] bell 按 device+pane throttle；notification 按 device+pane+source throttle；普通事件仍可发送。
- [tabs] observer 计数需要支持一个 client 同时观察多个 pane，并在设备断开、session close 时全部释放。
- **真冲突**：hub 的 session-aware 发送必须承载 tabs 的 observer count 和事件 delivery；不能让 tabs helper 继续直接操作旧 socket。
- **隐性耦合**：`tmux-command-handlers.ts` 的 select/subscribe/focus 成功路径必须触发 sync，否则 O(1) 观察者计数会停留在旧值。

### `apps/gateway/src/ws/tmux-command-handlers.ts`

- [hub] select、subscribe、history、focus、split 等命令接收 `GatewaySession`，状态通过 `session.borshState` 读取。
- [hub] switch barrier 必须以 GatewaySession 为 key，不能以单个 carrier 为 key。
- [tabs] select 成功后同步 selected pane observer。
- [tabs] subscribe/unsubscribe 成功后同步 subscribed pane observer。
- [tabs] focus 成功后同步 observer。
- **真冲突**：参数类型和状态访问需要 hub 化，同时保留 tabs 的 observer sync 调用。
- **隐性耦合**：如果 sync 放在“请求开始”而不是“状态写入成功之后”，会把未生效的 pane 计入 observer，导致输出丢失或额外广播。

### `docs/2026021000-tmex-bootstrap/deployment.md`

- [hub] 文档改为 tmex-cli、launchd/systemd、SQLite、standalone/mesh 部署方式。
- [hub] 文档应描述 node enrollment、root key、session/passkey/TOTP、升级、doctor、端口、HTTPS/trust proxy。
- [tabs] 删除原有 Docker/JWT/OIDC/手工密码部署文档。
- **真冲突**：这是“重写”和“删除”的冲突。若当前发行方式已经转向 tmex-cli，应保留 hub 重写版，但需确认文档引用的 service/install/operation 文档都存在。
- **隐性耦合**：仓库中 Dockerfile、docker-compose、build 脚本已被 tabs 删除；文档不能残留仍然可执行但已不存在的 Docker 命令。

### `packages/panels/src/device-console/page-actions.tsx`

- [hub] 点击 jump-to-latest 时，事件 detail 必须包含当前 `runtime.nodeId`，避免未来多个 node 控制台互相响应。
- [tabs] 页面动作层拆成 `useDeviceConsoleActions`、toolbar、deferred terminal settings、refresh dialog，主组件只负责组合视图。
- [tabs] terminal settings 动态加载失败时显示 loading/error/retry，而不是静默消失。
- [tabs] watch 查询、split、input mode、refresh 继续使用当前 runtime。
- **真冲突**：应采用 tabs 的拆分结构，同时确保 `useDeviceConsoleActions` 和最终事件发送保留 hub 的 nodeId detail。
- **隐性耦合**：`DeviceConsoleToolbar`、`use-device-console-actions.ts`、`DevicePage` 和 jump-to-latest 监听器必须一起核对事件格式。

### `packages/panels/src/device-tree/device-row.tsx`

- [hub] 传入 `nodeBadge` 时，在设备名称和状态之间显示 node badge；self 单 node 不传 badge。
- [tabs] 使用 per-device selector，避免任一设备输出导致所有设备行重渲染。
- [tabs] 传入 connection adapter 时，设备连接状态由 adapter 提供。
- [tabs] 设备被显式断开时隐藏其窗口树，但不因收起树而自动断开。
- **真冲突**：node badge 和 tabs 的 memo/selector/connection 逻辑都必须保留。
- **隐性耦合**：`device-row-header.tsx`、`device-tree-row-props.ts`、`sidebar-device-list.tsx` 必须使用同一份 props 定义，否则 nodeBadge 或 connection 会在拆分组件时丢失。

### `packages/panels/src/device-tree/device-tree-navigation.ts`

- [hub] 用户主动选择 pane 时，事件 detail 必须同时携带 `nodeId`、deviceId、windowId、paneId。
- [hub] 当前 runtime 的 `hostAppPath()` 必须生成正确 node 前缀。
- [tabs] pane 参数包含非法 percent encoding 时，解析应回退原字符串而不是抛出 URIError。
- [tabs] window 尚无 pane 时创建 pending navigation；目标快照到达后跳转 active pane。
- [tabs] pending navigation 到期、组件卸载或路由离开目标设备时必须清除，不能把用户从新页面拽回旧 pane。
- **真冲突**：tabs 的 pending-navigation 修复必须保留 hub 的 node-aware selection event。
- **隐性耦合**：pending 路由比较、`NodeRuntimeBoundary` 的 route pattern、`hostAppPath` 和跨 node 选择事件必须以同一 node 路由规则解析。

### `packages/panels/src/device-tree/index.ts`

- [hub] 导出 `NodeBadge`、`nodeBadgeAppearance` 和 `NodeBadgeInfo`，供 FE mesh sidebar 使用。
- [tabs] 导出 `DeviceConnectionAdapter` 和 `DeviceConnectionStatus`，供 FE 设备树接入连接控制。
- **真冲突**：无互斥行为，但漏掉任一导出都会造成跨 package 编译或运行时 import 失败。
- **隐性耦合**：`apps/fe` 的 node sidebar 和 `packages/panels` 的 device tree 必须同时采用最终导出名。

### `packages/panels/src/device-tree/sidebar-device-list.tsx`

- [hub] 设备行可以接收 `nodeBadge`，空列表可以显示 node-specific `emptyLabel`。
- [tabs] 查询使用当前 runtime 的 API client 和 query key。
- [tabs] 连接 adapter 存在时，展开设备调用 `connection.connect()`；收起只改变可见性，断开由 Power 控件负责。
- [tabs] 设备查询失败时显示 retry；设备列表成功为空时显示空状态。
- [tabs] 使用 per-device selector，避免整个 snapshot/store 变化导致所有行重渲染。
- [tabs] reorder mutation 进行中禁用重复拖拽，避免并发覆盖排序。
- **真冲突**：必须保留 hub 的 badge/emptyLabel，同时采用 tabs 的 connection、错误重试和性能优化。
- **隐性耦合**：`GlobalDeviceProvider` 提供 connection，`SidebarNodeSection` 提供 nodeBadge/emptyLabel，`DeviceRow` 接收并渲染三者。

### `packages/stores/src/tmux-device-events.ts`

- [hub] 当前 node 收到 terminal notification action 时，server 绝对路径必须转换成当前 runtime 的 app path，不能跳到 self 或错误 node。
- [tabs] 事件处理改为表驱动；缺失或非字符串字段不得抛异常。
- [tabs] bell、highlight、notification、pane-active 等行为按事件类型分派，未知或无效数据不应污染 store。
- **真冲突**：保留 tabs 的健壮事件解析，同时将 notification action 导航改为 hub 的 node-aware `hostAppPath`。
- **隐性耦合**：前端事件接收器、`dispatchUserInitiatedSelection`、`HostServices.navigate` 和 server 发送的 `paneUrl` 格式必须统一。

## 静默自动合并的风险文件

### `packages/stores/src/index.ts`

- [hub] 移除 root singleton store 导出，默认 runtime 改由 `@tmex/stores/default-runtime` 显式导出；主入口改为 runtime factory、node manager 和纯函数工具。
- [hub] `usePaneAgentState` 改为导出 `selectPaneAgentState`，避免 root 入口携带浏览器 hook/singleton。
- [tabs] 将 `SidebarSection` 类型替换为 `SidebarTab`。
- 当前自动合并结果看起来保留了 hub 拆包和 tabs 类型，但需人工确认：
  - 是否仍有外部代码从 `@tmex/stores` 导入旧 singleton。
  - 所有 `SidebarSection` 引用是否已迁移。
  - `default-runtime.ts` 是否只用于兼容测试/单实例入口。
  - package 公共 API 是否允许此次 singleton 导出移除。

### `packages/stores/src/runtime.ts`

- [hub] `RuntimeCore` 增加 `nodeId`；`createBrowserHostServices()` 支持 node-aware `appPath` 和导航。
- [hub] 默认 notification sink 改为 noop，node runtime 创建时显式注入 sonner sink。
- [tabs] 保留 transport/select machine/features 的拆分解析逻辑和 proxy notification sink。
- 需要确认默认 runtime、NodeConnectionManager、Standalone/FE 三种宿主是否都显式传入正确 notification sink。
- 需要确认已经经过 `hostAppPath()` 的路径不会被 `createBrowserHostServices().navigate()` 二次加 node 前缀。

### `apps/fe/src/pages/SettingsPage.tsx`

- [hub] restart 请求使用当前 `runtime.apiClient`，在 node-b 设置页点击重启时必须请求 node-b。
- [tabs] 设置页 tab trigger 使用共享 `pillTabTriggerClassName`。
- 需要同时验证 API 路由隔离和视觉样式，不能因保留 tabs 版本而恢复全局 `fetch()`。

### `apps/gateway/package.json`

- [hub] 增加 `@simplewebauthn/server`，认证/注册 passkey 的服务端依赖不可丢失。
- [tabs] 删除普通 `build` 脚本，增加 parser/frame-sizer/retention benchmark 脚本。
- 需要确认根脚本、CI、发布流程是否仍调用 `apps/gateway build`；同时检查 lockfile 是否包含 WebAuthn 依赖。
- 如果 Docker/build 入口已经整体删除，需确认删除 `build` 是有意行为而非静默丢失。

### `apps/gateway/src/api/files.test.ts`

- [hub] bulk hook 测试覆盖 UID/临时文件归属、追加上传、下载流结束清理和 abort 清理。
- [tabs] 文件 API 测试覆盖严格 offset、JSON object body 和 NDJSON invalid response。
- 两组测试必须同时保留；尤其确认 route 拆分后 bulk hook 仍操作同一 transfer session，而不是新建另一套临时文件状态。

### `packages/shared/src/i18n/locales/en_US.json`

### `packages/shared/src/i18n/locales/ja_JP.json`

### `packages/shared/src/i18n/locales/zh_CN.json`

- [hub] 新增 auth、security、nodes、node badge、direct/relay transfer、direct fallback toast 等文案。
- [tabs] 新增 retry/page fallback、device connect、terminal/file/watch loading/error，以及 `sidebar.section` → `sidebar.tab`。
- 输入旧 key `sidebar.section.*` 时，合并后应确认所有调用方已改为 `sidebar.tab.*`。
- 三种语言必须保持相同 key 集合，不能只有英文包含 hub 新增 key。
- 生成文件不应手工 lint/format；应在最终 JSON 合并后重新执行 i18n 生成脚本。

### `packages/shared/src/i18n/resources.ts`

### `packages/shared/src/i18n/types.ts`

- [hub] 生成结果必须包含 auth、nodes、node badge、mesh transfer 等 key。
- [tabs] 生成结果必须包含 retry、page fallback、sidebar tab、watch/file/terminal 状态 key。
- 需要确认生成结果与三个 locale JSON 完全同步，尤其不能保留 `sidebar.section` 类型而 JSON 已改成 `sidebar.tab`。
- 这些文件是生成文件，禁止人工修复；如果不一致，应重建源文件产物。

### `packages/shared/src/ws-borsh/index.test.ts`

- [hub] 保留 NODE_EVENT、RTC_SIGNAL、CARRIER_SWITCH、CARRIER_SWITCH_ACK、ENROLL_REDEEMED 的 kind、schema、边界校验测试。
- [tabs] 保留 chunk 并发流上限、超时清理、重复/越界 chunk 和 metadata mismatch 测试。
- 需要确认 `ChunkReassembler.cleanup()` API 变更没有因为两侧测试合并而回退。
- `ENROLL_REDEEMED` 的固定 key/signature 长度和证书最大长度必须继续验证。

### `packages/stores/src/site-theme.test.ts`

- [hub] 测试应从 `./default-runtime` 导入 singleton，反映主入口移除 singleton 导出的行为。
- [tabs] 保留 `handleSettingsUpdate('site')` 异步重拉、其他 namespace 不重拉、失败保留旧缓存的测试。
- 需要确认测试 import 与最终公共 API 一致，且异步 flush 不会产生未处理 rejection。

### `packages/ws-client/src/connection.test.ts`

- [hub] 每次新建 socket、包括 reconnect，都通过 `wsUrlFactory()` 生成新的 `cid`；静态 `getUrl()` 仍返回原始 wsUrl。
- [hub] socket close code 可通过 `onClose` 上报，缺失 code 时使用 1006；宿主回调异常不能阻断 client 自己的收敛。
- [tabs] pane sink 输出在微任务边界合并下发，且不同 connection 的 sink 必须互相隔离。
- 需要确认 `onClose`、`wsUrlFactory`、`socketFactory` 三层包装顺序正确，且 `dispose()` 不会关闭宿主持有的共享 transport。

### `apps/gateway/src/ws` 下其他自动带入文件

这些文件虽然不在 26 个冲突列表中，但会被 hub/tabs 的类型和行为改变影响。

#### hub 侧自动带入、需要检查 carrier/session 一致性的文件

- `apps/gateway/src/ws/carrier.ts`
- `apps/gateway/src/ws/gateway-session.ts`
- `apps/gateway/src/ws/types.ts`
- `apps/gateway/src/ws/borsh-dispatcher.ts`
- `apps/gateway/src/ws/borsh/codec-borsh.ts`
- `apps/gateway/src/ws/borsh/switch-barrier.ts`
- `apps/gateway/src/ws/canonical-feed-session.ts`
- `apps/gateway/src/ws/gateway-metrics-log.ts`
- `apps/gateway/src/ws/theme-settings-broadcaster.ts`
- `apps/gateway/src/ws/websocket-send-guard.ts`

人工确认：

- `Carrier.send()` 的 `sent/backpressure/closed` 结果是否被所有调用方正确处理。
- send guard 是否按 carrier 计数，而 metrics 中的 `clients` 是否仍按 session 计数。
- canonical、theme、agent、switch barrier 是否都通过 active carrier 发送。
- direct carrier close 是否只 detach，而不是触发整个 session close。

#### tabs 侧自动带入、需要适配 GatewaySession 的文件

- `apps/gateway/src/ws/legacy-event-delivery.ts`
- `apps/gateway/src/ws/legacy-event-delivery.test.ts`
- `apps/gateway/src/ws/legacy-observer-wiring.test.ts`
- `apps/gateway/src/ws/borsh/session-state.test.ts`
- `apps/gateway/src/ws/canonical/encoded-size.ts`
- `apps/gateway/src/ws/canonical/frame-sizer.ts`
- `apps/gateway/src/ws/canonical/pane-stream.ts`
- `apps/gateway/src/ws/canonical/transaction-sender.ts`
- `apps/gateway/src/ws/inbound-frame.test.ts`

重点风险：

- 当前 `legacy-event-delivery.ts` 仍导入 `ServerWebSocket`、`ClientState` 和旧 `sessionStateStore` API；hub 的 `types.ts` 已不再导出 `ClientState`，这是明确的编译/API 断裂风险。
- `legacy-observer-wiring.test.ts`、`session-state.test.ts`、部分 issue45 测试仍访问 `ws.data.borshState`，需要改成 GatewaySession fixture 或明确保留兼容层。
- `canonical/transaction-sender.ts` 使用 `sendFitted()` 后，必须确认 carrier 协商的 max frame、canonical protocol 上限和 chunk offset 没有冲突。
- `inbound-frame.test.ts` 要继续验证 Buffer view 的精确 byteOffset/byteLength，而不是仅验证普通 Buffer。

## 需要人工拍板的真冲突

1. **WebSocket 身份模型**

   结论建议：最终统一以 `GatewaySession` 表示逻辑客户端，以 `Carrier` 表示传输载体；将 tabs 的 observer、throttle、output gate、connect generation 全部迁移到 session/carrier 模型。

   若保留旧 socket 作为另一套 key，会出现状态分裂、direct/primary 互相覆盖或关闭时误清理。

2. **侧栏结构**

   结论建议：保留 tabs 的三选一容器：

   - panes：mesh 聚合 node sections，每个在线登录 node 使用独立 runtime。
   - agent：懒加载 AgentTab。
   - files：懒加载 FilesTab。

   不应把 hub 的旧三 section 结构原样塞回 tabs 外层。

3. **文件传输实现**

   结论建议：保留 tabs 的 route 拆分和严格输入校验，将 hub 的 UID 归属及 bulk hooks 放入 transfer route/shared transfer 层。

   必须确认 mesh 传输调用的临时文件与 HTTP upload/download 使用同一个 session。

4. **数据库迁移序号**

   结论建议：先决定 `0018_hub_auth` 与 `0018_agent_query_indexes` 的最终顺序，再同步修改：

   - SQL 文件名；
   - `managed-migrations.ts`；
   - `_journal.json`；
   - snapshot；
   - fresh DB 和 upgrade DB 行为。

   禁止仅选择一份 `0018_snapshot.json`。

5. **runtime 与通知出口**

   结论建议：保留 hub 的 per-node runtime 和 node-aware host；确认所有浏览器 runtime 显式注入正确通知 sink，并确认默认 noop 是有意设计。

6. **部署文档**

   结论建议：若 Docker/旧 JWT 部署已正式移除，保留 hub 重写后的 tmex-cli/launchd/systemd 文档；同时逐条检查文档命令、路径和链接是否仍存在。

7. **生成文件处理**

   结论建议：最终源文件确定后重新生成 i18n 和 Drizzle metadata。不要手工拼接或格式化生成文件。