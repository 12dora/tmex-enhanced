# watch-dialog 重构结果（错误态 / N+1 / 拆分）

## 1. 背景

`packages/panels/src/watch/watch-dialog.tsx`（429 行）同时承担对话框壳、列表、行、状态详情四层职责，且存在两个问题：

- 所有查询都是 `throwOnError: false`，失败时静默降级：规则列表失败渲染成「没有规则」，状态详情失败把每个字段渲染成 `—`。
- 每个 `WatchRuleRow` 都发一次 `GET /api/watch/rules/:id/state`，进入详情视图后又发一次，N 条规则 → N+1 次请求。

## 2. 网关 API 结论（只读确认）

`apps/gateway/src/api/watch.ts` 的 `handleListRules` 只返回 `{ rules: WatchRuleDto[] }`，`toRuleDto` 不含任何运行状态字段；`WatchRuleDto`（`packages/shared/src/contracts/watch.ts`）也没有 `lastTriggeredAt`。运行状态只有 `GET /api/watch/rules/:id/state` 提供。

因此按任务书的分支二处理：**行内不再请求状态，状态只在详情视图拉取**。行内原先的「最近触发 / 从未触发」文案改为纯规则字段推导的调度摘要（`每 N 秒采样`，`unchanged` 规则额外前缀 `M 分钟无变化`），不再需要任何请求；旧的 `watch.rules.lastTriggered/neverTriggered` key 按「只增不删」的约束保留在 locale 中（现已无引用）。

## 3. 改动清单

新增：

- `packages/panels/src/watch/use-watch-rules.ts`：`useWatchRules`（列表查询 + `retry`/`refresh`）、`useWatchRuleState`（详情专用，5s 轮询）、`useWatchRuleMutations`（启停 / 删除 + toast + 失效）、纯函数 `resolveQueryStatus`。
- `packages/panels/src/watch/watch-rule-list.tsx`：列表区（通知授权 banner、loading、error+retry、empty、行、新建按钮），纯 props，无查询。
- `packages/panels/src/watch/watch-rule-row.tsx`：单行 + 纯函数 `formatRuleSchedule`，无查询。
- `packages/panels/src/watch/watch-rule-state-view.tsx`：`WatchRuleStateView`（挂查询）+ `WatchRuleStatePanel`（纯 props，可测）+ 纯函数 `buildWatchStateFields`。
- 测试：`use-watch-rules.test.tsx`、`watch-rule-list.test.tsx`、`watch-rule-row.test.tsx`、`watch-rule-state-view.test.tsx`，共享 `watch-test-harness.tsx`。
- `packages/panels/src/watch/react-dom-server.d.ts`：`@types/react-dom` 不在 `@tmex/panels` 的 devDependencies 里（只有测试用到 `react-dom/server`），补了最小声明。**若后续把 `@types/react-dom` 加进本包依赖，请删除该文件。**

改写：`watch-dialog.tsx` 降到 230 行，只剩壳（Dialog 框架 + 标题 + `useDialogUiState` 视图状态 + `WatchDialogBody` 三态分发 + 删除确认框）。所有函数 ≤ 50 行。

i18n（三语同步新增，已跑 `bun run build:i18n`）：`watch.rules.everySeconds` / `watch.rules.unchangedFor` / `watch.rules.loadFailed` / `watch.state.loadFailed`，重试按钮复用既有 `common.retry`。

## 4. 错误态行为

- 列表失败且无缓存数据 → `watch-rules-error` + `watch-rules-retry`（`refetch()`），不再显示 empty。
- 详情失败 → `watch-rule-state-error` + `watch-rule-state-retry`，不再把六个字段渲染成 `—`。
- `resolveQueryStatus` 只在「失败且无数据」时判为 error：后台轮询失败不会把已渲染的内容替换成错误页。

## 5. 测试基建（本仓首次在 panels 做组件渲染测试）

仓库没有 happy-dom / testing-library，既有 panels 测试全是纯函数级。这里用 `react-dom/server` 的 `renderToStaticMarkup` + `QueryClientProvider` 做无 DOM 静态渲染（`watch-test-harness.tsx` 里初始化 i18next 与 `installWindowStorage()`）。SSR 下 react-query 不会真正发请求，但 `useQuery` 会在 QueryCache 里建条目，因此**请求条数用 `client.getQueryCache().getAll()` 的 key 列表断言**：

- 列表渲染 3 条规则 → cache 条目数 0（行不再发状态请求，N+1 回归防护）。
- `useWatchRules` → 恰好 `[['watch-rules','d1','%1']]`。
- `WatchRuleStateView` → 恰好 `[['watch-rule-state','a']]`。

局限：SSR 不跑 effect，无法点击按钮，所以重试按钮只断言存在（testid + 文案），回调本身由 hook 的 `retry: () => query.refetch()` 保证。

## 6. e2e testid 兼容

`apps/fe/tests/watch.spec.ts` 与 `mobile-agent-watch.spec.ts` 用到的 `watch-dialog`、`watch-rules-empty`、`watch-rule-add`、`watch-rule-item-*`（含 `data-rule-name`）、`watch-rule-toggle-*`、`watch-rule-edit-*`、`watch-rule-delete-*`、`watch-rule-state-*`、`watch-rule-delete-dialog`、`watch-rule-delete-confirm`、`watch-rule-form` 全部原样保留；新增 testid 均带 `-error` / `-retry` 后缀，不与 `[data-testid^="watch-rule-delete-"]` 这类前缀选择器冲突。保存后失效列表的行为（原 `handleSaved` 里的 `invalidateRules`）由 `useWatchRules().refresh()` 保留。

## 7. 验证

- `cd packages/panels && bun test`：285 pass / 0 fail（基线 239 + 本次 15 + 其他并行 agent 新增）。
- `bunx tsc --noEmit -p .`（packages/panels）：0 error。
- `bunx biome check`（本次改动的 11 个文件）：clean。仓库里 `packages/panels/src/watch/watch-events-init.tsx` 有一处既有的 import 排序告警，属他人/既有范围，未动。
