# T4 结果 — UplinkClient key-log sync 抽出

## 改了什么、为什么

`UplinkClient` 把连接/鉴权/心跳和 key-log catch-up 混在一个类里。catch-up 是独立状态机（generation、pending req/ack、fork、abort、list epoch），S1 finding 2 要求把它抽到 `UplinkKeyLogSync`，客户端只留 socket/auth/heartbeat/ctl dispatch。

抽出后的 host 正好 8 个回调，无模块环：

1. `generation()`
2. `isAuthenticated()`
3. `userId()`
4. `isOnline()`
5. `send(bytes)`
6. `tearDown(reason)`
7. `persistList(list)` — hub meta + admitted peers
8. `emitNodeList(list)` — 再 persist peers 后触发 `onNodeList`

构造期依赖（applier / scheduler / timeout / retry / `onFork` / `warnCatchUp`）不算进 host。`warnCatchUp` 只接到现有 `warnCtl` 限频日志。

协议逻辑原样搬迁：`handleKeyLogRes`、node-list catch-up 链、`queryKeyLogAt` / `appendAndAck`、pending req+ack、fork、`reset` 取消。`keyLogForked` 在 `reset` 时**不**清（fork 仍是硬失败）。`connectWithLink` 仍先 `snapshotTasks` 再 `reset`，避免 abort 同步 settle 后丢 in-flight promise。

未改 `jsonText`：另一 agent 已换成 `import { jsonText } from './json-text'`，本任务只继续用这个 import。

## 文件

- `apps/gateway/src/mesh/uplink-client.ts`（改）
- `apps/gateway/src/mesh/uplink-key-log-sync.ts`（新）
- `apps/gateway/src/mesh/uplink-key-log-sync.test.ts`（新，缝/回归）

## 行数 / CC

| | before | after |
|---|---:|---:|
| `uplink-client.ts` | 1371 | **843**（&lt; 900） |
| `uplink-key-log-sync.ts` | — | 630 |
| 生产净行 | | **+102**（843+630−1371） |

未打到 ≤+15：8 回调 host 类型、构造接线、`snapshotTasks`/`awaitSnapshot`/`reset` 公开面是抽出固有成本；catch-up 方法体没有复制。未走到 allowlist（缝干净：8 回调、无环依赖）。

| 函数 | before CC / 行 | after CC / 行 |
|---|---|---|
| `connectWithLink` | 12 / 36 | 8 / 24（client） |
| `handleCtl` | 13 / 20 | 13 / 17（client，仍只做 dispatch） |
| `resetConnectionState` | 3 / 21 | 2 / 9 |
| `handleKeyLogRes` | 8 / 22 | 8 / 22（sync） |
| `ingestNodeList` | 3 / 27 | 2 / 19（sync） |
| `runCatchUpFromList` | 10 / 27 | 10 / 27 |
| `pullAndApplyPages` | 15 / 49 | **15 / 49**（贴上限，未加分支） |
| `applyCatchUpPage` | 15 / 61 | **15 / 61** |
| `queryKeyLogAt` | 7 / 16 | 6 / 16 |
| `appendAndAck` | 6 / 39 | 5 / 38 |
| `pushMissingToHub` | 11 / 26 | 11 / 26 |
| `requestKeyLog` | 4 / 46 | 3 / 46 |

`gate.ts --report` 里这两个文件不再进入 CC 排行。

## 测量

scratchpad：`t4-keylog-host-bench.ts`（匹配 head 的 ingest 快路径 20k 次）+ 紧循环 2e6 次 `host.generation()` vs 直接读字段。

| | |
|---|---:|
| 匹配 head ingest | 26.26 ms / 20k = **1.313 µs/次** |
| `host.generation()` | **1.33 ns** |
| 直接字段 | **1.08 ns** |

host 多一次函数调用约 0.25 ns，相对 catch-up I/O 可忽略。无运行时加速承诺（与 S1 一致）。

## 测试

新缝测试（先 RED：模块不存在；再 GREEN）：

- 匹配 head：先 persist 再 emit，不 tearDown
- 同 seq 不同 hash：`key_log_fork` + tearDown，不 emit
- 换代后 stale catch-up 不能 failFork
- `reset` 把 pending append ack 打成 `offline`
- missing `key.log.res` id 只 warn 一次，对上 id 才 resolve

验证：

- `bun test src/mesh/uplink-client.test.ts src/mesh/uplink-key-log-sync.test.ts src/mesh/mesh-runtime.test.ts src/hub` → **134 pass / 0 fail**
- `bun test src/mesh` → **497 pass / 0 fail**
- `bunx tsc --noEmit -p .`（gateway）：全仓 **28** 个 error（基线 21）；**T4 文件 0**。多出的 7 个在 `push/supervisor.test.ts`、`user-key-service.ts`、`mesh-runtime.ts`、tmux/ssh/telegram/ws，属并行 agent，非本任务。
- `bunx biome check` 上述 3 个文件 → clean

## 未做 / 风险

- 净行 +102 &gt; 任务 +15。若收线以净行硬卡，应 allowlist `uplink-client.ts` 文件级而不是再拆；再拆会加 wrapper。
- `failFork` → `tearDown` → `keyLog.reset()` 仍是重入，行为与抽出前相同；`uplink-client.test.ts` 的 stale generation / abort applyMany / fork 用例覆盖。
- `requestKeyLog` 不再单独判 `link`：无 link 时 `host.send` 抛 `uplink-offline`，再清 pending。现有测试仍过。
