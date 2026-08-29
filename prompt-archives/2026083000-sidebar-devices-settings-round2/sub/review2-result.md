# 代码审查报告

审查对象：`batch2.diff`，提交 `db74fb28`。

## 主要问题

1. **高：分层碰撞检测会把列表间隙解析成错误落点。**  
   [device-folder-tree.tsx:178](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.tsx:178) 对兄弟元素只运行 `pointerWithin`，没有命中时直接降级到容器或根区域。

   - 同一容器内把节点放在两个节点之间的 `gap-3` 上，会命中分组容器或根容器；[folder-tree-model.ts:212](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/folder-tree-model.ts:212) 又把同容器整体落点判为无效，最终排序被取消。
   - 拖动分组并放在两个分组之间的间隙时，会命中整树根区域；[folder-tree-model.ts:171](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/folder-tree-model.ts:171) 将其解释为 `index: null`，分组会被移动到列表末尾，而不是插入该间隙。
   - 跨容器进入分组内部的节点间隙时，只能追加到分组末尾，无法插入视觉上的间隙位置。

2. **高：跨容器预览会在拖拽过程中卸载并重建整个节点运行时子树。**  
   [device-folder-tree.tsx:361](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.tsx:361) 将 `previewDrop` 直接应用到渲染布局；随后 [device-folder-tree.tsx:235](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.tsx:235) 会把活动节点从一个 `NodeList` 移到另一个。React 的 key 只在同一父级内保持身份，因此节点会卸载后重新挂载。

   实际子树包含 [node-device-group.tsx:247](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/node-device-group.tsx:247) 的 `NodeRuntimeScope`、`QueryClientProvider`、`GlobalDeviceProvider` 和设备面板。每次跨容器预览都会重置面板本地状态、重新注册添加设备目标，并重启 Provider 的查询及订阅 effect。运行时管理器的 30 秒宽限期通常能避免底层 WebSocket 真正销毁，但不能避免 React 子树和业务订阅重建。活动 `useSortable` 也会在拖拽中注销再注册。

3. **高：键盘无法在根层没有兄弟节点时将节点移出分组。**  
   无指针坐标时，[device-folder-tree.tsx:172](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.tsx:172) 仅把 `zones + items` 交给 `closestCenter`，明确排除了 `groups.root`。当根层为空时，没有任何根层兄弟节点可供键盘落下，因此分组里的节点只能在分组之间移动，无法回到根层。此次又删除了“移出分组”按钮，键盘用户已没有替代路径。

4. **高：固定使用 self QueryClient 后，远端路由缺少 self 的实时失效订阅，可能用陈旧布局覆盖新布局。**  
   [use-device-folders.ts:63](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/use-device-folders.ts:63) 正确地把请求和缓存固定到了 self；但 `SettingsEventsInit` 始终绑定当前路由的 runtime 和 QueryClient（[settings-events-init.ts:57](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/settings/settings-events-init.tsx:57)）。在 `/n/<remote>/devices` 下，它监听的是远端节点，不会把 self 网关发出的 `device-folders` 事件失效到 self 缓存。

   失败场景：页面在远端路由加载 self 布局 L1；另一浏览器把 self 改成 L2；当前页面仍保留 L1；用户再拖一次节点，整表 `PUT` 会以 L1 为基础提交，从而覆盖 L2。需要为常驻 self runtime/client 建立对应事件订阅，或让该 hook 自行订阅 self 的布局更新。

5. **中：截断文本的 Tooltip 对键盘和触屏用户不可用。**  
   [device-card.tsx:87](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-card.tsx:87) 把 Base UI 的 Tooltip 触发器渲染成不可聚焦的 `<div>`。Base UI Tooltip 依赖鼠标 hover 或焦点打开，因此视力正常的键盘用户无法看到被截断的全文；移动端也不能依赖原生 `title` 展示。文本节点本身仍能被屏幕阅读器读取，但这不能解决键盘和触屏的视觉可发现性。

   [device-card.test.tsx:165](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-card.test.tsx:165) 反而明确断言触发器必须是 `<div>`，把该问题固化成了测试契约。

6. **低：两项新增测试提供了错误的通过信号。**

   - [device-snapshot-store.test.ts:211](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/device-snapshot-store.test.ts:211) 把快照写入自建 `memoryStorage`，但调用 `offlineDevices` 时无法传入该 storage，实际读取的是默认存储；同时快照和 inventory 又使用相同 id。因此测试始终可能走 inventory 分支，不能证明“快照优先且不合并”。
   - [device-folder-tree.test.tsx:103](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.test.tsx:103) 只断言树容器存在。即使删除 `useDroppable({id: 'drop:root'})`，该测试仍然通过，不能证明整树确实是根落点区。

## 已核实无问题

- `event.over === null` 时取消拖拽并清除预览是正确的，不会误提交已经预览过的布局。
- `materializeRootNodes`、`applyDrop` 和 `rebaseNodeDrop` 对正常合法布局的隐式根节点、跨容器移动及下标换算正确。
- 数据库以节点 placement key 为主键，服务端也拒绝重复 `nodeId`；正常服务端数据不会产生重复 placement。新增 UI 去重不会改变合法布局。
- 当前 TanStack React Query 版本支持向 `useQuery`、`useMutation` 传入显式 `QueryClient`；该 hook 内查询、mutation 和手工失效均使用同一个 self client 和 `deviceFoldersQueryKey`。问题仅在外部事件订阅仍跟随路由 client。
- `MeasuringStrategy.Always` 能覆盖预览导致的 droppable 注册和尺寸变化；它不能解决 React 子树重挂，但其使用本身没有发现 API 错误。
- 本地 `snapCenterToCursor` 的偏移公式及无坐标兜底正确。
- 设备列表、快照和 inventory 去重均保留首条及稳定顺序；auto-fill 网格和设备卡片排序逻辑未发现持久化错误。

验证方面，目标五个测试文件共运行 79 项，结果为 `79 pass / 0 fail`。运行验证时 worktree 的 HEAD 已被外部推进到 `781183e3`；除设备网格最小列宽由 18rem 改为 24rem 外，上述受审逻辑未发生变化。当前环境为只读，且请求未给出具体输出路径，因此未创建报告文件。