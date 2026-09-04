# F5 结果：修复 R2 前端评审的七项

七项全部落地（1–6 should-fix、7 nit）。只改 `apps/fe/**` 与 `packages/panels/**`，未动 i18n locale JSON（复用既有 key），未执行任何 git 操作。

## 1. 变更后的刷新不再被在途请求满足

- `apps/fe/src/node/hub-load-coordinator.ts`：新增 `refresh(request)`。在飞的是同一个请求时不再复用它，而是排一条尾随刷新，等它落地后再发一轮并返回那个 promise；期间重复调用合并成同一次（`trailing` 字段）。三处退避：
  - 没有在飞的请求 / 目标不同 → 退化成普通 `load()`；
  - `dispose()` 清掉已排队的尾随；
  - 排队期间换了 hub（`this.target !== request`）→ 不补发，否则会把新目标的结果顶成过期响应。
- `apps/fe/src/node/mesh-nodes.ts`：`useHubNode` 返回的 `refresh` 改走 `coordinator.refresh(request)`（`load()` 仍供首屏与轮询用）。
- `apps/fe/src/pages/settings/nodes/uplink/local-uplink-controller.ts`：`refreshAll` 的成员集刷新改用现有 `ensureFreshMeshNodes(api)`（原为 `refreshMeshNodes`）。
- `apps/fe/src/components/side-panels/connect-devices/join-token.tsx`：`refreshAfterAdmit` 同样改用 `ensureFreshMeshNodes()`——它是 admit 成功后的刷新，同一类缺陷。

测试（`hub-load-coordinator.test.ts` 新增 6 条）：尾随补发、重复触发合并、无在途时等价于普通加载、在途失败仍补发、换 hub 后不补发、卸载后不补发。

## 2. 在途批准会复核行身份

- `apps/fe/src/node/admit-pending-node.ts`：`AdmitPendingContext` 新增可选 `stillValid(enrollmentId)`。凭据对话框返回后复核一次、进入 key-log 写锁后再复核一次（重发路径也在锁内复核），失效即返回 `{ kind: 'cancelled' }`，不签名、不提交。
- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts`：`useAdmitNode` 维护 `rowRef`（最新行）与 `mountedRef`（挂载态），`stillValid` = 仍挂载 && 仍是 pending && `admitMaterial.enrollmentId` 未变；`admit()` 也改用 `rowRef.current` 取材料。

测试（`admit-pending-node.test.ts` 新增 4 条）：凭据期间失效、锁内才失效（断言复核被调用两次）、重发路径失效、复核通过时照常批准。

## 3. 提交阶段的网络异常按「Hub 未确认」处理

- `apps/fe/src/node/admit-pending-node.ts`：`guard()` 改成带 `enrollmentId`；捕获异常时若该 enrollment 已有 `unconfirmedRecord()`（`submitAdmitRecord` 是先暂存字节再发请求），返回 `{ kind: 'unconfirmed' }`，UI 走既有 `nodes.enrollment.hubNotConfirmed` 警告。只有取 head / 解码 / 签名阶段（尚无暂存）才仍是 `failed`。

测试（新增 2 条）：`appendKeyLog` reject 时返回 `unconfirmed` 且字节留存；重发路径断网同样是 `unconfirmed` 且不再要凭据。原有「keyLogHead 抛错 → failed」的用例保持不变，覆盖了另一侧。

## 4. 真实的 502 `RELAY_ENROLL_FANOUT_FAILED` 命中同一句本地化文案

- `apps/fe/src/node/relay-join.ts`：新增导出常量 `RELAY_ENROLL_FANOUT_FAILED`，注释点明它与本地判定的 `RELAY_ENROLLMENT_NO_RELAY` 是同一件事（网关侧 502，见 `apps/gateway/src/mesh/relay-routes.ts`）。
- `apps/fe/src/pages/settings/nodes/management/errors.ts`：两个码都映射到 `nodes.enrollment.relayNoneAccepted`。

测试：
- `relay-join.test.ts` 新增「真实契约」用例——channel 以 `HubApiError('RELAY_ENROLL_FANOUT_FAILED', 502)` reject，断言错误码与状态码原样传出；原「201 全拒」用例保留但改名为「旧网关的 201 全拒」，并注明新网关走不到那条分支。
- `nodes-management.test.tsx` 新增 `actionErrorText` 用例，断言两个码给同一句文案。

## 5. 批准按钮的禁用原因可见且可读屏

- `apps/fe/src/pages/settings/nodes/management/pending-node-row.tsx`：`AdmitButton` 包一层纵向容器，禁用时在按钮下方渲染 `<span data-testid="pending-node-admit-hint" id="nodes-admit-hint-<rowId>">`（`text-muted-foreground`、11px），按钮加 `aria-describedby` 指向它；按钮仍然禁用，`title` 保留。动作列容器由 `items-center` 改为 `items-start`，多出一行说明时其余按钮不被拉偏。

测试（`pending-node-row.test.tsx` 新增 2 条）：材料缺失时说明可见且 `aria-describedby` 对上；可批准时不渲染说明、也不留空的 `aria-describedby`。

## 6. allowCommands 权限开关有可访问名

- `packages/panels/src/settings/integration-account-form-modal.tsx`：`renderToggleField` 里
  - 标题由 `<div>` 改为 `<label id="<inputId>-label" htmlFor={field.inputId}>`；
  - 说明段落带稳定 id `<inputId>-description`；
  - `Switch` 加 `id={field.inputId}`、`aria-labelledby`、`aria-describedby`（无说明时为 `undefined`，不留空属性）。

已核实 Base UI `Switch.Root`（`nativeButton=false`）把 `id` 落在内部那个真正的 `<input type="checkbox">` 上，因此 `<label for>` 能原生切换开关；`role="switch"` 在外层 `<span>` 上，可访问名与说明只能靠显式的 `aria-labelledby` / `aria-describedby`，两者都已接上（渲染产物已逐条核对）。

测试（`integration-account-form-modal.test.tsx` 新增 3 条）：标签 `for` 指向那个 checkbox（点标签即可切换）、开关带 `aria-labelledby`/`aria-describedby`、无说明时不留空的 `aria-describedby`。仓库没有 DOM 测试环境（`react-dom/server` 静态渲染），因此断言打在决定原生行为的那套接线上，而不是模拟点击。

## 7. 待批准行按 ID 去重

- `apps/fe/src/node/merge-nodes.ts`：`pendingRows()` 改为带 `seen` 的循环，同 ID 只保留第一条（连带保留它的 `admitMaterial`）。
- 测试（`merge-nodes.test.ts` 新增 1 条）：两条同 ID pending 只出一行，且保留第一条的名字与材料。

## 改动文件

```
apps/fe/src/node/hub-load-coordinator.ts
apps/fe/src/node/hub-load-coordinator.test.ts
apps/fe/src/node/admit-pending-node.ts
apps/fe/src/node/admit-pending-node.test.ts
apps/fe/src/node/merge-nodes.ts
apps/fe/src/node/merge-nodes.test.ts
apps/fe/src/node/mesh-nodes.ts
apps/fe/src/node/relay-join.ts
apps/fe/src/node/relay-join.test.ts
apps/fe/src/components/side-panels/connect-devices/join-token.tsx
apps/fe/src/pages/settings/nodes/uplink/local-uplink-controller.ts
apps/fe/src/pages/settings/nodes/management/errors.ts
apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts
apps/fe/src/pages/settings/nodes/management/pending-node-row.tsx
apps/fe/src/pages/settings/nodes/management/pending-node-row.test.tsx
apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx
packages/panels/src/settings/integration-account-form-modal.tsx
packages/panels/src/settings/integration-account-form-modal.test.tsx
```

## 验证

| 命令 | 结果 |
| --- | --- |
| `cd apps/fe && bun test src/node src/pages/settings/nodes` | 1031 pass / 0 fail |
| `cd apps/fe && bun test src`（全量单测，不含 Playwright） | 2114 pass / 0 fail（改动前基线 2098，新增 16 条） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 error |
| `cd packages/panels && bun test src/settings` | 120 pass / 0 fail |
| `cd packages/panels && bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check <本任务全部改动文件>` | 无告警 |
| `bun scripts/complexity/gate.ts` | 我的文件全部通过，未改 allowlist |

## 遗留 / 需要说明

1. **复杂度门禁当前有 2 条 violation，都在 `apps/gateway/src/hub/uplink-server.ts`**（2249 行 > 2247；`handleKeyLogAppend` CC 23 > 22）。该文件属并行的后端 agent（G6）作用域，非本任务改动，未触碰。
2. **`packages/panels` 全量 `bun test src` 有 15 条既有失败**（ChatThread、FilesTab / FilesNodeSection、WatchRuleList / WatchRuleStatePanel、usePane/useWindowActionItems），全在 agent/files/watch/device 相关目录，与本任务改动的 `src/settings` 无关，改动前即存在，未处理。任务指定的 `bun test src/settings` 全绿。
3. 第 4 项按评审的「最小修复」选了 `actionErrorText` 双码映射，而不是在 `createEnrollmentOnRelay` 里把 502 改写成 `RELAY_ENROLLMENT_NO_RELAY`：`HubApiError` 只带 code/status、不带响应体，改写会丢掉服务端的逐台 `relays` 明细；映射层处理既保留了原始错误，也覆盖了其它调用点。
4. 第 6 项无法用真实点击验证（仓库无 DOM 测试环境），断言的是决定原生 label 行为的 id/for 接线，实现依据是 Base UI 1.2.0 `SwitchRoot` 源码 + 实际 SSR 产物。
