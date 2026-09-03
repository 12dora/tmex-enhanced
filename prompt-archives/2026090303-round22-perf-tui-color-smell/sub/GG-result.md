# GG 结果：T2 leading-edge 终端输出合帧

## 改动

三处对称改为 **leading-edge + cooldown trailing**：

- pane 缓冲为空且距上次 flush ≥ `delay` → 以 **0 延迟**调度 flush（同轮 burst 仍合进同一缓冲，flush 次数不上升）
- 随后进入长度为 `delay` 的冷却窗口，窗口内按原 trailing 合帧（timer = 剩余时间）
- max-bytes 切块与既有背压/hold 路径未改；只在缓冲为空时 leading，保序

未做「首块同步直发」：那会把同轮 N 块拆成 2 次 flush，并打穿未拥有的 `index.test.ts` / `canonical-feed-session.test.ts` / `pane-sink-registry.test.ts`（它们断言同轮合帧、flush 前 frames=0）。0 延迟调度在击键路径上去掉 16ms/4ms 等待，同轮 TUI burst 仍 1 次 flush。

### 文件

- `apps/gateway/src/ws/terminal-output-batcher.ts`（+ `now` 注入）
- `apps/gateway/src/ws/terminal-output-batcher.test.ts`
- `apps/gateway/src/ws/canonical/pane-stream.ts`（+ `now` / `scheduleTimer` / `cancelTimer` 可选注入）
- `apps/gateway/src/ws/canonical/pane-stream.test.ts`
- `packages/ws-client/src/pane-output-coalescer.ts`（`PaneOutputScheduler` 第二参 `delayMs` 向后兼容）
- `packages/ws-client/src/pane-output-coalescer.test.ts`

每处补 4 条：孤立块 delay=0、burst flush 上界（≤2，实测 1）、间隔 > delay 两次 leading、冷却边界保序。

## 测量

未跑线上 RTT（禁碰 9883 / 生产 tmex）。行为等价于孤立回显从固定 16ms+4ms 变为 0 延迟 macrotask；持续输出冷却期内仍 16ms/4ms 合帧。

## 测试 / tsc / biome

| 项 | 基线 | 之后 |
|---|---|---|
| `cd apps/gateway && bun test src/ws` | 332 pass / 0 fail | 拥有文件 20/20 全绿；全量 332 pass / 8 fail（失败全在未拥有的 `websocket-send-guard` / `index.test.ts` slow consumer / RTC，并行 T9 等） |
| `cd packages/ws-client && bun test` | 382 pass / 0 fail | **392 pass / 0 fail** |
| `apps/gateway` tsc | 0 | 拥有文件 0；包级 1 条在未拥有的 `websocket-send-guard.ts`（并行修改） |
| `packages/ws-client` tsc | 0 | **0** |
| biome（6 个拥有文件） | — | 通过 |

拥有包测试：`terminal-output-batcher.test.ts` + `pane-stream.test.ts` 20 pass；`pane-output-coalescer.test.ts` 15 pass。`canonical-feed-session` 合帧用例、`pane-sink-registry` 合帧/discard 仍绿。

## 未做

- 未改 `apps/gateway/src/ws/index.ts`、`legacy-feed-broadcaster.ts`、`canonical-state-client.ts` / `client.ts`
- 未测真实击键 RTT
- gateway 包级 tsc/全量 fail 来自并行 agent 的 `websocket-send-guard.ts`，未触碰
