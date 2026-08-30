# R2 result — Gateway tmux-client: bounded legacy pane history, refresh quiet period, cold pane no-copy

Y2 items 2、3、8 已在代码中核实并落地。未改 `files/**`、`watch/**`、`api/**`、`hub/**`、`mesh/**`。

## 改了什么、为什么

### 1. `fetchPaneHistory()` 有界 capture + 同 pane 合飞（Y2 #2）

旧路径两次 `capture-pane -S -`，无行数/字节上限，本地 `Response.text()` / SSH 命令通道整段累积。control-barrier 路径已有 4096 行上限，legacy 绕过。

- 抽出 `MAX_PANE_HISTORY_LINES = 4096`、`MAX_PANE_HISTORY_CAPTURE_BYTES = 2 MiB`。
- alt-screen 已知（`0`/`1`）时只 capture 当前可见屏（无 `-a`）；未知时仍双采，但都带 `-S -4096` 且走 `runHistoryCapture`。
- 同 pane 并发请求共享 in-flight Promise。
- 本地 runner：`readTextWithByteLimit` 流式截断，超限 kill 子进程；SSH isolated 路径原本已按字节截断，legacy 现接入该路径。

### 2. 结构刷新 quiet period 150 ms（Y2 #3）

`requestSnapshot()`（control 通知 / 结构 churn）走 `coordinator.request()`，刷新后至少静默 150 ms，连续通知下约 ≤6–7 次/秒（每次 3 条 tmux 命令）。`requestSnapshotInternal()`（connect、用户命令 `runAndRefresh`）走 `requestImmediate()`，可打断 quiet wait。

### 3. Cold pane 不拷 payload、无消费者不 fan-out（Y2 #8）

`append()` 在 `mode === 'cold'` 只推进 `latestSeq` / `dirtyWhileCold`，不 `copyBytes`、不建 segment。`ingest()` 对 cold 返回 `null`。`fanout()` 在 `consumers.size === 0` 时直接返回。retained（active/grace/hot）路径仍拷贝并 fan-out。

调用方核对：`event-bridge.ts` 丢弃 `ingest` 返回值；测试与 bench 也不依赖 cold segment。

## 文件

- `apps/gateway/src/tmux-client/control-mode-capture.ts`
- `apps/gateway/src/tmux-client/external/session-commands.ts`（+ `.test.ts`）
- `apps/gateway/src/tmux-client/local-external-connection.ts`（+ `.test.ts`、`.eagain.test.ts`）
- `apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts`（+ `.test.ts`）
- `apps/gateway/src/tmux-client/external-tmux-core.ts`
- `apps/gateway/src/tmux-client/retention/replay-store.ts`
- `apps/gateway/src/tmux-client/pane-retention.ts`（+ `.test.ts`）

## 测量

scratchpad：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/cold-pane-ingest.bench.ts`  
Bun 1.3.14 / macOS arm64，5000 × 1 KiB cold ingest，best-of-5：

| | 耗时 | retainedBytes |
| --- | --- | --- |
| before | 2.147 ms | 0 |
| after | 0.904 ms | 0 |

约 2.4×。结构刷新：假时钟 1 s 连续 `request()` → refresh 次数 ∈ [6, 7]，tmux 命令 ≤ 21（每 refresh 3 条）。

## 测试 / tsc / biome

- `cd apps/gateway && bun test src/tmux-client`：**618 pass / 0 fail**（63 files）
- gateway `tsc --noEmit`：**21**（等于 baseline 21）
- `bunx biome check` 上述 12 个文件：**clean**

新增行为测试：bound `-S -4096` + byte cap；未知 alt 才双采；并发同 pane 共享一次 capture；`readTextWithByteLimit` 超限拒绝；quiet period 1 s 封顶；`requestImmediate` 不走 delay；cold ingest 返回 null 且不 fan-out，retained 仍拷贝。

## 残留 / 风险

- alt-screen **已知** 时不再做「可见 capture 空则回退 `-a`」。原先 `hasRenderableTerminalContent(normal) ? normal : alternate` 只在未知时保留。已知且可见 capture 为空会得到 `null` history。
- `requestSnapshot()` 在上次刷新 150 ms 内会推迟；用户命令仍走 immediate。部分原用短 `sleep` 断言 public `requestSnapshot` 的测试已改为 200 ms / `requestSnapshotInternal`。
- 超 2 MiB 的 legacy history capture 会 throw（与既有 `runHistoryCapture` 超限语义一致），不再静默截断。
