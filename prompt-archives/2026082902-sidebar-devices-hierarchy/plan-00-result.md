# Plan 00 执行结果：设备管理页（任务 2）

分支 `chore/merge-hub-tabs`，worktree `tmex-enhanced-wt-merge`。侧栏（任务 1）与 tab i18n（任务 3）已在 `211263ec` 落地；本文只记设备管理页五项。

## 提交
| commit | 内容 |
|---|---|
| `acc695b9` | A：修「+」崩溃；shared 设备文件夹契约 + 树纯逻辑；三语 i18n key |
| `a8bd3350` | B 后端：schema/0024 迁移/DB helper/REST/api-client/settings 命名空间 |
| `289b421d` | C/D/E：卡片真实种类、连接-断开开关、去重副标题、按种类编辑对话框、DeviceCardHost |
| `88608b17` | review 修复：SSH `authMode=auto` 保留语义 + 下拉「自动」项；删设备与 placement 同事务并广播 |
| `a59595fa` | B 前端：文件夹树 UI、拖拽、乐观更新、展开态持久化、顶栏新建文件夹 |
| （末批） | 拖把手 gutter 修正、实测截图、本文 |

## A. 「+」崩溃根因
mesh 下 ≥2 个 ready 节点时顶栏渲染 `AddDeviceMenu`，其 `DropdownMenuLabel`（Base UI `Menu.GroupLabel`）没有包在 `DropdownMenuGroup` 里，Base UI 渲染期抛 `MenuGroupRootContext is missing`（生产包表现为 `Base UI error #31`，被 React Router 的 ErrorBoundary 接住 → 整页 "Unexpected Application Error"）。用 Playwright 在源码起的 hub+node 环境复现（`sub/shots/a-mesh-after-click.png`）。修法：内容抽成 `AddDeviceMenuList` 并套 `DropdownMenuGroup`；回归测试 `add-device-menu.test.tsx` 对元素树断言 Label 的祖先含 Group，并用 SSR 证明裸 Label 会抛。standalone 单目标路径本来就正常。

## B. 文件夹层级
### 数据模型（entry/self 节点自己的库）
- `device_folders(id, name, parent_id, sort_order, created_at, updated_at)`，`parent_id` 自引用不加 FK（删除时手动上提）。
- `device_folder_placements(item_key PK, kind∈{node,device}, node_id, device_id, folder_id→device_folders cascade, sort_order, …)`；`item_key` = `node:<nodeId>` / `device:<nodeId>:<deviceId>`；self 节点 `nodeId='self'`，远端用 mesh node id；`folder_id=null` 表示根层显式排序，无 placement 的条目为隐式根条目。
- 迁移 `apps/gateway/drizzle/0024_narrow_tomas.sql`（已进 `managed-migrations.ts`）。
### REST（`/api/device-folders`）
`GET` → `DeviceFolderLayout`；`POST {name,parentId?}` → 201；`PATCH /:id {name?,parentId?,sortOrder?}`（成环 400 `apiError.folderCycle`）；`DELETE /:id`（子文件夹与条目上提到父级）；`PUT /layout`（整表替换：文件夹 id 集合必须与库一致、森林无环、placement 字段与 itemKey 唯一性校验）。写操作广播 `settings-update device-folders`，前端映射到 `['device-folders']` 失效。删设备与清理其 `device:self:<id>` placement 同一事务。
### 共享纯逻辑（`packages/shared/src/device-folders.ts`）
名称校验（trim、折叠空白、≤64 字符）、`wouldCreateFolderCycle`、`isFolderForestValid`、`moveFolderInLayout`/`moveItemInLayout`/`removeItemFromLayout`、`reparentOnFolderDelete`、`normalizeFolderLayoutOrder`、`buildDeviceFolderTree`。gateway 校验与前端乐观更新共用同一份。
### 前端
- `packages/panels/src/device-folders/`：通用树（`DeviceFolderTree`）、`FolderSection`（chevron、计数 chip、菜单：新建子文件夹/重命名/移出到上一层/删除；`grid-template-rows` 过渡，收起后卸载内容释放落点与远端 runtime）、`DeviceFolderItemShell`（拖把手 + 移出文件夹）、`FolderNameEditor`（Enter/Esc/blur；从菜单进入时抵抗菜单关闭的焦点回弹）、`folder-tree-model.ts`（容器子元素、`resolveDrop` 落点规则、根层显式化）。
- 拖拽：`@dnd-kit` 三套传感器复用侧栏的 `useDeviceTreeSensors`；碰撞两段式（先 `pointerWithin` 命中文件夹头/空态落点，否则 `closestCenter`）；悬停折叠文件夹 600ms 自动展开；`DragOverlay` 预览；成环拖放弹 `devices.folders.cycle`。
- `apps/fe/src/pages/devices/`：`use-device-folders.ts`（self runtime 上的 query + create/rename/delete/replaceLayout；乐观整表替换，布局未就绪或上一份在飞时拒绝提交，失败回滚/重拉）、`device-folders-view.tsx`（节点条目 → `NodeDeviceGroup(excludeDeviceIds)`，设备条目 → `PlacedDevice` 在该节点 `NodeRuntimeScope` 内取列表与连接适配器渲染 `DeviceCardHost`，节点不可用/设备已删显示占位且不改布局）、`new-folder-request.ts`（顶栏 `FolderPlus` 按钮的注册表）。standalone 下根层直接是 self 卡片网格。
- 展开态：`useUIStore.deviceFolderExpanded` 持久化，缺省展开。
### 取舍
- 根层一旦手动排序会把所有隐式节点条目写成显式 placement；之后新加入的节点排在其后。
- mesh 列表里消失的节点的 placement 不渲染、不自动清理（计数仍包含），需用户手动移除。
- 远端节点上删除设备时 entry 侧的 placement 不会同步清理（跨库），在文件夹里显示为占位，可手动移出。

## C/D/E. 卡片与对话框
- `DeviceNodeContext {runtimeNodeId,name,isSelf}` 由宿主（`node-device-group.tsx` 在 scope 内桥接）传入；种类 = `deviceDisplayKind(type, ctx)`：本地设备 / SSH 设备 / 节点 X 上的本机设备 / 节点 X 上的 SSH 设备（`device.kind.*`）。副标题只对 SSH 显示 `user@host:port`，种类 pill 只出现一次。
- 连接按钮真实化：`connection.status(id)` 驱动「连接 / 连接中(禁用) / 断开」，内嵌与侧栏同源的状态圆点；另设「打开」图标按钮跳设备页（`device-card-open-<id>`，e2e 选择器已跟改）。`connect()` 会清掉持久化的断开意图。
- 编辑对话框按种类分区：SSH 才有连接/认证区；远端节点编辑态多一块只读归属信息（节点名/节点 id/设备 id）+「显示在侧栏」开关；类型创建后不可改；远端目标新建默认 local 并显示节点 chip。SSH 历史记录 `authMode=auto` 原样保留并在下拉提供「自动（Agent → 已保存私钥 → 密码）」项（review 指出 auto 与 agent 语义不同，不能有损归一）。

## 测试
| 包 | 结果（基线） | tsc |
|---|---|---|
| `apps/gateway` | 2466 pass / 0 fail（2448） | 21 个既有错误，未增加 |
| `packages/shared` | 372 pass（新增 14 + 导出面快照更新） | 0 |
| `packages/panels` | 458 pass / 0 fail（389） | 0 |
| `apps/fe` | 602 pass / 0 fail（578） | 0 |
| `packages/stores` | 277 pass / 0 fail（275） | 1 个既有错误 |

## 实测（Playwright，截图在 `sub/shots/`）
- standalone dev 实例（19663/19883）：「+」直接开对话框无报错；新建「运维」→ 菜单新建子文件夹「数据库」→ 拖本机设备进「运维」→ 重命名「运维组」→ 刷新后仍在 → 删除「运维组」后「数据库」上提到根、设备 placement 回到根层；卡片「断开」→ 侧栏状态点变 `disconnected`，再「连接」变回；本机设备编辑对话框无 host 字段（`b-*.png`、`c-*.png`、`e-*.png`）。
- 源码起的 hub+node mesh：「+」弹出两节点菜单、选远端开对话框且带节点 chip；远端卡片种类「Local device on node mesh-node-b」；远端编辑对话框含归属信息块与侧栏开关；远端卡片连接开关 disconnected→connected；把远端节点整组拖进文件夹并持久化（`m-*.png`）。
- 两套实例均由本会话启动并已停止；未触碰生产 tmex 与 `tmex` tmux session。

## 审查
codex（gpt-5.6-sol）两轮：`sub/review-2-result.md`（auto/agent 语义、删设备事务、远端 nodeContext/connection 接线）与 `sub/review-3-result.md`（布局未就绪写回、并发整表替换、折叠内容常驻）全部已修。
