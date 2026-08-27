# retention-perf 结果

## 改了什么

`ingest()` 热路径不再对所有 pane 做 `sweep()` / `Array.from+filter+sort`。

- 全局 `retainedBytes` 随 append / trim / checkpoint / makeCold / epoch rotate / pane 删除增量维护。
- 单次 ingest 只处理当前 pane 的 per-pane replay byte limit 与 replay TTL。
- 全局 sweep（所有 pane 的 TTL / grace→hot / hot_limit / retention_limit）只在：定时器、订阅变更（`refreshModes`）、或 `retainedBytes` 越过 `maxRetentionBytes` 时运行。
- implicit / explicit hot 用 Map 索引；hot_limit 只在 implicit 数量超过额度时排序驱逐。
- retention_limit 的最老 replay chunk 用 lazy min-heap，避免每踢一条就 `filter+sort` 全表。
- 定时器 deadline 补上 oldest replay + `replayTtlMs`，避免去掉 ingest 全表 sweep 后 TTL 只能等到 grace/hot 边界才触发。

驱逐顺序与原先 `enforceBounds` 一致（表征测试锁定）：

- hot_limit：implicit hot 按 `lastTouchedAt` DESC，并列按插入序（`createOrder` ASC）保留前 N 个；explicit hot 不参与。
- retention_limit：先 LRU 整 pane makeCold implicit hot，再按保护 rank（active > explicit hot > 其余）+ LRU 丢 checkpoint，最后按 oldest `receivedAt`（并列 rank/LRU/插入序）踢 replay chunk。

## 文件

- `apps/gateway/src/tmux-client/pane-retention.ts` — ingest 去掉全表 sweep；reconcile 删除 pane 时 `forgetPane`
- `apps/gateway/src/tmux-client/retention/kernel.ts` — `retainedBytes`、hot 索引、`createOrder`
- `apps/gateway/src/tmux-client/retention/policy-scheduler.ts` — 按需 sweep / 索引驱逐 / replay TTL 定时器
- `apps/gateway/src/tmux-client/retention/replay-store.ts` — 增量记账
- `apps/gateway/src/tmux-client/retention/types.ts` — `PaneState.createOrder`
- `apps/gateway/src/tmux-client/retention/min-heap.ts` — 懒 min-heap
- `apps/gateway/src/tmux-client/retention/eviction-order.test.ts` — 改前写好的表征测试
- `apps/gateway/src/tmux-client/retention/min-heap.test.ts`
- `apps/gateway/bench/pane-retention.bench.ts`
- `apps/gateway/package.json` — `bench:retention`（未动其他 `bench:*`）

## Bugs

无行为 bug 修复。性能重构。语义上唯一变化：其它 pane 的 replay TTL 不再在每次 ingest 时顺带清掉，改为定时器 / 订阅 / 越过全局 cap 时清理。同 pane 的 TTL 与 byte limit 仍在 ingest 上立即执行。既有测试都是时间推进后显式 `sweep()`，不受影响。

## 基准（`bun run bench:retention`，active panes，每组 8000 次 ingest）

| P | seg | BEFORE µs/ingest | AFTER µs/ingest | 加速 |
| --- | --- | ---: | ---: | ---: |
| 10 | 1 KiB | 2.77 | 1.03 | 2.7× |
| 10 | 16 KiB | 3.54 | 2.59 | 1.4× |
| 100 | 1 KiB | 8.57 | 0.62 | 14× |
| 100 | 16 KiB | 9.72 | 2.24 | 4.3× |
| 500 | 1 KiB | 36.44 | 0.64 | 57× |
| 500 | 16 KiB | 35.91 | 2.00 | 18× |

改前 per-ingest 随 P 线性涨（全表 scan）；改后 1 KiB 路径与 P 无关，16 KiB 主要是 `copyBytes`。

## 测试 / tsc

- 表征测试先在旧实现上全绿，再改生产代码后保持全绿。
- `bun test`（retention 相关 6 个文件）：28 pass / 0 fail
- `bun test`（整个 gateway）：1537 pass / 0 fail（基线 1473；其它 agent 同期加了测试，无失败）
- `bunx tsc --noEmit -p .`：27 个既有错误，retention 路径 0 新增
- `bunx biome check --write`：已对本次文件跑过，干净

## 未做

- 没有给 implicit hot 做持续维护的双向链表 LRU：hot 数量通常很小，超额时对索引 `sort` 即可复现旧的并列插入序；链表 touch-order 在 `lastTouchedAt` 相同时会与稳定 sort 不一致。
- 没有改其它 `tmux-client` 文件。
