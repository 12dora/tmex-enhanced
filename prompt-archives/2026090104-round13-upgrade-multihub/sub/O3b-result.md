# O3b 结果 — 修 RV5 对 Nodes 页取消 / 恢复的 6 项发现

对应 RV5-5、RV5-7、RV5-8、RV5-9、RV5-10、RV5-11。全部先补测试再实现，测试均验证过「拿掉实现就会红」。

## 1. RV5-5 —— `pending`（POST 在途）时按停止不再形同虚设

**问题**：FE 在 POST 发出前就进入 `pending` 并把这一行显示为可停止。后端 POST 在注册 controller / job 之前还要等 latest 与目标 info，这段时间 DELETE 拿到的是 `UPGRADE_NOT_RUNNING`；老实现只弹一条 info，既不 abort POST 也不改状态，POST 随后照常把升级跑起来——**按了停止仍升级**，可稳定复现。

**做法**：把「停止」与 POST 的先后关系显式记账，不再靠时序碰运气。

- 新增 `createUpgradeCancelGate()`（纯对象，可单测）：
  `request(id)` → `'send'`（POST 不在途，立刻发 DELETE）/ `'defer'`（POST 在途，先记账）/ `'busy'`（已有一次在途）；
  `beginStart` / `endStart`（POST 收尾时取走并清掉记账，只返回一次）/ `pending` / `deferIfStarting` / `finish` / `cancelling`。
- `runNodeUpgrade` 新增可选 `handoff: UpgradeStartHandoff`（`begin` / `pending` / `settle(live)`）：
  POST 发出前 `begin()`；POST 落地后按结论分流——
  - `started` / `unconfirmed` → `settle(true)`：**立刻补发一次** `cancel(row)`，结果按常规处理（200 → idle +「已取消」；409 `UPGRADE_NOT_CANCELLABLE` → warning 并继续轮询；501 → warning 并继续轮询）。补发成功时 `runNodeUpgrade` 直接返回 `'cancelled'`。
  - `failed` / `alreadyLatest` / `cancelled` → `settle(false)`：不发 DELETE，只把记账与 `cancelling` 清掉，行为与今天一致。
  - `io.start` 抛异常也走 `settle(false)` 后再抛，记账不会漏。
- 用户已经按下停止时，`reportStart` 静音「已开始升级到 x」/「无法确认是否已开始」两条提示（`quiet` 参数）：失败与「已是最新」仍照常提示。按下停止后先弹一条 success 再弹「已取消」只会让人以为没停住。
- 残余竞态兜底：`cancelNodeUpgrade` 拿到 `UPGRADE_NOT_RUNNING` 时先问 `retry?.()`（hook 接 `gate.deferIfStarting`）——若此刻 POST 仍在途，说明「只是早了一步」，改成排队等 POST 落地再补一次，返回新的 `'deferred'`，**不弹 info**。

**测试**（`POST 在途时按下「停止升级」` describe，复刻 hook 的 gate + handoff 接线）：
POST 在途按停止 → 记账不发 DELETE、连点只记一次 → POST 落地后 `cancel` 恰好被调用**一次**、行回到 `{phase:'idle', cancelling:false}`、只剩一条「已取消」；POST 落地即失败 → 不补发、记账清空；补发被 409 拒 → 继续轮询，不谎报已取消。

## 2. RV5-11 —— `cancelling` 状态

`NodeUpgradeEntry` 新增与阶段无关的 `cancelling: boolean`（`IDLE_UPGRADE_ENTRY` 补 `false`）。

- hook 的 `cancel(row)` 先过 gate：`'busy'` 直接返回（双击不会发第二条 DELETE），否则 `patch({cancelling:true})`；`'defer'` 就此打住，等 handoff 补发。
- DELETE 收尾（非 `deferred`）时 `gate.finish` + `patch({cancelling:false})`。
- `nodes-table.tsx`：停止按钮在 `cancelling` 时禁用、图标换成转圈的 `Loader2`、`title` 用新键 `nodes.upgrade.cancelling`（「正在停止升级…」）。

## 3. RV5-7 —— 多轮恢复共用一把并发闸

原来每次 `rows` 新增都独立起一个 3 worker 的池，两轮叠加就是 6 个并发 GET。

- 新增 `createSemaphore(limit)`：名额在 `release` 时**直接交棒**给队首（不还回池子），并且有人排队时新来的一律排队，杜绝插队冲破上限。
- `restoreUpgradeStates` 改为 `rows.map(row => gate.run(...))`，`gate` 由参数传入；hook 用 `useRef(createSemaphore(RESTORE_CONCURRENCY))` 全局一把。不传 `gate` 时按 `concurrency` 现开一把（既有测试不动）。

**测试**：第一轮 4 台还没回包时第二轮再来 3 台，全程 `peak === 3`。

## 4. RV5-8 —— 恢复与行内 / 批量启动严格互斥

- `NodeUpgradeController` 新增 `restoringIds: ReadonlySet<string>`；`restoring` 改为由它派生（`size > 0`），去掉原来的计数器。节点在**入队时**就进集合，各自回读收尾时移出（`restoreUpgradeStates` 新增 `onSettled(nodeId)`，`finally` 里调用，跳过的行也不例外）。
- 行内「升级」按钮：`restoringIds.has(row.id)` 时禁用，`title` =「正在同步升级状态…」；`launchRowUpgrade` 新增 `restoring` 门禁，程序化调用同样不受理。
- `launchUpgradeBatch` 新增 `restoring` 门禁：非空即整批让路，并弹一条 info（`nodes.upgrade.restoring`）。
- 抢跑兜底：新增 `createResumeQueue({busy, resume})`。`onActive` 交给它——这一行空着就直接接手，被行内 / 批量占着就**排队**；`runExclusive` 收尾时 `release(id, outcome)` 把排队的放出来接上 watcher。若这次升级自己就是 `done` / `alreadyLatest`，排队的接手作废（回读到的状态已经过时，再接会重复报成功）。

**测试**：行内占用 → offer 排队且只接手一次；`done` 结论下作废；空闲时直接接手。加上「每一行都收尾一次」的 `onSettled` 测试与两条 `restoring` 门禁测试、一条表格渲染测试（`restoringIds` 只锁住那一行）。

## 5. RV5-9 —— 成员集变化后重新回读

新增 `retainKnownIds(seen, rows)`：只保留还在 `rows` 里的 id。恢复 effect 每次先剪一遍 `restoredRef`，节点从列表消失后以相同 id 回来会重新回读。**只是离线 / 掉登录**（仍在 `rows` 里）不重复回读，与 O3 既定取舍一致。

## 6. RV5-10 —— 旧版本的 DELETE 回法

`cancelNodeUpgrade` 在 `code` 没命中已知映射时按 HTTP 状态兜底：`404` / `405` / `501` 一律 warning「该节点版本不支持中断」并继续轮询，不再退化成通用失败 toast。已知 `code`（`UPGRADE_NOT_CANCELLABLE` / `UPGRADE_CANCEL_UNSUPPORTED` / `UPGRADE_NOT_RUNNING`）优先级更高，不受影响。

> 与并行落地的 G7b 契约一致：`501 UPGRADE_CANCEL_UNSUPPORTED` 现在也可能在 push **之后**出现（目标缺 `'upgrade-cancel'` 能力），FE 的处理与 push 之前完全相同（warning + 继续轮询）；`409 UPGRADE_NOT_CANCELLABLE`（目标已在安装）同理。无需再改。

## 文件清单

改动（均在授权范围内）：

- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.test.ts`
- `apps/fe/src/pages/settings/nodes/management/types.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `translation.nodes.upgrade` 子对象，新增 1 个键 `cancelling`）
- `packages/shared/src/i18n/{resources.ts,types.ts}`（`bun run build:i18n` 生成，未手改）

未改：`upgrade-batch.ts`、`nodes-management.tsx`（本轮无需改动），`apps/gateway/**`、`packages/api-client/**` 一律未碰。未跑任何 git 命令。

## 验证

| 项 | 之前 | 之后 |
|---|---|---|
| `cd apps/fe && bun test src/` | 1225 pass / 0 fail（77 文件，3448 expect） | **1244 pass / 0 fail**（77 文件，3527 expect） |
| `bunx tsc --noEmit -p apps/fe` | 0 | **0** |
| `bunx tsc --noEmit -p packages/shared` | 0 | **0** |
| `bunx biome check apps/fe/src/pages/settings/nodes/management/ packages/shared/src/i18n/locales/` | clean | **clean**（16 文件；`--write` 只作用于自己的文件） |

新增 19 条测试。为确认不是空测试，临时禁掉三处实现（handoff 的 `settle(true)` 补发、`retainKnownIds` 调用、`CANCEL_UNSUPPORTED_STATUS` 集合）后重跑：3 条新测试立刻变红（补发路径 2 条 + 404/405/501 兼容 1 条），随即完整还原并复跑全绿。

## 需要指挥者注意

1. **`NodeUpgradeEntry` 新增 `cancelling`、`NodeUpgradeController` 新增 `restoringIds`**：任何别处构造这两个对象的地方都要补字段。已确认全仓只有本目录内的文件用到（`apps/fe` 之外只有 `packages/app/resources/fe-dist` 的构建产物）。
2. **`launchUpgradeBatch` / `launchRowUpgrade` 各新增一个必填参数 `restoring`**，`UpgradeRestoreParams` 新增可选 `gate` / `onSettled`，`cancelNodeUpgrade` 返回值多一档 `'deferred'`（类型 `UpgradeCancelResult`）、新增可选 `retry`。全部调用方都在本目录内，已同步。
3. **i18n 只新增 1 个键 `nodes.upgrade.cancelling`**（zh「正在停止升级…」/ en「Stopping the upgrade…」/ ja「アップグレードを中止しています…」）。收尾时已从仓库根跑过 `bun run build:i18n`；若其他 agent 之后还改 locale JSON，合并前**再跑一次**。
4. **「批量升级」在回读期间是整体让路（refuse + info），没有再做「逐个排除 restoring 节点」**：`restoring` 由 `restoringIds.size > 0` 派生，二者等价，加过滤只会是死代码。若后续把 `restoring` 改成别的来源，记得把过滤补回 `eligibleUpgradeRows` 之后。
5. **没做真机联调**：G7b 的 DELETE 契约在我收尾时仍在并行开发。合并后建议实测三条：下载中点停止（应变回「升级」并弹「已取消」）、**POST 刚发出就点停止**（应只弹一条「已取消」，目标不留升级）、安装中点停止（按钮灰、提示「正在安装，无法中断。」）。另外 RV5-1/2/3/4/6 是后端项，不在本次范围。

## 风险

- 排队的 `onActive` 接手在「这次升级自己就成功了」时被丢弃。若出现「行内升级失败、但目标其实另有一次升级在跑」的组合，排队的接手仍会照常接上（`failed` / `timeout` / `cancelled` 都会放行），只有 `done` / `alreadyLatest` 才丢——这两种结论下再接一次只会重复报成功。
- 停止按钮的 `cancelling` 由 hook 记账驱动。若 DELETE 长时间不回包（入口卡住），按钮会一直转圈直到超时；这与既有「行内升级没有独立超时」的取舍一致，没有额外加计时器。
- `createSemaphore` 是先到先得的 FIFO，不区分优先级：某一轮回读排在很多行之后时，那几行的升级按钮会多灰一小会儿。回读只是一次 GET，实测量级可忽略。
