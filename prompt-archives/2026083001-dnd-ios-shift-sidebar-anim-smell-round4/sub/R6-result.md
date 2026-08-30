# R6 结果：forwarder 响应 / failover 接缝瘦身

## 做了什么

在上一轮（flushQueue 只 flush 一次、HTTP abort listener 在 finally 卸掉、`appendNodeCookie`）之上，把三个高 CC 热点拆开，并删掉文件里用 `rg` 确认过的死代码。拆分的行数由死代码和对重复逻辑的合并覆盖，整体净减。

- **`failover`（CC25/68 → CC9/25）**：循环只负责 retry/open；`openFailoverStream` 做 backoff + getLink + openWs + inflight/abort；`completeFailover` 做 replay + log + flush。`pumpDead` 收口重复的 `browserClosed || aborted`。
- **`handleRemoteHttp`（CC18/54 → CC1/15）**：只留 abort listener 的 try/finally；重试循环提到 `forwardHttp`（CC13/42）。getLink 与 openHttpStream 合成一个 try（失败语义不变：非幂等 break，幂等 continue）。幂等判定与 GET/HEAD 禁 body 共用 `IDEMPOTENT_HTTP`。
- **`adaptResponse`（CC17/65 → CC2/7）**：`copyUpstreamHeaders` 只做 allowlist / MIME / CSP；`applyAuthPolicy` 做 set-session cookie、renewed、以及 401 JSON 改写。
- **死重量（`rg` 验证后删除）**：从未被调用的 `handleForwardSocketOpen`；只写不读的 `boundLink` / `ForwardMeta.link`；与 `getMeshRequestContext().selfRewrite` 重复的 `selfRewrites` WeakMap；pathname 不含 query 时的 `stripQuery`；未使用的 `WS_CLOSE_LOGIN_REQUIRED` 与 `LinkSession` import；无站外 importer 的 `export`（`ForwarderDeps`、`ForwardResult`、`parseNodePrefix`、`rewriteRequest`）。
- **重复删除**：三处 pane-sub 解码收成 `paneSubPayloads`；hello/resume 等待与 connect/post-connect 发送在 `replaySubscription` 内局部去重；`NODE_UNREACHABLE` 的 jsonError 调用点压成单行；`readBodyLimited` 用 `Buffer.concat` 收尾。

## 变更文件

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/mesh/forwarder.ts` | 拆 failover / HTTP 重试 / 响应改写；删死字段、死方法和死导出 |
| `apps/gateway/src/mesh/forwarder.test.ts` | 未改 |

## 行数

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `apps/gateway/src/mesh/forwarder.ts` | 1049 | 993 | **−56** |

目标 −40 已达到（−56）。

| 函数 | 前 | 后 |
|------|----|----|
| `failover` | CC25 / 68L | CC9 / 25L |
| `handleRemoteHttp` | CC18 / 54L | CC1 / 15L |
| `adaptResponse` | CC17 / 65L | CC2 / 7L |

三个目标函数均低于 CC15。同文件内其余函数（含 `forwardHttp` CC13、`openFailoverStream` CC12、`applyAuthPolicy` CC13）也全部 ≤15。

## `git diff --stat`

```
 apps/gateway/src/mesh/forwarder.ts | 678 +++++++++++++++++--------------------
 1 file changed, 311 insertions(+), 367 deletions(-)
```

## 测试 / tsc / biome

**开始前：**

- `bun test src/mesh/forwarder.test.ts src/mesh/integration/stream-failover.integration.test.ts`：46 pass / 0 fail（39.23s）
- 未跑全量 `apps/gateway && bun test`（并行 agent 正在改其它文件）

**结束后：**

- `bunx biome check apps/gateway/src/mesh/forwarder.ts`：通过
- `bun test src/mesh/forwarder.test.ts`：44 pass / 0 fail
- `bun test src/mesh/forwarder.test.ts src/mesh/integration/stream-failover.integration.test.ts`：46 pass / 0 fail（24.67s）
- `bunx tsc --noEmit -p .`：35 个 `error TS`，**无一落在 `forwarder.ts`**。增量全部在并行范围内的 `hub-runtime.ts` / `mesh-routes.ts` / tmux / telegram / push 等。基线 21 的上升与本文件无关。

## 修过的 bug

无新行为 bug。上一轮已修的 flush 双调用与 abort listener 泄漏保持原样（成功路径仍只在 `failingOver` 复位后 `flushQueue` 一次；HTTP listener 仍在 `finally` 卸掉）。

## 刻意跳过

- **`noteOutbound` 的长 switch**：已低于 CC15，再拆会加行。
- **`defaultSleep`**：上一轮刚修了 abort listener 泄漏，未再动。
- **`readBodyLimited` 仍按字节上限读并 `cancel`**：改成 `arrayBuffer()` 会读满 body、不再在 64KiB 处取消上游，属于可观察行为，不换。
- **未改** `forwarder.test.ts`、发版文件、以及前几轮保留热点（本文件不含那些符号）。
- **全量 `apps/gateway bun test`（2499）**：未作为本轮门禁。并行 agent 把 gateway tsc 从 21 抬到 35，且曾出现 `hub-runtime.ts` 的 `firstAbort is not defined` 中间态；scoped 的 46 条已绿。
