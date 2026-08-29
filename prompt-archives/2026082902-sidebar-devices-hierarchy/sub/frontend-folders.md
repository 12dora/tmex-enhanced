# 任务 B：设备管理页文件夹层级（拖拽、嵌套、持久化）——前端

worktree：`/Users/konata/code/tmex-enhanced-wt-merge`（分支 `chore/merge-hub-tabs`）。**其他代理正并行修改同一 worktree 的其它文件**：`packages/panels/src/device-management/**`（另一位前端代理）、`apps/gateway/**` + `packages/api-client/**`（后端代理，正在实现下面的 REST 与 client 封装）。你只能改「文件范围」里的文件；**禁止任何 git 命令**。运行时 Bun（`export PATH="$HOME/.bun/bin:$PATH"`）。先读 `AGENTS.md`。macOS 无 `timeout`；`bun test` 输出带 ANSI 色（`sed 's/\x1b\[[0-9;]*m//g'`）；`apps/fe` 单测用 `bun test src/`（裸 `bun test` 会捞到 Playwright）。注释只在逻辑不直观处写、简体中文，标识符英文。**严禁偷懒**：不留 TODO、不写「简化版」、不用 localStorage 存树结构。

## 文件范围（只准改/建）
- 新建 `packages/panels/src/device-folders/**`（通用树 UI + dnd + 测试），并在 `packages/panels/package.json` 的 `exports` 里照 `./device-management`/`./device-tree` 的写法加 `./device-folders`。
- `apps/fe/src/pages/DevicesPage.tsx`、`apps/fe/src/pages/devices/**`（含 `add-device-menu.tsx`——已修好一个 Base UI 崩溃：`DropdownMenuLabel` 必须在 `DropdownMenuGroup` 里，保留 `AddDeviceMenuList` 与其测试）。
- `packages/stores/src/ui.ts`、`packages/stores/src/ui.test.ts`：加 `deviceFolderExpanded: Record<string, boolean>` + `setDeviceFolderExpanded(folderId, expanded)`，进 `partialize` 持久化并在 `merge` 里 `normalizeBooleanMap`（缺省视为展开）。
- `apps/fe/src/components/page-layouts/**` 不要动。**不要改** locale JSON / i18n 生成物 / `packages/shared/**` / `packages/panels/src/device-management/**`。

## 已经就绪、必须复用的东西
- 契约：`packages/shared/src/contracts/device-folders.ts`；纯逻辑：`packages/shared/src/device-folders.ts`（`buildDeviceFolderTree`、`moveFolderInLayout`、`moveItemInLayout`、`removeItemFromLayout`、`reparentOnFolderDelete`、`validateDeviceFolderName`、`deviceFolderItemKey/parseDeviceFolderItemKey`、`wouldCreateFolderCycle`、`findItemFolderId`），均从 `@tmex/shared` 导出。**前端乐观更新一律用这些函数算新布局**，不要再写一份树逻辑。
- i18n key（三语已加）：`devices.folders.{newFolder,newSubfolder,rename,delete,deleteConfirmTitle,deleteConfirmDescription(name),namePlaceholder,nameRequired,nameTooLong(max),itemCount(count),empty,dropHere(name),dropToRoot,moveToRoot,dragHandle,expand,collapse,cycle,moveFailed,createFailed,renameFailed,deleteFailed,loadFailed,missingDevice,folderMenu}`。缺 key 写到 `prompt-archives/2026082902-sidebar-devices-hierarchy/sub/frontend-folders-i18n-request.md`（key + zh/en/ja），代码照常 `t('key')`。
- 后端契约（后端代理并行实现中；你按此编码，最终由指挥官联调）：
  - `GET /api/device-folders` → `DeviceFolderLayout`；`POST /api/device-folders` `{name,parentId?}` → 201 `{folder}`；`PATCH /api/device-folders/:id` `{name?,parentId?,sortOrder?}` → `{folder}`（成环 400）；`DELETE /api/device-folders/:id` → `{success:true}`（子项上提到父级）；`PUT /api/device-folders/layout` `UpdateDeviceFolderLayoutRequest` → `DeviceFolderLayout`。
  - api-client（`@tmex/api-client`，后端代理新建 `packages/api-client/src/device-folders.ts`）：`deviceFoldersQueryKey = ['device-folders']`、`fetchDeviceFolderLayout(client)`、`createDeviceFolder(body, errorFallback?, client?)`、`updateDeviceFolder(id, body, errorFallback?, client?)`、`deleteDeviceFolder(id, errorFallback?, client?)`、`replaceDeviceFolderLayout(body, errorFallback?, client?)`。在它落地前 tsc 会报找不到导出，属预期；你的单测不要依赖真实 client（mock `@tmex/api-client` 或注入）。
  - 这些请求**只打 self 节点**：在 `DevicesPage` 顶层（self runtime，`useRuntime().apiClient`）发，不要在远端 `NodeRuntimeScope` 里发。`nodeId` 约定：self 为 `'self'`（`DEVICE_FOLDER_SELF_NODE_ID`），远端为 mesh node id（即 `NodeDeviceGroupEntry.runtimeNodeId`，它对 self 就是 `'self'`）。
- 另一位代理正在给 `@tmex/panels/device-management` 加这些 prop / 导出（名字已定，直接用）：
  - `DeviceManagementPanel` 新 prop：`nodeContext?: DeviceNodeContext`（`{ runtimeNodeId, name, isSelf }`）、`connection?: DeviceConnectionAdapter`、`excludeDeviceIds?: ReadonlySet<string>`、`renderCard?: (card, device, index) => ReactNode`、`hideEmptyState?: boolean`。
  - 新导出 `DeviceCardHost({ device, queryKey, nodeContext, connection?, style?, className? })`：单卡 + 自带编辑/删除对话框。
  - `DeviceNodeContext` 类型从 `@tmex/panels/device-management` 导出。
  - `connection` 从 `useGlobalDevice()`（`apps/fe/src/components/global-device-provider.tsx`）取；远端节点必须在该节点的 `NodeRuntimeScope` 内取（它内部挂了 `GlobalDeviceProvider`）。写一个小桥接组件放在 scope 里：`const { connection } = useGlobalDevice();` 再传给面板/卡片。

## 先读
`apps/fe/src/pages/DevicesPage.tsx`、`apps/fe/src/pages/devices/*`、`apps/fe/src/node/node-runtime-scope.tsx`、`apps/fe/src/node/mesh-nodes.ts`（`useSharedAuthMode`、`useMeshNodes`）、`packages/panels/src/device-management/device-management-panel.tsx`、`packages/panels/src/device-tree/device-tree-dnd.tsx`（dnd 传感器与 house style）、`packages/panels/src/device-tree/sidebar-device-list.tsx`（乐观重排 + 失败回滚模式）、`packages/ui/src/motion.tsx` + `packages/theme/src/motion.css`（`Reveal`/`Stagger`/`staggerItemStyle`/`--tmex-motion-*`、reduced-motion 规则）、`packages/ui/src/components/{collapsible,dropdown-menu,context-menu,input,alert-dialog,button}.tsx`（存在什么用什么）、`packages/stores/src/ui.ts`、`apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx`（无 DOM：`react-dom/server` 静态渲染 + `mock.module` 的测试写法）。

## 语义
- 树 = 文件夹（任意嵌套）+ 条目。条目两种：`node`（整个 mesh 节点分组，内含它未被单独放置的设备）与 `device`（单台设备，脱离节点分组单独放进文件夹）。
- 根层：`buildDeviceFolderTree(layout)` 的 `roots` 文件夹 + `rootItems`（显式排序的根条目）+ **隐式根条目**（没有 placement 的节点，按今天的顺序 self 在前、其余按名，追加在显式条目后）。standalone（`!meshEnabled`）只有一个隐式节点 self：根层不显示节点分组头，直接显示 self 的卡片网格（`DeviceManagementPanel` + `excludeDeviceIds`），被放进文件夹的 self 设备在文件夹里以 `DeviceCardHost` 渲染。
- mesh 下：`node` 条目 → 现有 `NodeDeviceGroup`（保留离线 / 未登录 / ready 三态与登录按钮），传 `excludeDeviceIds`（该节点被单独放置的设备）；`device` 条目 → `PlacedDevice`：在 `NodeRuntimeScope nodeId=runtimeNodeId` 内 `useQuery(devicesQueryKey, fetchDevices(runtime.apiClient))` 找到设备后渲染 `DeviceCardHost`；节点离线/未登录或设备已不存在 → 渲染灰色占位（`devices.folders.missingDevice`，含节点名、设备 id），占位也可拖回根层或删除 placement（`removeItemFromLayout`）。不要为不存在的设备自动改布局。
- 文件夹被删除 → 子文件夹与条目上提到父级（服务端做，前端乐观用 `reparentOnFolderDelete`）。
- 展开/收起状态：`useUIStore` 的 `deviceFolderExpanded`（持久化），缺省展开。

## 数据流（apps/fe/src/pages/devices/use-device-folders.ts）
- `useQuery({ queryKey: deviceFoldersQueryKey, queryFn: () => fetchDeviceFolderLayout(apiClient) })`（self runtime）。
- mutations：create / rename / delete / `replaceLayout`。移动与排序统一走 `replaceLayout`：用 shared 纯函数算出新 `layout`，`onMutate` 乐观写入 query cache，失败回滚 + `toast.error(t('devices.folders.moveFailed'))`，成功用响应覆盖。并发保护：上一次 replace 在飞时禁用拖拽（参考 `SortableVerticalList.disabled`）。
- 布局变化后不要重新触发首屏错落动画（参考面板里 `initialBatchRef` 做法）。

## 通用树 UI（packages/panels/src/device-folders/）
与 apps/fe 解耦：只知道 `DeviceFolderLayout`、条目 key 与一个 `renderItem(placementOrImplicitItem, ctx)` 回调，不 import apps/fe。建议模块：
- `folder-tree-model.ts`：从 layout + 隐式根条目列出每个容器（`root` / `folder:<id>`）的有序子元素 id（文件夹 `folder:<id>` 在前，条目 `deviceFolderItemKey` 在后）；`resolveDrop(active, over, layout, implicitItems)` → `{ kind:'folder'|'item', targetFolderId, index } | null`（放到文件夹头/空态上 = 追加到该文件夹末尾；放到某个兄弟上 = 插到兄弟所在容器的该位置；文件夹拖到自己或后代内 → null，并通过 `wouldCreateFolderCycle` 判定）。**这一层必须有单测**（纯函数）。
- `device-folder-tree.tsx`：`DndContext`（复用 `useDeviceTreeSensors` 的三套传感器，键盘用 `sortableKeyboardCoordinates`）+ 每个容器一个 `SortableContext`（`verticalListSortingStrategy`；根层条目网格也可以用 `rectSortingStrategy`）；`DragOverlay` 里渲染被拖元素的轻量预览（文件夹：图标+名+计数；条目：名称 chip）；`collisionDetection`：先 `pointerWithin` 命中文件夹头/空态，否则 `closestCenter`。拖拽中给命中的文件夹头加 `data-drop-target` 高亮（ring + 背景微变，`--tmex-motion-fast`）；拖过折叠的文件夹 600ms 自动展开。
- `folder-section.tsx`：一个文件夹 = 头部（拖把手 GripVertical、chevron 旋转、Folder/FolderOpen 图标、名称、`itemCount` 计数 chip、右侧 `MoreHorizontal` 菜单：新建子文件夹 / 重命名 / 移出到上一层（非根时）/ 删除）+ 内容区（`Collapsible`，grid 高度过渡 `grid-template-rows 0fr→1fr` 用 `--tmex-motion-standard`，`motion-reduce` 直接切换）。缩进：每层左侧 12px 竖向细线（`border-l border-border/50`）+ `pl-3`，最多显示 6 层缩进再封顶。空文件夹内容区显示虚线框「拖到这里放入此文件夹」，拖拽中变为实线高亮。内联重命名：双击名称或菜单「重命名」→ 就地 `Input`，Enter 保存 / Esc 取消 / blur 保存，`validateDeviceFolderName` 失败时红字提示（`nameRequired` / `nameTooLong`）。删除走 `AlertDialog` 确认（`deleteConfirmTitle`/`deleteConfirmDescription`），文案说明内容会上提。新建文件夹：在容器末尾插入一个处于编辑态的临时行，确认后才 `POST`，取消即消失。
- `draggable-item.tsx`：包住节点分组 / 设备卡片的 sortable 外壳，左上/左侧一个拖把手（`GripVertical`，`aria-label=devices.folders.dragHandle`，触摸下常显、桌面 hover 显现），`useSortable` 的 `transform/transition`，拖起时 `opacity-40`。
- 所有 `data-testid`：`device-folder-${id}`、`device-folder-toggle-${id}`、`device-folder-name-${id}`、`device-folder-menu-${id}`、`device-folder-rename-input`、`device-folder-new`（新建行输入）、`device-folder-drop-${id}`（空态/放置区）、`device-folder-item-${itemKey}`（拖拽外壳）、`devices-new-folder`（顶栏按钮）。
- 视觉方向：延续现有 shadcn/Base UI 的克制风格，但要有「文件管理器」的层次感——层级竖线、chevron、计数 chip、拖拽时的 ring 高亮与 overlay 轻微放大阴影（`scale-[1.02] shadow-lg`），入场用 `Reveal`/`Stagger`，**所有过渡用 `--tmex-motion-*` token 并尊重 `prefers-reduced-motion`**（`motion-reduce:*`）。不要引入新字体或新色板。
- 无障碍：文件夹头 `role=button aria-expanded`，拖把手有 `aria-label`，键盘可 Tab 到把手后用空格/方向键排序（dnd-kit 默认公告已可用）。

## 顶栏
`DevicesPage.PageActions`：在现有「+」左边加一个 `FolderPlus` 图标按钮（`data-testid=devices-new-folder`，title `devices.folders.newFolder`），点它在根层末尾插入编辑态新建行。顶栏与页面主体是两棵子树（见 `add-device-targets.ts` 的注释），照同样的模块级注册表模式做一个 `new-folder-request`（页面主体挂载时登记回调）。保持 `devices-add` 在单目标/standalone 下仍直接开设备对话框（e2e 依赖）。

## 测试
- `packages/panels/src/device-folders/*.test.ts(x)`：模型层纯函数（容器子元素排序、resolveDrop 各种落点、成环拒绝、隐式根条目）；组件层用 `react-dom/server` 静态渲染断言（重命名态、空文件夹提示、计数、缩进层级 data 属性）。
- `apps/fe/src/pages/devices/*.test.tsx`：树与节点分组/standalone 的映射（哪些设备被排除、隐式根条目顺序、PlacedDevice 找不到设备时的占位）——`mock.module` 掉 `@tmex/api-client` 与 runtime 相关模块，照 `sidebar-device-list.test.tsx` 的做法。
- `packages/stores/src/ui.test.ts`：`deviceFolderExpanded` 持久化/合并。
- 完成标准：`packages/panels` `bun test src/` 基线 389 pass；`apps/fe` `bun test src/` 基线 578 pass（另有我新加的 3 个）；`packages/stores` 275 pass（tsc 有 1 个既有错误 `src/host-services.test.ts:93`，不算你的）。各包 `bunx tsc --noEmit -p .`：除「`@tmex/api-client` 尚无 device-folders 导出」这类由并行代理补齐的错误外不得有新错误，并在报告里逐条列出剩余错误。改动文件跑 `bunx biome check --write`。

## 交付
报告写到 `prompt-archives/2026082902-sidebar-devices-hierarchy/sub/frontend-folders-result.md`（简体中文，简洁）：模块结构、拖拽落点规则、与后端/另一代理契约的接缝、测试数、tsc 剩余错误、未尽事项。
