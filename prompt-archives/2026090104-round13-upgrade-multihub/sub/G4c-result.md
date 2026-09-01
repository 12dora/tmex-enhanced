# G4c result — 22 MB relay push `NODE_UNREACHABLE` / `relay-rst`

## 根因

不是 mux 1 MiB 流控窗本身、也不是 `MAX_LINK_UNACKED`（32 MiB）安全帽。3 MiB in-memory 测通是因为它走 `createInMemoryLinkPair`（byte pipe），没有 Bun `ServerWebSocket`。

生产网关：

```217:219:apps/gateway/src/runtime.ts
    websocket: {
      backpressureLimit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
```

`GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576`（`apps/gateway/src/ws/websocket-send-guard.ts:3`）。Hub uplink 是这条 server WS（`hub-runtime.ts` `BunServerWsAdapter.send` → `ws.send()`）。

`WebSocketLink` 服务端队列原先只要 `send()` 没返回 `-1`/`0` 就继续泵。Mux 把一整窗 DATA（1 MiB payload）在同一轮事件循环里塞进 socket。每帧还有 10 字节 header：约 16 × 64 KiB → **1 MiB + 160 字节** 的 WS 缓冲。Bun 于是关掉连接（`send` 返回 `0`，或 `closeOnBackpressureLimit` 直接掐）。

链路：

1. Hub→C 的 uplink WS 被关掉
2. `pumpRelay` `abortBoth`（`apps/gateway/src/hub/uplink-server.ts:1445-1464`）两边 `reset('relay-rst')`
3. 入口 `openHttpStream` 在响应 HEAD 之前抛错
4. `forwardAuthorizedHttp` 吞掉异常 → `503 NODE_UNREACHABLE`
5. C 侧 PUT 从未进入 handler，没有 staging 目录

这与现场日志一致：A 同进程 hub+node 打出 `rst send/recv stream=… reason=relay-rst`，C 无 PUT 日志，失败发生在 15 s 内（第一窗就撑爆，不是 15 min push timeout）。

未改 `INITIAL_STREAM_WINDOW` / `MAX_FRAME_PAYLOAD` / `MAX_LINK_UNACKED`：那是协议窗和安全帽；混版本改窗会让对端 `exceeded receive window`。问题在传输层把一整窗同步倒进 1 MiB 的 Bun 队列。

## 修复

`packages/shared/src/link/websocket-link.ts`（`createQueuedTransport` server 路径）：

- 新增 `SERVER_WS_BACKPRESSURE_LIMIT = 1 MiB`，与网关 `backpressureLimit` 对齐
- 跟踪 `serverQueued`；下一帧会超过 1 MiB 时 **先 pause、不调用 `send`**，等 `onDrain` 再泵
- `send() === -1` 或 `serverQueued >= 1 MiB` 同样 pause
- `send() === 0` 仍视为丢弃并关 link（行为不变）

`queued === 0` 时仍允许发出单帧（避免一帧略大于 1 MiB 时死锁）。实况 `createReadStream` 默认 64 KiB，不会发满 1 MiB 的单帧。

诊断（仅 raw-body）：

- `forwarder.ts`：`console.warn('[mesh][forward] raw-body push aborted node=… bytes=… err=…')`
- 503 JSON 增加 `error`（底层异常 message）
- `remote-upgrade-job` 的 `describeUpstream` 已拼 `code` + `error`，job 文案变为  
  `push failed: HTTP 503 NODE_UNREACHABLE websocket send discarded`（或实际原因）

未改 `pumpRelay` / `stream-targets` / `upgrade.ts`：hub RST 是 WS 被掐后的症状。

## 测试证据

复现夹具：`large-push-harness.ts` 的 `BackpressuredServerSocket` 模拟 Bun（缓冲 > 1 MiB → `send` 返回 0 并 close）。无 WebSocketLink 排队限制时，第一窗就会把 uplink 掐死。

| 路径 | 字节 | 状态 | durationMs |
|---|---:|---|---:|
| relay（A hub+node → C uplink，1 MiB WS 帽） | 24 MiB = 25,165,824 | 200 `{ received: 25165824 }` | **64–66** |
| ws-secure（`WebSocketLink` + 同一 1 MiB 帽） | 24 MiB | 200 `{ received: 25165824 }` | **14–16** |

另：`websocket-link.test.ts` 用 `sendImpl` 在 > 1 MiB 时返回 0；修复后 24 × 64 KiB 写出 `dropped === 0`。  
`forwarder.test.ts`：raw-body 失败打 warn，503 带 `error`。  
`remote-upgrade-job.test.ts`：job error 含底层原因。

## 验证

| 命令 | 结果 |
|---|---|
| `cd packages/shared && bun test && bunx tsc --noEmit -p .` | **410 pass / 0 fail**，tsc 0 |
| `cd apps/gateway && bun test src/mesh src/system src/hub && bunx tsc --noEmit -p .` | **861 pass / 0 fail**，tsc 0 |
| biome（本任务改动文件） | 干净 |

## 指挥官实况复测

同一套三实例、生产模式、22,359,746 字节 `tmex-cli-1.1.10.tgz`，A→C **relay**（无 DC）：

- `POST /api/mesh/nodes/<C>/upgrade` 仍应立刻 `200 downloading`
- 随后 `GET` 应变 `executing` / handoff，而不是 15 s 内 `idle` + `push failed: HTTP 503 NODE_UNREACHABLE`
- A 日志不应再在推包期间出现 `reason=relay-rst`（停机清理仍可能 RST）
- 若仍失败：看新的 `[mesh][forward] raw-body push aborted node=… bytes=… err=…`。若 `bytes` 卡在 ~1 MiB 且 `err` 仍是 `websocket send discarded`，把 uplink 的 `backpressureLimit` 从 1 MiB 抬高（例如 4 MiB）——那是 `runtime.ts` / 网关 WS 配置，本任务未改。

## 改动文件

- `packages/shared/src/link/websocket-link.ts` + `.test.ts` + `index.ts`
- `apps/gateway/src/mesh/forwarder.ts` + `.test.ts`
- `apps/gateway/src/system/remote-upgrade-job.test.ts`（job 实现未改，`describeUpstream` 已读取 `error`）
- `apps/gateway/src/mesh/integration/large-push.integration.test.ts`
- `apps/gateway/src/mesh/integration/large-push-harness.ts`（新）

未改：`mesh-runtime.ts`、`uplink-pool.ts`、`uplink-client.ts`、`multi-hub-harness.ts`、`pumpRelay`、`apps/fe/**`、`packages/app/**`。
