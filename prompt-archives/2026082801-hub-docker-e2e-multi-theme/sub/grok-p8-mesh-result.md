# grok-p8-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。范围 `apps/gateway/src/mesh/**` 与 `apps/gateway/src/hub/**`（+ 测试）。无 git 操作。未改 `scripts/hub-e2e/split/` 与 docs。

`review-p45.md` 的 9 条 finding 全部落地，每条都有先红后绿的单测。

## 改动摘要

| # | 处理 |
|---|---|
| 1 | 握手 `hello` 带 `caps: ['quiesce']`；未声明该能力的旧 peer 不走后台升级。ctl 层另有 `link.hello` / `link.quiesce.probe`（adoptLink 与未知能力链路）。`getLink` 仅在旧链 `streams === 0` 时允许无 fence 升级。 |
| 2 | `maybeFinishRetire` 在 `streams > 0` 时永不硬关；`PEER_RETIRE_MAX_MS`（30 s）只用于 `streams === 0` 且 fence 未完成。覆盖 60 s 活跃流测试。 |
| 3 | `getLink` 替换现有链走 `{ cooldown: true, userPath: true }`，尊重 `nextEligibleAt`；首次 `nextEligibleAt=0` 仍立即拨号。 |
| 4 | `head()` / `list()` / `applyMany()` 抛异常进入同一有界 `retryOrTearDown`；超过次数 teardown。`result.error === 'fork'` 仍 `failFork()`。 |
| 5 | catch-up 绑定 `connectGeneration`，每个 await 后校验；`listEpoch` 跨代次单调不归零；换链时重置 `catchUpChain`。同代次新 list 仍串行，但已取到的 records 会先 apply，避免旧 epoch 卡住新 list。 |
| 6 | `userId` guard 在 `peerManager.start()` 之前。node 空 userId：不绑 peer 口、不上行。hub 空库：绑 listener 但 `isTrusted` deny-all；`uplink.userId` 改为 getter，`hub user add` 后无需重启即可 `listReach`。 |
| 7 | 换链 `resetConnectionState` 立刻离开 `online`。`sendCtl` / `openRelay` / `sendStatus` / `appendAndAck` 与入站 relay OPEN 均要求 `authenticatedGeneration === generation`；未认证 OPEN `reset`。 |
| 8 | `hubPresenceLive` 只在当前代次 `finishNodeList`（catch-up 完成）后置真；断线清除。`listHubOnline` 依赖该标志。`NODE_EVENT` 按 last-emitted 去重。 |
| 9 | `keyLogReqBuckets` / `keyLogReqLogs` 改为有上限、idle TTL 的 LRU；stop 时 clear，revoke 时 delete；短时断线保留 burst，重连不能重置限频。 |

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `background upgrade is skipped when the peer does not ACK quiesce capability` | #1 后台 |
| `getLink may upgrade a mixed-version peer only when the old link has no open streams` | #1 用户路径 |
| `retiring link with an active 60s stream is not hard-closed at the 30s cap` | #2 |
| `getLink upgrade of an existing link respects nextEligibleAt backoff` | #3 |
| `head list and applyMany throws enter the retry machine and tear down, fork stays hard` | #4 |
| `stale catch-up from a previous generation cannot failFork the replacement connection` | #5 |
| `node role with empty userId does not bind the peer listener` | #6 node |
| `hub empty db binds deny-all then works after hub user add without restart` | #6 hub |
| `replacing an online connection leaves online immediately and gates outbound and inbound OPEN` | #7 |
| `hub presence is fresh only after the current generation finishes catch-up and offlines de-dupe` | #8 |
| `key.log.req buckets are LRU+TTL, survive reconnect, clear on stop, and drop on revoke` | #9 |

握手 `caps` 避免在 raw handshake 尚未结束时向对端打 LinkMux ctl（否则会把直连 handshake 打成 `aborted`）。adoptLink 测试用 `echoQuiesceCaps` 回应 ctl hello/probe。

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2283 pass / 0 fail**（基线 2272；本轮新增用例 + 并行 agent 增量） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 21） |
| `bunx biome check`（改动文件） | 通过 |

## Harness（remote-cycle tag `p8`）

`scripts/hub-e2e/out/report.md`（远程 2026-08-28T08:26:24Z；本轮脚本含 `bundle:resources` + runtime + cli pack；项目 `tmex-e2e`，未碰 `tmex-split`）：

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

全 PASS。日志在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p8/`。
