# G8 result — empty capture ≠ missing, inflight history keyed by transport generation, quiet-wait upgrade

review-be2 findings 8 / 9 / 10 已在代码中核实并落地。未改 `files/**`、`watch/**`。

## 改了什么、为什么

### 1. 空 capture 不再当成 target-missing（finding 8）

`fetchPaneHistoryUncached` 原先 `if (!history) return null`，并把 `TmuxTargetMissingError` 折成 `''`，成功的空屏与 pane 消失无法区分。legacy 切 pane 因此不发 `TERM_HISTORY`，前端一直等到 history timeout。

- `display-message` 失败（`exitCode !== 0`，含 target-missing recovery）→ `null`
- `runHistoryCapture` 抛 `TmuxTargetMissingError` → `null`
- 成功但 stdout 为空 → 仍走 `appendCursorRestore` + modes，返回 truthy payload，`capturePaneHistory` 立刻 `onTerminalHistory`

### 2. in-flight capture 按 transport generation 合飞（finding 9）

`SessionCommands` 跨 control-channel reconnect 存活，合飞 key 原先只有 pane id。reconnect 后对 active pane 的 recapture 会复用 reconnect 前的 hung/stale Promise。

- inflight Map key 改为 `${historyTransportGeneration}:${paneId}`
- `invalidateInflightHistory()` 递增 generation；`ExternalTmuxConnectionCore.startControlClient()` 在每次（重）拉起 control client 时调用——local / ssh 的 `reconnectControlClient` 都走这条路径，不必改那两个文件

### 3. quiet wait 中的 `requestImmediate()` 只升级、不 trailing（finding 10）

原先 `requestImmediate()` 先 `cancelQuiet()` 再 `enqueue(true)`。quiet wait 期间 `active` 仍在，enqueue 会记一条 trailing immediate，结构刷新 + 用户命令变成连续两次 snapshot。

- 若 `cancelQuiet` 已挂起（正在 quiet wait）：只取消等待并返回当前 `active`，不记 trailing
- 刷新真正在跑时仍走原 trailing 语义

## 文件

- `apps/gateway/src/tmux-client/external/session-commands.ts`（+ `.test.ts`）
- `apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts`（+ `.test.ts`）
- `apps/gateway/src/tmux-client/external-tmux-core.ts`（`startControlClient` 一处 invalidate）

未改 `local-external-connection.ts` / `ssh-external-connection.ts`。

## 测量

scratchpad：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/g8-quiet-upgrade.bench.ts`

假时钟：冷启动 `request()` 一次后，结构 `request()`（quiet wait）紧接 `requestImmediate()`：

| | refresh 次数 |
| --- | --- |
| before | 3（1 次冷启动 + 升级后又 trailing 一次） |
| after | 2（1 次冷启动 + 升级后只跑一次） |

即 structure+immediate 这对从 2 次背靠背降为 1 次。

## 测试 / tsc / biome

- `cd apps/gateway && bun test src/tmux-client`：**625 pass / 0 fail**（63 files）
- gateway `tsc --noEmit`：**21**（等于 baseline 21）
- `bunx biome check` 上述 5 个文件：**clean**

新增行为测试：空 capture 返回带 cursor/mode 的 payload 并发 `TERM_HISTORY`；display-message / capture 缺 target 均 `null` 且不 emit；invalidate 后新请求不复用旧 Promise；quiet wait + immediate 恰好一次额外 refresh；刷新进行中的 immediate 仍 trailing 一次。

## 残留 / 风险

- control 已死、`startControlClient` 尚未跑完的 reconnect delay 窗口内，仍可能合飞到旧 capture；reconnect 自己的 recapture 发生在 invalidate 之后，是 finding 9 的主路径。
- 空 history 的 `data` 仍可能只有 cursor restore 序列（无屏幕文本），前端需能消化这种 payload（与非空路径同一 `appendCursorRestore`）。
- 未改 local/ssh 测试里「空 alt 回退」等既有 capture 语义；已知 alt-screen 时仍只采当前屏。
