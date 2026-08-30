# R2 结果 — PeerManager transport ladder and control dispatch

## 文件变更

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/mesh/peer-manager.ts` | `dial` 改为 DC → WS-secure → live →（lostDirect 时延后 DC）→ relay 的有序 attempt 循环，共用 `throwIfStopped` / `stale`；`track` 拆成 admission（`reject`）+ `installLive`；`handlePeerCtl` 用 `asyncCtl` 表把 `node.status` / `key.log.req` / `key.log.res` 交给 `runCtlAsync`（`rtcLog('ctl failed', …)`）；其余 close/reset 的重复 try/catch 收成 `quiet()`。 |
| `apps/gateway/src/mesh/peer-manager.test.ts` | 回归：ctl 异步 handler 在 `upsertPeer` / `applyMany` 抛错时打日志、不产生 unhandled rejection。 |

未新增 sibling 文件。`peer-manager.upgrade.test.ts` 未改。

## `git diff --stat`

```
 apps/gateway/src/mesh/peer-manager.test.ts |  83 +++++
 apps/gateway/src/mesh/peer-manager.ts      | 492 ++++++++++++-----------------
 2 files changed, 277 insertions(+), 298 deletions(-)
```

`git diff --numstat`：`peer-manager.ts` 194 / 298（净 −104）；test 83 / 0（净 +83）。

## 行数（`wc -l`）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `peer-manager.ts` | 2204 | 2100 | **−104** |
| `peer-manager.test.ts` | 2268 | 2351 | +83 |
| `peer-manager.upgrade.test.ts` | 1009 | 1009 | 0 |

生产文件净减超过目标 −80。

## 测试 / tsc / biome

### 开始前（基线）

- `bun test src/mesh/peer-manager.test.ts src/mesh/peer-manager.upgrade.test.ts`：**61 pass / 0 fail**
- `bunx tsc --noEmit -p .`：任务说明为 **21** 个既有错误
- biome：未改文件，未跑

回归测试 RED（实现前）：`peer ctl async handlers log errors instead of unhandled rejection` **fail**，并出现 `upsert-fail` / `apply-fail` unhandled rejection（分别来自 `applyPeerStatus` → `upsertPeer` 与 `applyKeyLogRes` → `applyMany`）。

### 结束后

- 同一回归测试：**1 pass / 0 fail**
- `bun test src/mesh/peer-manager.test.ts src/mesh/peer-manager.upgrade.test.ts`：**62 pass / 0 fail**（含新回归）
- `cd apps/gateway && bun test`：**2498 pass / 1 fail**（2497 基线 + 本范围 1 条新测试；失败项 `UplinkClient > partial apply re-reads head…` 在 `uplink-client`，属其他 agent，不在 SCOPE）
- `bunx biome check` 两个改动文件：**clean**
- `bunx tsc --noEmit -p .`：当前工作区 **23** 个错误；**`peer-manager.ts` / `peer-manager.test.ts` 为 0**。多出的不在本范围（`user-key-service.ts`、`push/supervisor.test.ts`、tmux-client 等，其他 agent 正在改）。

## 修掉的问题

- **BUG**：`handlePeerCtl` 对 `applyPeerStatus` / `serveKeyLog` / `applyKeyLogRes` 使用 `void` fire-and-forget。`userStore.upsertPeer` 可抛；`applyKeyLogRes` 的 `decodeBase64url` / `applyMany` 无 catch → unhandled rejection。现统一走 `runCtlAsync`，失败时 `rtcLog('ctl failed', { peer, kind, reason })`。
- 回归测试覆盖：`upsertPeer` 抛 `upsert-fail`、`applyMany` 抛 `apply-fail`，断言无 unhandled rejection 且日志含 `ctl failed`。
- `parseEndpoints` 去掉死表达式 `raw.includes('/') ? raw : raw`。

## 有意跳过

- **未抽出 `peer-transport.ts`**：transport dial（`dial` / `dialDc` / `dialWsSecure` / `dialDirect` / `accept*`）与 bookkeeping 通过 `this.track` / `this.live` / `this.generation` 缠在一起，搬 ≥300 行要么加 wrapper class，要么 glue 远超 ~20 行。按 SCOPE 留在原文件、只降 CC / 行数。
- **未改** `peer-manager.upgrade.test.ts`（行为未变，现有用例已覆盖 upgrade / DC fallback）。
- **未碰** `emitOsc` / `encodeMouseEvent` / `classifySshError` / control-mode `parse` / `dispatchPaneStreamByte` / `runInit` / `sanitizeBunPath`（本文件无这些热点）。
- **未改** version / CHANGELOG / 构建脚本。
- `serveKeyLog` 去掉内部 try/catch（改由 `runCtlAsync` 记日志）。原先静默吞掉的 `parseSeq` 等错误现在会打 `ctl failed`；无既有测试依赖静默。
