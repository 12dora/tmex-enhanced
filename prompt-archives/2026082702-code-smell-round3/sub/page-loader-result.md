# 页面模块加载 + 控制台操作区拆分（round3 子任务结果）

## TASK A：`PageWrapper` 动态加载无兜底

### 问题

`apps/fe/src/main.tsx` 的 `PageWrapper` 里 `moduleLoader().then(setModule)`：

1. 没有 rejection handler——chunk 加载失败（弱网、发版后旧 hash 404）直接 unhandled rejection，页面永久空白；
2. 没有请求代次守卫——路由快速切换时，上一个路由的 promise 后 resolve 会把当前路由的 module 覆盖掉。

### 改动

- 新增 `apps/fe/src/use-page-module.ts`：
  - `PageModuleState` 三态判别联合（`loading` / `ready` / `error`），取代原来的 `Record<string, any>` + `eslint-disable`，`PageModule` 用 `ComponentType` 精确声明 `default` / `PageTitle` / `PageActions`；
  - `requestPageModule(loader, apply)` 为纯函数取消守卫：返回 cancel，取消后 resolve/reject 都不再写状态；`useEffect` 的 cleanup 即取消，旧路由的 chunk 无法覆盖当前路由；
  - `toPageModuleError` 把非 `Error` 的 reason 包装成 `Error`；
  - `usePageModule` 返回 `{ state, retry }`，`retry` 递增 attempt 触发重新加载。
- 新增 `apps/fe/src/PageLoadFallback.tsx`：`role="alert"` 的错误 UI，文案走 i18n（`common.pageLoadFailed` / `common.pageLoadFailedHint` / `common.retry`），带重试按钮；`data-testid`：`page-load-error`、`page-load-retry`。
- `main.tsx` 的 `PageWrapper` 改为消费 hook，内容区在 `state.status === 'error'` 时渲染兜底。

### 测试

`apps/fe/src/use-page-module.test.ts`（10 个用例）：加载成功写入 module、rejection 转 error 状态（不留 unhandled rejection）、非 Error reason 包装、取消后 resolve/reject 均不写状态、**旧请求无法覆盖当前请求**、初始态、以及三语兜底文案 key 存在性。

> 注意：仓库内没有 happy-dom / testing-library / react-test-renderer，现有 panels 测试全部是纯逻辑测试，因此按同一惯例把可测面做成纯函数（`requestPageModule`），未引入新依赖。跑法：`cd apps/fe && bun test src/use-page-module.test.ts`（不能在 `apps/fe` 直接跑 `bun test`，会把 `tests/*.spec.ts` 的 playwright 用例也扫进来）。

## TASK B：`DeviceConsoleActions` 拆分 + 硬编码英文修复

### Bug

原 `DeferredTerminalSettingsSheet` 兜底条里 `Loading terminal settings…` / `Terminal settings failed to load.` / `Retry` / `Close` 全是硬编码英文。现全部走 i18n：

- 新增 `settings.terminal.loading`、`settings.terminal.loadFailed`（en/zh/ja 三语齐全）；
- 复用已有 `common.retry`、`common.close`；
- 另为 TASK A 新增 `common.pageLoadFailed`、`common.pageLoadFailedHint`（三语）；
- 已执行仓库根 `bun run build:i18n` 重新生成 `resources.ts` / `types.ts`（未手改生成文件）。

### 拆分

`page-actions.tsx` 从 213 行 / CC≈18 降到 54 行，组件只做组合：

- `use-device-console-actions.ts`：数据面。导出纯函数 `findWindow` / `findPane` / `hasEnabledWatchRule` / `panePath` / `nextInputMode`；内部再拆 `useWatchRuleIndicator`（watch 规则查询）与 `useConsoleCommands`（导航、分屏、跳最新、reload），主 hook 只做组装，单个函数均 ≤60 行。
- `device-console-toolbar.tsx`：表驱动按钮。纯函数 `buildToolbarButtons` 由 `splitButtons` / `coreButtons` / `watchButton` / `terminalSettingsButton` 组合出 `ToolbarButton[]`，组件只把模型映射成 `<Button>`；watch 角标用 `badge` 字段表达。
- `deferred-terminal-settings-sheet.tsx`：懒加载面板 + 可重试兜底条，兜底展示面抽成纯函数 `terminalSettingsFallbackView(loadError)` → `{ role, messageKey, showRetry }`。
- `refresh-confirm-dialog.tsx`：刷新确认 AlertDialog。

### 测试 ID 保持不变

已核对 `apps/fe/tests/terminal-shortcuts.spec.ts`、`watch.spec.ts` 及其他 spec 使用的 id，全部保留且顺序不变：`split-right-button`、`split-down-button`、`terminal-input-mode-toggle`、`watch-open-button`、`watch-active-indicator`、`keyboard-behavior-open-button`。

### 测试

`packages/panels/src/device-console/device-console-actions.test.ts`（16 个用例）：选择/编码纯函数；`buildToolbarButtons` 的桌面端顺序与 testId 快照、移动端去掉分屏按钮、`watchUi=false` 去掉 watch 按钮、`canInteract=false` 的禁用矩阵（refresh/设置仍可用）、无 pane 时 watch 禁用、watch 角标可见性、输入模式按钮标签、每个按钮回调路由正确；回归用例锁定 `terminalSettingsFallbackView` 返回的是 i18n key（不是英文字面量）且三语齐全。

## 验证

- `cd packages/panels && bun test` → **285 pass / 0 fail**（baseline 239 + 本任务 16 + 其他并行 agent 新增）。
- `cd apps/fe && bun test src/use-page-module.test.ts` → **10 pass / 0 fail**。
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 错误**。
- `cd packages/panels && bunx tsc --noEmit -p .` → 仅剩 `src/watch/watch-rule-state-view.test.tsx`、`src/watch/watch-test-harness.tsx` 两个**其他 agent 正在写的文件**报错（`react-dom/server` 缺类型、`WatchRuleStateDto` 字段可选性），与本任务无关。
- `bunx biome check` 我改/新增的 9 个文件 → 全部干净；`main.tsx` 残留的 `useExhaustiveDependencies`（`StatusBarSync` 的 `theme`）是 HEAD 上既有告警，非本次引入（HEAD 版本本来 2 条，现在 1 条）。

## 注意事项

- 另一个 agent 在同 worktree 的 `packages/panels/src/watch/` 下引入了 `renderToStaticMarkup` 的 SSR 测试脚手架（`watch-test-harness.tsx`）。如果它最终落地，fe 的 hook 测试后续可以改成真渲染；本次没有依赖它，避免耦合到未完成的改动。
