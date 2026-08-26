# Plan 00：WatchService 与 control-mode 行为保持拆分

## 背景

父计划 `prompt-archives/2026082700-code-smell-cleanup` 第二轮。范围仅本 worktree
`apps/gateway/src/watch/` 与 `apps/gateway/src/tmux-client/control-mode-parser.ts` /
`control-mode-subscription.ts` 及新建的 `control-mode/` 子目录。其他 agent 并行改
gateway 其他文件，禁止触碰 `pane-stream-parser*`、`external-connection*`、
`pane-retention.ts`、`canonical-feed-session.ts`、`ws/index.ts`。

公开 API 保持：`WatchService` 类及 `watchService` 单例、`WatchRuntimeLike`、
`WatchServiceDeps`、`effectiveIntervalSeconds`；`createControlModeParser` /
`createControlModeSubscription` 及既有导出类型。

## 拆分

### Watch

- `sample-store.ts`：ring buffer 独立类
- `scheduler.ts`：规则 timer + tick 互斥
- `runtime-pool.ts`：设备 runtime 引用计数与生命周期
- `llm-eval.ts`：prompt 构建 + generateObject 包装（纯-ish）
- `notifier.ts`：通知 / 广播
- `service.ts`：编排，保留公开方法

### Control mode

- `control-mode/types.ts`、`unescape.ts`、`framing.ts`、`notifications.ts`
- `control-mode/metadata.ts`、`pane-registry.ts`
- 原 parser / subscription 文件作 facade
- 增加 golden tests：整段 transcript + 任意边界切分

## 已知候选 bug

- `%session-renamed` 手册格式仅为 `name`，现实现要求 `sessionId name`，导致漏发 metadata。
  用 `%session-changed` 记下当前 session id 后补齐。仅在有证据时修。
