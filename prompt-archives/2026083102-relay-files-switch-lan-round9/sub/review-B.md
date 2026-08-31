## 1. Blockers

未发现 blocker。逐节点 `QueryClient` 隔离、未登录请求门禁、嵌套 DnD ID 隔离和单目录 500 行上限均保持正确。

## 2. Should fix

1. [app-sidebar.tsx:66](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:66)：远端文件分节没有订阅该节点的 `settings-update` 事件。现有 `SettingsEventsInit` 只覆盖 self 和当前路由节点，而 `FilesNodeRoots` 的 roots 查询仅在窗口聚焦时刷新。具体场景：当前路由位于 self，远端 A 的分节已经加载；另一个浏览器修改 A 的文件根后，A 广播 `file-roots`，本页面的 A 缓存不会失效，目录可无限期保持旧状态，直到手动刷新或重新聚焦窗口。最小修复是在每个已登录分节的 `NodeRuntimeScope` 内挂载对应运行时的设置失效订阅，或提供等价的按节点订阅组件。

2. [app-sidebar.tsx:93](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:93)：聚合刷新会对离线、未登录节点也调用 `nodeQueryClient()`。该函数会创建并永久登记新客户端，但这些节点没有挂载 `NodeRuntimeScope`，因此不会经过 `appNodeRuntimes.onDispose` 清理。具体场景：远端离线超过 30 秒、原运行时已释放后点击刷新，会重新创建一个空 `QueryClient`；节点随后被撤销时该对象仍留在模块级 Map，节点反复加入/撤销会持续累积。最小修复是只失效当前已挂载的客户端，或增加不创建实例的 `peekNodeQueryClient()`。

3. [files-node-roots.tsx:70](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/files-node-roots.tsx:70)、[files-node-section.test.tsx:59](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/files/files-node-section.test.tsx:59)：高风险接线缺少行为测试。现有测试只覆盖纯排序函数、API 请求形状和单个手工注入的运行时，未验证两个节点不会串缓存、未登录节点零请求，以及 mutation 失败回滚和 pending 期间禁止第二次重排。建议增加一个双运行时测试和一个使用延迟 Promise 的 mutation 测试；这些测试能直接覆盖本批次最容易回归的边界。

## 3. Nits

无。