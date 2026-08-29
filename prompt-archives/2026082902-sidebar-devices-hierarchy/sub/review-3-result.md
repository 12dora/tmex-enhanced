- **高** — `apps/fe/src/pages/devices/device-folders-view.tsx:70、170`，`apps/fe/src/pages/devices/use-device-folders.ts:67、76-84`：布局尚未加载或首次加载失败时，代码把“未知布局”当成 `EMPTY_LAYOUT`，但仍允许拖拽并整体写回。若服务端没有文件夹、却已有根层 placement，`PUT` 的文件夹集合校验会通过，当前不可见的 placement 会被永久删除；请求失败时 `previous` 为 `undefined`，乐观数据也不会回滚。应区分“未加载”和“确实为空”，在取得有效布局前禁用所有布局变更；错误时删除/恢复乐观缓存并重新拉取。

- **高** — `packages/panels/src/device-folders/device-folder-tree.tsx:175-179、284-287`，`apps/fe/src/pages/devices/use-device-folders.ts:69-89、179`：`pending` 只禁用了拖拽，条目的“移出文件夹”和文件夹菜单中的移动操作仍可再次触发 `replaceLayout.mutate`。这些 mutation 没有共享 scope，会并行执行；较早请求后返回时可用旧的整份布局覆盖较新的操作，服务端同样是整表替换，存在真实的顺序丢失风险。应禁用所有布局变更入口，并在数据层串行化布局 mutation 或拒绝 pending 期间的新提交。

- **中** — `packages/panels/src/device-folders/folder-section.tsx:217-230`：折叠只通过 `0fr + visibility:hidden` 隐藏内容，整个子树的 `useSortable`、`useDroppable` 和 `NodeRuntimeScope` 仍然挂载。`MeasuringStrategy.Always` 会继续测量这些隐藏落点，碰撞检测可能选中被裁剪的后代；同时折叠文件夹里的远端节点仍保持连接、查询和 zustand 订阅。应在折叠后卸载子树，或至少递归禁用/注销其所有拖放目标；远端运行时也应随隐藏内容释放。

结论：需修后合并。