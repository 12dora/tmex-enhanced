# grok-p9-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。范围 `apps/gateway/src/mesh/**` 与 `apps/gateway/src/hub/**`（+ 测试）。无 git 操作。未改 `scripts/hub-e2e/split/` 与 docs。`packages/shared/src/auth/**` 未动。

`review-p8.md` 的 4 条 finding 全部落地，每条都有先红后绿的单测。

## 改动摘要

| # | 处理 |
|---|---|
| 1 | 握手 JSON 去掉未认证 `caps`。quiesce 只信加密 `link.hello` / probe ACK。未 ACK 前任何路径（含 `getLink` user-path 且 `streams === 0`）都不得替换已有链；无链时 user-path 仍可拨新链。 |
| 2 | catch-up 把 `(generation, epoch, userId, AbortSignal)` 传入 `pushMissingToHub` / head / list / applyMany 包装。每个 await 后、每次 `appendAndAck` 前校验。applier 调用带 abort/timeout。按代次追踪 outstanding promise，重连时 abort 并 `allSettled`，不再只重置 `catchUpChain`。同代次新 list 仍允许已取到的 records 先 apply。 |
| 3 | 合成 offline 只按连接代次去重。`node.list` 按投影（online/reach/version/inventory/direct_capable/name）变化才发。`NodeEventDedupe` 有 revoke 删除、stop 清空、容量 1024 LRU。 |
| 4 | LRU 满时不再 `set()` 淘汰并派发满 burst。`KeyLogReqLimiter.trySet` 失败则落到按 userId 的不可淘汰 overflow 桶。容量 `keyLogReqStateMax`（默认 1024）。1025 节点循环不能重置 burst。 |

额外：去掉握手 caps 后每条新链都会走加密 `link.hello`。ctl.send 返回 void 且底层 `sendFrame` 在关链时会 reject。`PeerManager` 的 ctl 出口改为吞掉 rejection；`packages/shared/src/link/mux.ts` 的 WINDOW/RST `void sendFrame` 补 `.catch()`，避免测试间 Unhandled error。

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `handshake hello does not advertise unauthenticated caps` | #1 握手 |
| `getLink does not replace an existing mixed-version link until quiesce is ACKed` | #1 有链不替换 |
| `getLink may still dial a new link when none exists without a quiesce ACK` | #1 无链可拨 |
| `stale pushMissingToHub cannot append on the replacement connection` | #2 |
| `node.list inventory changes emit NODE_EVENT while identical projections are de-duped` | #3 list 投影 |
| `NodeEventDedupe` 四条（inventory/name、合成 offline 代次、revoke/clear、1025 淘汰） | #3 生命周期 |
| `key.log.req overflow bucket does not reset burst when cycling past capacity` | #4 1025 节点 |

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2292 pass / 0 fail**（基线 2283；本轮 +9） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 21） |
| `bunx biome check`（改动文件） | 通过 |

## Harness（remote-cycle tag `p9`）

`scripts/hub-e2e/out/report.md`（远程 2026-08-28T09:34:04Z；本轮脚本含 `bundle:resources` + runtime + cli pack；项目 `tmex-e2e`，未碰 `tmex-split`）：

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

全 PASS。日志在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p9/`。
