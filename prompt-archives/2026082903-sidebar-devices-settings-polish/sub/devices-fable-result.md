# 设备管理页重做 —— 执行结果

分支 `chore/merge-hub-tabs`，worktree `/Users/konata/code/tmex-enhanced-wt-merge`。未执行任何改变 git 状态的命令，由 commander 提交。

## 一、五项需求的落地

### 1. 远端节点离线后卡片保留

- `NodeDeviceGroup`：`ready` 与 `offline` 共用同一棵 `NodeRuntimeScope` 子树，节点掉线只是把面板切到 `offline` 模式，不再卸载运行时（ready→offline 翻转卡片不消失）；`signedOut` 仍只给登录按钮、不建运行时。
- `DeviceManagementPanel` 新增 `offline` / `fallbackDevices` / `onDevicesLoaded`：离线时 `enabled: false` 不再拉列表，卡片来源优先级为 query 缓存 → 本地快照 → 节点 inventory；每次成功拿到列表都写快照。
- 新增 `apps/fe/src/pages/devices/device-snapshot-store.ts`：按 `tmex:device-snapshot:<runtimeNodeId>` 落 localStorage，只留渲染需要的字段（凭证字段不落盘），读取时逐条校验；`inventoryFallbackDevices()` 把 inventory 里的 `{id,name}` 映射成最小 `Device` DTO（实测 gateway 现在的 inventory 只有 `{version}`，所以主要靠本地快照）。
- `DeviceCard` 新增 `offline`：虚线边框 + 灰显 + `WifiOff`「节点离线」徽标（替代状态徽标），编辑 / 删除 / 测试连接菜单项禁用；`DeviceCardConnectToggle` 在离线时把残留的 `connected` 按 `disconnected` 展示（按钮文案「连接」），点击即发起一次手动连接，产生的 connecting / error / reconnecting 照常展示。

### 2. 连接按钮闪烁

- 新增 `PendingConnectionRequests`（`device-intent-store.ts`，按 storagePrefix 共享，同一 node 的多份 provider 看到同一份）：点击连接 / 断开时登记在飞请求；`deriveDeviceConnectionStatus` 有在飞请求时稳定返回 `connecting` / **新增的 `disconnecting`** 状态。
- `GlobalDeviceProvider` 的 `usePendingSettlement`：真实推导态到达目标（connect → connected/error/reconnecting；disconnect → disconnected）且 pending 已展示 ≥ 350ms 才摘掉；8s 仍未落定则放弃。两个方向都有稳定中间态，不会「连接 → 连接中 → 断开」一帧连跳。
- 按钮本身：`min-w-[5.5rem]` 固定最小宽度、pending 用 `Loader2` 转圈而不是换文案宽度；`disconnecting` 文案 `device.disconnecting`。
- 卡片 key 仍是 `device.id`，不再有 `renderCard` 外壳包装；`tmex-stagger` 只在首屏那批卡片上，`animationend` 计数（+1.5s 兜底）后摘掉类——之后的重排 / 状态更新 / DOM 移动不再重放入场动画。
- `useDeviceStatusSlices` 改为 `useMemo` 返回稳定对象，避免 adapter 每次渲染换引用。

### 3. 文件夹 → 一层「分组」，设备绑定节点

- 数据模型（`packages/shared/src/contracts/device-folders.ts`）：`DeviceFolder` 去掉 `parentId`；`DeviceFolderPlacement` 只剩 `{ nodeId, folderId, sortOrder }`；`CreateDeviceFolderRequest` / `UpdateDeviceFolderRequest` 去掉 `parentId`；layout 请求的 folders 只有 `{ id, sortOrder }`。
- 共享校验（`device-folders.ts`）：`isFolderListValid`（id 唯一）、`isDeviceFolderLayoutValid`（节点唯一、folderId 存在、sortOrder 整数）、`moveFolderInLayout(layout, folderId, index)`（只在根层重排）、`moveNodeInLayout` / `removeNodeFromLayout` / `findNodeFolderId` / `countFolderItems`；删除了 `wouldCreateFolderCycle` / `folderDescendantIds` / `isFolderForestValid` / `buildDeviceFolderTree` / `deviceFolderItemKey` 等嵌套与设备 placement 相关代码（`packages/shared/src/index.test.ts` 导出快照同步更新）。
- Gateway：
  - 路由：POST / PATCH 带非 null `parentId` 一律 400 `folderLayoutInvalid`；layout PUT 拒绝嵌套分组、`kind` 非 `node`、带 `deviceId` 的 placement、未知 folderId、重复 nodeId；兼容旧客户端的 `{kind:'node', deviceId:null}` 形态。
  - DB helper：`replaceDeviceFolderLayout` 自带 id 集合一致性 + `isDeviceFolderLayoutValid` 防御（绕过 HTTP 直接调用会抛错）；读取时忽略库里残留的嵌套分组与设备 placement；新增 `resetDeviceFolderLayout()` 一个事务清空。
  - 迁移 `apps/gateway/drizzle/0025_flat_device_groups.sql`：`parent_id` 置空、删除非 node / 带 device_id 的 placement；journal、`0025_snapshot.json`、`managed-migrations.ts` 同步。
- 前端 DnD（`packages/panels/src/device-folders/**` 全部重写）：元素只有 `folder:<id>` 与 `node:<id>`；分组只能在根层彼此重排（落到节点 / 分组内容区上一律无效）；节点只能在根层与分组之间移动；设备完全不是列表条目，DnD 不提供任何设备落点。移除「新建子分组」「上移一层」、成环提示与深度缩进。
- 设备在节点内排序：`DeviceManagementPanel` 内置独立 `DndContext` + `rectSortingStrategy` 网格，把手 `dragHandle` 注入卡片第一行最左，落点后 `PUT /api/devices/order`（乐观更新 + 失败回滚 + `device.reorderFailed`）；离线 / 在飞 / 少于两台时禁用。
- 把手位置：树把 `dragControls`（把手 + 分组内的「移出分组」按钮）通过 `renderNode(nodeId, ctx)` 交给宿主，`NodeDeviceGroup` 放进分组头最左，分组头是被拖动的单元。standalone 下根层的 self 不套把手；进了分组的节点即使 standalone 也渲染分组头（把手在头上）。
- 视觉：每个分组是 `border-2 border-dashed` 的放置区，命中时实线高亮；空分组内是虚线「把节点拖到这里放入此分组」；拖动分组内节点时列表末尾出现虚线「移到最外层」落点条（`device-folder-drop-root`）。
- 文案：`devices.folders.*` 全部改成「分组 / Group / グループ」，`apiError.folder*` 同步；删除已无用的 `newSubfolder` / `cycle` / `missingDevice` / `folderCycle` / `devices.nodes.lastKnownDevices`；新增 `resetLayout` / `resetConfirmTitle` / `resetConfirmDescription` / `resetFailed` / `resetDone`、`devices.nodes.offlineSnapshot` / `deviceOffline`。
- 恢复默认布局：`POST /api/device-folders/reset`（路由 + db helper 一个事务 + 广播 `device-folders`）、api-client `resetDeviceFolderLayout()`、`use-device-folders` 的 `resetLayout` mutation（乐观置空 + 回滚 + toast）；顶栏新增 `RotateCcw` 图标按钮（`devices-reset-layout`，在新建分组按钮左侧），点开 `@tmex/ui/alert-dialog` 确认对话框（`devices-reset-layout-confirm`）。顶栏命令经新的 `page-commands.ts` 注册表递上去（替代 `new-folder-request.ts`）。

### 4. 宽度不稳定

- `DevicesPage` 新增 `DevicesPageContainer`：`mx-auto w-full max-w-6xl xl:max-w-7xl px-4 sm:px-6 py-3 sm:py-5`，loading 与就绪态共用（测试断言两态容器标签完全一致）。
- `DeviceFoldersView` 与 `DeviceManagementPanel` 都只剩 `w-full`，不再各自套 max-width / padding；`NodeDevicePanel` 不再需要 `max-w-none p-0` 覆盖。
- 分组内容不再 `ml-3 pl-3` 缩进，只有虚线框内 `px-2`；条目外壳不再 `pl-5`（把手进了分组头）。
- 网格 `grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4`。
- 实测（worktree 起 dev server 19663/19883，Playwright 截图 375 / 768 / 1280 / 1920，之后已 kill 该 dev 进程）：容器宽度分别为 359 / 408 / 920 / 1280px（1920 命中 `max-w-7xl`；768 的窄是外壳侧栏占 336px，非本页问题），未出现横向滚动；截图在 scratchpad `shots/`。

### 5. 文案

- `device.kind.nodeLocal` → 「远程本地设备 / Remote local device / リモートローカルデバイス」，`nodeSsh` → 「远程 SSH 设备 / Remote SSH device / リモート SSH デバイス」；`deviceKindLabel(t, kind)` 不再接节点名；设备对话框标题 chip 改为直接显示节点名（没有名字时退回种类文案）。

## 二、文件清单

- shared：`contracts/device-folders.ts`、`device-folders.ts`（+test）、`index.test.ts`（导出快照）、`i18n/locales/{zh_CN,en_US,ja_JP}.json`（`devices.*` / `device.*` / `apiError.folder*`），`resources.ts` / `types.ts` 由 `bun run build:i18n` 重新生成。
- api-client：`device-folders.ts`（reset + 文案）。
- gateway：`api/device-folder-routes.ts`（+test）、`db/device-folders.ts`（+test）、`db/index.ts`、`db/managed-migrations.ts`、`drizzle/0025_flat_device_groups.sql`、`drizzle/meta/_journal.json`、`drizzle/meta/0025_snapshot.json`。
- panels：`device-connection.ts`（union 加 `disconnecting`）、`device-folders/*`（model / tree / section / draggable-item / index + 两个测试）、`device-management/{device-management-panel,device-card,device-card-host,device-card-connect-toggle,device-node-context,device-dialog}.tsx` 及对应测试。
- fe：`pages/DevicesPage.tsx`（+test）、`pages/devices/{device-folders-view,node-device-group,use-device-folders}`、新增 `device-snapshot-store.ts`（+test）、`page-commands.ts`（+test）；删除 `placed-device.tsx`（+test）、`device-name-cache.ts`、`new-folder-request.ts`；`components/{device-connection-status,device-intent-store,global-device-provider}` 及测试。

范围外但必须动的两处：`packages/panels/src/device-connection.ts`（状态 union 加一项，`device-tree` 里的消费方都有 default 分支，未改动）、`packages/shared/src/index.test.ts`（运行时导出快照）。

## 三、验证数据

| 包 | bun test | tsc |
|---|---|---|
| packages/shared | 358 pass / 0 fail（基线 358） | 0 |
| packages/panels | 464 pass / 0 fail（基线 458） | 0 |
| packages/api-client | 130 pass / 0 fail | 5（均在未改动的 `client.test.ts` / `files-download.test.ts` / `host-services.test.ts`，既有） |
| packages/stores | 282 pass / 0 fail | 1（既有） |
| apps/gateway | 2479 pass / 0 fail（基线 2473 / 0，tsc 基线 21） | 21（与基线相同，均在未改动文件） |
| apps/fe（`bun test src/`） | 621 pass / 0 fail（基线 602） | 0 |

改动的源文件均已 `bunx biome check --write`；生成文件未 lint。

## 四、设计取舍与说明

- 离线节点**保持运行时挂载**（含冷启动就离线的节点）：这是让「离线卡片 + 手动连接尝试」成立的最小方案；代价是该 node 的 `GlobalDeviceProvider` 会尝试拉一次 `/api/devices`（`retry: 1`）并起直连控制器，均有退避，不会自动连设备。
- 「断开中」是新引入的展示态：点断开后按钮先停在「断开中…」≥350ms 再变「连接」，`global-device-provider-shared-intent.test.tsx` 的断言据此更新。
- placement 的 DB 列（`kind` / `device_id`）与 `device_folders.parent_id` 保留不改 schema，只靠迁移清数据 + helper 读时过滤 + 写时校验；`removeDeviceFolderPlacementsForDevice` 保留为删设备时的旧数据兜底（`db/devices.ts` 不在本次范围）。
- `folder.parentId` 从 DTO 里彻底移除而不是「恒为 null」：类型上就不可能嵌套，路由对带 `parentId` 的请求返回 `folderLayoutInvalid`。
- 未做：e2e（Playwright specs）未运行，仓库里也没有引用旧 testid 的 e2e 文件；离线态未做真机截图（standalone 无法模拟 mesh 掉线），逻辑由单测覆盖。
