# TASK G 结果：设置页三处超标组件/hook 拆分

纯机械搬运，行为不变：未改动任何用户可见文案、hook 顺序在各自组件内保持一致、effect 依赖与注释原样保留。

## 1. `useSiteSettingsForm` 151 行 → 105 行

- 新文件 `apps/fe/src/pages/settings/use-site-settings-save.ts`（115 行）：`useSiteSettingsSave({ plan, hubApi, linkage, languagePreview, draft, applySettings, refreshSettings, refreshHub, setPinnedName })`，内含原 `saveMutation`（rename → PATCH → `onSettled` 三段重拉）、`renamedInAttempt` ref、`save` 的 `useCallback`，以及只被这段用到的 `sleep`。`t` / `apiClient` 改为在新 hook 内自取（`useTranslation` / `useRuntime`）。
- 宿主保留 `pinnedNameRef`，新增 `pinName` 回调（`pinnedNameRef.current = name; setPinnedName(name)`）作为 `setPinnedName` 传入——原代码在 mutationFn 里改完名字会同时写 ref 与 state，ref 那一步是注水 effect 读到最新钉住名字的关键，不能只传裸 setter。`setPinnedName(null)` 那条一并同步 ref 在语义上等价（render 阶段本来就会把 ref 同步成 null，两次写之间没有任何 effect 能观察到差异）。
- 宿主去掉了因此不再使用的 `apiClient`、`useTranslation`、`toast`、`parseApiError`、`refreshMeshNodes`、`refreshUntilRenamed` 引用。

## 2. `NodeDetailDialog` 122 行 → 67 行

- 新文件 `apps/fe/src/pages/settings/nodes/management/use-node-detail-state.ts`（121 行）：`useNodeDetailState(row, open, { io, rename, writerPublicUrl, onChanged, onOpenChange })`，含 `NodeDetailState` 接口、`initialState`、`state`/`patch`、`latest` ref、加载 effect、`plan`、`save`、`onAllowedChange`，返回 `{ state, patch, plan, save, onAllowedChange }`。
- `biome-ignore lint/correctness/useExhaustiveDependencies` 注释、`const rowId = row.id` 触发器与 `[open, rowId]` 依赖数组逐字保留。
- 组件只剩 JSX + `useTranslation`；`node-detail-dialog.tsx` 里所有被测试导入的纯函数（`planNodeDetailSave` / `saveNodeDetail` / `loadDomainAccessState` / `NodeDetailBody` 等）原地未动，测试文件零改动。
- 说明：新 hook 从 `./node-detail-dialog` 反向 import 这些纯函数，形成一条模块环。因为环两端顶层只有函数声明与常量、无跨模块的顶层求值，ESM/bundler 均能正常解析（tsc、bun test、vite 构建路径上的 biome 都已验证）。若想彻底消环需把纯函数搬出 `node-detail-dialog.tsx` 并回导出，超出本次「只动指定文件」的范围，故未做。

## 3. `AcmePanel` 255 行 → 171 行（要求 ≤180）

- 新文件 `apps/fe/src/pages/settings/nodes/https/acme-dns-fields.tsx`（110 行）：`AcmeDnsFields({ draft, errors, busy, stored, patch })`，即原 `draft.challenge === 'dns-01'` 分支内的整块（服务商 Select + Cloudflare token / DNSPod id+token 两套字段），`PROVIDER_LABEL` 一并迁入（原文件已无其它使用者）。
- `storedProvider` / `hasStoredCredentials` 留在宿主：`stored` 除了做 hint，还要喂给 `validateAcmeDraft(draft, stored)`，只能在宿主算好后作为 prop 传下去。宿主里 `dns-01` 的条件渲染位置与 `data-testid="https-acme-dns"` 容器均保持原样。

## 验收

- `bun test src/`（apps/fe）：**1737 pass / 0 fail**，89 个文件，测试文件零改动。
- `bunx tsc --noEmit -p .`（apps/fe）：0 错误。
- `bunx biome check` 六个改动/新增文件：通过，无 fix。
- `bun scripts/complexity/gate.ts`：违规数 24 → 21，三处目标函数全部从违规列表消失（剩余 21 条均属其它 agent 的文件，含 `nodes-management.tsx:82` 250>249）。allowlist 未动，stale 条目 0。

## 有意保留

- 上文第 2 条提到的 `node-detail-dialog.tsx` ↔ `use-node-detail-state.ts` 模块环。
