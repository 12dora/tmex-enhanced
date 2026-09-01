发现 1 个 blocker、1 个 should-fix。

1. **blocker** — 行内升级与批量升级没有真正互斥  
   [use-node-upgrade.ts:521](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:521)、[use-node-upgrade.ts:543](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:543)、[upgrade-batch.ts:84](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts:84)

   `startAll` 未检查 `runningRef` 中是否已有行内任务。若用户先对远端 Hub 点击「升级」，再点击「全部升级」，批量执行到 Hub 时 `runOnce` 会立即返回 `cancelled`；批处理仍将它计入 `completed`，但不计成功或失败，随后立即启动本机升级。此时原来的 Hub 升级仍在进行，恰好破坏了“Hub 完全结束后才升级本机”的安全顺序，最终汇总数还会小于总数。反向上，`start` 也未检查 `batchRunningRef`，互斥仅依赖下一次 React 渲染后的按钮禁用。

   应在两个入口做同步双向互斥：批量启动前拒绝任何现存的行内任务，行内启动前检查 `batchRunningRef`；同时让工具栏以响应式状态在行内任务运行时禁用。当前测试只验证了渲染后的按钮禁用，没有覆盖“行内任务已运行后启动批量”的场景。

2. **should-fix** — 单个任务抛异常会提前结束整个组，并让其他任务脱离批量状态  
   [upgrade-batch.ts:107](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts:107)、[upgrade-batch.ts:112](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/upgrade-batch.ts:112)、[use-node-upgrade.ts:564](/Users/konata/code/tmex-enhanced-wt-r13/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:564)

   `p.run(row)` 没有异常隔离，`Promise.all` 会在首个 rejection 时立即拒绝，而同组其他 worker 仍在后台运行。具体场景是某个 `UpgradeIo` 方法或回调意外 reject：批量不显示汇总，Hub/本机不会继续执行，外层 `finally` 却会把 `batch.running` 清掉，使行内按钮在其他 worker 尚未结束时重新可用；被忽略的 `finally` 返回值还会形成未处理 rejection。应在每个节点边界将异常转成失败结果，并等待所有 worker settle 后再进入下一组。需补一个 worker reject 的测试。

其余重点项未发现问题：正常的 `failed`/`timeout` 结果不会阻止本机组；本机同时为 Hub 时只排在最后一次；`alreadyLatest` 正确计为成功；正常 abort 会停止后续节点且不弹汇总；`rows` 与 `latest` 作为启动快照使用没有明显 stale-closure 错误。英文 `_one`/`_other` 键在当前 i18next 版本下可正确解析，三语文案含义和命令提示一致。