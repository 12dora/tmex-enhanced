结论：未发现 blocker；有 6 项 should-fix、1 项 nit。

## Should-fix

1. 批准成功后的刷新可能复用变更前的 Hub 请求，待批准行会错误保留

位置：[use-node-row-actions.ts:316](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:316)、[hub-load-coordinator.ts:118](/Users/konata/code/tmex-r25/apps/fe/src/node/hub-load-coordinator.ts:118)

`onChanged()` 最终调用 `hub.refresh()`，但 `HubLoadCoordinator.load()` 遇到同一个在途请求时直接返回该 promise，不会安排尾随刷新。

复现时序：

1. Hub 轮询在批准前发出，响应尚未回来。
2. 用户批准成功。
3. `refreshAll()` 被合并进旧轮询。
4. 旧响应返回仍含 pending 行，并被正常写入状态。
5. 按钮重新可用，直到 30 秒后的下一轮轮询；再次点击会收到 `node_id_reused` 等错误。

`refreshMeshNodes()` 也有同类行为，可能暂时看不到新成员。

最小修复：为 mutation 后刷新提供“必须比当前请求更新”的接口。Mesh 使用现有 `ensureFreshMeshNodes()`；Hub coordinator 增加 trailing refresh，当前请求完成后强制再拉一次。

2. Hub 轮询改变或移除 pending 行后，在途批准仍会提交旧材料

位置：[use-node-row-actions.ts:312](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:312)、[admit-pending-node.ts:45](/Users/konata/code/tmex-r25/apps/fe/src/node/admit-pending-node.ts:45)

`admit()` 捕获整个 `row`，经过凭据弹窗和写锁两个异步等待后，没有重新确认：

- 组件是否仍挂载；
- 该节点是否仍为 pending；
- `enrollmentId` 和材料是否仍是点击时那一份。

Hub 轮询失败会清空 `hubNodes`，使 pending 行卸载；另一端完成批准、撤销或重新 enrollment 也会改变材料。但旧调用仍会继续签名和提交，形成不可见的后台写入或 `node_id_reused` 错误。现有 enrollment engine 在每次 await 后都会复核权威 pending store，新入口没有保持同一约束。

最小修复：以 `row.id + enrollmentId` 作为操作身份，维护最新材料/挂载状态 ref，并在凭据返回后及进入 key-log 锁后各复核一次；失效时静默取消。或者在操作结束前固定保留该 busy 行。

3. 网络异常被报告成确定失败，但代码实际上保留了待重发记录

位置：[admit-pending-node.ts:69](/Users/konata/code/tmex-r25/apps/fe/src/node/admit-pending-node.ts:69)、[use-node-row-actions.ts:295](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts:295)

`submitAdmitRecord()` 在发请求前先写入 `unconfirmedRecords`。如果 `appendKeyLog()` 抛出超时或断网异常，记录仍然存在，服务端是否接收也未知；但通用 `guard()` 将其折成 `failed`，UI 显示“批准失败”。下次点击又会走重发路径。

这与代码注释中“未知结果必须按 Hub 未确认处理”的语义相反，会误导用户重新发起加入流程。

最小修复：捕获异常时检查对应 enrollment 是否已有 `unconfirmedRecord()`；有则返回 `{ kind: 'unconfirmed' }`，只有取 head、解码或签名阶段且没有暂存记录的异常才返回 `failed`。补充 `appendKeyLog()` reject 的回归测试。

4. 实际的“所有中继都拒绝”错误不会命中新加的本地化提示

位置：[relay-join.ts:80](/Users/konata/code/tmex-r25/apps/fe/src/node/relay-join.ts:80)、[errors.ts:21](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/errors.ts:21)

当前 gateway 在没有任何 relay 接受时直接返回 502 `RELAY_ENROLL_FANOUT_FAILED`，见 [relay-routes.ts:416](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-routes.ts:416)。因此 `createEnrollment()` 会先抛 `HubApiError`，根本到不了 `acceptedRelays()` 中生成 `RELAY_ENROLLMENT_NO_RELAY` 的分支。

结果是实际故障时页面显示原始的 `RELAY_ENROLL_FANOUT_FAILED`，而不是新加的 `nodes.enrollment.relayNoneAccepted`。现有测试模拟了服务端以 201 返回“全部 accepted=false”，与真实服务端契约不符。

最小修复：`actionErrorText()` 同时映射 `RELAY_ENROLL_FANOUT_FAILED`，或在 `createEnrollmentOnRelay()` 捕获该服务端错误并转换为 `RELAY_ENROLLMENT_NO_RELAY`。测试应模拟真实 502 路径。

5. Admit 按钮禁用原因对鼠标和键盘用户实际上都不可发现

位置：[pending-node-row.tsx:81](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/pending-node-row.tsx:81)

材料不全或 Hub 不可写时，原因只放在禁用按钮的 `title` 上。项目的 Button 默认 `focusableWhenDisabled=false`，且样式包含 `disabled:pointer-events-none`：

- 键盘无法聚焦；
- 鼠标通常也触发不了 title；
- 屏幕阅读器没有关联的说明。

尤其材料缺失时，行内没有其他可见错误，用户只看到一个无法点击的“批准加入”。

最小修复：把原因渲染为可见辅助文字或 Tooltip wrapper，并通过 `aria-describedby` 关联；若必须让禁用按钮可聚焦，可使用 Base UI 的 `focusableWhenDisabled`，同时确保点击仍被阻止。

6. 新增的 allowCommands 权限开关没有可访问名称

位置：[integration-account-form-modal.tsx:139](/Users/konata/code/tmex-r25/packages/panels/src/settings/integration-account-form-modal.tsx:139)、[integration-account-form-modal.tsx:150](/Users/konata/code/tmex-r25/packages/panels/src/settings/integration-account-form-modal.tsx:150)

标签只是普通 `<div>`，`field.inputId` 没有传给 `Switch`，也没有 `aria-label`、`aria-labelledby` 或 `aria-describedby`。键盘可以切换，但屏幕阅读器只能读出无名称的 switch；点击文字也不会切换。新增加的 Telegram/微信权限开关均受影响。

最小修复：为 `Switch` 设置 `id={field.inputId}`，将标题改成关联的 `<label htmlFor>`；描述增加稳定 ID，并通过 `aria-describedby` 关联。

## Nit

7. Hub 返回重复 pending ID 时会生成重复行和重复 React key

位置：[merge-nodes.ts:199](/Users/konata/code/tmex-r25/apps/fe/src/node/merge-nodes.ts:199)、[nodes-table.tsx:83](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:83)

`hubById` 会自然合并正常成员对应的重复 ID，但 `pendingRows()` 直接遍历原数组，仅排除 mesh ID，没有对 Hub 自身重复 ID 去重。异常或过渡期响应中如果出现两个同 ID pending，会渲染重复 `key={row.id}`；React 可能错误复用 busy 状态，并显示两个可批准按钮。

当前数据库通常保证 node ID 唯一，因此列为 nit。最小修复是在生成 pending 行时维护 `seen`，按 ID 保留一条确定性的记录。

## 已核对

- 三个 locale 中本轮使用的 `nodes.*`、`telegram.*`、`weixin.*` key 均存在。
- 旧 Hub 缺少 `admission_status` 时会按 admitted 处理，未发现兼容性回归。
- `HubUplinkNotices` 的首次加载、失败重试和在线刷新分档本身没有发现循环或缺失依赖。
- 定向 Bun 测试：100 项通过。
- `bunx tsc --noEmit -p apps/fe/tsconfig.json` 通过。