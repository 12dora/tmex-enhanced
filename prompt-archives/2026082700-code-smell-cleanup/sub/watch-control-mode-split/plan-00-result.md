# Plan 00 执行结果：WatchService + control-mode 拆分

## 完成情况

行为保持拆分已落地。公开 API 未改名。

### Watch

| 新文件 | 职责 |
|---|---|
| `sample-store.ts` | ring buffer 类 `WatchSampleStore` |
| `scheduler.ts` | `WatchRuleScheduler` + `effectiveIntervalSeconds` |
| `runtime-pool.ts` | `WatchRuntimePool` 设备引用计数 / acquire-release / close 重建 |
| `evaluation-pipeline.ts` | prompt、LLM `generateObject` 包装、llm cooldown 闸门 |
| `notifier.ts` | 触发/错误/模型不可用通知与广播 |
| `service.ts` | 编排，保留 `WatchService` / `watchService` / `WatchServiceDeps` |

### Control mode

| 新文件 | 职责 |
|---|---|
| `control-mode/types.ts` | 类型与常量 |
| `control-mode/unescape.ts` | 八进制反转义 |
| `control-mode/framing.ts` | 按行切分、超长行丢弃 |
| `control-mode/notifications.ts` | `%output`/`begin`/`end`/`exit` 等 kind 表 |
| `control-mode/metadata.ts` | pane/window metadata 解析 |
| `control-mode/pane-registry.ts` | 每 pane stream parser |
| `control-mode-parser.ts` / `control-mode-subscription.ts` | facade |

Golden：`control-mode-parser.golden.test.ts`、`control-mode-subscription.golden.test.ts`（整段 + 逐字节 + 中点切开）。

## Bug 修复

`%session-renamed` 手册格式只有 `name`。旧实现要求 `sessionId name`，纯 name（含空格）会丢。
`ControlModeMetadataBridge` 记住 `%session-changed` 的 `$id`，name-only 时补上。
`$N name` 形式仍按旧路径解析。测试见 `metadata.test.ts` 与 subscription 回归。

未改 regex 求值路径：采样后立刻 `evaluateWatchRule({ screen, ... })`，没有对 ring 里过期样本求值。
dispose 仍清 structure timer；未发现 lease 泄漏。

## 验证

- 范围测试：111 pass / 0 fail（原 79 + 新单测/golden）
- gateway `bun test`：1267 pass / 0 fail
- biome：26 个改动文件 clean
- tsc：基线 35 → 现 36。范围内 0 个新错误。+1 来自范围外 `control-mode-capture.ts`（`historyText`，其他 agent）
