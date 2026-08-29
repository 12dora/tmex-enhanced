1. [sidebar-device-list-runtime.tsx:63](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:63) — **med**  
   `useSidebarDeviceStats` 将查询失败时的 `undefined` 数据视为零设备，远端 node 因此直接返回 `null`，原有加载失败及重试 UI 永远无法显示。  
   场景：已登录远端 node 的 `/api/devices` 请求失败，侧栏中整个 node 消失，用户无法重试。  
   修复：统计结果携带查询状态；仅在查询成功后执行隐藏判断，错误状态应挂载 `DeviceTree`。

2. [sidebar-node-section.tsx:162](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:162) — **low**  
   离线分支无条件传入 `keepWhenNoDevices=true`，导致零已知设备的远端 node 仍显示空分节，与“仅 self 保留真正零设备空态”不符。  
   场景：离线远端 node 的 inventory 为 `null` 或空数组，侧栏仍出现 node 标题和空态。  
   修复：传入 `node.isSelf`，远端零已知设备时返回 `null`。

3. [sidebar-device-list.test.tsx:15](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:15) — **low**  
   测试 mock 掉了实际执行统计与隐藏逻辑的 `SideBarDeviceListForRuntime`，因此在线 node 的全隐藏、当前选中设备例外、可见性切换恢复及查询失败行为均未被测试。上述第 1 项即不会被现有测试发现。  
   修复：使用真实 QueryClient/runtime 渲染该组件，覆盖全隐藏、选中设备、visibility 更新和查询失败四种状态。

未发现 hook 顺序问题、默认 React Query cache key 不一致或已删除 props 的残留引用。