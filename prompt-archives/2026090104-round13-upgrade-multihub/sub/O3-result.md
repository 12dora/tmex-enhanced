# O3 结果 — 刷新后恢复升级状态 + 下载阶段「停止升级」

## 交付内容

### 1. 刷新后恢复在途升级（需求 1）

升级状态只活在 React 里，页面一刷新就退回「待升级」，而目标机还在下载/安装。新增：

- `restorableRows(rows)`（`use-node-upgrade.ts`）：筛出「在线 且（本机 或 已登录）」的行——其余行 `GET` 只会吃一条 401 / 离线错误。
- `restoreUpgradeStates(p)`：按行回读 `GET /api/mesh/nodes/:id/upgrade`，并发上限 `RESTORE_CONCURRENCY = 3`，全部挂在传入的 `AbortSignal` 上（signal 已 abort 时一次都不查）。**只有非 idle 的行交回调用方**；idle 的行一律不复活——`error === 'UPGRADE_CANCELLED'` 是良性结论，别的旧失败也没必要在刷新后再报一次。`skip(nodeId)` 让本会话已经有升级在跑的行直接跳过。
  复用既有的 `io.poll`（就是同一个 GET），没有另加 `status()` 方法。
- `resumeNodeUpgrade(p)`：**不重发 POST**（目标正在升级，再来一次只会撞 `UPGRADE_IN_PROGRESS`），先把回读到的 `{state, targetVersion}` 写回表格，再以 `sawActive: true` / `unconfirmedStart: false` 调 `watchUpgrade`，之后的 done / failed / timeout / 已取消处理与正常路径完全共用 `reportResult`。
- hook 里一个 effect 驱动：`rows` 每次刷新都换引用，靠 `restoredRef`（已回读过的 nodeId 集合）保证**只查新出现的行**，因此「挂载时」与「列表新增节点时」是同一条代码路径，重复渲染是纯 no-op（不 setState，不会自激）。

### 2. 「已取消」是良性结论（需求 1、3）

- 新增 `UpgradeWatchResult` 的 `{ kind: 'stopped' }`：`settleIdle` 见到 `idle + error === 'UPGRADE_CANCELLED'` 时返回它（在原来的「idle 上还挂 error 就是失败」判定**之前**）。
- `reportResult` 的 `stopped` 分支：`patch({ phase:'idle', targetVersion:null, error:null })` + `toast.info(nodes.upgrade.cancelled)` + 刷新列表。绝不弹失败 toast，也不留 `failed` 痕迹。
- `outcomeOf()` 把 `stopped` 映射成 `UpgradeRunOutcome` 的 `'cancelled'`，供批量统计。
- 覆盖两条路径：本页点了停止（DELETE 200 → 直接掐轮询）与**别处**取消（另一个标签页 / 另一台入口 → 轮询自己发现 `UPGRADE_CANCELLED`）。

### 3. 每节点一把 AbortController + `cancel(row)`（需求 2）

- `createNodeAbortRegistry()`：`open / stop / release / stopAll`。hook 级那把 controller 只管「组件是否还活着」与 DELETE / 回读请求；每一次升级在 `runExclusive` 里领一把自己的，`finally` 里 `release`（`release` 只摘自己那把，不会误停后一次升级新开的 controller）。卸载时 `stopAll()`。
  → 停一行不波及同批的其他节点；批量调度用 hook 级 signal，某一行被停掉后批量照常推进下一个。
- `cancelNodeUpgrade(p)`：`io.cancel` → `DELETE /api/mesh/nodes/:id/upgrade`
  - `200` → `stopWatch()`（掐这一行的轮询）→ `patch({phase:'idle', targetVersion:null, error:null})` → `toast.info(cancelled)` → `onChanged()`（刷新列表），返回 `'cancelled'`。
  - `409 UPGRADE_NOT_CANCELLABLE` → `toast.warning(cancelNotAllowed)`，**不动状态、轮询继续**。
  - `501 UPGRADE_CANCEL_UNSUPPORTED` → `toast.warning(cancelUnsupported)`，轮询继续。
  - `409 UPGRADE_NOT_RUNNING` → `toast.info(cancelNotRunning)`（升级已经自己结束了，不是错误），轮询继续（它马上会自己收尾）。
  - 其余 → `toast.error(cancelFailed:{error})`，`error` 走既有 `upgradeErrorText` 映射表，轮询继续。
- `UpgradeIo` 扩展 `cancel(nodeId, signal): Promise<UpgradeCancelOutcome>`，`UpgradeCancelOutcome = { kind:'cancelled'; status } | { kind:'failed'; code; httpStatus }`（与 G7 契约一致；`httpStatus` 只用于诊断，判定一律看 `code`）。默认实现 `requestUpgradeCancel`：网络异常 → `NODE_UNREACHABLE`；200 但回包读不出来仍按已取消处理。

### 4. 「停止升级」按钮（需求 3）

`nodes-table.tsx` 新增 `UpgradeCancelButton`，紧跟在行内「升级」按钮之后（进度文案就在那颗按钮上）：

- 只在 `isUpgradeBusy(phase)` 时渲染；`idle / done / failed` 时**整个按钮不出现**。
- `pending` / `downloading` → 可点，`title` / `aria-label` =「停止升级」。
- `executing` / `restarting` → 按钮在但禁用，`title` =「正在安装，无法中断。」——半路掐掉安装会留下一台装坏的机器。
- `data-testid="node-upgrade-cancel-<id>"`，`size="icon-xs"`，图标 `Square`。

### 5. 批量统计增加「已取消」一档（需求 3）

- `UpgradeBatchSummary` 新增 `cancelledCount: number`（原有的 `cancelled: boolean` 语义不变，仍表示「组件卸载导致结论不完整」）。`tally` 里 `cancelled` outcome 计入 `cancelledCount`，仍不算成功也不算失败。
- `reportBatchSummary`：`cancelledCount > 0` 时改弹新键 `nodes.upgrade.allDoneWithCancelled`（「成功 X，失败 Y，已取消 Z」），无失败时 `info`、有失败时 `warning`；`cancelledCount === 0` 时行为与之前**逐字不变**（`allDone` / `allDoneWithFailures`）。

### 6. 工具栏在恢复期间禁用（需求 4）

`NodeUpgradeController` 新增 `restoring: boolean`（hook 里用计数器，允许多轮回读叠加）。`UpgradeAllButton` 的 `disabled` 加上它，`title` 优先级为 `restoring` >「已有节点在升级」> latest 未知 > 无候选 > 正常提示。

### 7. i18n（需求 5）

`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的 `translation.nodes.upgrade` 子对象（**只动这一处**）新增 8 个键：
`allDoneWithCancelled`、`cancel`、`cancelled`、`cancelNotAllowed`、`cancelUnsupported`、`cancelNotRunning`、`cancelFailed`、`restoring`。
zh_CN 为源语言，按 `tmex-copy-guidelines.md`：无第二人称、全角标点、数字两侧半角空格、按钮 Title Case（en）。已从仓库根跑 `bun run build:i18n`（生成文件未手改）。

## 文件清单

改动：
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`
- `apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts`
- `apps/fe/src/pages/settings/nodes/management/types.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `nodes.upgrade` 子对象）
- `packages/shared/src/i18n/{resources.ts,types.ts}`（`build:i18n` 生成）

未新增文件；`apps/gateway/**`、`packages/api-client/**`、其他 FE 文件一律未碰。

## 验证

| 项 | 之前 | 之后 |
|---|---|---|
| `cd apps/fe && bun test src/` | 1205 pass / 0 fail（77 文件，3388 expect） | **1225 pass / 0 fail**（77 文件，3448 expect） |
| `bunx tsc --noEmit -p apps/fe` | 0 | **0** |
| `bunx tsc --noEmit -p packages/shared` | 0 | **0** |
| `bunx biome check apps/fe/src/pages/settings/nodes/management/ packages/shared/src/i18n/locales/` | clean | **clean**（16 文件，`--write` 只动过自己文件的格式） |

新增 20 条测试：

`use-node-upgrade.test.ts`（14 条）
- `restorableRows`：离线 / 未登录远端剔除，本机即使 `loggedIn=false` 也保留。
- `restoreUpgradeStates`：downloading / executing 交回调用方，`idle` / `idle+UPGRADE_CANCELLED` / `idle+其他 error` / `unreachable` 一律不复活；不可查的行连 GET 都不发；`skip` 生效；并发上限 3（gate 逐个放行断言）；signal 已 abort 时零请求。
- `cancelNodeUpgrade`：200 / 409 NOT_CANCELLABLE / 501 UNSUPPORTED / 409 NOT_RUNNING / 其他错误五条路径的 toast、patch、`stopWatch`、`onChanged` 断言。
- `createNodeAbortRegistry`：停一行不影响另一行、`stopAll` 全停、`release` 不误停下一把 controller。
- `reportBatchSummary`：只有取消时 `info`、既有失败又有取消时 `warning`。
- 既有 3 处 summary 断言补上 `cancelledCount`（其中「成败统计」那条现在断言 `cancelled` 计入 `cancelledCount: 1`）。

`nodes-management.test.tsx`（6 条）
- 静止阶段没有停止按钮；`pending`/`downloading` 可点且 `title=nodes.upgrade.cancel`；`executing`/`restarting` 禁用且 `title=nodes.upgrade.cancelNotAllowed`。
- `restoring: true` 时「全部升级」变灰且 `title=nodes.upgrade.restoring`。
- 轮询见到 `idle + UPGRADE_CANCELLED`：outcome `'cancelled'`、一条 `info`、patch 回 idle、刷新列表，**没有失败 toast**。
- `resumeNodeUpgrade` 正常路径（不发 POST，阶段 `downloading → executing → restarting → done`）与「恢复后又吃到已取消」。

未跑 Playwright e2e（按 spec）。

## 需要指挥者注意

1. **`useNodeUpgrade` 签名变了**：`useNodeUpgrade(rows, onChanged, io?)`（rows 排第一）。全仓唯一调用方是 `nodes-management.tsx`，已同步。传 rows 是为了驱动刷新后的状态回读。
2. **`UPGRADE_CANCELLED` 目前是 FE 本地常量**（`use-node-upgrade.ts` 的 `UPGRADE_CANCELLED_ERROR`）。G7 会把它加进 `packages/shared/src/contracts/system.ts`；两边合并后建议把这个 const 改成从 `@tmex/shared` import，去掉重复定义。我不能碰 shared contracts，所以留在这里。
3. **`NodeUpgradeController` 新增两个成员**（`cancel`、`restoring`）、**`UpgradeIo` 新增 `cancel`**、**`UpgradeBatchSummary` 新增 `cancelledCount`**。任何别处构造这些对象的地方都要补字段——已确认全仓只有本目录内的文件用到它们。
4. **有失败又有取消时汇总 toast 不再列失败节点名**：`allDoneWithCancelled` 只报三个数（「成功 X，失败 Y，已取消 Z」）。这是为了满足「keep the existing keys and add one」——`allDoneWithFailures` 没有 `{{cancelled}}` 占位，硬塞会变成两条 toast 或两个新键。失败的行在表格里仍标着 `failed` + 具体原因。若要在这一档也带名单，加第二个键即可。
5. **`bun run build:i18n` 已在收尾时跑过**；若其他 agent 之后还改 locale JSON，合并前**再跑一次**，否则 `resources.ts` / `types.ts` 会落后。
6. **没做真机截图核对**：G7 的 `DELETE /api/mesh/nodes/:id/upgrade` 尚未落地（`G7-result.md` 在我收尾时还不存在），起临时实例点停止按钮只会吃 404。合并 G7 之后建议做一次联调：下载中刷新页面（应保留「下载中」并继续推进）、下载中点停止（应变回「升级」且弹「已取消」）、安装中点停止（按钮应是灰的）。
7. **`restoredRef` 只记「查过一次」**：节点掉线再上线不会重新回读。这符合 spec 的「mounts + 列表新增节点时」，但如果之后想让「节点重新上线」也触发回读，改成按 `id + online` 组合记账即可。

## 风险

- 恢复靠的是后端 `GET` 的**当前**状态，没有持久化历史：如果刷新恰好落在「目标已重启完、状态回 idle 但节点列表版本号还没更新」的窗口里，这一行会保持静止态、不弹成功提示——与既有的「结果未确认」策略一致，不会误报失败。
- 停止按钮点下去到 DELETE 回包之间没有加载态（按钮仍可点）；重复点最多是多发一次 DELETE，第二次会拿到 `UPGRADE_NOT_RUNNING` 并只弹一条 info。若嫌吵，可在行 entry 上加个 `cancelling` 标记，当前刻意没加以免多一份状态。
- `runExclusive` 的去重分支返回 `'cancelled'`，现在会计进 `cancelledCount`。在 O1 建立的「行内 ⇄ 批量双向互斥」下这条分支在批量路径上不可达（`startAll` 见到任何行内任务就直接拒绝），因此不会污染汇总数字。
