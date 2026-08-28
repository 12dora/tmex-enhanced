# files-tab 拆分与错误态修复

## 修复的 bug

`packages/panels/src/settings/files-tab.tsx` 原来用 `rootsQuery.data ?? []` 加 `!isLoading && entries.length === 0` 判空：file roots 查询失败时（网关不可达 / 5xx）落到「未配置任何目录」空态，用户看不到任何错误提示，也无从重试。

现在列表状态由纯函数 `resolveFileRootsListState({ isLoading, isError, entryCount })` 统一裁决，优先级 `loading > ready(有数据) > error > empty`：

- 查询失败且无数据 → 渲染 `settings-files-error`（`TriangleAlert` + `settings.files.loadFailed`）与重试按钮 `settings-files-retry`（`common.retry`，`onClick` 调 `rootsQuery.refetch()`，`isFetching` 时禁用）。
- 已有数据时后台重取失败仍保留列表，不闪错误态。
- 成功且为空仍是原来的 `settings-files-empty`。

## 文件清单

新增（均在 `packages/panels/src/settings/`）：

- `file-root-query.ts`（210 行）：query key、`FileRootDeviceOption/FileRootDeviceGroup/FileRootEntry` 类型、`resolveFileRootsListState`、`collectFileRootClients`、`resolveFileRootClient`、`resolveFileRootErrorMessage`、`useFileRootsQuery`，以及统一了「失效 `['files']` 缓存 + `onRootsMutated` 扇出 + 成功 toast + 完成后关窗」的内部 `useFileRootMutation`，对外暴露 `useFileRootToggleMutation` / `useFileRootDeleteMutation` / `useFileRootSaveMutation`。
- `file-root-row.tsx`（116 行）：`FileRootRow` + 删除确认框，mutation 全部来自 query 模块。
- `file-root-form-modal.tsx`（103 行）：`FileRootFormModal`，只做 Dialog 外壳 + 组合。
- `use-file-root-form.ts`（110 行）：`useFileRootForm` 表单状态/提交 hook，含纯函数 `isFileRootFormSubmittable`、`collectFileRootDeviceOptions`。
- `file-root-form-sections.tsx`（155 行）：`FileRootDeviceField`（内部再拆 `DeviceSelect` / `DeviceSelectValue` / `DeviceReadonlyValue`）、`FileRootPathField`、`FileRootEnabledField`。
- `file-root-device-icon.tsx`（15 行）：原 `DeviceIcon`，行与弹窗共用，`type` 收窄为 `DeviceType | null`。
- 测试 `file-root-query.test.ts`（10 例）、`use-file-root-form.test.ts`（4 例）。

改动：

- `files-tab.tsx` 555 → 158 行，只剩 feature gate、两个 query、列表状态分支、错误态子组件与弹窗组合；继续 re-export `FileRootDeviceGroup` / `FileRootDeviceOption`（`settings/index.ts` 依赖，未在 scope 内故保持接口不变）。
- i18n 源文件三处新增 `settings.files.loadFailed`（en_US / zh_CN / ja_JP），随后在仓库根跑 `bun run build:i18n` 重新生成 `resources.ts`/`types.ts`。重试按钮复用既有 `common.retry`。

## 行为差异（有意）

原 toggle 失败固定弹 `settings.files.toggleFailed`，其余 mutation 在 `FileApiError` 时弹服务端 message。统一后 toggle 也走 `resolveFileRootErrorMessage`：有服务端 message 时优先展示，否则回落 `toggleFailed`。其他文案、data-testid、请求路由（分组 client 解析、编辑沿用来源 client）保持一致。

创建/更新原本是两个 mutation，现合并为一个 `useFileRootSaveMutation`（按 `root` 是否存在分支），顺带去掉了原 update 分支里不可达的 `throw new Error(t('settings.files.updateFailed'))`。

## e2e 兼容

`apps/fe/tests/settings-files.spec.ts` 依赖 `settings-files-section` 与 `settings-files-empty`，均保留。其余 testid（`settings-files-root-add`、`settings-files-root-{id}`、`settings-files-root-enabled-{id}`、`settings-files-root-edit-{id}`、`settings-files-root-delete-{id}`、`settings-files-root-delete-confirm-{id}`、`settings-files-add-modal`、`settings-files-edit-modal-{id}`、`settings-files-device-select`、`settings-files-path-input`、`settings-files-enabled-switch`、`settings-files-form-submit`）逐一保留，新增 `settings-files-error` / `settings-files-retry`。

## 验证

- `cd packages/panels && bun test`：253 pass / 1 fail。新增 14 例全绿（`bun test src/settings` → 14 pass / 0 fail）。唯一失败来自其他 agent 正在写的 `src/watch/spike.test.tsx`（`spike error state renders`，与本任务无关，未处理）。
- `bunx tsc --noEmit -p .`（packages/panels）：仅剩 1 条错误，同样来自 `src/watch/spike.test.tsx` 的 `react-dom/server` 缺 `@types/react-dom`（其他 agent 的文件，未处理）；本任务文件 0 错误。
- `bunx tsc --noEmit -p .`（apps/fe）：0 错误。
- `bunx biome check --write` 覆盖全部 9 个改动/新增文件，无残留问题。

## 未做

- 组件级渲染测试：panels 包目前没有 DOM 测试基建（无 happy-dom / testing-library，且 `@types/react-dom` 缺失），因此错误态的回归测试落在纯函数 `resolveFileRootsListState` 上（明确覆盖「失败且无数据 → error 而非 empty」）。若其他 agent 的 `src/watch/spike.test.tsx`（react-dom/server SSR 渲染方案）最终落地，可再补一个渲染层断言。
