# O2a 执行结果 — 设备卡片侧栏开关组（终端 / 文件）+ 文件侧栏可见性与离线行为

## 做了什么

### 1. store：新增 `sidebarFilesVisibility`

- `packages/stores/src/sidebar-device-visibility.ts`
  新增 `isSidebarFilesVisible(map, runtimeNodeId, deviceId, hasRoots)`，复用同一个复合键
  `sidebarDeviceVisibilityKey(runtimeNodeId, deviceId)`；缺省规则 = `stored ?? hasRoots`
  （配了目录就默认显示，self 与远端 node 一视同仁）。`isSidebarDeviceVisible` 的语义原样不动
  （self 默认显示 / 远端默认隐藏），仍然只服务终端页。
- `packages/stores/src/ui.ts`
  UI store 新增字段 `sidebarFilesVisibility: Record<string, boolean>` 与
  `setSidebarFilesVisibility(key, visible)`；已接入 `partialize` 持久化与 `merge` 里的
  `normalizeBooleanMap`（脏数据只保留合法布尔项）。
- `packages/stores/src/index.ts`：追加导出 `isSidebarFilesVisible`。

### 2. 设备卡片：一组标签 + 两个开关

`packages/panels/src/device-management/device-card.tsx`

- 第二行右侧原来的单个「显示在侧栏」开关，换成开关组：
  `侧栏显示   终端 [●]   文件 [○]`（容器 `data-testid=device-card-sidebar-group-<id>`，
  `flex flex-wrap justify-end`，宽卡片一行、窄了自然换行）。
- 新增内部组件 `SidebarVisibilityToggle`：标签与开关同属一个 tooltip 触发器（渲染成 `div`，
  不进 Tab 序），`title` 同时保留给触屏 / 无障碍。
  - 终端：tooltip「在侧栏的终端页显示该设备」，testid 沿用 `device-card-sidebar-<id>`（e2e 不破）。
  - 文件：tooltip「在侧栏的文件页显示该设备的目录」，testid `device-card-sidebar-files-<id>`；
    该设备没有任何 file root 时 `disabled` + 整块 `opacity-60`，tooltip 换成「尚未为该设备配置目录」。
  - `runtime.features.filesUi` 关断的宿主里不渲染文件开关（否则是个永远点不动的死开关）。
- 是否有目录：`useQuery({ queryKey: ['files','roots'], queryFn: fetchFileRoots(runtime.apiClient) })`，
  与文件侧栏同键。`settings-events-init` 在 `file-roots` 事件上失效 `['files']`，所以在弹窗里配完
  目录，开关立刻从禁用变可用，无需刷新。`enabled: filesUi && !offline`（离线不打远端，缓存仍算数）。
- 三点菜单新增「文件」入口（`FolderCog` 图标，testid `device-card-files-<id>`，节点离线时禁用），
  打开 O2b 的 `DeviceFilesModal`（`../settings/device-files-modal`，已就位）。弹窗按「开过一次才挂载」
  处理：一页几十张卡片不会各挂一个 Dialog，同时关闭动画能播完。
- return 由单个 `<Card>` 改为 fragment，弹窗作为 Card 的兄弟节点（Card 有 `overflow-hidden`）。

### 3. 文件侧栏过滤

- 新增 `packages/panels/src/files/root-visibility.ts`（纯函数，便于单测）：
  - `isFileRootDeviceReachable(deviceType, deviceId, deviceConnected)`：`local` 恒可达；
    其余要 `deviceConnected[deviceId] === true`；`deviceType === null`（设备已不存在）不可达。
  - `selectVisibleFileRoots({ roots, runtimeNodeId, visibility, deviceConnected })`：
    `enabled` && `isSidebarFilesVisible(..., hasRoots=true)` && 设备可达。
- `packages/panels/src/files/files-tab.tsx`：
  - 原来的 `.filter(r => r.enabled)` 换成 `selectVisibleFileRoots`，可见性读
    `useUIStore(state => state.sidebarFilesVisibility)`，连接态读
    `useTmuxStore(state => state.deviceConnected)`——两者都是响应式的，设备断开/重连时
    根目录即时消失/回来，不依赖 React Query 重新拉取（缓存原样留着，靠过滤器藏）。
  - 新增 prop `nodeOffline?: boolean`。外壳门在 `filesUi` 判断之后再判它：离线时只渲染一行
    muted 提示「节点离线」（`data-testid=files-node-offline`），没有头部、没有错误/重试、
    也不挂内层（内层 hooks 完全不执行 ⇒ 一个请求都不发，也不会显示陈旧目录）。
    node 回线后内层重挂，自动重新拉取。
  - `pruneStaleRoots` 仍按**未过滤**的完整列表清理展开态（临时隐藏不该清掉展开记忆）。

### 4. 外壳接线

`apps/fe/src/components/page-layouts/components/app-sidebar.tsx`（只动 files tab 相关行）

- 新增导出的纯函数 `isRouteNodeOffline(nodes, entryNodeId, routeNodeId)`：`self` 路由查 entry
  自身那条；名单里没有该 node（standalone / mesh 列表还没回来）按在线算。
- 新增 hook `useRouteNodeOffline`：`useMeshNodes({ enabled: false })` —— 只订阅宿主级 mesh 快照，
  **不**发 `/api/mesh/*`、**不**订阅事件流（拉取与订阅仍归 `SideBarDeviceList`），
  standalone 下零新增请求。
- `<FilesTab nodeOffline={routeNodeOffline} />`。agent tab 那一支原样不动（O1 的地盘）。
- 跨节点行为按任务书保持现状：文件页仍只显示当前路由 node 的 roots，只是多了可见性 / 连接 /
  离线三层过滤。`sidebar-node-section.tsx` 没有改动——它只负责终端页的设备树，与文件页无关。

### 5. i18n（三语同 key）

- `translation.device.sidebar` 新增：`group`、`terminal`、`files`、`terminalHint`、`filesHint`、
  `filesDisabledHint`。原有 `show` / `hint` 保留未删——`device-remote-info-fields.tsx`（不在本次
  scope）仍在用。
- `translation.files` 新增：`nodeOffline`。
- 三点菜单的「文件」标签复用已有的 `files.title`。
- 已在本地跑过 `bun run build:i18n`（只从 JSON 重新生成）。

## 改动文件

新增：
- `packages/panels/src/files/root-visibility.ts`
- `packages/panels/src/files/root-visibility.test.ts`
- `packages/panels/src/files/files-tab.test.tsx`
- `apps/fe/src/components/page-layouts/components/app-sidebar.test.ts`

修改：
- `packages/stores/src/sidebar-device-visibility.ts`、`sidebar-device-visibility.test.ts`
- `packages/stores/src/ui.ts`、`ui.test.ts`
- `packages/stores/src/index.ts`
- `packages/panels/src/device-management/device-card.tsx`、`device-card.test.tsx`
- `packages/panels/src/files/files-tab.tsx`
- `apps/fe/src/components/page-layouts/components/app-sidebar.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（+ 生成的 `resources.ts`/`types.ts`）

## 验证

| 包 | bun test | tsc --noEmit | 基线 |
| --- | --- | --- | --- |
| packages/stores | 294 pass / 0 fail | 1 error（`host-services.test.ts` 既有） | 282 / 1 |
| packages/panels | 551 pass / 0 fail | 0 error | 507 / 0 |
| apps/fe | 693 pass / 0 fail（`bun test src/`） | 2 error，均在 `sidebar-agent-sessions.tsx` / `use-sidebar-agent-sessions.test.ts`（O1 的 agent `nodeId` 契约，非本任务） | 671 / 0 |
| packages/shared | 365 pass / 0 fail | 0 error | 365 / 0 |

`bunx biome check` 覆盖全部 13 个改动/新增源文件：`No fixes applied`。

新增测试：
- stores：`isSidebarFilesVisible` 的缺省/显式/跨 node 三组；UI store 的文件可见性持久化与脏数据规范化。
- panels：`root-visibility` 7 例（本机免连、SSH 需连、设备不存在、禁用、开关关掉、断开/重连）；
  `files-tab` 5 例（默认显示、未连 SSH 不显示、禁用不显示、离线只留一行提示且无错误/刷新入口、在线无提示）；
  `device-card` 6 例（两个开关 + 组标签、终端默认值 self/远端、文件默认值、无目录禁用 + 文案、
  只认本设备的目录、离线沿用缓存）。
- fe：`isRouteNodeOffline` 4 例。

## 说明 / 遗留

1. **O2b 的 `DeviceFilesModal` 已就位**（`packages/panels/src/settings/device-files-modal.tsx`），
   props 为 `{ device: Device; nodeId; open; onOpenChange }`（不是任务书里写的 `DeviceDto`——
   仓库里没有这个类型，实际就是 `@tmex/shared` 的 `Device`），已按此接线，无需占位文件。
2. 执行途中有一段时间 `packages/api-client/src/files.ts` 没有把 `browseDirectory` 透出去，
   导致整个 panels 测试套过不了模块解析；随后已被相应 agent 补上，最终全绿。
3. **设备卡片菜单项的静态渲染测不到**：`DropdownMenuContent` 在 `react-dom/server` 下不渲染
   （base-ui 走 portal + 关闭态），所以「文件」菜单项与它的离线禁用只有代码保证，没有单测覆盖，
   留给 e2e / 手测。
4. **离线时文件开关不禁用**：`useQuery` 的 `enabled:false` 只阻止重新拉取，缓存里的 roots 仍然可读，
   所以节点离线期间开关维持上一次的可用状态。两个开关都只是浏览器本地偏好，离线可改无副作用——
   这是有意为之，与终端开关行为一致。
5. **文件侧栏被全部过滤掉时**沿用既有空态文案「没有可访问的目录。请在「设置 → 文件」中添加。」。
   如果希望区分「一条都没配」与「配了但都被隐藏 / 设备没连上」，需要再加一条文案——本次没做，
   任务书未要求。
6. `packages/panels/src/device-tree/**` 未改动：`selectSidebarVisibleDevices` 这个名字对终端页依然准确，
   没有必要重命名。
