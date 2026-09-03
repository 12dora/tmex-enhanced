# ON 结果：F1 mesh 轮询 store 工厂 + R14 前端待机边角料

worktree `/Users/konata/code/tmex-r22`，未做任何 git 操作。

## 1. 基线（改动前实测）

| 项 | 值 |
|---|---|
| `cd apps/fe && bun test src/node src/pages/settings` | 1122 pass / 0 fail（46 文件） |
| `bunx tsc --noEmit -p .`（apps/fe） | 2 errors（`src/lib/sonner-notification-sink.ts:19` TS2349、`packages/ghostty-terminal/src/canvas-renderer.ts:25` TS6196，均非本任务文件） |
| `bun scripts/complexity/gate.ts` | 1 violation：`apps/gateway/src/mesh/peer-manager.ts` 1939 > 1930（并行 agent 的改动，非本任务） |

## 2. F1：`create-polling-store.ts` 抽取

新建 `apps/fe/src/node/create-polling-store.ts`（179 行），承载两份 store 逐处相同的部分：

- `createStateStore<TState>(initial, onReset?)` —— 模块级状态 + `useSyncExternalStore` 订阅面 + `set`（浅合并补丁并通知）+ `reset`（回初始状态、跑 `onReset` 清模块自己的在途标记、通知一次）。
- `startPollingLoop(timing, spec)` —— 选项缺省解析（`intervalMs` / `throttleMs` / `schedule` / `delay` / `visibility` / `now`）、`runRefresh` / `requestRefresh` 节流对（原 `requestRefresh` 两侧逐字相同）、「先接线事件源 → 首拉 → 装兜底定时器 + 可见性订阅」的顺序、隐藏页跳拍的可见性门、`intervalMs <= 0` 只走事件驱动的分支。分歧点由 `spec` 的三个可选钩子承载：`wire`（订阅哪些事件源）、`tick`（兜底拍做什么，缺省 `runRefresh`）、`onVisible`（回前台做什么，缺省 `requestRefresh`）。
- `createPollingHandle(start)` —— 单例引用计数（首个取用方的 options 定回路接线，归还幂等）。

`timing` 参数直接吃各 store 原本的扁平 options 对象（`PollingTimingOptions` 全部可选，非字面量传参不触发多余属性检查），所以两侧公开的 options 形状、缺省值、导出名一个没变。

两侧改造：

- `mesh-hubs.ts` 331 → **243**（−88）：删掉自己那份 `browserVisibility`（改用 `hub-polling.ts` 的导出）、store 脚手架、`requestRefresh`、`acquireXPolling`；`startPolling` 只剩 hub 特有的两条事件订阅（`onStatusChange` + 「已知 hub 机的 NODE_EVENT」）。
- `mesh-nodes.ts` 852 → **779**（−73）：同上，另保留 `unknownSeen` / `authSeen` 两个集合与 `sweep`（清集合再刷新）作为 `tick`，`onVisible` 保留 `staleMs` 过期判定，`wire` 保留三条订阅（status / nodeEvent / `authRequired`）。原 `startPolling` CC13 / 105 行降到 ~55 行。

行数账（生产代码）：删掉重复 161 行，新增共享模块 179 行，**净 +18**（1183 → 1201）。EX4 §3.2 预估的「消掉 ~160 行」指的是被删掉的重复量，抽出的模块本身要付类型声明与文档注释的成本，净额不为负——重复消除是真的（`requestRefresh`、引用计数、store 脚手架、`browserVisibility` 各只剩一份），但不要按净行数记账。

行为保持：

- 两份 store 的公开导出（`getMeshXState` / `subscribeMeshX` / `setMeshXStateForTest` / `resetMeshXStateForTest` / `acquireMeshXPolling` / `MeshPollingOptions` / `MeshHubsPollingOptions`）名称与签名不变，只是从 `function` 变成绑定到 store 方法的 `const`。
- 第二十一轮的两条语义原样保留：`useHubNode` 的兜底拍仍走 `hub-polling.ts` 的 `startHubPolling`（可见性门在那边，只读引用未改）；`patchNodesWithEvent` / `applyMeshNodeEvent` / `mergeNodes` / `findHubNodeId` 等纯函数一行未动，本地 hub 行提升后的不变量测试仍绿（`mesh-nodes.test.ts` 全量通过，未改任何断言）。
- 两份既有 spec（`mesh-hubs.test.ts` 345 行 + `mesh-nodes.test.ts` 1075 行）**未改一个字符**，全部通过。

新增 `apps/fe/src/node/create-polling-store.test.ts`（223 行，7 用例）直接覆盖工厂本身：订阅/退订、`reset` + `onReset`、首拉与隐藏跳拍、节流窗口内只排一次延时、`intervalMs<=0` 不装定时器、`onVisible` 的可见性门、引用计数与幂等归还。

## 3. R14：前端待机边角料

### 3.1 `index.css` 常驻 `will-change`（已改）

`.kb-floating-shortcuts` 的 `will-change: transform` 从常驻改为条件生效：

```css
.kb-floating-shortcuts[style*="--tmex-kb-shortcut-lift"]:not(
    [style*="--tmex-kb-shortcut-lift: 0px"]
  ) {
  will-change: transform;
}
```

理由与取舍：真正知道「键盘弹起没有」的是 `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts` + `utils/shortcut-lift.ts`，**不在本任务 ownership 内**；仓库里也没有现成的键盘态 data 属性可用（`use-keyboard-avoidance` 只读 `[data-virtual-keyboard-avoid]` / `[data-slot="sidebar-inset"]`，不写任何状态标记）。可用的现成信号是 `ShortcutLiftWriter` 写在该元素上的**行内**自定义属性：follow 模式抬起时写实际位移，`inset<=0`（键盘落下）时写回 `0px`，所以「行内有这个变量且不是 0px」等价于「快捷键栏当前浮着」。选择器退化方向是安全的——万一某引擎的行内序列化不带冒号后空格，`:not()` 不命中，结果回到今天的常驻 `will-change`，只会少省不会漏层。

如果后续有人接手 `packages/terminal-ui`，更干净的做法是让 `ShortcutLiftWriter` 顺带 toggle 一个 `data-kb-floating` 属性，CSS 换成属性选择器；本轮没动那个包。

（EX3 §5 提到的 `index.css:47`/`:56` 两个零引用 keyframes 已由并行 agent OJ 删除，本次未重复处理。）

### 3.2 设置子页 `refetchInterval`（结论：不需要改，未动代码）

逐个核对 EX3 §5 点名的位置：

| 位置 | 机制 | 判定 |
|---|---|---|
| `apps/fe/src/pages/settings/nodes/https/use-tls-status.ts:41` | 经 `use-protected-status-query.ts:102` 传给 react-query 的 `refetchInterval`（`acmePollInterval`，非 pending 时返回 `false`） | react-query 原生轮询，`refetchIntervalInBackground` 缺省即 `false`，后台不发请求。加可见性门属于**重复门控**，不加 |
| `apps/fe/src/pages/settings/remote-access/use-tunnel-status.ts:43` | 同上（`tunnelPollInterval`，2s/10s） | 同上，不加 |
| `packages/panels/src/files/use-directory-listing.ts`、`packages/panels/src/watch/use-watch-rules.ts` | 同为 react-query `refetchInterval` | 不在本任务 ownership（`packages/panels`），且判定同上 |

在 `apps/fe/src/pages/settings/**` 全量搜 `setInterval` / `setTimeout` / `requestAnimationFrame`，**没有绕过 react-query 的常驻周期定时器**：

- `nodes/management/use-node-upgrade.ts:1259` 是唯一的 `setInterval`，但只在 `batch.running`（批量升级进行中）时装，用途是给别的标签页续 `updatedAt` 心跳——这恰恰**必须**在页面隐藏时继续跑，加可见性门会让另一个标签页误判这批升级已经没人管，属于反向优化，不动。
- `restart/wait-for-restart.ts`、`nodes/copy-feedback.tsx`、`nodes/management/use-create-enrollment.ts`、`use-site-settings-save.ts`、`chunk-preload.ts` 的 `setTimeout` 都是一次性/用户动作触发，不是待机成本。

所以 R14 的第二条**没有可做的事**，本任务未修改任何 settings 文件。

## 4. 验收

| 项 | 基线 | 改动后 |
|---|---|---|
| `bun test src/node src/pages/settings` | 1122 pass / 0 fail | **1129 pass / 0 fail**（+7 为新增的工厂单测；既有断言一条未改、一条未删） |
| `bunx tsc --noEmit -p .` | 2 errors | **2 errors**（同两条既有错，均非本任务文件） |
| `bunx biome check`（5 个改动文件） | — | **通过**（`create-polling-store.ts` / `.test.ts` / `mesh-hubs.ts` / `mesh-nodes.ts` / `index.css`） |
| `bun scripts/complexity/gate.ts` | 1 violation（peer-manager 1939>1930） | **同一条，未增未减**；本任务的三个文件（243 / 779 / 179 行）全部远低于 900 行门槛 |

未跑 e2e（按要求）。

## 5. 改动文件清单

新增：
- `apps/fe/src/node/create-polling-store.ts`
- `apps/fe/src/node/create-polling-store.test.ts`

修改：
- `apps/fe/src/node/mesh-hubs.ts`（331 → 243）
- `apps/fe/src/node/mesh-nodes.ts`（852 → 779）
- `apps/fe/src/index.css`（`.kb-floating-shortcuts` 的 `will-change` 改条件生效）

只读参考、未修改：`apps/fe/src/node/hub-polling.ts`（`browserVisibility` / `PageVisibility` 现在由 `create-polling-store.ts` import）、`packages/terminal-ui/src/{hooks/use-keyboard-avoidance.ts,utils/shortcut-lift.ts}`、`apps/fe/src/pages/settings/**`。

## 6. 遗留 / 需要别人接手

1. **键盘 `will-change` 的干净做法**在 `packages/terminal-ui`（见 §3.1）：让 `ShortcutLiftWriter` 顺带 toggle 一个 data 属性，CSS 就不必靠行内 `style` 子串匹配。本轮受 ownership 限制没做。
2. **门禁那条 `peer-manager.ts` 1939 > 1930 违规**是并行 agent 的改动，需要对应 owner 处理（本任务未碰 gateway）。
