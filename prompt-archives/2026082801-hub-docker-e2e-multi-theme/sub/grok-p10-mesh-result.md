# grok-p10-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。范围 `apps/gateway/src/mesh/**`、`apps/gateway/src/hub/**`、`apps/gateway/src/auth/user-key-service.ts`、`packages/shared/src/link/mux.ts`、`packages/shared/src/ws-borsh/**`、`packages/ws-client/src/**`、`apps/fe/src/node/mesh-nodes.ts`（+ `mesh-events.ts` 解码）。无 git 操作。未碰 `tmex-split`。

`review-p9.md` 的 5 条 finding 全部落地，每条都有先红后绿的单测。

## 改动摘要

| # | 处理 |
|---|---|
| 1 | `track()` 入站替换：旧链未 ACK quiesce 时不 `retirePeer`。新链 `parkInbound`（已认证、不接流），probe 旧链；ACK 后 `activateParked` 再切换。legacy 主动拨升级不会丢掉在途 OPEN。 |
| 2 | `head` / `list` / `applyMany` 接受 `AbortSignal`。`applyMany` 先整批校验，再 head-CAS 单事务提交；abort 发生在提交前则 `applied=0`。uplink 按代次追踪 **原始** applier Promise，重连时 bounded `allSettled`，两代不会并发改 key-log。 |
| 3 | NODE_EVENT Borsh 增加 option 字段 `version` / `directCapable` / `name`；`decodeNodeEvent` 兼容旧 4 字段 payload。gateway 编码器、ws-client `GatewayNodeEvent`、fe `mesh-events` 解码与 `patchNodesWithEvent` 同步更新这些字段。 |
| 4 | overflow 改为 per-user TTL LRU，内部 per-node 子桶（硬顶 8）+ remainder；`size` 计入 overflow。限流返回 `key.log.res error=rate_limited`。暴露 `overflowUsers` / `overflowNodes` / `denied` / `primarySize`。 |
| 5 | `sendFrame` 异步 rejection 先 `finishClose` 再 reject。WINDOW/RST 的 `.catch()` 只吞 rejection，不再留下假在线 mux。 |

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `legacy peer inbound upgrade with an OPEN in flight does not replace the live link` | #1 |
| `applyMany abort mid-batch does not commit further records` | #2 服务 |
| `aborted applyMany stops mid-batch and reconnect waits for the in-flight commit` | #2 uplink |
| `NODE_EVENT payload roundtrip includes version / directCapable / name`（含 legacy decode） | #3 schema |
| `NODE_EVENT 更新 version / direct_capable / name` | #3 fe patcher |
| `KIND_NODE_EVENT 带上 version / directCapable / name` | #3 ws-client |
| `overflow limiter is TTL-bounded, node-fair, and counted in size` | #4 |
| `closes the mux when transport.send rejects without firing onClose` | #5 |

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2296 pass / 0 fail**（基线 2292；本轮 +4） |
| `bun test`（`packages/shared`） | **327 pass / 0 fail** |
| `bun test`（`packages/ws-client`） | **261 pass / 0 fail** |
| `bun test src/`（`apps/fe`） | **331 pass / 0 fail** |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 21） |
| `bunx tsc --noEmit` shared / ws-client / fe | **0** |
| `bunx biome check`（改动文件） | 通过 |

## Harness（remote-cycle tag `p10`）

`scripts/hub-e2e/out/report.md`（远程 2026-08-28T10:34:36Z；本轮脚本含 `bundle:resources` + runtime + cli pack；项目 `tmex-e2e`，未碰 `tmex-split`）：

| scenario | result |
|---|---|
| 1a–1c | PASS |
| 2a–2c | PASS |
| 3a–3g | PASS |
| 4a / **4b** / **4c** / 4d | PASS |
| 5 | PASS |
| **6a** / **6b** / 6c | PASS |
| 7a–7b | PASS |
| **8** | PASS |

全 PASS。日志在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p10/`。
