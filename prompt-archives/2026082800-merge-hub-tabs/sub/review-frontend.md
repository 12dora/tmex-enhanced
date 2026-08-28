审查完成，确认 2 处合并语义丢失：blocker 1 项、major 1 项。

由于当前沙箱是只读模式，写入 [review-frontend.md](/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082800-merge-hub-tabs/sub/review-frontend.md) 被明确拒绝，文件未能落盘。以下为应写入的核心报告。

## Blocker：切换 node 路由会串写并覆盖下一 node 的连接意图

- **文件:行**：[global-device-provider.tsx:81](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/global-device-provider.tsx:81)、[node-runtime-boundary.tsx:20](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-boundary.tsx:20)、[main.tsx:283](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:283)
- **丢失行为**：
  - tabs 侧 `bbc8d0e`、`bb74ebd` 引入持久连接意图和显式断开集合，要求显式断开抑制路由/展开自动订阅。
  - hub 侧 `08b2243` 引入 `/n/:nodeId` 动态 runtime，以及按 node 隔离的存储前缀。
- **合并后为什么失效**：`usePersistedDeviceIds(storageKey)` 只在首次 mount 读取：
  ```ts
  const [ids] = useState(() => readPersistedIds(storageKey));
  useEffect(() => writePersistedIds(storageKey, ids), [storageKey, ids]);
  ```
  `/n/node-a/*` 切换到 `/n/node-b/*` 仍复用同一个路由组件，`GlobalDeviceProvider` 不会 remount。runtime 和 storage key 已变成 node-b，但内存 Set 仍属于 node-a，effect 会把它写入 node-b 的持久化键。随后对账逻辑还可能用 node-a 的意图操作 node-b store。
- **复现断言**：
  1. A：connected=`["shared"]`、disconnected=`[]`。
  2. B：connected=`[]`、disconnected=`["shared"]`。
  3. 同一 router 从 `/n/A/devices/shared` 导航至 `/n/B/devices/shared`。
  4. 应断言 B 的两个键保持不变，且 `B.connectDevice("shared")` 未调用。当前会覆盖 B 的数据，并可能连接其原本显式断开的设备。
- **严重度**：blocker。存在跨 node 持久数据覆盖，并可能将一侧连接意图用于另一侧设备，属于数据错误和安全边界破损。

## Major：mesh 当前 node 的显式断开会被第二个 Provider 立即重连

- **文件:行**：[node-runtime-boundary.tsx:31](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-boundary.tsx:31)、[node-runtime-scope.tsx:18](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/node/node-runtime-scope.tsx:18)、[sidebar-node-section.tsx:105](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:105)、[global-device-provider.tsx:304](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/global-device-provider.tsx:304)
- **丢失行为**：tabs 侧 `bbc8d0e` 保证点击 Power 后写入显式断开集合，路由订阅不得重新连接；hub 侧 `a9b545c` 为每个在线、已登录 node 增加 `NodeRuntimeScope`。
- **合并后为什么失效**：当前路由 node 同时存在两份 `GlobalDeviceProvider`：
  ```text
  NodeRuntimeBoundary
  └─ GlobalDeviceProvider（外层）
     └─ SidebarNodeSection
        └─ NodeRuntimeScope（同一 runtime）
           └─ GlobalDeviceProvider（内层）
  ```
  两者共享 tmux store 和 localStorage，却各自持有独立的显式断开 Set。侧栏点击断开只更新内层；`connectedDevices` 变化后，外层路由 effect 重跑，外层仍认为设备可自动订阅，于是立即调用 `connectDevice`。此时侧栏仍显示“已断开”，但底层已重新连接。
- **复现断言**：mesh 下访问 node-a 的 `/devices/device-a`，点击侧栏断开后，断言调用序列中 `disconnectDevice` 后不得再出现 `connectDevice`，且最终 `connectedDevices` 不含该设备。当前断言失败。
- **严重度**：major。当前设备页上的断开控制失效；先离开具体设备路由再断开可以绕过。

其余重点均确认保留，包括三 tab 互斥与懒挂载、node runtime/QueryClient/store 隔离、离线与未登录请求守卫、路由归属、错误重试、按 node 空态、`DeviceRow` 优化、设置页 runtime API、动态加载重试、设置事件、侧栏折叠持久化及 i18n 迁移。

验证结果：

- frontend：306 pass，0 fail
- panels：368 pass，0 fail
- stores：238 pass，0 fail
- frontend TypeScript：exit 0

现有测试未覆盖“同一挂载切换 node 参数”和“同 runtime 双 Provider”两个组合场景，因此全绿不反驳上述问题。