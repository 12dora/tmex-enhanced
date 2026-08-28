# 合并后前端两处组合缺陷的修复结果

分支 `chore/merge-hub-tabs`（合并提交 `d60bd42`），worktree `/Users/konata/code/tmex-enhanced-wt-merge`。
本次只改前端，未做任何 git 操作，未触碰 `apps/gateway`。

## 一、问题定位复述

两处缺陷都不是解冲突解错，而是 hub 的「多 node runtime」与 tabs 的「连接意图持久化」叠加后暴露的：

- **缺陷 1（blocker）**：`usePersistedDeviceIds(storageKey)` 用 `useState` 初值读键、用 `useEffect([storageKey, ids])` 写键。
  `NodeRuntimeBoundary` 没有 `key={nodeId}`，`/n/A/*` → `/n/B/*` 时组件树被 React Router 复用，
  `GlobalDeviceProvider` 不重挂：`storageKey` 已经是 B、内存里的 Set 还是 A，effect 立刻把 A 的意图写进 B 的键。
- **缺陷 2（major）**：mesh 下当前路由 node 的组件树里有**两份** `GlobalDeviceProvider`（路由层一份、
  侧栏 `SidebarNodeSection` → `NodeRuntimeScope` 一份），共享同一个 tmux store 与同一组 localStorage 键，
  却各自持有独立的 `useState` 意图集合。侧栏点断开只更新内层，外层 effect 因 `connectedDevices` 变化重跑、
  仍认为可自动订阅，立刻 `connectDevice` 连回来。

## 二、修法与取舍

### 核心决定：把连接意图从 React 组件状态提升为「按 storagePrefix 的模块级单一事实源」

新增 `apps/fe/src/components/device-intent-store.ts`：

- `DeviceIntentStore`：持有 `{ connected, disconnected }` 两个集合 + 自己的两个存储键。
  **写入永远落在本实例自己的键上**，调用方无从指定键 —— 结构上消灭了「集合来自 A、键指向 B」的错配。
  变更同步写回 localStorage 并通知订阅者（不再依赖 effect 写回）。
  快照对象只在意图真正变化时换引用，满足 `useSyncExternalStore` 的缓存要求。
- `deviceIntentStore(storagePrefix)`：模块级实例表，同 prefix 恒返回同一实例。
- `reconcileDeviceSubscriptions(store, known, connected, actions)`：把原来 effect 里的对账体抽成可无 React 测试的函数
  （先 prune 再读快照，用的永远是本 node 的意图）。
- `resetDeviceIntentStores()`：仅供测试重置实例表。

`GlobalDeviceProvider` 侧：

- `useDeviceIntent(storagePrefix)` = `deviceIntentStore(prefix)` + `useSyncExternalStore`。
  prefix 变了就换订阅源并读新源的快照，**不搬运旧集合、不写旧集合**；同 node 的多份 provider 拿到同一实例。
- `ensureDeviceSubscribed` 与路由自动订阅 effect 改为**从 store 现读**意图（而不是渲染期快照）：
  同一个 node 的另一份 provider 刚写下的显式断开，在本 effect / 本回调里必须已经可见。
- 渲染期用于 UI 的 `connection.status` / `isIntentionallyDisconnected` 仍用渲染快照（保持 React 渲染纯度）。

#### 取舍说明

**缺陷 1 的三个候选**：

| 方案 | 取舍 |
| --- | --- |
| hook 内感知 key 变化重读 | 需要在 render 里比对 prev key 并同步 setState，或再加一层 effect；仍然是「组件持有状态」，多 provider 场景照样错 |
| `NodeRuntimeBoundary` 加 `key={nodeId}` 重挂 | 能修缺陷 1，但会把整棵页面子树（含终端实例、Query 缓存消费者）在换 node 时全部重建，代价过大；且完全不解决缺陷 2 |
| **意图提升到 runtime/模块级（采用）** | 一处改动同时消灭两个缺陷；React 侧退化成纯订阅，逻辑可无 DOM 测试；代价是多一个模块级 Map |

**缺陷 2 的三个候选**：

| 方案 | 取舍 |
| --- | --- |
| 当前路由 node 的侧栏分节复用外层 provider | 需要在侧栏区分「当前路由 node」与「旁路 node」，`SidebarNodeSection` 得知道路由状态，耦合变重；且聚合视图里旁路 node 仍要自己的 provider，两条代码路径 |
| 让内外层通过 context 共享同一份 state | 等于在 React 里手搓单例，嵌套顺序一变就退化 |
| **按 nodeId 提升到模块级（采用）** | 与 provider 挂了几份、嵌套顺序如何无关；聚合视图里不同 node 各自成实例，隔离性不变 |

**对聚合视图的影响**：实例按 `storagePrefix` 分开（self 是空前缀，沿用旧键），多个 node 并存时互不可见，
离线 / 未登录 node 根本不挂 `NodeRuntimeScope`，不建连接不发请求 —— 这些行为一律未动。

**未削弱的既有行为（逐项确认）**：

- tabs：连接意图持久化（键名、载荷格式 `string[]`、self 空前缀）完全不变；显式断开抑制自动订阅仍生效
  （且现在跨 provider 生效）；`deriveDeviceConnectionStatus` 的状态优先级未动。
- hub：node 隔离（每 node 一个 runtime / QueryClient / storagePrefix）未动；`NodeRuntimeBoundary` /
  `NodeRuntimeScope` 结构未动；离线、未登录 node 的短路路径未动。
- 一处行为变化已核实无损：`ensureDeviceSubscribed` 的引用不再随 `connectedDevices` 变化。
  `connectedDevices` 在整个 stores 包里只由 `connectDevice` / `disconnectDevice` 增删
  （网关事件不会移除它），收缩只可能来自「用户显式断开」（被意图抑制）或「设备已从列表消失」
  （`devices` 本身变了，panels 的 effect 依旧会重跑）。因此 panels `sidebar-device-list.tsx`
  里那两个以 `ensureDeviceSubscribed` 为依赖的 effect 少跑的都是空跑。
  路由自动订阅 effect 则显式把 `connectedDevices` 留在依赖里，重跑时机与原来一致。

## 三、改动文件

| 文件 | 说明 |
| --- | --- |
| `apps/fe/src/components/device-intent-store.ts` | 新增。意图单一事实源 + 实例表 + 对账函数 |
| `apps/fe/src/components/global-device-provider.tsx` | 意图状态改为订阅模块级 store；自动订阅入口与路由 effect 改为现读意图；对账体外移 |
| `apps/fe/src/components/device-intent-store.test.ts` | 新增。无 React 的不变量回归测试 |
| `apps/fe/src/components/global-device-provider-shared-intent.test.tsx` | 新增。走真实组件树（静态渲染）的两缺陷回归测试 |

`device-connection-persistence.ts` / `device-connection-status.ts` 的纯函数与既有测试原样保留。

## 四、新增测试覆盖了什么

### 关于测试环境的限制（必须说明）

仓库没有 DOM 测试环境（无 happy-dom/jsdom，无 testing-library），既有 React 测试一律用
`react-dom/server` 的 `renderToStaticMarkup`，**effect 不会执行**，也无法「同一挂载重渲染」。
本次没有为此引入新依赖。应对方式是：把两个缺陷的判定逻辑下沉到可无 React 测试的 store / 纯函数层，
再用静态渲染跑真实组件树，断言 provider **对外暴露的意图与调用序列**（而不是 React 的调度细节）。
「重渲染」用「再渲染一次同样的树」建模。

另外发现一个测试相关事实：zustand 的 `useStore` 在 SSR 路径下读的是 `getInitialState()`，
所以静态渲染里 provider 拿到的 `connectedDevices` 恒为初始空集，且对 store action 的 `setState` 包装会被绕过。
调用序列因此改为在 `FakeTransport.send` 上记录 `connect-device` / `disconnect-device`，这反而更贴近真实链路。

### `device-intent-store.test.ts`（18 个用例）

- 实例表：同 prefix 同实例、不同 prefix 独立、self 空前缀沿用旧键名、从自己的键读初值。
- **场景一**：把 `storagePrefix` 从 A 切到 B（模拟 provider 不重挂、只是解析源换了）后，
  B 的两个存储键 raw 值逐字节不变、B 的快照来自 B 自己的存储；之后在 B 上操作只写 B 的键；
  切到 B 的对账只连 B 的设备（`['connect:dev-b1']`），不会拿 A 的意图去连。
- **场景二**：同 prefix 的两次取用是同一实例；一处 `markDisconnectIntent` 另一处的快照立即可见；
  显式断开后另一份 provider 的对账不会恢复订阅（调用序列为空）。
- 快照/持久化：无变化不换引用不通知、意图变化立即写回自己的键（不依赖 effect）、prune 的写回与引用稳定性。
- 对账：退订已消失设备 + 恢复仍存在的连接意图（`['disconnect:deleted', 'connect:dev-1']`）、已订阅不重复下发。

### `global-device-provider-shared-intent.test.tsx`（4 个用例，走真实 provider）

树形与生产一致：`RuntimeProvider` → `QueryClientProvider` → 外层 `GlobalDeviceProvider`（路由层）
→ 内层 `GlobalDeviceProvider`（侧栏 `NodeRuntimeScope` 那份，同一 runtime）。

- **场景二主用例**：设备页已订阅 `dev-1` → 侧栏 `connection.disconnect('dev-1')` → 重渲染 →
  路由层 `ensureDeviceSubscribed('dev-1')`。断言下发序列恰为 `['disconnect-device:dev-1']`
  （**`disconnect` 之后不再出现 `connect`**）、`connectedDevices` 不含 `dev-1`，
  且意图落在共享事实源上、路由层那份 provider 也报 `isIntentionallyDisconnected === true`、`status === 'disconnected'`。
- 抑制可撤销：侧栏重新 `connect` 后序列恢复 `['connect-device:dev-1']`，再调 `ensureDeviceSubscribed` 不重复下发。
- **场景一（provider 层）**：A 上的显式断开/连接立即写进 A 自己的两个键，B 的两个键 raw 值不变；
  B 的 provider 只采用 B 的意图（`dev-b2` 断开、`dev-a1` 不受影响）。
- 渲染本身不写任何连接意图键（写入只由显式意图触发）。

### 「测试确实能抓住这两个 bug」的实证

把 `global-device-provider.tsx` 临时换回 `d60bd42` 的版本（`git show d60bd42:...`，只做文件替换，未动 git 状态），
新测试**两个缺陷用例同时失败**，且失败点正是缺陷的表现：

```
141 |     const second = renderProviders(runtime);
142 |     second.route[0].ensureDeviceSubscribed('dev-1');
145 |     // 调用序列里 disconnect 之后不再出现 connect，订阅集合也不再含该设备
146 |     expect(transport.deviceCommands).toEqual(['disconnect-device:dev-1']);
error: expect(received).toEqual(expected)
@@ -2,3 +2,3 @@
     "disconnect-device:dev-1",
+    "connect-device:dev-1",
   ]

(fail) 缺陷 2：同一 node 的两份 provider 共享连接意图 > 侧栏显式断开后，路由层不会立刻把设备连回来
(fail) 缺陷 1：不同 node 的 provider 各用自己的意图与存储键 > A 上的意图不会进入 B 的存储键，也不会被 B 的 provider 采用
 2 pass
 2 fail
```

随后已还原为修复版本。

## 五、验收（真实输出）

```
$ cd /Users/konata/code/tmex-enhanced-wt-merge/apps/fe && bun test src/ 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5

 324 pass
 0 fail
 747 expect() calls
Ran 324 tests across 23 files. [720.00ms]

$ cd /Users/konata/code/tmex-enhanced-wt-merge/apps/fe && bunx tsc --noEmit -p . 2>&1 | grep "error TS" | wc -l
       0

$ cd /Users/konata/code/tmex-enhanced-wt-merge/packages/panels && bun test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5

 368 pass
 0 fail
 609 expect() calls
Ran 368 tests across 27 files. [292.00ms]

$ cd /Users/konata/code/tmex-enhanced-wt-merge/packages/stores && bun test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5

 238 pass
 0 fail
 557 expect() calls
Ran 238 tests across 24 files. [79.00ms]

$ cd /Users/konata/code/tmex-enhanced-wt-merge/packages/stores && bunx tsc --noEmit -p . 2>&1 | grep "error TS" | wc -l
       1

$ bunx biome check apps/fe/src/components/global-device-provider.tsx \
    apps/fe/src/components/device-intent-store.ts \
    apps/fe/src/components/device-intent-store.test.ts \
    apps/fe/src/components/global-device-provider-shared-intent.test.tsx
Checked 4 files in 20ms. No fixes applied.
```

对照基线：

| 项 | 基线 | 现在 |
| --- | --- | --- |
| apps/fe `bun test src/` | 306 pass / 0 fail | **324 pass / 0 fail**（+18） |
| apps/fe tsc | 0 | 0 |
| packages/panels | 368 pass / 0 fail | 368 pass / 0 fail |
| packages/stores | 238 pass / 0 fail | 238 pass / 0 fail |
| packages/stores tsc | 1 | 1（既有，`src/host-services.test.ts(93,23) TS2339`，与本次无关） |
| biome（改动文件） | — | 干净 |

## 六、遗留与建议（不阻塞）

1. **缺陷 1 的「同一挂载重渲染」这一步没有端到端的 React 级断言**，因为仓库没有 DOM 测试环境。
   现在锁住的是更强的结构性不变量（意图不在组件状态里、写入永远与读取同源同键），
   加上 provider 层的静态渲染断言。若后续引入 happy-dom，建议补一个真正「同一挂载切 nodeId」的渲染用例。
2. `NodeRuntimeBoundary` 依然没有 `key={nodeId}`。这是有意为之（避免换 node 时重建整棵页面子树），
   本次修复不再依赖重挂来保证正确性。
3. 意图 store 实例随进程常驻，不随 node runtime 回收释放。内容只有两个设备 id 集合，
   保留下来还能让短暂卸载后重挂的 provider 直接复用内存态；如果将来 mesh 规模很大再考虑随
   `NodeConnectionManager.onDispose` 一起释放。
