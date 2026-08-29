# 任务 B（前端）执行结果：设备管理页文件夹层级

## 模块结构

### `packages/panels/src/device-folders/`（通用树 UI，与 apps/fe 解耦）

| 文件 | 职责 |
| --- | --- |
| `folder-tree-model.ts` | 纯逻辑：元素 / 容器 / 放置区的 id 编解码、`listContainers`、`implicitRootItems`、`resolveDropTarget` / `resolveDrop`、`materializeRootItems`、`applyDrop`、`placedDeviceIds`。布局本身的重排全部转调 `@tmex/shared`（`moveFolderInLayout` / `moveItemInLayout` / `wouldCreateFolderCycle` / `normalizeFolderLayoutOrder`），没有第二份树逻辑。 |
| `device-folder-tree.tsx` | `DndContext`（复用 `useDeviceTreeSensors` 的鼠标 / 触摸 / 键盘三套传感器）+ 每个容器两个 `SortableContext`（文件夹一组、条目一组）+ `DragOverlay` 预览 + 新建 / 重命名 / 删除确认的状态机。对外只暴露 `layout`、`implicitRootItems`、`renderItem`、`itemLabel`、`itemDraggable` 与一组回调，不 import apps/fe。 |
| `folder-section.tsx` | 单个文件夹：拖把手 + chevron + Folder/FolderOpen + 名称 + 计数 chip + `MoreHorizontal` 菜单（新建子文件夹 / 重命名 / 移出到上一层 / 删除），内容区 `grid-template-rows: 0fr→1fr` 过渡；另导出 `FolderDropArea`（空文件夹 / 根层落点条）。 |
| `draggable-item.tsx` | `DeviceFolderItemShell`：条目外壳，`sortable`（在容器有序列表里）与 `draggable`（还在节点分组卡片网格里的设备卡）两种形态，左侧悬浮把手 + 「移出文件夹」按钮。 |
| `folder-name-editor.tsx` | 新建行与重命名共用的就地输入：Enter 保存 / Esc 取消 / blur 保存（内容为空的 blur 视为放弃），`validateDeviceFolderName` 失败时红字提示。 |
| `index.ts` | 包出口；`packages/panels/package.json` 的 `exports` 加了 `./device-folders`。 |

### `apps/fe/src/pages/devices/`

| 文件 | 职责 |
| --- | --- |
| `use-device-folders.ts` | 数据层：`useQuery(deviceFoldersQueryKey)` + create / rename / delete / `replaceLayout` 四个 mutation。移动与排序统一走 `replaceLayout`（乐观写 cache，失败整份回滚 + `toast.error(devices.folders.moveFailed)`，成功用响应覆盖）；删除乐观用 `reparentOnFolderDelete`。全部用 `useRuntime().apiClient`，只打 self 节点。 |
| `device-folders-view.tsx` | 页面主体：条目 → 节点分组 / 单卡的映射，`nodeItemCandidates`、`excludeDeviceIds`、`renderCard` 外壳、`itemLabel`、`itemDraggable`，以及 `registerNewFolderRequest`。 |
| `placed-device.tsx` | `PlacedDevice`：ready 的节点才进 `NodeRuntimeScope`，scope 内自取设备列表并交给 `DeviceCardHost`；`resolvePlacedDevice` 是可测的纯函数，`MissingDeviceCard` 是灰色占位。 |
| `new-folder-request.ts` | 顶栏「新建文件夹」的模块级注册表（与 `add-device-targets` 同一套路）。 |
| `device-name-cache.ts` | 拖拽预览用的设备名缓存（渲染过卡片的地方记一笔，取不到退回设备 id，绝不为此发请求）。 |
| `node-device-group.tsx` | 加 `excludeDeviceIds` / `renderCard` / `showHeader`；面板改经 `NodeDevicePanel` 桥接组件挂在 scope 内，从 `useGlobalDevice()` 取 `connection`，并传 `nodeContext`、`hideEmptyState`。 |

`packages/stores/src/ui.ts`：新增 `deviceFolderExpanded: Record<string, boolean>` + `setDeviceFolderExpanded`，进 `partialize`，`merge` 里走 `normalizeBooleanMap`（缺键 = 展开）。

`apps/fe/src/pages/DevicesPage.tsx`：主体统一走 `DeviceFoldersView`；standalone 与「mesh 列表还没回来」都退化成一个合成的 self 分组（`showNodeHeaders=false`，根层直接是卡片网格）。`PageActions` 在「+」左边加 `FolderPlus`（`data-testid=devices-new-folder`），注册表为空时不显示；`devices-add` 的单目标 / standalone 行为原样保留。

## 拖拽落点规则

- 元素 id：文件夹 `folder:<id>`，条目 `deviceFolderItemKey()`（`node:<nodeId>` / `device:<nodeId>:<deviceId>`）；放置区 `drop:<container>`（文件夹头、根层落点条）与 `dropin:<container>`（空文件夹内容区，droppable id 必须全局唯一，所以同一容器给了两个 id）。
- 碰撞检测两段式：先 `pointerWithin` 只跑放置区，命中就用它；否则 `closestCenter` 跑其余元素。混在一次里排序会让「拖到文件夹头上」时不时落成「插到该文件夹第一个孩子前面」。
- 落点解析（`resolveDropTarget`）：
  - 落在放置区 → 该容器末尾（`index=null`）；
  - 落在同类兄弟上 → 插到该兄弟在其容器同类列表里的下标（同容器内上下移动都直接用这个下标，`moveXInLayout` 先摘再插的语义正好对上）；
  - 条目落在文件夹行上 → 放进那个文件夹的末尾；
  - 文件夹落在条目上 → 追加到该容器的文件夹列表末尾；
  - 不认识的 id / 目标容器不存在 → null。
- 成环单独判定：`resolveDrop` 在 `resolveDropTarget` 之上加 `wouldCreateFolderCycle`，返回 null；UI 据此弹 `devices.folders.cycle`（区别于「无效落点」的静默忽略）。
- 根层排序会先 `materializeRootItems`：隐式条目全部落成显式 placement，否则「显式在前、隐式在后」会把刚拖动的条目弹回队首。
- 交互细节：拖过折叠文件夹停留 600ms 自动展开；`measuring.droppable = Always`（拖拽中容器高度会变，必须持续重测）；命中的文件夹头 `data-drop-target` + ring 高亮；`DragOverlay` 轻微放大 + 阴影；上一次 `replaceLayout` 在飞时整棵树 `disabled`。

## 与后端 / 另一代理的接缝

- REST 与 client 封装（`packages/api-client/src/device-folders.ts`）已由后端代理落地，签名与约定一致：`deviceFoldersQueryKey`、`fetchDeviceFolderLayout`、`createDeviceFolder`、`updateDeviceFolder`、`deleteDeviceFolder`、`replaceDeviceFolderLayout`。`toLayoutRequest()` 负责把本地 `DeviceFolderLayout` 削成 `UpdateDeviceFolderLayoutRequest`。
- `@tmex/panels/device-management` 的新接口（`nodeContext` / `connection` / `excludeDeviceIds` / `renderCard` / `hideEmptyState` / `DeviceCardHost` / `DeviceNodeContext`）也已落地，本任务按名直接消费，无编译缺口。
- `connection` 一律在该 node 的 `NodeRuntimeScope` 内取：分组走 `NodeDevicePanel`，单卡走 `PlacedDeviceBody`。
- i18n：`devices.folders.*` 三语齐全（含 `dropHere`，用作命中态的空文件夹文案），**没有缺 key**，未创建 `frontend-folders-i18n-request.md`。

## 测试

| 包 | 结果 | 本任务新增 |
| --- | --- | --- |
| `packages/panels`（`bun test src/`） | 458 pass / 0 fail | 33（`folder-tree-model.test.ts` 20 + `device-folder-tree.test.tsx` 13） |
| `apps/fe`（`bun test src/`） | 602 pass / 0 fail | 20（`device-folders-view.test.tsx` 8 + `placed-device.test.tsx` 12） |
| `packages/stores`（`bun test`） | 277 pass / 0 fail | 2（`ui.test.ts` 持久化 / 归一化） |

覆盖点：容器子元素排序与隐式根条目、`resolveDrop` 的各类落点与成环拒绝、根层显式化后的顺序、`applyDrop` 的非法落点；静态渲染的层级 / 缩进 `data-depth` / 计数 / 空文件夹提示 / 重命名态 / 命中高亮 / 折叠态 a11y；fe 侧的节点↔条目映射、`excludeDeviceIds` 透传、占位（节点不可用 / 设备已删）且不改布局、mesh 列表里消失的节点不渲染、standalone 根层不套把手。

`apps/fe/src/pages/DevicesPage.test.tsx` 同步更新（它是本任务改写的 `DevicesPage.tsx` 的测试）：面板 mock 补 `DeviceCardHost`、mock 掉 `./devices/use-device-folders`、补 `RuntimeProvider`（页面顶层现在要读共享 UI store），断言从 `devices-node-groups` 改为 `devices-folders-view` / 分组头。

## tsc 剩余错误

- `packages/panels`：0
- `apps/fe`：0
- `packages/stores`：1，且是既有错误 —— `src/host-services.test.ts(93,23): error TS2339: Property 'value' does not exist on type '{ remove: Mock<...>; select: Mock<...> }'`（与本任务无关）

`bunx biome check --write` 已对全部改动文件跑过，无剩余告警。

## 未尽事项 / 已知取舍

1. **根层显式化的副作用**：任何一次根层排序都会把当时所有隐式节点条目写成 placement。之后新加入 mesh 的节点仍是隐式条目，排在已显式条目之后（不是按名插进去）。
2. **`node` placement 指向未知节点**：mesh 列表里没有的 nodeId 不渲染任何东西，也不动布局（节点可能只是被临时移出列表）。UI 上表现为「文件夹里少一项但计数还算它」，需要用户手动删除或等节点回来。
3. **折叠的文件夹内容仍然挂载**（用 `visibility` + `grid-template-rows` 过渡）：里面的 `PlacedDevice` 会照常建该节点的运行时。同一节点的运行时是引用计数共享的，多数情况下与根层分组复用同一份连接，但「只在折叠文件夹里出现的远端节点」会被提前连上。
4. **拖拽预览的设备名**依赖 `device-name-cache`：卡片渲染过才有名字，冷启动后直接拖一台从未渲染过的设备（理论上不会发生，卡片必须先渲染才拖得动）会退回显示设备 id。
5. **未做真实浏览器实测**：本任务只跑了单测与静态渲染断言，拖拽手感、自动展开时机、`DragOverlay` 视觉需要在联调时用真实实例验证。
