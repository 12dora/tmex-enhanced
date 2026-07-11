# tmux 树快照 REST 端点 + 侧边栏平铺

## 背景

- 脚本/CLI 等非 WS 客户端目前无法读取 gateway 持有的 tmux 树（session→window→pane）快照；快照只经 WS `KIND_STATE_SNAPSHOT` 下发。
- 侧边栏 panes / agent / files 三个功能区当前用 `<Tabs>` 互斥切换（app-sidebar.tsx），跨区操作（如从 pane 起 agent 会话）需要程序化切 Tab，用户也看不到并列全景。本次改为 Collapsible 并列分区、默认全展开。

## 现状锚点（基线 d49b650）

- 快照真相源：`StateSnapshotPayload`（packages/shared/src/index.ts:469，`{ deviceId, session: TmuxSession | null }`）。
  - WS 侧：`WebSocketServer.connections[].lastSnapshot`，公开读取口 `getLastSnapshot(deviceId)`（ws/index.ts:315），已经由 `registerSnapshotLookup` 注册到 `tmux/snapshot-directory.ts`（runtime.ts:61），消费方用 `getDeviceSnapshot(deviceId)`。仅覆盖「当前有 WS 客户端连接」的设备。
  - 常驻侧：`PushSupervisor.entries[].lastSnapshot`（push/supervisor.ts:25）——push 通道对**所有设备**常驻连接，但没有公开读取方法。
  - 下发前 overlay 链（ws/index.ts:1325 `encodeSnapshotWithOverlays`）：`applyDeviceTreeOverlay(payload, getDeviceTreeOrder(deviceId))`（排序，ws/overlay-utils.ts，纯函数）→ `applyWindowCustomNames`（自定义窗口/pane 名，wsServer 私有，内存 map，带 stale 清理副作用）。REST 读侧已有 `getTreeOverlayBridge()?.getCustomNames(deviceId)` 桥（settings/broadcaster.ts:35）。
- `/api` 相邻端点无独立鉴权（gateway 单用户模型，runtime.ts:111 直接分发 `handleApiRequest`），tree-order 端点即此语义。
- 测试模式：`api/tree-order.test.ts`——bun test preload 设 `DATABASE_URL=:memory:`，`runMigrations()` + `createDevice()` 造数，直接调 handler 断言 JSON。
- 侧边栏：
  - app-sidebar.tsx:44-95 `<Tabs value={sidebarTab}>` + 条件渲染；AgentTab/FilesTab 是 `React.lazy`。
  - `useUIStore.sidebarTab: 'panes'|'agent'|'files'`（packages/stores/src/ui.ts:6,20,33），刻意不持久化。
  - `setSidebarTab` 调用点 5 处：agent-tab.tsx:438（切回会话树按钮）、sidebar-device-list.tsx:233、:250（选中/新建 agent 会话）、rsync-install-flow.ts:96（agent 安装引导）、DevicePage.tsx:979（终端快捷键 newAgentSession）。
  - i18n key：`sidebar.tab.panes/agent/files`（三语言 JSON），生成文件 resources.ts/types.ts 由 `bun run build:i18n` 重建。
  - `@tmex/ui/collapsible` 封装 `@base-ui/react` Collapsible，Panel 默认 `keepMounted=false`——折叠即卸载，满足「折叠时卸载内容」。
  - e2e 基建：`bun run test:e2e`（apps/fe/scripts/run-e2e.ts）自动选空闲端口、透传 spec 参数；tmux 用独立 socket `tmex-e2e`（tests/helpers/tmux.ts）。

## 设计

### A. `GET /api/tmux/tree`

新文件 `apps/gateway/src/api/tmux-tree.ts`，挂进 `api/index.ts`。

- 数据源（同源，不发明新模型）：每设备
  `snapshot = getDeviceSnapshot(deviceId) ?? pushSupervisor.getLastSnapshot(deviceId)`。
  - WS 源较新鲜（有活跃客户端时事件驱动 + 轮询刷新）优先；push 常驻源兜底覆盖无 WS 客户端场景。
  - 给 `PushSupervisor` 补公开方法 `getLastSnapshot(deviceId): StateSnapshotPayload | null`（与 wsServer 同名同签名）。
- overlay 与 WS 下发同链：`applyDeviceTreeOverlay(snapshot, getDeviceTreeOrder(deviceId))` + 新增纯函数 `applyCustomNamesOverlay(payload, names)`（放 ws/overlay-utils.ts；wsServer 私有版本带 stale 清理副作用，保持不动）。自定义名经 `getTreeOverlayBridge()?.getCustomNames(deviceId)` 读取。
- 响应形状：
  ```json
  { "devices": [ { "deviceId": "...", "deviceName": "...", "session": TmuxSession | null } ] }
  ```
  设备顺序 = `getAllDevices()`（sortOrder）。`session: null` 表示该设备当前无可用快照（未连接/离线）。
- 可选 `?deviceId=` 过滤单设备；不存在返回 404（语义同 `/api/devices/{id}`）。
- 鉴权：与相邻端点一致（无额外鉴权，直接进 `handleApiRequest`）。
- 测试 `api/tmux-tree.test.ts`：`registerSnapshotLookup` 注入假快照；覆盖——空快照设备返回 `session:null`、排序 overlay 生效、自定义名 overlay 生效、`?deviceId=` 过滤与 404、方法不匹配 404。

### B. 侧边栏平铺

- stores（packages/stores/src/ui.ts）：`sidebarTab/SidebarTab/setSidebarTab` 替换为
  `sidebarSections: Record<SidebarSection, boolean>`（`'panes'|'agent'|'files'`，默认全 true，不持久化）+ `toggleSidebarSection(section)` + `expandSidebarSection(section)`（幂等展开，供程序化调用点使用）。
- app-sidebar.tsx：去 `<Tabs>`；`SidebarContent` 内三个受控 `Collapsible` 分区，各带 header（icon + 标题 + chevron，`data-testid="sidebar-section-toggle-{panes,agent,files}"`）。展开分区 `flex-1 min-h-0` 均分高度，折叠分区 `shrink-0` 只留 header；`CollapsibleContent` 撑满 `flex-1 min-h-0 flex flex-col`。AgentTab/FilesTab 维持 React.lazy + Suspense（默认展开=首屏即加载，见「性能影响」）。Footer（NavMain 设备管理入口）改为常驻——原来仅 panes Tab 显示。
- agent-tab.tsx:407 根 `h-full`→`flex-1`；:438「切回会话树」按钮改 `expandSidebarSection('panes')`。
- 其余调用点同改 `expandSidebarSection('agent')`（分区常驻可见，「聚焦」= 确保展开）。
- i18n：`sidebar.tab.*` → `sidebar.section.*`（键名对齐新语义，值不变，三语言），跑 `bun run build:i18n` 重建生成文件。
- e2e 4 个 spec：删「点 Tab」步骤，改断言分区内容常驻可见；mobile spec 中「切回 Panes 后 agent-tab 消失」的断言改为两区并列可见；修正 agent-session.spec.ts:315 「sidebarTab 持久化」过时注释（sidebarTab 本就不持久化，且状态已移除）。

### 性能影响（PR 需标注）

三分区默认全展开，AgentTab/FilesTab 的 lazy chunk 会在首屏即被请求，抵消部分原 Tab 互斥下的按需加载收益；折叠分区时 Panel 卸载（base-ui 默认 `keepMounted=false`），懒加载在「用户折叠后不再展开」的场景仍然生效。首屏 entry chunk 本身不变（仍是动态 import 分包），变化只是请求时机提前。

## 验收

- `bun test` 全绿。
- `bun run test:e2e agent-session.spec.ts mobile-agent-watch.spec.ts files-context-menu.spec.ts sidebar-pane-menu-alignment.spec.ts` 全绿（独立 socket `tmex-e2e`，动态端口）。
- `bun run build:fe` 通过。

## 注意事项

- 严禁触碰生产 tmex（launchd/9883/`~/Library/Application Support/tmex`）与名为 `tmex` 的 tmux session；e2e 只走 `bun run test:e2e`（内建端口防撞 + 独立 socket）。
- 生成文件（resources.ts/types.ts）只由 build:i18n 重建，不手改不 lint。
