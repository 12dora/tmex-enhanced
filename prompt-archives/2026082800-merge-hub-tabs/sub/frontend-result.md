# 前端侧 merge 冲突解决结果（feat/hub-node × feat/sidebar-tabs-ui）

范围：`apps/fe`、`packages/panels`、`packages/stores`（未触碰 `apps/gateway`，未做任何 git 操作）。

共同祖先 base = `bf5b998`。

---

## 一、逐文件冲突点与融合方式

### 1. `apps/fe/src/main.tsx`（2 处）

| | ours（hub-node） | theirs（tabs） |
|---|---|---|
| 冲突 1 | 无新增 | `import { PageLoadFallback }` |
| 冲突 2 | `NodeRuntimeBoundary` / `appNodeRuntimes` / `installSessionInterceptor` / `SELF_NODE_ID`+`useNodeRuntime`；store hooks 走 `@tmex/stores/react` | `usePageModule` / `SettingsEventsInit`；store hooks 走 `@tmex/stores` |

两处都是**纯 import 冲突**，函数体已由 git 自动合并（`NodeShell` / `pageRoutes()` / `/n/:nodeId` 路由 + `PageWrapper` 的 `usePageModule` + `SettingsEventsInit` 同时在）。融合方式：取两侧 import 的并集，其中 `useSiteStore/useUIStore` 统一改到 `@tmex/stores/react`（hub-node 已把带 hook 的入口拆到 react 子入口，`@tmex/stores` 主入口不再导出这些名字）。

### 2. `apps/fe/src/components/global-device-provider.tsx`（4 处）

- ours：`useRuntime()` + `runtime.apiClient`、`useTmuxStore` 改 react 子入口、新增导出 `deviceRoutePattern` / `routeDeviceId`（用 react-router `matchPath` 匹配 `hostAppPath(host, '/devices/:deviceId')`，因此**不会认领别的 node 的路径**）。
- theirs：把 provider 拆成 `usePersistedDeviceIds` / `useDeviceIntentState` / `useDeviceStatusSlices` / `useDeviceStoreActions` / `useReconcileWithDeviceList` / `useRouteDeviceSubscription` / `useIntentActions` / `useDeviceConnectionAdapter` 一串 hook，落地「设备连接/断开控制 + 连接意图持久化 + 设备列表就绪后对账」。

融合：**保留 theirs 的整套结构**，把 hub-node 的多 runtime 语义注入进去：

1. `GlobalDeviceProvider` 里先 `const runtime = useRuntime()`；
2. `useRouteDeviceSubscription(host, devicesData, ensureDeviceSubscribed)` 增加 `host` 参数，内部改用 ours 的 `routeDeviceId(pathname, path => hostAppPath(host, path))`，替代 theirs 里写死 `/devices/:id` 正则的 `matchRouteDeviceId`；
3. `useDeviceIntentState(storagePrefix)` 增加前缀参数，连接意图的 localStorage 键按 runtime 隔离（`self` 前缀为空串，键名与旧版完全一致，老用户状态不丢；其他 node 为 `n:<id>:tmex:connectedDevices`）。

### 3. `apps/fe/src/components/global-device-provider.test.ts`（1 处）

两侧各自新增了一段 import + 用例，互不重叠：ours 是 `routeDeviceId` 的 self/node 路径归属用例，theirs 是连接状态派生/持久化用例。融合方式：合并成一条 import，两组用例全保留。

### 4. `apps/fe/.../app-sidebar.tsx`（1 处）

只有 import 块冲突。theirs 把 base 的三段 `Collapsible` 分区（`SidebarSectionBlock` + `sidebarSections`）整体换成 3 个 Tab（`sidebarTab` + `TabsList`），hub-node 对本文件只做了 `@tmex/stores/react` 的 import 迁移。融合：**保留 theirs 的 Tabs 结构**，import 只留 `useUIStore from '@tmex/stores/react'`；`SidebarSection` / `cn` / `Collapsible` 随分区结构一并删除（`packages/stores/src/ui.ts` 已自动合并成只有 `sidebarTab`、且显式丢弃 localStorage 里遗留的 `sidebarSections`，类型 `SidebarSection` 不复存在）。

### 5. `apps/fe/.../sidebar-agent-sessions.tsx`（6 处）

theirs 把这个 400+ 行的文件拆成 `use-sidebar-agent-sessions.ts`（控制器 + 纯函数）、`agent-session-row.tsx`（行）、`agent-session-dialogs.tsx`（对话框）三个新文件；ours 只做了机械改造：所有 `useXxxStore.getState()` → `runtime.stores.xxx.getState()`，并把常量适配器 `sidebarAgentAdapter` 改成 hook `useSidebarAgentAdapter()`（因为要闭包捕获当前 node 的 runtime）。

融合逐处：

1. import：`AppRuntime` 类型 + `useRuntime/useTmuxStore/useUIStore` 走 react 子入口；`formatDateTime`/`useSiteStore`/`useAgentStore` 已随拆分移到子文件，本文件不再需要。
2. `SidebarAgentSessionsProvider` → 用 theirs 的 `useSidebarAgentSessionsController()`（controller 内部已改成 runtime 版，见第三节）。
3. `useSelectSession`：ours 的 `runtime.stores.agent.setActiveSession` + `runtime.stores.tmux.snapshots`，theirs 的 `setSidebarTab('agent')`（取代已删除的 `expandSidebarSection('agent')`）。
4. 依赖数组合并为 `[setSidebarTab, nav, runtime]`。
5. `createSessionForPane(runtime, ...)`：`runtime.stores.agent.startDraft` + `runtime.stores.ui.getState().setSidebarTab('agent')`。
6. 尾部：删掉 ours 侧被 theirs 拆分取代的 `AgentPaneSessions`/`AgentOrphanSessions`/`AgentSessionDialogs` 旧实现（theirs 版本已在上方，且带 `devicesReady` + pane 存活判定的修复），保留 ours 的 `useSidebarAgentAdapter()` 导出。

### 6. `apps/fe/.../sidebar-device-list.tsx`（1 处）

这是**语义最错位的一处**：hub-node 把这个文件整体挪成了 mesh 聚合器（新文件 `sidebar-device-list-runtime.tsx` 承接原有单 runtime 内容），theirs 则在原文件上继续加了 `connection` 与 `agentUi` 开关。

融合：本文件保留 ours 的聚合器（`toSidebarEntries` + `MeshDeviceList` + `SideBarDeviceList` 按 `meshEnabled` 分流），theirs 的两处改动**下沉到 `sidebar-device-list-runtime.tsx`**（见第三节）。

### 7. `apps/fe/src/pages/DevicePage.tsx`（1 处）

纯 import 冲突：ours 加 `DeviceNodeBadges`/`useRouteNodeId`（PageActions 里的 node 徽标），theirs 加 `useGlobalDevice`（把 `connection` 传给 `DeviceConsole`）。函数体已自动合并，两者都在。取并集即可。

### 8. `packages/panels/src/device-console/page-actions.tsx`（1 处）

theirs 把数据面抽到 `useDeviceConsoleActions`，视图只消费 `model`；ours 的那一整块（`watchRulesQuery`、`canInteract`、`handleJumpToLatest` 等）在 theirs 的模型里已全部有对应实现，且模型里已经带上了 hub-node 的 `runtime.apiClient` / `runtime.features.watchUi` / `runtime.host.reload()`。唯一在拆分中丢掉的 hub-node 行为是 `tmex:jump-to-latest` 事件的 `detail: { nodeId }`，已补回 `use-device-console-actions.ts`。本文件直接采用 theirs 的薄壳。

### 9. `packages/panels/src/device-tree/device-row.tsx`（2 处）

theirs 把设备行拆成 `DeviceRowHeader` + `DeviceWindowList` + `device-tree-row-props.ts`，并用 `memo` + 按设备切片订阅（`useDeviceWindows`/`useDeviceOnline`）做重渲染优化，同时用 `DeviceConnectionControl` 取代了原来的在线状态小圆点。ours 只加了一个 `nodeBadge` prop 与 `<NodeBadge>` 渲染。

融合：本文件取 theirs；`nodeBadge` 下沉到 `device-tree-row-props.ts` 的 `DeviceRowProps`，`<NodeBadge>` 渲染下沉到 `device-row-header.tsx`（放在 `DeviceStatusBadge` 之前，与 ours 原来的位置一致）。

### 10. `packages/panels/src/device-tree/device-tree-navigation.ts`（1 处）

同一个 `useCallback` 的依赖数组：ours 加了 `nodeId`（`dispatchUserInitiatedSelection` 需要），theirs 加了 `pendingNavigation`（pending 导航 slot 化的修复）。取并集 `[handleNavigate, host, nodeId, pendingNavigation]`。

### 11. `packages/panels/src/device-tree/index.ts`（1 处）

两侧各加一行导出（ours: `NodeBadge` 系列；theirs: `DeviceConnectionAdapter`/`DeviceConnectionStatus`）。两行都留。

### 12. `packages/panels/src/device-tree/sidebar-device-list.tsx`（3 处）

props 与实参各一处、空态渲染一处。ours 加 `nodeBadge` + `emptyLabel`，theirs 加 `connection`（并把 `handleDeviceExpandedChange` 改成优先走 `connection.connect`）+ 设备列表请求失败时的错误态与重试按钮。

融合：props 与传参取并集；空态用 theirs 的 `isError ? 错误态+重试 : 空态` 分支，其中空态文案改成 ours 的 `emptyLabel ?? t('sidebar.noDevices')`（聚合视图里每个 node 分节要显示各自的空态文案）。`DeviceRow` 同时传 `nodeBadge` 与 `connection`。

### 13. `packages/stores/src/tmux-device-events.ts`（2 处）

theirs 把 `handleTmuxEvent` 的 if 链改成 `Map<TmuxEventType, handler>` 表驱动 + `eventData`/`stringField` 提取；ours 只改了 notification 的跳转：`ctx.core.host.navigate(hostAppPath(ctx.core.host, toAppPath(paneUrl)))`（服务端下发的是本 node 绝对 URL，要先取 pathname 再套本 runtime 的 node 前缀）。

融合：结构取 theirs，import 取并集（`DeviceEventType`/`TmuxEventType` + `toAppPath` + `hostAppPath`），把 ours 的 navigate 改法写进 theirs 的 `handleNotification`。

---

## 二、侧边栏融合后的最终结构

层次自外向内：

```
AppSidebar（apps/fe/.../app-sidebar.tsx）
├─ SidebarHeader: SidebarTitle + Tabs（Panes / Agent / Files 三选一，互斥）   ← tabs 分支
└─ SidebarContent（按 sidebarTab 渲染其一）
   ├─ 'agent' → <AgentTab/>（lazy）
   ├─ 'files' → <FilesTab/>（lazy）
   └─ 'panes' → <SideBarDeviceList/>                                        ← 两分支交汇点
        │
        ├─ 非 mesh（standalone / 单 node）
        │    └─ <SideBarDeviceListForRuntime/>            // 行为等同旧版单运行时设备树
        │
        └─ mesh（useSharedAuthMode().meshEnabled）        ← hub-node 分支
             └─ <div data-testid="sidebar-node-list">
                  └─ 每个 node 一个 <SidebarNodeSection/>：
                       ├─ 离线：NodeBadge + inventory 里最近已知设备名（灰显，不建连接）
                       ├─ 在线未登录：NodeBadge + 「登录此节点」按钮（不建连接）
                       └─ 在线已登录：NodeBadge
                            └─ <NodeRuntimeScope nodeId>   // 该 node 的 runtime + QueryClient + GlobalDeviceProvider
                                 └─ <SideBarDeviceListForRuntime
                                        nodeBadge          // 每行右侧的 node 徽标
                                        expansionKeyFor    // 展开态按 node 隔离
                                        emptyLabel />      // 分节级空态文案
```

`SideBarDeviceListForRuntime`（单 runtime 设备树，两分支能力在此汇合）：

```
SideBarDeviceListForRuntime
├─ agentUi = useRuntime().features.agentUi          ← tabs 分支的 feature 开关
├─ connection = useGlobalDevice().connection        ← tabs 分支的连接控制
├─ agentAdapter = useSidebarAgentAdapter()          ← hub-node 的 per-runtime 适配器（hook 形态）
└─ agentUi ? <SidebarAgentSessionsProvider><DeviceTree/></...> : <DeviceTree/>
     └─ @tmex/panels device-tree SideBarDeviceList
          ├─ DeviceRow（memo，按设备切片订阅）
          │    ├─ DeviceRowHeader：拖拽柄 + 名称 + [NodeBadge] + 状态徽标 + 连接开关 + 展开箭头
          │    └─ DeviceWindowList（展开且未被主动断开时才渲染）
          ├─ 空态：请求失败 → 错误态 + 重试；否则 emptyLabel ?? sidebar.noDevices
          └─ agentAdapter.OrphanSessions / .Dialogs
```

要点：

- **Tab 是最外层容器，node 分节是「设备」这个 tab 的内容**，两者不互相感知；切 tab 不影响 node 分节的挂载策略，node 分节的懒挂载（离线/未登录不建连接）也不影响 tab。
- Agent 会话的「跳到 agent 面」动作，由原来的 `expandSidebarSection('agent')` 改为 `setSidebarTab('agent')`，是 tabs 结构下的等价动作；调用方拿的是**当前 node runtime 的 ui store**（`runtime.stores.ui`），不是全局单例。
- `SidebarAgentSessionsProvider` 现在按 node 各挂一份（每个在线已登录 node 一份会话上下文），控制器内部的 `ensureInitialized/loadSessions/renameSession/deleteSession` 全部走 `runtime.stores.agent`。

---

## 三、额外改动的非冲突文件清单及原因

### 在允许目录内（`page-layouts/` 与 `device-tree/`）

| 文件 | 原因 |
|---|---|
| `apps/fe/.../sidebar-device-list-runtime.tsx` | hub-node 新文件，承接原 `sidebar-device-list.tsx` 内容。把 tabs 侧的两项能力搬进来：传 `connection`、按 `runtime.features.agentUi` 决定是否挂 `SidebarAgentSessionsProvider` 与传 `agent` 适配器。 |
| `apps/fe/.../use-sidebar-agent-sessions.ts` | tabs 新文件，原本 `import { useAgentStore } from '@tmex/stores'`——该导出在 hub-node 已不存在，且语义上必须按 node 取 store。改为 `useRuntime()` + `runtime.stores.agent`，selector 读取走 `@tmex/stores/react` 的 `useAgentStore`。 |
| `apps/fe/.../agent-session-row.tsx` | 同上，`useSiteStore` 改到 `@tmex/stores/react`。 |
| `packages/panels/src/device-tree/device-tree-row-props.ts` | tabs 新文件，为承接 `device-row.tsx` 冲突里 ours 的 `nodeBadge` prop，加 `nodeBadge?: NodeBadgeInfo`。 |
| `packages/panels/src/device-tree/device-row-header.tsx` | 同上，渲染 `<NodeBadge>`（否则 mesh 聚合视图丢徽标）。 |

### 超出允许目录（都是「不改就编不过/丢功能」的合并善后，请复核）

| 文件 | 原因 |
|---|---|
| `apps/fe/src/components/device-connection-persistence.ts` | tabs 新文件，`import { defaultRuntime } from '@tmex/stores'`——hub-node 已把 `defaultRuntime` 移出主入口。改成 `connectedDevicesKey(prefix)` / `disconnectedDevicesKey(prefix)` 两个函数，由 provider 传入当前 runtime 的 `storagePrefix`。self 的键名与旧版逐字符一致。 |
| `apps/fe/src/components/device-connection-persistence.test.ts` | 跟随上一条改断言（用例数不变，另加了「按前缀隔离」的断言）。 |
| `apps/fe/src/components/device-connection-status.ts` | 删除 `matchRouteDeviceId`（写死 `/devices/:id` 正则）。它已被 `routeDeviceId(pathname, appPath)` 取代；留着会把 `/n/<other>/devices/x` 误判成本 node 的设备并触发**错误 node 的订阅**。 |
| `apps/fe/src/components/device-connection-status.test.ts` | 跟随删除对应的 2 个用例（对应能力由 `global-device-provider.test.ts` 的 3 个 `routeDeviceId` 用例覆盖，覆盖面反而更宽）。 |
| `packages/panels/src/device-console/use-device-console-actions.ts` | 补回 hub-node 在 `page-actions.tsx` 里的 `tmex:jump-to-latest` 事件 `detail: { nodeId }`（tabs 抽 hook 时丢了）。 |
| `packages/panels/src/watch/watch-test-harness.tsx` | tabs 新增的 watch 测试 harness 没有 `RuntimeProvider`，而 hub-node 把 watch 组件改成了 `useRuntime()`，合并后 4 个用例直接抛错。harness 补上 `RuntimeProvider`（`createAppRuntime()`，惰性 transport，不建真实连接）。 |
| `packages/stores/src/runtime-core-resolution.test.ts` | tabs 新增测试：(a) 断言缺省 notifications 是 `proxyDefaultNotificationSink`，但 hub-node 已删掉该代理改为 `noopNotificationSink`（多 node 下不应有全局默认接收方），断言按合并后实现更新；(b) `GatewayConnection` 的探针对象缺 hub-node 新增的 `attachDirectCarrier` 等成员，改为展开真实连接再覆盖 `client` getter。 |
| `packages/stores/src/site-refresh.test.ts` | tabs 新增测试，从 `./index` 取 `useSiteStore/useUIStore`，改为 `./default-runtime`。 |

---

## 四、需要指挥官拍板的取舍点

1. **`proxyDefaultNotificationSink` 被移除**（stores）。base 有一个可替换的全局默认通知 sink，hub-node 在 per-node runtime 改造里删掉了它（`resolveRuntimeCore` 缺省改 `noopNotificationSink`），tabs 分支没动它、只是新写的测试断言了旧行为。我按 hub-node 的实现改了断言。若希望保留「宿主可全局替换默认 sink」的能力，需要在 stores 里重新引入并明确它在多 runtime 下的语义。

2. **设备在线状态小圆点消失**。tabs 分支用 `DeviceConnectionControl`（连接/断开开关，带 status）取代了 `device-online-status-${id}` 的绿/灰点。hub-node 侧无对应改动。我采纳了 tabs 的行为。注意 `apps/fe/tests/*.spec.ts`（Playwright，不在本次范围）若还断言 `device-online-status-*`，需要另行更新。

3. **连接意图存储键按 node 前缀隔离**。这是我做的设计判断（不隔离的话，两个 node 上同名/同 id 的设备的「已连接/已主动断开」意图会互相覆盖）。self 键名不变，无迁移成本；但多 node 下用户在 node A 的连接意图不会带到 node B——如果产品上希望「一次断开处处断开」，需要改回共享键。

4. **`matchRouteDeviceId` 及其 2 个用例被删**。理由见上表。若希望保留纯函数版本的路由匹配，可以让 `routeDeviceId` 先剥离 node 前缀再调它，但会引入一次前缀字符串处理，我认为不如直接用 `matchPath` 清晰。

5. **`apps/fe/src/main.tsx:81` 的 biome `useExhaustiveDependencies` 报错是既有问题**（`feat/hub-node` 与 `feat/sidebar-tabs-ui` 各自单独跑也报同一条，位置行号都是 81），`StatusBarSync` 那段我一行没动。`theme` 在依赖数组里是有意的（主题变了要重算 `getComputedStyle` 后的状态栏色），删掉会破坏暗色模式状态栏。建议保持现状或另开任务加 biome-ignore。

---

## 五、验收命令真实输出

```
$ cd apps/fe && bun test src/ 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5

 306 pass
 0 fail
 695 expect() calls
Ran 306 tests across 21 files. [636.00ms]

$ cd apps/fe && bunx tsc --noEmit -p . 2>&1 | grep "error TS" | wc -l
       0

$ cd packages/panels && bun test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5

 368 pass
 0 fail
 609 expect() calls
Ran 368 tests across 27 files. [262.00ms]

$ cd packages/panels && bunx tsc --noEmit -p . 2>&1 | grep "error TS" | wc -l
       0

$ cd packages/stores && bun test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5

 238 pass
 0 fail
 557 expect() calls
Ran 238 tests across 24 files. [85.00ms]

$ cd packages/stores && bunx tsc --noEmit -p . 2>&1 | grep "error TS" | wc -l
       1
```

stores 仅剩的 1 条与基线一致（两分支都有）：

```
src/host-services.test.ts(93,23): error TS2339: Property 'value' does not exist on type
'{ remove: Mock<...>; select: Mock<...> }'.
```

对照基线：

| 包 | hub-node | tabs | 合并后 | 结论 |
|---|---|---|---|---|
| apps/fe | 208 pass / tsc 0 | 109 / 0 | **306 / 0** | ≥ 两侧 |
| packages/panels | 217 / 0 | 347 / 0 | **368 / 0** | ≥ 两侧 |
| packages/stores | 125 / 1 | 214 / 1 | **238 / 1** | ≥ 两侧 |

biome（26 个改动文件）：

```
$ bunx biome check <改动文件…>
Checked 26 files in 10ms. No fixes applied.
Found 1 error.
```

唯一一条即第四节第 5 点的 `apps/fe/src/main.tsx:81 useExhaustiveDependencies`，为两分支既有问题、非本次改动引入（把两个分支各自的 `main.tsx` 单独拷出来跑 biome，同样各报 1 条）。除它以外，全部改动文件干净。

注：worktree 原本没有 `node_modules`，已执行 `bun install`（1286 packages）以便跑测试与类型检查；未做任何 git 操作。
