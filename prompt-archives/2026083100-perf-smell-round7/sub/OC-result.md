# OC 任务结果：mesh-node 前端两处修复

## 一、线索核实

### 1. [perf] 离线 node 仍然发全局 `/api/devices` —— 属实

- `apps/fe/src/pages/devices/node-device-group.tsx`：`ready` 与 `offline` **共用同一棵运行时子树**（注释写明「节点掉线只是把面板切到离线模式，不重挂」），离线 node 的 `NodeRuntimeScope` 一直挂着。
- `apps/fe/src/node/node-runtime-scope.tsx`：无条件挂 `GlobalDeviceProvider`。
- `apps/fe/src/components/global-device-provider.tsx`：`useQuery({ queryKey: ['devices'] })` 无 `enabled`。
- `apps/fe/src/node/node-runtimes.ts`：每 node 一个 QueryClient（`retry: 1`），所以 N 个离线 node = N 条注定失败的请求 + 各一次重试。
- 对照 `packages/panels/src/device-management/use-device-management-state.ts` 已有 `enabled: !offline`，属同一契约的漏网点。

补充观察（未改，属设计取舍）：侧边栏对离线 node 根本不挂 `NodeRuntimeScope`（`sidebar-node-section.tsx` 先判 `!node.online` 走离线分支），所以 N 重请求只发生在设备页聚合视图。另外 provider 里除这条 query 外没有其它网络动作：路由设备自动订阅只在 pathname 命中本 runtime 的 `/n/:nodeId/devices/:id` 时才动，聚合视图里的旁路 node 不会命中。

### 2. [bug] `useHubNode` 三条来源竞态 —— 属实

原 `loadHub` 无单飞、无序号：初次加载 effect、轮询 interval、手动 `refresh` 各自开请求；且 `refresh` 传的是 `() => false`（**永不取消**），所以手动刷新的慢响应既能盖掉更新的结果，也会在卸载后继续 `setState`。`nodes-management.tsx` 的刷新按钮正是 `refreshNodes() + hub.refresh()` 同时打，与 30 s 轮询天然交错。

## 二、改动

### 1. 离线 node 不发设备列表请求

- `apps/fe/src/components/global-device-provider.tsx`
  - 新增导出的纯函数 `devicesQueryOptions(apiClient, offline)`：`enabled: !offline`，`queryKey` 保持 `['devices']` 不变。
  - `GlobalDeviceProvider` 新增可选 `offline?: boolean`（默认 `false`），查询改用该 options。
- `apps/fe/src/node/node-runtime-scope.tsx`：新增可选 `offline?: boolean` 透传给 provider。
- `apps/fe/src/pages/devices/node-device-group.tsx`：`<NodeRuntimeScope offline={state === 'offline'}>`。

行为要点：
- query key 不变 → 离线期间 `useQuery` 仍返回**缓存里的旧列表**，`useReconcileWithDeviceList` 与面板兜底照常工作；
- 离线→在线：`enabled` 翻回 `true`，react-query 对「上一轮 `enabled === false` 且数据已 stale（staleTime 5 s）」的 query 会自动重取，子树不重挂、路由订阅逻辑不变；
- 未改 `NodeRuntimeBoundary`（路由层）：路由 node 同一时刻只有一个，不构成 N 重放大，且门闸逻辑与登录态耦合，本次不动。
- 未动运行时本身（离线 node 的 WS 连接仍按设计保持挂载并重连）——那是「掉线不重挂、卡片不消失」的既定取舍，不在本次范围。

### 2. hub 列表取数加代号 + 单飞

- 新增 `apps/fe/src/node/hub-load-coordinator.ts`：`HubLoadCoordinator`
  - **generation**：每次真正开跑的请求领递增代号，只有最新一代能写状态；过期响应连 `loading:false` 都不写（否则会提前停掉新请求的转圈）。
  - **single-flight**：同一个请求闭包在飞时，后来的调用方拿到同一个 promise，不叠加请求。
  - **卸载 vs 过期分开判**：`dispose()` 置 `active=false`（组件没了，永不写状态），`activate()` 供 StrictMode 二次挂载恢复；过期只是代号落后。
- `apps/fe/src/node/mesh-nodes.ts`：`useHubNode` 改接协调器
  - `request = useMemo(...)`：`!enabled || !resolved` 时为 `null`（协调器 `reset()` 清列表、停 loading）；否则是请求闭包，**其身份即单飞的 key**（目标一变就是新一次加载）。
  - 初次加载 / 轮询 / `refresh` 三处统一走 `coordinator.load(request)`；`refresh` 不再是「永不取消」的裸请求。
  - 新增私有 hook `useHubLoadCoordinator`（协调器只建一次，挂载/卸载切写状态开关）。
  - 公开 API（`HubNodeState` / `UseHubNodeOptions` / `refresh`）完全未变。
  - 顺带修正：原来 `enabled` 为真但定位不到 hub 时，轮询 interval 仍在空转（每 30 s 把 `hubNodes` 重置一遍）；现在 `request` 为 `null` 就不起 interval。

## 三、测试

- 新增 `apps/fe/src/node/hub-load-coordinator.test.ts`（9 例）：慢/快响应交错、过期失败不写 error 且不提前停 loading、轮询在飞时手动刷新合并成一次、卸载中途成功/失败均不写状态、重新挂载恢复、失败写 error、无可用 hub 时 reset、切到 null 后旧响应被丢弃。
  - 说明：仓库**没有 DOM 测试环境**（无 happy-dom / testing-library，现有组件测试只能 `renderToStaticMarkup`，effect 不执行），所以把时序逻辑抽到 React 之外的协调器里单测，而不是写跑不起来的 hook 测试。`mesh-nodes.test.ts` 保持只测纯函数，新逻辑放同目录的新测试文件。
- `apps/fe/src/components/global-device-provider.test.ts` 扩了 `devicesQueryOptions` 3 例：在线启用、离线禁用、离线→在线翻转且 query key 不变。

验证结果：
- `apps/fe`：`bun test src/` → **895 pass / 0 fail**（63 文件；基线 883 + 新增 12）。
- `bunx tsc --noEmit -p .`（apps/fe）→ 0 错误。
- `bunx biome check <7 个改动文件>` → 干净（No fixes applied）。
- `bun scripts/complexity/gate.ts` → 唯一违规是 `packages/stores/src/site.ts:53 createSiteStore`（其它 agent 正在改的文件，非本次范围）；本次改动的函数无违规。

## 四、改动文件

- `apps/fe/src/components/global-device-provider.tsx`
- `apps/fe/src/components/global-device-provider.test.ts`
- `apps/fe/src/node/node-runtime-scope.tsx`
- `apps/fe/src/node/mesh-nodes.ts`
- `apps/fe/src/node/hub-load-coordinator.ts`（新增）
- `apps/fe/src/node/hub-load-coordinator.test.ts`（新增）
- `apps/fe/src/pages/devices/node-device-group.tsx`
