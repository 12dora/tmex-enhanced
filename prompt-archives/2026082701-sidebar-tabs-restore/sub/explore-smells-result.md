以下以 `HEAD` 为基线，跳过 `app-sidebar.tsx` 与 `stores/ui.ts` 的 tabs/section 并发改动。

1. [packages/panels/src/agent/use-agent-tab-state.ts:54]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-state.ts:54 )、[use-agent-tab-actions.ts:31]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-actions.ts:31 ) — **BUG**：Agent 路由解析和跳转未使用 `hostAppPath`，嵌入式宿主带前缀时无法识别 pane，Go to Binding 也会跳错路由。建议统一使用 `hostAppPath`、`encodePaneIdForUrl`，抽取 `buildAgentPanePath()`。Effort：M。

2. [packages/panels/src/agent/use-agent-tab-actions.ts:68]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-actions.ts:68 ) — **BUG**：Rebind 只校验 `routePaneId`，未校验 `routeDeviceId`；跨设备时会把当前会话绑定到另一设备的 pane ID。建议在 `onRebind` 和 `canRebind` 中要求设备一致，或让 API 同时接收 `deviceId`。Effort：M。

3. [packages/panels/src/agent/use-agent-tab-state.ts:125]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-state.ts:125 ) — **BUG**：切换 pane 后旧 `draft` 仍存在，自动起草条件不满足，发送时可能把内容提交到旧 pane。建议抽取 `useSyncDraftToRoute()`，检测 device/pane 不一致后清理并重新起草。Effort：M。

4. [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:443]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:443 ) — **BUG**：设备仍存在但 pane 已消失的会话既不挂在 pane 下，也不被列入 orphan，会从侧栏消失。建议基于 tmux snapshot 构造 `knownPaneKeys`，或抽取 `isSessionAttached()`。Effort：M。

5. [packages/panels/src/agent/use-agent-tab-actions.ts:127]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-actions.ts:127 ) — **BUG**：`withdrawQueuedMessage()` 失败时会吞掉异常，随后仍执行 enqueue，可能造成原消息和 steer 消息重复排队。建议让 withdraw 返回成功状态，或提供后端原子化 `steerQueuedMessage()`。Effort：M。

6. [packages/panels/src/device-tree/sidebar-device-list.tsx:66]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/sidebar-device-list.tsx:66 ) — **BUG**：设备查询失败且没有缓存时，界面走 `noDevices`，用户会误以为没有设备且没有重试入口。建议增加 `DeviceListError`，显示错误和 `devicesQuery.refetch()`。Effort：S。

7. [packages/panels/src/files/files-tab.tsx:63]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/files/files-tab.tsx:63 ) — **BUG**：文件根目录查询失败时同样显示 `files.noRoots`，错误被伪装为空列表。建议增加 roots error 状态和重试按钮。Effort：S。

8. [packages/panels/src/device-tree/window-row.tsx:88]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/window-row.tsx:88 ) — **BUG**：空 pane 的窗口仍加入“新建 Agent 会话”动作，点击后 `pane.id` 会触发运行时异常。建议先计算 `sessionPane`，仅在存在 pane 时添加 action。Effort：S。

9. [packages/ui/src/components/sidebar/sidebar-provider.tsx:73]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/ui/src/components/sidebar/sidebar-provider.tsx:73 )、[packages/stores/src/ui.ts:33]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/stores/src/ui.ts:33 ) — **BUG**：Sidebar 写入 cookie 但从不读取；`sidebarCollapsed` 也未接入 `SidebarProvider`，折叠状态刷新后丢失，相关快捷操作不会真正展开侧栏。建议读取 cookie，或由应用层通过 `open/onOpenChange` 做受控桥接，并删除废弃状态。Effort：M。

10. [apps/fe/src/components/page-layouts/components/nav-main.tsx:35]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/nav-main.tsx:35 ) — **BUG**：`Link` 包裹 `SidebarMenuButton`，形成 `<a><button>`；子菜单还形成嵌套 `<a>`，键盘和读屏行为不可靠。建议让 `SidebarMenuButton` 直接 `render={<NavLink />}`，同时接入真实路由 active 状态。Effort：M。

11. [packages/panels/src/device-tree/device-tree-navigation.ts:67]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/device-tree-navigation.ts:67 ) — **BUG**：对异常 URL 直接调用 `decodeURIComponent`，非法 `%` 路径可能让侧栏渲染抛异常。建议抽取 `safeDecodePaneParam()`，捕获 `URIError` 并返回原值或空选择。Effort：S。

12. [packages/panels/src/agent/use-agent-tab-state.ts:100]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-state.ts:100 ) — **BUG**：设备查询的 loading/error 都被压缩为 `devices === undefined`，下游可能把“尚未加载/查询失败”当成 orphan 并禁用输入。建议返回 `devicesLoading/devicesError`，只在查询成功后判定设备不存在。Effort：S。

13. [packages/panels/src/device-tree/sidebar-device-list.tsx:116]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/sidebar-device-list.tsx:116 ) — **BUG**：设备拖拽重排允许 mutation 并发执行，快速连续拖动时旧请求可能覆盖新顺序。建议串行化 mutation、禁用 pending 期间拖拽，或使用请求序号做 last-write-wins。Effort：M。

14. [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:83]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:83 )、[packages/panels/src/agent/use-agent-tab-state.ts:109]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/agent/use-agent-tab-state.ts:109 ) — **SMELL**：两个入口都 bootstrap Agent sessions；StrictMode、切换 tabs 或快速重挂载会重复请求，存在响应覆盖风险。建议保留唯一 bootstrap owner，并在 store 增加 `loadSessionsOnce()`。Effort：M。

15. [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:161]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:161 ) — **BUG**：`updatedAt` 相等时比较器始终返回 `-1`，不满足排序比较器对称性，列表顺序可能抖动。建议复用 store 的 `sessionOrder`，或增加 `id` 作为稳定 tie-breaker。Effort：S。

16. [apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:8]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:8 ) — **SMELL**：即使 `agentUi` 关闭，`SidebarAgentSessionsProvider` 仍会初始化并加载 Agent sessions。建议按 feature gate 条件挂载 Provider，或将 bootstrap 移到 Agent 面板内部。Effort：S。

17. [packages/panels/src/device-tree/device-row.tsx:11]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/device-row.tsx:11 )、[window-row.tsx:30]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/window-row.tsx:30 )、[pane-row.tsx:26]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/pane-row.tsx:26 ) — **SMELL**：设备树三层传递大量点击、菜单、导航和 Agent props，维护成本高。建议建立 `DeviceTreeContext`，提供 `useDeviceTreeActions()` 与导航对象。Effort：L。

18. [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:1]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:1 ) — **SMELL**：554 行文件同时负责 bootstrap、Context、会话列表、orphan 列表、菜单和两个对话框。建议拆成 `useSidebarAgentSessionController`、`AgentSessionRow`、`AgentSessionDialogs` 和 adapter 组装文件。Effort：M。

19. [packages/panels/src/device-tree/device-tree-dialogs.tsx:52]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/device-tree-dialogs.tsx:52 ) — **SMELL**：单个 hook 同时管理关闭、重命名、Watch 三套状态、动作和完整 JSX，超过 200 行。建议拆成 `useCloseDialog`、`useRenameDialog`、`CloseConfirmDialog`、`RenameDialog`。Effort：M。

20. [packages/panels/src/device-tree/window-row.tsx:47]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/window-row.tsx:47 )、[pane-row.tsx:40]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/pane-row.tsx:40 ) — **SMELL**：行组件同时构造 action model、渲染标题、pane 列表和 Agent 分支，且 action 构造逻辑重复。建议抽取 `useWindowActionItems()`、`usePaneActionItems()`、`WindowHeader`、`PaneDetails`。Effort：M。

21. [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:413]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:413 ) — **SMELL**：每个 pane 分支都对完整 session map 做一次 `Object.values + sort + filter`，pane 多时开销为 O(P×S log S)。建议 Provider 一次性构造 `sessionsByPane`，或增加按 pane 的 Zustand selector。Effort：M。

22. [packages/panels/src/device-tree/device-tree-navigation.ts:165]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/panels/src/device-tree/device-tree-navigation.ts:165 ) — **SMELL**：pending navigation 的 TTL 只有在 snapshots 变化时才检查，没有定时器；目标设备永不返回数据时，过期 ref 会长期保留。建议在写入 pending 时启动 `setTimeout`，或抽取可测试的 `usePendingNavigationExpiry()`。Effort：S。

23. [packages/ui/src/components/sidebar/sidebar-provider.tsx:40]( /Users/konata/code/tmex-enhanced-wt-tabs/packages/ui/src/components/sidebar/sidebar-provider.tsx:40 ) — **BUG**：`localStorage` 读取和写入均未捕获 `SecurityError`；禁用存储的隐私模式或 sandbox iframe 可能导致侧栏初始化/拖拽异常。建议封装 `safeReadStorage/safeWriteStorage` 并静默降级。Effort：S。

24. [apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:218]( /Users/konata/code/tmex-enhanced-wt-tabs/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:218 ) — **BUG（无障碍）**：省略号菜单的 `aria-label` 使用“重命名会话”，读屏用户无法知道这是操作菜单。建议增加 `agent.session.menu` 或复用通用 `moreActions` 文案。Effort：S。