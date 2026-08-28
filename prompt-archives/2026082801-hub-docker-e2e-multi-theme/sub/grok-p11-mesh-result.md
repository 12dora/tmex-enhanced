# grok-p11-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。范围 `apps/gateway/src/mesh/**`、`apps/gateway/src/hub/**`、`apps/gateway/src/auth/user-key-service.ts`、`packages/shared/src/link/mux.ts`、`apps/fe/src/node/mesh-events.ts` + `mesh-nodes.ts`（+ tests）。无 git 操作。未碰 `tmex-split`。

`review-p10.md` 的 6 条 finding 全部落地，每条都有先红后绿的单测。

## 改动摘要

| # | 处理 |
|---|---|
| 1 | `onRevoked` 先 `dropParked`。`dropPeer('revoked')` 不再 `activateParked`。`track()` / `activateParked()` 提升前重验 trust（证书存在、未撤销、同 user）。 |
| 2 | park 时立刻注册 ctl drain + `onStream` RST（`parkedSessions` WeakSet，activate 后失效）。替换 parked 链保留原始 `at`，不重置 fence。`LinkMux` 增加 pending incoming / ctl inbox / streams 硬上限，溢出 `protocolError` 关链。 |
| 3 | `key.log.req` 增加 `limit`（默认 256），`key.log.res` 增加 `has_more`；hub 按条数 + ~1 MiB 截断。客户端按页循环、每页 head-CAS `applyMany`，拒绝超过 256 条的响应。`applyMany` 校验时只保留最新状态 + 标量 nextHead/nextRoot，persist 走 payload，不再保存逐步 Map 快照。 |
| 4 | `decodeMeshFrame` 对缺省 optional 保留 `null`；`patchNodesWithEvent` 仅在 wire 有值时更新 `direct_capable` / `version` / `name`。legacy 四字段不再把已有 `direct_capable:true` 改成 `false`。 |
| 5 | 去掉 overflow remainder 桶。超出 per-user 8 个 overflow 节点直接 `rate_limited`（带 `retry_after_ms`）。overflow 仍是有界 per-node LRU+TTL，过期后重连节点能拿回槽位。 |
| 6 | 同步/异步 send 失败都走 `close(reason)`：先幂等 `transport.close`，再 `finishClose`，再 reject。关闭后 `onData` 丢弃，`pendingChunks` 不再增长。 |

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `revoking a node drops parked inbound instead of promoting it` | #1 |
| `track refuses to promote a parked link after the cert is revoked` | #1 |
| `parked inbound RSTs OPEN, drains ctl, and keeps the original fence deadline` | #2 |
| `closes the link when pending incoming streams exceed the hard cap` | #2 mux |
| `closes the link when the ctl inbox exceeds the hard cap` | #2 mux |
| `applyMany 2000 records commits atomically without per-step state snapshots` | #3 applyMany |
| `key.log.req pages records and sets has_more` | #3 hub |
| `key.log catch-up applies each page atomically and loops has_more` | #3 client |
| `key.log.res oversized page is rejected and not applied` | #3 client |
| `legacy 四字段 NODE_EVENT 保留 absent optional 为 null` | #4 decoder |
| `legacy 四字段 NODE_EVENT 不覆盖已有 direct_capable:true` | #4 patcher |
| `9th overflow node is rate_limited without starving an existing burst, then gains a slot after TTL` | #5 |
| `closes the transport once on send rejection and drops post-close chunks` | #6 |

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2304 pass / 0 fail**（基线 2296；本轮 +8） |
| `bun test`（`packages/shared`） | **330 pass / 0 fail**（基线 327；本轮 +3 mux） |
| `bun test`（`packages/ws-client`） | **261 pass / 0 fail** |
| `bun test src/`（`apps/fe`） | **333 pass / 0 fail**（基线 331；本轮 +2） |
| `bunx tsc --noEmit -p apps/gateway` | **22** 个 `error TS`（基线 21；新增 0，多出的 1 条是既有 `auth-routes.test.ts` 的 `BootstrapUserResult.nodeId`，本轮未改该文件） |
| `bunx tsc --noEmit` shared / ws-client / fe | **0** |
| `bunx biome check`（改动文件） | 通过 |

## Harness（remote-cycle tag `p11`）

`scripts/hub-e2e/out/report.md`（远程 2026-08-28T11:21:49Z；本轮脚本含 `bundle:resources` + runtime + cli pack；项目 `tmex-e2e`，未碰 `tmex-split`）：

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

全 PASS。日志在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p11/`。
