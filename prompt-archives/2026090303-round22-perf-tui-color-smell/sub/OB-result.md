# OB 结果：F3 + F6 + F7（设置页表单原语 / 危险确认框 / hub setup 提交 / node-detail 破环）

worktree `/Users/konata/code/tmex-r22`，仅改本任务拥有的文件，无 git 操作。

## 基线（改动前）

| 项 | 值 |
|---|---|
| `bun test src/pages/settings`（apps/fe） | 853 pass / 0 fail / 2628 expect，33 文件 |
| `bunx tsc --noEmit -p .`（apps/fe） | 0 error |
| `bun scripts/complexity/gate.ts` | ok |

## 改动后

| 项 | 值 |
|---|---|
| `bun test src/pages/settings` | **853 pass / 0 fail / 2628 expect**（无减少） |
| `bunx tsc --noEmit -p .` | **0 error**（不高于基线） |
| `bunx biome check apps/fe/src/pages/settings` | **Checked 121 files, no fixes applied** |
| `bun scripts/complexity/gate.ts` | **complexity gate ok (1257 files, 11692 functions)** |
| 附带回归 `bun test src/components/side-panels/connect-devices` | 61 pass / 0 fail（`copy-feedback` 的外部消费者） |

## F3：表单原语合一 + 危险确认框合一

新建：
- `apps/fe/src/pages/settings/components/form-primitives.tsx`（113L）：`NoticeTone` / `Notice` / `FormField` / `InfoRow`。
- `apps/fe/src/pages/settings/components/danger-confirm-dialog.tsx`（67L）：`DangerConfirmDialog`。

四对重复原语的落点：

| 原重复对 | 现状 |
|---|---|
| `https/parts.tsx:Notice` ↔ `setup/form-parts.tsx:SetupNotice` | 两处都改成 `export { Notice ... }` / `export { Notice as SetupNotice }` 再导出，实现只剩一份 |
| `https/parts.tsx:Field` ↔ `setup/form-parts.tsx:FormField` | 合成 `FormField`，两者唯一的像素差异（`space-y-1.5` vs `space-y-2`）收成显式 `spacing: 'tight' \| 'normal'`；`Field` 是传 `spacing="tight"` 的三行包装 |
| `https/parts.tsx:InfoRow` ↔ `remote-access/step-shell.tsx:DetailRow` | 合成 `InfoRow`，标签列宽差异（`w-28` vs `w-24`）收成 `labelWidth: 'wide' \| 'narrow'`；`DetailRow` 是传 `labelWidth="narrow"` 的包装 |
| `https/parts.tsx:CopyableCode` ↔ `copy-feedback.tsx:CopyableValue` | 合并到 `CopyableValue`，唯一差异 `font-mono` 收成 `mono?: boolean`；`CopyableCode` 变成 `<CopyableValue ... mono />` |

四份危险确认框全部改用 `DangerConfirmDialog`：`nodes/domain-access-row.tsx:DomainAccessConfirm`、`nodes/direct-section.tsx:RemoveConfirm`、`nodes/https/https-section.tsx:StopListenerConfirm`、`remote-access/status-card.tsx:ConfirmRemoveDialog`。确认按钮的 testId 单独传参而不是拼后缀——历史上 `-ok`（本机域名访问 / 直连删除）与 `-confirm`（停 https 监听 / 移除隧道）两种后缀并存，e2e 与单测都在断言这些名字，顺手统一会破坏断言。取消按钮四处一致，仍按 `${testId}-cancel` 派生。

**像素一致性已实测**：用 `react-dom/server` 静态渲染新原语，与重构前的字面 markup 逐字比对（Notice 两种 tone、Field/FormField 的 hint 与 error 两条分支、InfoRow/DetailRow、CopyableValue），**7/7 全等**（临时脚本跑完即删）。`CopyableValue` 加 `mono` 后 class 串是 `... text-[11px] font-mono`（原为 `... font-mono text-[11px]`）——仅顺序不同，Tailwind 无冲突类，渲染结果一致。

**未改任何用户文案，未增删任何 i18n key**（`packages/shared/src/i18n/*` 零改动）：合并过程中所有 `t()` key 原样搬运，四个确认框各自的 title/cancel/confirm key 都由调用方传入。

**call site 说明**：`parts.tsx` / `form-parts.tsx` / `step-shell.tsx` / `copy-feedback.tsx` 的**导出名与签名全部保持不变**（`Field`、`SetupNotice`、`DetailRow`、`CopyableCode`…），因此 `acme-panel.tsx`、`sans-editor.tsx`、`selfsigned-panel.tsx`、`external-panel.tsx`、`acme-dns-fields.tsx`、`access-step.tsx`、`named-step.tsx`、`login-protection.tsx`、`wizard.tsx`、`direct-step.tsx`、`external-card.tsx`、`exposure.tsx`、`remote-access-tab.tsx`、`local-machine-card.tsx`、`enrollment-section.tsx`、`connect-devices/command-block.tsx` 等 **16 个不属于本任务的消费者一行都没改**。这是刻意的：本任务的文件所有权只覆盖那 8 个文件，改它们的 import 行会与并行 agent 冲突。四个宿主文件现在是薄适配层（再导出 + 参数固化），重复实现已经消灭。

## F6：hub setup 提交流程合一

新建 `apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts`（82L）：`useHubSetupSubmit<T>({ client, hasErrors, submit, successMessage, onRestarted })`，返回 `{ showErrors, revealErrors, submitting, submitError, result, waiter, handleSubmit }`。

行为逐条保持：`preventDefault` → `setShowErrors(true)` → 有校验错误则直接 return（不发请求）→ `setSubmitting(true)` / 清空 `submitError` → `await submit()` → `setResult` → `toast.success` → `waiter.start(previousStartedAt)`；catch 走 `describeSetupError` 同时写入 `submitError` 与 `toast.error`；`finally` 复位 `submitting`；`useEffect` 在 `waiter.state === 'restarted'` 时调 `onRestarted`。顺序、错误映射、忙态、成功后导航全部未变。

`become-hub-form.tsx` 的地址预检也要「亮错误」，因此 hook 额外暴露 `revealErrors()`（原来是直接调 `setShowErrors(true)`）；`runPrecheck` 其余逻辑（预检状态机、地址一改就作废）留在表单里，因为 join 表单没有这一段。两个表单各自的字段、校验器、结果卡片均未合并（形状确实不同）。

`become-hub-form.tsx` 299→277L，`join-hub-form.tsx` 208→184L。

## F7：`node-detail-dialog` ↔ `use-node-detail-state` 破环

新建 `apps/fe/src/pages/settings/nodes/management/node-detail-types.ts`（173L）。

**注意：只搬类型不足以破环。** backlog §4.1 的检测只统计**值导入**，而 `use-node-detail-state.ts:5-16` 从 `.tsx` 里 import 的除了 4 个类型还有 6 个**函数值**（`createNodeDetailIo`、`loadDomainAccessState`、`nextNodeDetailBaseline`、`planNodeDetailSave`、`saveNodeDetail`、`toggleDomainAccess`）。因此新模块承载的是**类型 + 与渲染无关的领域逻辑**这一整片叶子：`Translate`、`DomainAccessState`、`NodeDetailIo`/`createNodeDetailIo`/`nodeDetailClient`、`domainAccessErrorText`、`loadDomainAccessState`、`toggleDomainAccess`、`NodeDetailValues`/`NodeDetailPlan`/`planNodeDetailSave`/`hasNodeDetailChanges`、`NodeDetailSaveContext`/`NodeDetailSaveResult`/`saveNodeDetail`、`nextNodeDetailBaseline`。纯搬移，一行逻辑未改。

依赖方向现在是：`node-detail-types.ts`（叶子）← `use-node-detail-state.ts`（状态）← `node-detail-dialog.tsx`（渲染）。**环已消失**，`.tsx` 不再做任何再导出（避免把 barrel 塞回叶子路径上），`node-detail-dialog.tsx` 511→350L，只剩渲染 + `domainAccessNote` / `domainAccessSwitchDisabled` 两个渲染判定。

`node-detail-dialog.test.tsx` 相应拆成两次 `await import()`（渲染件从 `./node-detail-dialog`，领域函数从 `./node-detail-types`），**断言一条未删未改**。

顺带说明：`node-detail-dialog.tsx` 里还有第五份确认框 `DomainAccessConfirm`，结构与 F3 合并的四份不同（正文块在 `AlertDialogHeader` **外面**、取消按钮无 testId），且 backlog §3.8 未把它列进来，本次**未动**——它可以在后续轮次里连同 `DangerConfirmDialog` 加一个「正文外挂槽」的参数一起收编。

## `wc -l` 变化

| 文件 | 前 | 后 |
|---|---:|---:|
| `nodes/https/parts.tsx` | 162 | 81 |
| `nodes/setup/form-parts.tsx` | 160 | 98 |
| `nodes/copy-feedback.tsx` | 117 | 123 |
| `remote-access/step-shell.tsx` | 118 | 104 |
| `nodes/domain-access-row.tsx` | 253 | 230 |
| `nodes/direct-section.tsx` | 289 | 266 |
| `nodes/https/https-section.tsx` | 436 | 412 |
| `remote-access/status-card.tsx` | 445 | 418 |
| `nodes/setup/become-hub-form.tsx` | 299 | 277 |
| `nodes/setup/join-hub-form.tsx` | 208 | 184 |
| `nodes/management/use-node-detail-state.ts` | 126 | 126 |
| `nodes/management/node-detail-dialog.tsx` | 511 | 350 |
| **既有文件小计** | **3124** | **2669**（−455） |
| `components/form-primitives.tsx`（新） | — | 113 |
| `components/danger-confirm-dialog.tsx`（新） | — | 67 |
| `nodes/setup/use-hub-setup-submit.ts`（新） | — | 82 |
| `nodes/management/node-detail-types.ts`（新） | — | 173 |
| **总计** | **3124** | **3104**（**净 −20**） |

`git diff --stat` 口径：13 个既有文件 **+128 / −581**，另 4 个新文件。

净行数收益小是意料之中：F7 是纯搬移（±0），F6 的 hook 要显式声明两个 interface（+82 换 −46）。**本任务的收益在结构而非行数**——4 对重复原语 → 1 份、4 份确认框 → 1 份、2 份提交流程 → 1 份、1 个循环依赖 → 0。

## 未做 / 需上游决策

- 16 个不属于本任务的消费者仍从 `parts.tsx` / `form-parts.tsx` / `step-shell.tsx` 取原语（经再导出）。要让它们直接 import `settings/components/form-primitives` 并删掉三个宿主文件的再导出，需要一个能同时改这批文件的任务（本轮它们分属别的 agent）。建议记入下一轮 backlog。
- `setup/form-parts.tsx:ResultRow` 与 `InfoRow` 形状接近（少一个标签列宽），未合并——backlog §3.7 没列它，且它的标签列是自适应宽度，合并要再加一档 `labelWidth`，收益不抵参数复杂度。
- 未跑 e2e（按任务要求）。
