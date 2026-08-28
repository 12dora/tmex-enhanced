# grok-p5-peer 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。范围仅 `apps/gateway/src/mesh/peer-manager.ts` 与 `peer-manager.upgrade.test.ts`。无 git 操作，未跑 Docker harness。未改 `packages/shared`（LinkMux 未加新 FrameOp）。未改 `uplink-client.ts` / `mesh-runtime.ts` / `mesh-routes.ts` / `uplink-server.ts`。

## 审查三项的修复

### P1：链路替换丢失 in-flight OPEN

**根因**：`retirePeer()` 在本端 `streams === 0` 时立刻 `finishRetire` 关链。`openStream()` 返回只表示 OPEN 已写入载体；延迟投递下对端仍是 `streams === 0`，把稍后到达的 OPEN 当成 `stale-link`，或因旧链已关得到 `link-closed/replaced`。

**修复（ctl 级 fence + 宽限期，未改 LinkMux 帧类型）**：

- 新链认证成功后，旧链一律进入 retiring：禁止本端再 `openStream`，但**保持打开**。
- 旧链发送 `{ t: 'link.quiesce' }`。对端处理完该 ctl **之前**的全部 OPEN 后回 `{ t: 'link.quiesce.ack' }`。OPEN 与 ctl DATA 走同一字节流，顺序即 fence。不新增 `FrameOp`：未知 op 会 `protocolError`，混版本会把整链打掉。
- 关闭条件：fence 完成且 `streams === 0`；否则 `streams === 0` 持续 ≥ 2 s **且** retire 已满 5 s；硬顶 30 s。
- 接收侧：只要该 session 仍在 `retiring` 集合且未真正 close，继续接受 OPEN，**绝不**对仍打开的链回 `stale-link`。

`mesh-runtime.ts` 不需要改。

### P1：升级拨号限流

- 无论 endpoints 是否变化，每 peer 最小间隔 `PEER_UPGRADE_COOLDOWN_MS`（10 s）。`getLink` 用户路径仍 `{ cooldown: false }`。
- pending / cooling 期间的变更合并为一次后续尝试（`coalesced` + `scheduler.sleep`）。
- 失败：`backoffDelayMs(failures-1, 10s, 5min)`（指数 + jitter，封顶 5 min）。同一 session 未真正换链视为失败。
- 全局 semaphore：同时最多 4 个升级拨号。
- 接受的 endpoints：数量 ≤ 16，每条长度 ≤ 256（`parseEndpoints` / `applyPeerStatus`）。

### P2：status 按链路去重

去掉全局 `lastAdvertisedStatusJson`。每个 `LivePeer` 存自己最后发出的 status JSON。新链 `''` 必发；周期 `refreshAdvertisedStatus` 只向 hash 落后的 live peer 重推。B 重建链不会让 C 漏收。

## 测试（`peer-manager.upgrade.test.ts`）

| 测试 | 覆盖 |
|---|---|
| `single-sided upgrade accepts an in-flight OPEN on the retiring link` | 延迟投递 A→B，单边换链，OPEN 被接受 |
| `simultaneous upgrades keep in-flight OPENs on both retiring links` | 双边同时升级 + 双向 in-flight OPEN |
| `alternating endpoints within cooldown coalesce into at most two upgrade dials` | 20 次交替 endpoints → 1 次拨号 |
| `failed background upgrades exponential-backoff before the next dial` | 8 次失败后 10 s 不够、5 min cap 才再拨 |
| `periodic upgrade scan respects the global dial semaphore` | 10 个 relay peer 扫描，并发 ≤ 4 |
| `caps accepted peer endpoints by count and length` | 超长丢弃，最多 16 条 |
| `refresh advertises new status to a live peer whose link was not rebuilt` | A–B–C，只重建 B，C 在下一轮 refresh 收到新 status |

延迟运输是测试内 `DelayedPipeEnd`（hold/flush），不改 `@tmex/shared/link`。

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2270 pass / 0 fail**（含本轮 7；他处并发改动未打破无关文件） |
| `bun test src/mesh/peer-manager*.test.ts` | **25 pass / 0 fail**（原 18 + 7） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 21） |
| `bunx biome check`（改动文件） | 通过 |

未跑 Docker harness。`mesh-runtime.ts` 无需改动。
