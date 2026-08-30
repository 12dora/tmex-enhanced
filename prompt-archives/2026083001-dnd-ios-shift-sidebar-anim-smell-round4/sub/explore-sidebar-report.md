# 侧栏 node 切换只读勘察报告

## 结论

- `RootLayout`、`SidebarProvider`、`AppSidebar` 位于 `/` 的公共布局下，self runtime 常驻；切换 `/devices/...` 与 `/n/:nodeId/devices/...` 不会整体卸载侧栏。[apps/fe/src/main.tsx:127-151](apps/fe/src/main.tsx:127)
- `NodeRuntimeBoundary` 只包页面区；route node 变化会重挂页面、QueryClient、GlobalDeviceProvider，但不影响侧栏设备聚合树。[apps/fe/src/main.tsx:198-223](apps/fe/src/main.tsx:198)
- 当前不存在 node section 级别的“active/expanded”状态。实际变化的是当前 node 下的 selected device，以及 device 的窗口/pane 子树。
- 仓库没有 `framer-motion`、`motion/react`、`AnimatePresence` 或 Motion `layout` 动画 prop；现有方案是 CSS motion token、`Reveal`/`Stagger` 和 Base UI transition。

## 1. node 切换时的渲染变化

### 布局与 route

`useRouteNodeId()` 从 pathname 解析 `/n/:nodeId`，无前缀归为 `self`。[apps/fe/src/node/node-runtime-boundary.tsx:30-38](apps/fe/src/node/node-runtime-boundary.tsx:30)

路由配置让 self 与 `/n/:nodeId` 共用同一个 `RootLayout`。[apps/fe/src/main.tsx:241-286](apps/fe/src/main.tsx:241)

runtime provider 会按 runtime 实例生成 Fragment key；因此页面区换 node 时整棵页面子树重挂。[packages/stores/src/react.tsx:19-31](packages/stores/src/react.tsx:19)

侧栏本身挂在固定的 `NodeRuntimeScope(self)` 下；只有 Agent / Files tab 另外挂载当前 route node 的 scope。[apps/fe/src/components/page-layouts/components/app-sidebar.tsx:28-87](apps/fe/src/components/page-layouts/components/app-sidebar.tsx:28)

### 侧栏变化矩阵

| 部分 | node 切换时的触发源 | 实际变化 | 生命周期 |
|---|---|---|---|
| node 分节列表 | 宿主级 `useMeshNodes()`：`/api/mesh/nodes`、轮询、mesh event | 节点名称、在线态、登录态、inventory、排序变化；route 本身不改列表 | `key={entry.runtimeNodeId}`，正常切换保持挂载。[sidebar-device-list.tsx:93-145](apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:93) |
| 当前 node 分节 | pathname → `selectedDeviceIdForNode()` | 只有匹配当前 route node 的设备获得 selected 例外；其它 node 的 selected 为 `null`。[sidebar-node-section.tsx:62-81](apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:62) | 分节可能因可见设备数变为 `return null`，但不是整棵侧栏 remount。[sidebar-device-list-runtime.tsx:61-85](apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:61) |
| 设备行 | `useDeviceTreeSelection()` + UI store | 当前设备的 `isSelected` 改变；左侧选中条和背景色改变。[device-row-header.tsx:16-63](packages/panels/src/device-tree/device-row-header.tsx:16) | 设备以 `key={device.id}` 保持；旧、新 selected 行只重渲染。[sidebar-device-list.tsx:255-275](packages/panels/src/device-tree/sidebar-device-list.tsx:255) |
| 窗口 / pane | 当前 route 的 device/window/pane 参数 | 对应 window/pane 设置 `data-active="true"`；其它行取消 active。[window-row-header.tsx:43-67](packages/panels/src/device-tree/window-row-header.tsx:43) | window 用 `key={tmuxWindow.id}`，pane 用 `key={pane.id}`。[device-window-list.tsx:83-104](packages/panels/src/device-tree/device-window-list.tsx:83) |
| device 子树展开 | UI store `sidebarDeviceExpanded` | 新 route device 首次进入时可能被自动展开；旧 device 不会自动收起。展开态按 self/device 或 `nodeId:deviceId` 隔离。[sidebar-device-list.tsx:168-210](packages/panels/src/device-tree/sidebar-device-list.tsx:168) | `DeviceWindowList` 通过条件渲染挂载/卸载；当前无退出动画。[device-row.tsx:20-37](packages/panels/src/device-tree/device-row.tsx:20) |
| node header | mesh store 的 name/online/inventory | `NodeBadge` 文案和在线灰显状态可变；没有 route active 样式或展开箭头。[sidebar-node-section.tsx:84-121](apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:84) | header 随分节存在，不因 node switch 单独重挂 |
| Agent session 分支 | 当前 runtime 的 agent store、tmux snapshots、`loadSessions()` | 每个 node 的 pane 下显示该 node 的绑定 sessions；孤立 sessions 在该 node 的底部折叠区显示。[sidebar-agent-sessions.tsx:68-151](apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:68) | session 行用 `key={session.id}`；provider 按 runtime 隔离。[use-sidebar-agent-sessions.ts:125-142](apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:125) |
| Agent tab | `AppSidebar` 的 `NodeRuntimeScope(routeNodeId)` | 切 node 时 AgentTab、agent store observer、当前聊天视图重挂；AgentTab 本身不是 session 导航列表。[app-sidebar.tsx:77-85](apps/fe/src/components/page-layouts/components/app-sidebar.tsx:77) |
| Files tab | 同一个 route-scoped `NodeRuntimeScope` | 切 node 时文件 query、文件树和 file store 重挂。[files-tab.tsx:49-75](packages/panels/src/files/files-tab.tsx:49) |
| SidebarTitle | self runtime 的 site/tmux store、mesh mode | 不显示当前 node 名称；Brand、延迟、主题、节点入口、设置入口通常不变。[sidebar-title.tsx:16-30](apps/fe/src/components/page-layouts/components/sidebar-title.tsx:16) |
| 底部 NavMain | pathname 归一化 | `/n/:nodeId` 前缀会被剥除；终端深链不会点亮“管理设备”，只有精确 `/devices` 才 active。[nav-main.tsx:17-34](apps/fe/src/components/page-layouts/components/nav-main.tsx:17) |
| 移动端页面顶栏 | PageWrapper + 当前页面 `PageTitle` | 终端标题会按新 device/window/pane snapshot 更新；这是页面顶栏，不是 SidebarTitle。[page-wrapper.tsx:36-56](apps/fe/src/page-wrapper.tsx:36) |

### self 与 remote 差异

- mesh 模式下，entry node 映射为 runtime id `self`，并强制视为已登录；远端使用真实 node id。[sidebar-device-list.tsx:61-80](apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:61)
- 非 mesh 或 mesh 列表尚未返回时，侧栏直接渲染单 runtime 设备树，没有 node header/badge。[sidebar-device-list.tsx:113-145](apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:113)
- remote node 默认按 UI visibility 过滤；当前 route 选中的 device 无条件保留。[device-tree-selectors.ts:53-70](packages/panels/src/device-tree/device-tree-selectors.ts:53)
- remote 未登录时只显示折叠登录入口；在线已登录时才挂载该 node 的 `NodeRuntimeScope` 和真实设备树；离线时只显示 inventory 中的灰显设备。[sidebar-node-section.tsx:125-178](apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:125)

## 2. 现有动画基础

### 依赖与 primitives

- `apps/fe/package.json`、`packages/ui/package.json`、`packages/panels/package.json` 均没有 `framer-motion` 或 `motion` 依赖。[apps/fe/package.json:15-55](apps/fe/package.json:15)
- 全仓没有 `AnimatePresence`、Motion `layout`/`layoutId` 或 `<motion.*>` 用法。
- `apps/fe/src/pages/devices/device-folders-view.tsx:108-121` 的 `layout={layout}` 是业务数据，不是动画 prop。[device-folders-view.tsx:108-121](apps/fe/src/pages/devices/device-folders-view.tsx:108)
- `@tmex/ui/motion` 是 CSS wrapper，不是 framer-motion wrapper：`Reveal`、`Stagger`、duration constants、`useReducedMotion`。[packages/ui/src/components/motion.tsx:5-94](packages/ui/src/components/motion.tsx:5)

### 时长、缓动、约定

- `fast=100ms`、`standard=150ms`、`layout=200ms`、`slow=300ms`。[motion.tsx:5-11](packages/ui/src/components/motion.tsx:5)
- `ease-out = cubic-bezier(0.22, 1, 0.36, 1)`；exit 可用 `ease-in`；布局 token 为 `ease-in-out`。[packages/theme/src/motion.css:3-15](packages/theme/src/motion.css:3)
- `Reveal` 使用 `fade-up + translateY(6px)`；`Stagger` 每项间隔 35ms。[motion.css:18-65](packages/theme/src/motion.css:18)
- AppSidebar 当前只在 tab 切换时使用 `Reveal key={sidebarTab}`；node route 切换不会触发这个 key。[app-sidebar.tsx:74-86](apps/fe/src/components/page-layouts/components/app-sidebar.tsx:74)
- 设备展开时的 `DeviceWindowList` 只有 `tmex-reveal` 入场，条件卸载时没有 exit。[device-window-list.tsx:16-37](packages/panels/src/device-tree/device-window-list.tsx:16)
- Base UI `CollapsibleContent` 已具备高度和 opacity transition，可直接复用。[packages/ui/src/components/collapsible.tsx:15-29](packages/ui/src/components/collapsible.tsx:15)
- Side panel 使用 Base UI 的 ending-style，并延迟清理 `rendered` 内容，保证退场动画期间内容仍存在。[side-panel-host.tsx:8-10,30-80](apps/fe/src/components/side-panels/side-panel-host.tsx:8)
- 设备管理页的 stagger 只用于初始批次，延迟上限 11 项；不用于实时列表更新。[device-management-panel.tsx:63-66,383-400](packages/panels/src/device-management/device-management-panel.tsx:63)
- reduced-motion 有全局兜底，并大量使用 `motion-reduce:transition-none` / `motion-reduce:animate-none`。[packages/theme/src/motion.css:67-77](packages/theme/src/motion.css:67)
- JS 状态型 enter/exit 的成熟范例是 `ConnectionIndicator`：reduced motion 时直接落终态，避免等待不存在的 `transitionend`。[connection-indicator.tsx:27-55](packages/panels/src/connection-indicator.tsx:27)

## 3. 测试约束

单测覆盖：

- 聚合 node 映射、self→`self`、排序、离线/未登录/已登录分支、selected device 保留和 runtime device tree：[sidebar-device-list.test.tsx:85-153,211-321,358-388](apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:85)
- SidebarTitle 的 mesh/standalone 节点入口：[sidebar-title.test.tsx:51-78](apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx:51)
- Agent session 排序、分组、孤立判定：[use-sidebar-agent-sessions.test.ts:82-201](apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.test.ts:82)
- NavMain route active 归一化：[nav-main.test.ts:6-39](apps/fe/src/components/page-layouts/components/nav-main.test.ts:6)

Playwright 实际目录是 `apps/fe/tests`，没有专门的 node-switch animation test：

- mesh node 列表与远端 terminal route：[mesh-login.spec.ts:21-80](apps/fe/tests/mesh-login.spec.ts:21)
- 设备展开持久化、tab 互斥、terminal window/pane active：[sidebar-device-disclosure.spec.ts:55-136](apps/fe/tests/sidebar-device-disclosure.spec.ts:55)
- Agent tab、session 行、重命名/删除、跨 tab 同步：[agent-session.spec.ts:21-36,287-401,431-470](apps/fe/tests/agent-session.spec.ts:21)
- session 分支存在时 pane 操作按钮的垂直对齐：[sidebar-pane-menu-alignment.spec.ts:51-80](apps/fe/tests/sidebar-pane-menu-alignment.spec.ts:51)

## 4. 推荐的最小动画设计

1. 保持现有稳定 key：`runtimeNodeId`、`device.id`、`window.id`、`pane.id`、`session.id`。不要给整个 `MeshDeviceList` 或滚动容器增加 `key={routeNodeId}`，否则会丢失滚动位置并重挂所有 node 树。

2. 将 device 的 `showTree` 条件渲染改为受控 Base UI `Collapsible`，让 `DeviceWindowList` 放入 `CollapsibleContent`。使用现有 `height + opacity`、150ms、`ease-out`；不要同时叠加第二套 `tmex-reveal`。设备箭头补齐 `duration-(--tmex-motion-standard)`。

3. 只给 device/window/pane 的 active 色彩增加 100–150ms transition；可给当前 route node header 加轻微背景或状态点过渡。不要把整个 node section 淡出，当前代码并没有 node section active state。

4. 不对每次 node switch 的 window、pane、session 做 stagger。实时 tmux snapshot 会频繁更新，逐项动画会造成拖尾和布局抖动；35ms stagger 仅适合初始、数量受限的列表。

5. 本次不建议引入 `framer-motion`。若未来确实引入 Motion：
   - `AnimatePresence initial={false}` 只用于轻量的 tab/section 视觉壳；
   - `layout` 只放在 node section 的 inner wrapper，用于 sibling 位移；
   - 不要把 `layout` 放到 dnd-kit 同时控制 `transform` 的根元素。[device-tree-dnd.tsx:96-114](packages/panels/src/device-tree/device-tree-dnd.tsx:96)
   - 不要用它包住整棵 route-scoped runtime；旧 runtime 若要等待 exit，会延长旧 QueryClient、WS 和订阅生命周期。

6. 对 node section 的真正 enter/exit，当前 `return null` 需要先增加 delayed-unmount/presence 壳；否则 CSS exit 没有机会播放。该改动应作为独立增强，不属于本次 terminal window 切换的最小修复。

7. reduced-motion 下直接呈现最终展开/收起状态；若 presence 逻辑依赖 `transitionend`，应像 `ConnectionIndicator` 一样直接进入 visible/hidden，不能停在 opacity 0。

最小收益最大的落点是：`DeviceRow` 的高度/opacity 展开收起 + active 行颜色过渡，并保持 node 聚合树、key 和滚动容器不变。