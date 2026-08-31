# G2 结果：去掉 TERM_HISTORY 后固定 450ms LIVE_RESUME 延迟

## 改了什么

去掉 `LIVE_RESUME_DELAY_MS = 450`。最后一个 `TERM_HISTORY` 分块同步写入 socket 后立即发 `LIVE_RESUME`；`wantHistory:false` 在 `SWITCH_ACK` 后立即 resume，且走 `focusPane`（不 `capture-pane`）。

## 450ms 为何存在（git）

- 引入：`890a7fc0`（2026-02-14，`wip: fe`）。`git blame` 该常量仍落在此 commit。
- 源码注释（后被 `e6bf6291` 清理掉，延迟本身留下）：
  - history 发完后延迟解除屏障，「给快速连续切换留出取消窗口」
  - `wantHistory:false` 同样延迟，「也要……留出取消窗口」
- 没有测试编码 450ms 或「取消窗口」语义。
- 该理由不成立，**未保留任何延迟**：
  1. `startTransaction` 先 `cancelTransaction`，会 `clearTimeout` 旧 resume 定时器。
  2. `sendLiveResume` 仍按 `selectToken` 门控，过期 token 不能 resume。
  3. `sendToClient` / `sendFrames` 是同步循环：全部 history 分块交给 socket 后才返回；WS 有序，客户端先处理 history 再处理 resume。
  4. 背压不是「异步续传剩余分块」：`sendFrames` 遇 `backpressure` 会丢掉后续帧并最终 terminate（`backpressure_gap`），没有 drain 后再发完 history 的队列。因此不存在「必须等一个与 history 不同的队列排空」的排序理由。

## `wantHistory: false` 网关行为（给 O3 热切换）

`handleTmuxSelect` 收到 `TMUX_SELECT(wantHistory:false)` 时：

| 步骤 | 行为 |
|---|---|
| 屏障 | 仍 `startTransaction`（短暂打开 output buffering） |
| ACK | 立刻 `SWITCH_ACK` |
| LIVE_RESUME | **立刻**（与 ACK 同一调用栈，无 450ms、不武装 history 超时） |
| 缓冲 | resume 时关闭；该同步窗口内若有 buffer 会跟在 LIVE_RESUME 后 flush |
| tmux select | `focusPane` → `select-window` + `select-pane`，发 `pane-active`，要 snapshot |
| capture-pane | **不执行**（不再走 `selectPane` / `selectPaneWithSize`，那两条总会 capture） |
| resize-window | 仅当 `cols` 与 `rows` 都非 null：额外 `resizePane` → `resize-window` |
| 迟到的 TERM_HISTORY | 事务已 `STABLE`，`sendTermHistory` 要求 `ACKED`，直接 no-op |

对 O3：热切换发 `wantHistory:false` 即可，ACK 后马上 LIVE_RESUME，无 TERM_HISTORY。仍会 tmux focus；若不想 resize，不要带 cols/rows。

`wantHistory:true`：ACK 后仍等 capture 回调 `sendTermHistory`（history 超时 1500ms 仍会 resume），发完最后一块 history 立刻 LIVE_RESUME。

## 文件

- `apps/gateway/src/ws/borsh/switch-barrier.ts` — 删 450ms；history 发完 / wantHistory:false ACK 后立即 resume；history **发送失败**也走 `sendLiveResume`（避免卡在 HISTORY_APPLIED + buffering）
- `apps/gateway/src/ws/borsh/switch-barrier.test.ts` **新建** — 立即 resume、分块顺序、过期 token、history 超时仍 resume、发送失败仍解除、wantHistory:false
- `apps/gateway/src/ws/tmux-command-handlers.ts` — `wantHistory:false` → `focusPane`（+ 可选 `resizePane`）
- `apps/gateway/src/ws/tmux-command-handlers.test.ts` **新建**
- `apps/gateway/src/ws/switch-barrier.issue45.test.ts`、`apps/gateway/src/ws/issue45-cross-bug.test.ts` — `HISTORY_APPLIED` 现为瞬态，断言改为 `STABLE`（否则套件回归）。主断言（按事务 pane 投递 TERM_HISTORY）未改。

未改 `legacy-feed-broadcaster.ts`。

## 测试 / tsc

| | before | after |
|---|---|---|
| `apps/gateway` `bun test` | **2969 pass / 0 fail** | G2 相关 7 个文件 **110 pass / 0 fail**。全量当时约 2987 pass / 10 fail，失败全在 G3 文件（`node-list-projection`、`PeerManager`、`mesh-routes`），非本任务 |
| `bunx tsc --noEmit -p apps/gateway` | **21** | 本任务文件 **0** 条新错误；全量随其他 agent 在 21–32 间晃 |

`bunx biome check` 上述改动文件：通过。

新增用例：立即 resume；分块 LIVE_RESUME 在最后一块之后；过期 token 忽略；history 超时 / 发送失败仍解除；wantHistory:false ACK 后立即 resume 且不走 capture。

## 指挥官需知

- 上述两个 issue45 测试不在「Owned files」原文列表，但不断言会变成全量 fail。
- `session-commands.selectPaneInternal` 仍无条件 capture；G2 只在 `wantHistory:false` 改走 `focusPane`。若别处仍调 `selectPane`，仍会 capture。
- ACK 发送失败路径仍 `completeTransaction`（`ACKED→STABLE` 非法转移，预存在），未扩范围去修。
