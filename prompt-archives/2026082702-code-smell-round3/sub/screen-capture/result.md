# screen-capture 执行结果

## 背景

`CanonicalScreenCapture.captureInternal`（原 L48–147，约 100 行、CC≈24）把 barrier/fallback 采集、历史行预算、UTF-8 截断、epoch 校验和 checkpoint 构造揉在一起。按计划拆成两个模块，主函数只做编排。行为保持不变。

## 改动

`captureInternal` 现为约 30 行的编排器：身份/预算守卫 → `estimateHistoryLines` → `capturePaneFrame` → `assembleScreenPayload` → `resolveCaptureEpoch` → `buildScreenCheckpoint` → 落库。

### `runtime/screen-frame-source.ts`

采集路径选择：

- 有 `capturePaneFrameAtBarrier`：在 `onBarrier` 里采样 `getLatestCursor`
- 否则 fallback：`getPaneInfo` → `capturePaneText`（alt 屏 `historyLines=0`）→ `getLatestCursor` → `getPaneHistoryCaptureInfo`；`historyText=null`、`modes=null`

`CanonicalScreenCaptureHost` 继承 `ScreenFrameCaptureHost`，对外方法集不变。

### `runtime/screen-checkpoint-builder.ts`

纯函数：

- `estimateHistoryLines`：按列宽/行高估字节，额外历史最多 256 行
- `truncateUtf8Tail`：从 `@/bytes` 再导出，截尾且不切开 UTF-8 码点
- `assembleScreenPayload`：前缀/光标预留预算、历史整段取舍、可见区尾截断、组装 payload
- `historyCursorBeforeLine` / `encodeScreenModes` / `resolveCaptureEpoch` / `buildScreenCheckpoint`

历史规则保持原样：alt 屏 scrollback 永不拼进快照；预算不够时整段丢历史，不从头部截断。

`canonical-screen-capture.ts` 仍导出 `concatBytes` / `truncateUtf8Tail`，原测试 import 路径不变。

## 文件

- 修改：`apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts`
- 未改：`apps/gateway/src/tmux-client/runtime/canonical-screen-capture.test.ts`（按任务要求原样通过）
- 新建：
  - `apps/gateway/src/tmux-client/runtime/screen-frame-source.ts`
  - `apps/gateway/src/tmux-client/runtime/screen-frame-source.test.ts`
  - `apps/gateway/src/tmux-client/runtime/screen-checkpoint-builder.ts`
  - `apps/gateway/src/tmux-client/runtime/screen-checkpoint-builder.test.ts`

## 修的 bug

无。本次是等行为重构。

## 测试 / tsc

相关测试（先红后绿：缺模块失败 → 实现后通过）：

- `bun test src/tmux-client/runtime/canonical-screen-capture.test.ts src/tmux-client/runtime/screen-checkpoint-builder.test.ts src/tmux-client/runtime/screen-frame-source.test.ts`：**33 pass / 0 fail**（原 7 + builder 23 + frame-source 3）
- 新增覆盖：2/3/4 字节 UTF-8 截断边界、payload 尾截断不切开 CJK、历史整段丢弃、alt 屏不带 scrollback、预算估算（默认 80×24、256 行帽、16 字节/行下限）、barrier vs fallback 调用顺序

全包：

- `cd apps/gateway && bun test`：**1607 pass / 2 fail**（基线 1473；本任务新增 26 条）
- 两处失败均不在本次文件，属并行 agent：
  - `agent query indexes > list pending confirmations uses (session_id, status, created_at) index`（`db-indexes`）
  - `LegacyFeedBroadcaster pane observer counts > skips batching when nobody observes...`（`legacy-broadcaster`，`legacyPaneObserverCount` 未定义）

类型与格式：

- `bunx tsc --noEmit -p .`：**29 errors**（基线 27）。本次文件 **0**。多出的在并行改动里（如 `src/push/connection-alerts.test.ts` / `src/push/supervisor.test.ts` 缺 `disabledNotificationChannels`）
- `bunx biome check --write`：上述 5 个源/测文件通过

## 未做 / 为何

- 未改 `device-session-runtime.ts` 及其它 tmux-client 文件（范围外；host 接口结构兼容）
- 未改 `bytes.ts` 的 `truncateUtf8Tail` 实现，builder 再导出并补多字节用例
- 未把 epoch 校验或 `storeScreenCheckpoint` 再抽一层：编排器已短，再拆只会增加转发
