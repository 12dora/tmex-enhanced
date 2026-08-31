# O2 结果：多 node 文件侧栏 + 根目录/分节拖拽排序

工作目录：`/Users/konata/code/tmex-enhanced-wt-r9`（分支 `feat/round9-relay-files-perf`）。未执行任何写入型 git 命令。

## 做了什么

### 1. api-client：`reorderFileRoots`
- `packages/api-client/src/file-resources.ts`：新增 `reorderFileRoots(rootIds, client)` → `PUT /api/files/roots/order`，请求体 `{ rootIds }`，返回 `ListFileRootsResponse`（`{ roots }`），非 2xx 走 `parseError` 抛 `FileApiError`。与 G1 已落地的网关实现（`apps/gateway/src/api/file-root-routes.ts`）逐字对齐（已核对：路径、body、200 载荷、400 分支一致）。
- `packages/api-client/src/files.ts`：门面补一行 re-export（`index.ts` 是 `export * from './files'`，不改 index）。
- 新增 `packages/api-client/src/file-resources.test.ts`（2 个用例）。

### 2. panels：文件侧栏拆成「外壳 + 分节 + 文件树」
- `packages/panels/src/files/files-tab.tsx` 收缩为**外壳**：标题 + 刷新 + `ScrollArea` + 外部文件拖入兜底。新增两个 prop：
  - `sections?: ReactNode`：多 node 宿主传进来的各 node 分节；未传即渲染当前运行时的单节文件树（旧行为不变）。
  - `onRefresh?: () => void`：聚合视图下每个 node 一份 QueryClient，只能由宿主逐个失效；未传即失效当前 QueryClient。
  - `hideHeader` / `nodeOffline` 语义与 testid（`files-tab` / `files-node-offline` / `files-refresh`）原样保留。
- 新增 `packages/panels/src/files/files-node-roots.tsx`：把原 `FilesTabInner` 的四个查询、`selectVisibleFileRoots` 过滤、`pruneStaleRoots`、`DirNode` / `FileLeaf` / `useSelectedFilePath` / `DISPLAY_CAP` 全量搬过来（逻辑逐行未变，含 500 行上限与「选中项撑上限」）。额外接上根目录拖拽排序。
- 新增 `packages/panels/src/files/files-node-section.tsx`：`FilesNodeSection`（+ `FilesNodeInfo` / `FilesNodeSortable` 类型）。分节头用现成的 `NodeBadge variant="plain"`（含在线/离线状态点、灰显），可折叠（折叠即卸载文件树，连带停掉该 node 的 files 查询），头右侧带 grip 拖拽手柄；在线已登录时头上还有该 node 自己的 `useIsFetching` 转圈。三种形态：
  - 在线已登录 → `FilesNodeRoots`（宿主已把它包在该 node 的 `NodeRuntimeScope` 里）；
  - 在线未登录 → `files.nodeSignInHint` 一行 + 宿主经 `renderLogin` 注入的登录入口（不发任何请求）；
  - 离线 → `files.nodeOffline` 一行。
- `packages/panels/src/files/directory-node-view.tsx`：新增可选 `drag?: DirectoryDragHandle`。手柄是**独立的 grip 按钮**，绝对定位在整节左侧 `pl-3.5` 落槽里——不是整行兼任手柄：整行兼任会让 KeyboardSensor 吞掉 Enter/Space，根目录再也展不开；放进缩进链则根行会比自己的子目录还靠右。
- 新增 `packages/panels/src/files/root-reorder.ts`：`nextFileRootOrder()` 把「可见列表的新顺序」合并回完整顺序（复用设备树的 `mergeReorderedVisibleIds`，隐藏的根原地不动），并把 `reorderDevicesOptimistically` 以 `reorderFileRootsOptimistically` 之名复用做乐观更新。失败回滚 + `toast.error(files.reorderFailed)`（panels 里 sonner 本来就在用），`onSettled` 统一 invalidate 收口；重排在飞时 `SortableVerticalList disabled`。
- `packages/panels/src/files/index.ts`：导出 `FilesNodeSection` 及其类型。

### 3. apps/fe：`app-sidebar.tsx`
- files 标签不再套路由 node 的 `NodeRuntimeScope`，改走新的 `SidebarFilesTab`：
  - **非 mesh**：与今天完全一致（`NodeRuntimeScope(routeNodeId)` + `FilesTab nodeOffline`），无分节头、无视觉回归；
  - **mesh**：`MeshFilesTab` 用 `useMeshNodes({ enabled: false })` + `toSidebarEntries(nodes, entryNodeId, sidebarNodeOrder)`（直接复用 `sidebar-device-list.tsx` 已导出的映射与排序），每个 node 一个 `SortableFilesNodeSection`；在线且已登录的才套 `NodeRuntimeScope`（离线/未登录不建连接、不发请求）。
  - 分节顺序拖拽复用 `SortableVerticalList` + `sidebarNodeSortableId`，落 `setSidebarNodeOrder`（**与终端侧栏共用同一份顺序**，按需求刻意为之）。
  - 刷新按钮在 mesh 下逐个 `nodeQueryClient(runtimeNodeId).invalidateQueries(['files'])`。
  - files 的 `Reveal key` 从 `files:${routeNodeId}` 改为 `files`：聚合视图与路由 node 无关，切 node 不再整块重挂。agent 标签的 `key`/行为保持原样。
  - 未登录 node 的登录入口用现成的 `NodeLoginButton`（点了才用内存会话钥登录，不自动发请求）。

### 4. i18n（三语同步 + `bun run build:i18n`）
`files.nodeSignInHint` / `files.reorderFailed` / `files.rootDragHandle`：
- zh：登录后显示文件 / 目录排序保存失败 / 拖动以调整目录顺序
- en：Sign in to show files / Failed to save folder order / Drag to reorder folders
- ja：ログインするとファイルを表示します / フォルダーの並び順を保存できませんでした / ドラッグしてフォルダーの順序を変更

分节头的手柄 aria-label 复用已有的 `sidebar.node.dragHandle`，不新增键。

## 测试 / 类型 / lint（before → after）

| 目标 | before | after |
|---|---|---|
| `packages/panels` `bun test` | 650 pass / 0 fail | **668 pass / 0 fail**（其中我新增 9：`root-reorder.test.ts` 4、`files-node-section.test.tsx` 4、`files-tab.test.tsx` +1；其余为并发 agent 新增） |
| `packages/panels` tsc | 0 | **0** |
| `apps/fe` `bun test src/` | 1069 pass / 1 fail（O1 在改的 `device-node-badges.test.tsx`） | **1079 pass / 0 fail** |
| `apps/fe` tsc | 1（同上，O1 的文件） | **0** |
| `packages/api-client` `bun test` | 132 pass / 0 fail | **134 pass / 0 fail** |
| `packages/api-client` tsc | 5（既有） | **5**（同一批既有错误，未新增） |

- `bunx biome check`（我改动的全部文件）：clean。
- `bun scripts/complexity/gate.ts`：我的文件零违规（剩余 8 条全在 gateway / device-console / terminal-ui / stores，属并发 agent 的在改文件）。
- 生成文件只经 `bun run build:i18n` 重建，未手工 lint/format。

## 决策与取舍（需要 commander 知情）

1. **分节不做「空则隐藏」**。终端侧栏会把「一台可见设备都没有」的 node 整节藏掉；文件这边我保留了所有 node 的分节（空的显示一行 `files.noRoots`）。原因：藏节需要把「有没有可见根」从运行时作用域内提上来控制分节头，会把 header 的所有权从分节挪到宿主，得不偿失；而根目录默认可见，实际上有配目录的 node 都会有内容。若需要收紧，改动点在 `FilesNodeSection` 的 shell。
2. **离线 node 也出分节**（一行「节点离线」），而不是只列在线 node。这样路由 node 掉线时的旧行为（一行提示）在聚合视图里仍然存在，用户也知道那台机器还在。
3. **折叠状态用组件局部 state**。UI store 里没有现成的 files 分节折叠字段（`sidebarNodeOrder` / `sidebarFilesVisibility` 都不是），按指令不新增 store 字段；代价是切侧栏标签会重置为展开。要持久化需在 `packages/stores/src/ui.ts` 加字段（不在我的可改范围）。
4. **mesh 下顶部刷新按钮的转圈**读的是 entry(self) 的 QueryClient（外壳挂在 self 运行时下），远端 node 的加载状态改在各自分节头上用小转圈表示。
5. **重排 handler 没有 DOM 层面的测试**：panels 的测试环境无 DOM（`renderToStaticMarkup`），无法派发拖拽事件。改为把逻辑抽成纯函数 `nextFileRootOrder` / `reorderFileRootsOptimistically` 单测 + api-client 侧 `reorderFileRoots` 请求单测，两端拼起来覆盖整条链。
6. **越界但必要的一行**：`packages/api-client/src/files.ts` 加了一行 re-export（该文件是 file-resources 的门面，`index.ts` 只 `export * from './files'`）。除此之外没有碰任何非 owned 文件。
7. **单 node 视觉变化**：根目录行现在左侧多出 14px 的 grip 落槽（拖拽排序需要），这是本任务要求的新功能，非回归；缩进链未变（根行与子目录相对缩进保持原样）。
8. 未跑 dev server / Playwright；建议 commander 合并后在临时实例里截图核对分节头与 grip 在窄侧栏下的换行/截断（文案规范要求）。

## Review follow-up（三条 should-fix 已处理）

### 1. 远端分节缺 `settings-update` 订阅 → 已接上
`SettingsEventsInit`（`packages/panels/src/settings/settings-events-init.tsx`）本来就是**按运行时**工作的（`useRuntime().transport` + `useQueryClient()`），不需要抽取或参数化，直接在分节的 `NodeRuntimeScope` 里再挂一份即可。

- `apps/fe/src/components/page-layouts/components/app-sidebar.tsx` 的 `SortableFilesNodeSection`：在线且已登录的分节内、`FilesNodeSection` 之前挂 `<SettingsEventsInit />`。
- **self 不重复挂**：`main.tsx` 的 `SelfSettingsEventsInit`（路由不是 self 时）与 `NodeSessionInit`（路由 node）已经恒定覆盖 self，故加了 `node.runtimeNodeId !== SELF_NODE_ID` 的条件。
- 远端分节若恰好也是当前路由 node，会有一份重复订阅：`invalidateQueries` 幂等、并发 refetch 由 React Query 去重，代价可忽略；换成再判一次 `routeNodeId` 会把 sidebar 和 `NodeSessionInit` 的挂载时机耦死，故不做。
- 效果：`file-roots` 命名空间映射到 `['files']`，别处改了某远端 node 的目录配置，该 node 的分节缓存即时失效，不再等手动刷新/窗口聚焦。

### 2. 聚合刷新给未挂载 node 建缓存 → 已收窄
`nodeQueryClient()` 是懒建 + 登记的，只有运行时被回收时才经 `appNodeRuntimes.onDispose` → `disposeNodeQueryClient` 释放；对离线/未登录（没有 `NodeRuntimeScope`）的 node 调它会留下永远等不到回收的缓存。

- 新增 `isFilesSectionMounted(entry) = entry.online && entry.loggedIn`，`MeshFilesTab` 的 `refresh` 与 `SortableFilesNodeSection` 的分支共用这一条判定，刷新只失效**已挂载**分节的缓存。
- 没有改 `node-runtimes.ts`（不在 owned 范围），因此走的是「只碰已挂载的」这条路，而不是新增 peek 访问器。若后续想要 peek 版本，加在 `apps/fe/src/node/node-runtimes.ts`（如 `peekNodeQueryClient`）即可，本处调用点一行替换。

### 3. 测试补强
- **重排接线抽成纯函数**：`packages/panels/src/files/root-reorder.ts` 新增
  - `FILE_ROOTS_QUERY_KEY`（从 `files-node-roots.tsx` 移过来）；
  - `fileRootOrderToSubmit(allRoots, visibleIds, nextVisibleIds, pending)`——`pending` 为真时返回 `null`，把「上一次还在飞就不受理第二次拖动」变成代码级硬保证（原先只有 `SortableVerticalList disabled` 这一层 UI 兜底，现在两层都在）；
  - `fileRootReorderOptions({ queryClient, submit, onFailed })`——乐观改写 / 失败回滚 / `onSettled` invalidate 的完整 mutation 接线，脱离 React 可直接单测。
  `useFileRootReorder` 改为消费这两个函数，行为不变。
- `packages/panels/src/files/root-reorder.test.ts`（4 → 8 例）：新增 `fileRootOrderToSubmit` 的空闲/在飞两个分支，以及用 `MutationObserver` + deferred promise 驱动的两个 mutation 用例——
  - 提交期间缓存已是乐观顺序、`submit` 恰好收到一次完整顺序；reject 后缓存回滚到原顺序、`onFailed` 恰好一次；
  - 在飞期间 `observer.getCurrentResult().isPending === true`，把这个真实的 pending 值喂给 `fileRootOrderToSubmit` 得到 `null`（即第二次拖动被挡下），resolve 后 `submit` 仍只被调用一次、`isPending` 归假。
- `packages/panels/src/files/files-node-section.test.tsx`（4 → 5 例）：新增「按 node 隔离」用例，同时渲染三个分节（A/B 已登录各带一份自己的 `QueryClient`，C 未登录），断言：
  - A 的分节 HTML 里有 `/srv/app` 且没有 `/srv/node-b`，B 反之；
  - `clientA` / `clientB` 的 `['files','roots']` 各自只有自己那一条，互不串；
  - 未登录分节的 QueryClient 里**根本没有** `['files','roots']` 这条 query（`getQueryCache().find()` 为 undefined），且它的 `apiClient.fetch` 调用数为 0；对照断言已登录分节的同一条 query 是存在的（证明这个断言不是空跑）。

### 复核后的数值

| 目标 | 结果 |
|---|---|
| `packages/panels` `bun test` | **676 pass / 0 fail**（我的用例共 14：root-reorder 8、files-node-section 5、files-tab +1） |
| `packages/panels` tsc | **0** |
| `apps/fe` `bun test src/components/page-layouts/` | **94 pass / 0 fail** |
| `apps/fe` `bun test src/` | 1078 pass / **1 fail** —— 失败在 `src/node/mesh-nodes.test.ts:162`（`patchNodesWithEvent` 的 `peerAddress`），属 O1 并发在改的 `mesh-nodes.ts`/`mesh-nodes.test.ts`，与本批无关（我只读该模块）；我这批落地后的上一轮全量还是 1079/0 |
| `apps/fe` tsc | **0** |
| `packages/api-client` | **134 pass / 0 fail**，tsc **5**（既有） |
| biome（改动文件） | clean |
| 复杂度门禁 | 我的文件零违规（余下 8 条全在 gateway / device-console / terminal-ui / stores 的并发改动里） |
