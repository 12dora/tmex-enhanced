# P3b 执行结果 —— 设备行 / 卡片改按设备订阅连接态

## 结论

X4 报告的第 3、6、7 项均已核实并修复。第 3 项在读代码后发现真正的放大器不止「适配器每次换身份」一条：
`useDeviceTreeNavigationApi` 订阅了整张 `snapshots`，而它在 `SideBarDeviceList` 里被调用——终端每输出一次，
整棵侧边栏设备树就重渲染一遍（代码里第 156 行的注释本身就承认了这点）。第 6 项的修复顺带把它一并解决。

`packages/stores/src/tmux-event-router.ts` **没有改**：事件里 `{...prev.deviceConnected, [id]: true}` 这种整表克隆
是 zustand 顶层 state 的必然写法，改成按设备分表要动整个 tmux store 与所有消费方。改完之后所有读取都走
按设备选择器（返回的是字符串 / 布尔），整表换新引用不会再引起任何重渲染，克隆本身是 O(设备数) 的一次浅拷贝，
不值得为它做大改。

## 改了什么

### 1. 连接适配器身份恒定 + 按设备的状态选择器（X4 第 3 项）

- 新增 `apps/fe/src/components/device-status-store.ts`：`DeviceStatusStore`。快照在 provider 的**渲染期**写入
  （读取立刻可见，SSR 也拿得到最新值），变更通知留到**提交后**（`notifyChanged`，挂在无依赖数组的 `useEffect` 上）
  按设备派发——只唤醒「推导出来的 status / 主动断开位真的变了」的那几台。
- `global-device-provider.tsx`：`useDeviceConnectionAdapter` 不再每次把整套快照闭包进新对象，改成 memo
  `[store, connect, disconnect]`（三者都恒定）→ **适配器与 context 值身份恒定**。适配器新增 `subscribe(deviceId, cb)`。
- `packages/panels/src/device-connection.ts`：`DeviceConnectionAdapter` 增加**必填**的 `subscribe`（故意必填：
  只有两处构造点，漏实现会在编译期报错，而不是运行时静默变成读不到更新的死值），并提供两个
  `useSyncExternalStore` 选择器 hook：`useDeviceConnectionStatus(connection, deviceId)` /
  `useDeviceIntentionallyDisconnected(connection, deviceId)`（都带 server snapshot，SSR 测试照旧）。
- 消费方改用 hook：`device-tree/device-row.tsx`、`device-management/device-card-connect-toggle.tsx`、
  `device-console/device-console.tsx`。

  **device-console.tsx 超出了任务给的文件清单，但必须改**：适配器身份稳定之后，`useConsoleTargets` 并不订阅
  `connectedDevices`，如果控制台继续在渲染期直接 `connection.isIntentionallyDisconnected(...)`，用户在
  「你已主动断开」占位页上点「连接」后，占位页要等设备真正连上才会消失（今天是立刻消失）——即一处可见的行为回归。
  改动只有 2 行（import + 一行调用），语义与旧写法逐字等价（`deviceId` 缺省传 `''`，`Set.has('')` 恒为 false）。
  没有别的 agent 认领 device-console；`device-card-connect-toggle.tsx` 同理（device-card 的按钮，同一处接线）。

- `sidebar-device-list.tsx` **未改**：它本来就把 `connection` 原样透传给 `DeviceRow`，适配器身份稳定后
  `React.memo` 自然生效，没有需要动的接线。

### 2. 设备卡片记忆化 + 稳定的按卡片 props（X4 第 3 项后半）

- `device-grid.tsx`：`SortableDeviceCard` 包 `React.memo`；宿主每次渲染都新建 `card` 字面量，这里按四个字段
  （queryKey / nodeContext / connection / offline）`useMemo` 锁住引用。
- `device-card.tsx`：`DeviceCard` 包 `React.memo`。
- 首屏 stagger 期间 `staggerStyle()` 会返回新对象，那一段仍会整体重渲染；入场动画结束后它恒为 `undefined`，
  稳态下 memo 全程生效。这是既有的入场动画实现（`use-device-management-state.ts` 不在范围内），未动。

### 3. 设备树导航只订 pending 目标设备（X4 第 6 项）

- `device-tree-navigation.ts`：`createPendingNavigationSlot` 增加 `onChange`（写入 / 清空 / TTL 过期都回调），
  `usePendingNavigationSlot` 据此多导出一位 `targetDeviceId` 状态；hook 由
  `useTmuxStore((s) => s.snapshots)` 改为 `useTmuxStore((s) => targetDeviceId ? s.snapshots[targetDeviceId]?.session?.windows : undefined)`。
- 落定 effect 的 `lookupWindows` 加了 `deviceId === targetDeviceId` 的守卫（槽位与状态若有一帧不同步，
  只会退化成 `waiting`，绝不会导航到错误的设备）。路由离开即作废 pending 的行为与其全部单测原样保留。
- 副作用（也是本项最大的收益）：`SideBarDeviceList` 不再随每次终端输出重渲染。

### 4. 分组树 context 不再挂整个 props（X4 第 7 项）

- `device-folder-tree.tsx`：`TreeContextValue.props` 拆成实际用到的三项 `renderNode` / `nodeDraggable` / `nodeLabel`，
  memo 依赖改成这三项，消费方（`NodeItem` / `DragPreview`）随之解构。父组件传别的 props 时 context 身份不再翻新。

## 度量

脚本：`/private/tmp/claude-501/.../scratchpad/p3b-device-status.bench.ts`、`p3b-row-render.bench.tsx`（临时，未入库）。

**一条设备状态事件波及多少行**（500 行挂载、5000 条事件）：

| | 行失效次数 | 派发耗时（不含 React 重渲染） |
|---|---:|---:|
| before（每次事件换新适配器 → 每行重读） | 2,500,000 | 123.6 ms |
| after（`DeviceStatusStore` 按设备唤醒） | 5,000 | 150.5 ms |

派发本身两者都是 O(订阅设备数)，after 略贵（多比一位「主动断开」）；**省掉的是 React 的重渲染与协调**，
用 SSR 近似量一下这部分：

| | 一条状态事件要渲染的行 | 耗时 |
|---|---:|---:|
| before | 20 行全渲染 | 3.01 ms |
| after | 只渲染那一行 | 0.19 ms |

即 20 台设备的侧边栏，每条连接事件从 ~3.0 ms 降到 ~0.19 ms（约 1/16）；行数越多差距越大（before 线性增长，after 恒定）。
另外 `SideBarDeviceList` 不再订阅整张 `snapshots`，终端输出（每秒可能几十上百帧）不再触发这棵树的渲染，这一项没有单独计时
——它把一整类重渲染直接归零了。

## 测试 / 校验

| 包 | bun test | 基线 | tsc | 基线 |
|---|---|---|---|---|
| apps/fe | **876 pass / 0 fail** | 866/0 | **0 error** | 0 |
| packages/panels | **604 pass / 0 fail** | 580/0 | 1 error | 0 |
| packages/stores | **327 pass / 0 fail** | 321/0 | 1 error | 1 |

- panels 的那 1 个 tsc 错误在 `src/agent/composer-isolation.test.ts:72`（`SessionInProgress` 缺 `toolCalls` / `staleBarrier`），
  是 P1b 正在并行编辑的文件，与本任务无关；我改的文件全部 0 error。stores 的 1 个是既有基线
  （`src/host-services.test.ts:93`），stores 我一个字都没改。
- `bunx biome check <改动文件>` 全绿。
- 未跑 Playwright e2e（按要求）。

新增 / 扩充的测试：

- `apps/fe/src/components/device-status-store.test.ts`（新增，7 例）：**20 台设备挂监听、一条状态事件只唤醒 1 个**；
  意图断开同样只唤醒那一台；快照换新引用但推导值没变 → 一个都不唤醒；渲染期写入的快照立刻可读；
  退订幂等；同设备多监听者都唤醒；pending → connecting → 落定各唤醒一次。
  **仓库没有 DOM 测试环境**（无 happy-dom / testing-library，且不许加依赖，既有测试全靠 `renderToStaticMarkup`，
  effect 根本不执行），无法真的挂载 20 行再驱动一次更新数「重渲染次数」。这里把它换成等价且更精确的断言：
  每个挂载的 DeviceRow / DeviceCard 通过 `useSyncExternalStore` 恰好登记一个监听者，「只唤醒 1 个监听者」
  就是「只重渲染 1 行」。这一点已在文件头注释里写明。
- `device-row.test.tsx`：+2 例——连接态按设备从适配器读取（`data-status="reconnecting"`，同时喂入另一台设备的
  不同状态）；主动断开的设备展开也不渲染子树。
- `device-card.test.tsx`：+1 例——`DeviceCard` 必须是 memo 组件（`$$typeof === Symbol.for('react.memo')`），
  防止顺手拆掉；`stubConnection` 补上 `subscribe`。
- `device-tree-navigation.test.ts`：+1 例——`onChange` 在写入 / 覆盖写入 / TTL 过期 / 清空四种路径上都回调
  （目标设备 id 靠它跟上槽位，订阅方才敢只订那一台）。

## 行数

生产代码净 **+165 行**（其中新文件 `device-status-store.ts` 74 行、`device-connection.ts` 的接口与两个 hook +41 行），
测试净 **+199 行**。比 X4 估的 +25~60 多，多出来的基本就是那两块：一个按设备的通知表，加一对
`useSyncExternalStore` 选择器 hook——没有它们就只能在「适配器换身份」和「状态读不到更新」之间二选一。
没有引入任何为将来准备的抽象。

## 文件清单

改动：

- `apps/fe/src/components/global-device-provider.tsx`
- `apps/fe/src/components/device-status-store.ts`（新）
- `apps/fe/src/components/device-status-store.test.ts`（新）
- `packages/panels/src/device-connection.ts`
- `packages/panels/src/device-tree/device-row.tsx`、`device-row.test.tsx`
- `packages/panels/src/device-tree/device-tree-navigation.ts`、`device-tree-navigation.test.ts`
- `packages/panels/src/device-management/device-grid.tsx`、`device-card.tsx`、`device-card.test.tsx`、`device-card-connect-toggle.tsx`
- `packages/panels/src/device-folders/device-folder-tree.tsx`
- `packages/panels/src/device-console/device-console.tsx`（**超出清单**，理由见上）

未改（说明在上）：`packages/stores/src/tmux-event-router.ts`、`packages/panels/src/device-tree/sidebar-device-list.tsx`。

## 风险 / 留意

1. **`DeviceConnectionAdapter.subscribe` 改成了必填**。当前仅两处构造点（fe 的 provider、device-card 的测试桩），
   都已补齐；新增宿主实现时编译期就会被拦下。
2. **通知走 `useEffect`（提交后）**，比旧写法晚一个提交批次。读取（`status` / `isIntentionallyDisconnected`）
   走渲染期就写好的快照，任何原因触发的重渲染都读得到最新值，所以只影响「谁被唤醒」的时机，
   不会出现读到旧值的窗口。React 18/19 会在同一帧内处理完 effect 触发的 setState，肉眼无差别。
3. **同一个 node 挂多份 provider**（路由层 + 侧栏聚合视图）时每份各有一个 `DeviceStatusStore`，
   但它们订阅的是同一份 tmux store / 意图 store / 在飞请求表，因此会同时重渲染并各自派发，行为一致。
4. `notifyChanged` 是 O(当前有监听者的设备数)/次提交。500 台设备实测 ~30 µs/次，远低于一次 React 提交，
   没有做增量 diff（那需要对 4 张表 + 2 个集合做差，同样是 O(n)，只会更啰嗦）。
5. 设备卡片网格在**首屏 stagger 动画期间**仍会整体重渲染（`staggerStyle` 每次返回新对象），动画结束后恢复
   memo。要彻底消掉需要改 `use-device-management-state.ts` 的 stagger 实现（不在范围内，且只影响首屏那一秒）。
