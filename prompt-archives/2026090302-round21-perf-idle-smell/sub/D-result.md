# 任务 D 结果：统一拨号熔断器 + 降低 `dialWsSecureCandidate` CC

## 做了什么

### 1. 一份共享熔断器

抽出纯逻辑机到 `packages/shared/src/net/dial-breaker.ts`（无 `node:*` import），选项为 `{ skipKinds?, onTrip?, onReset?, trackAttempts? }`。

两侧薄包装保留原导出名、常量和返回类型，调用点零改动：

- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts`：`RtcDialBreaker` 组合 `DialBreaker({ trackAttempts: true, onTrip, onReset })`，`noteFailure` 仍返回 `RtcDialFailureResult`；`createGatewayRtcDialBreaker` 的 trip/reset 打点顺序不变（先用户回调，再 `flushDialFailed`，再 `rtcLog`）。`envInt('TMEX_RTC_DIAL_BREAKER_MS', …)` 仍在 gateway 包装层。
- `packages/ws-client/src/direct/direct-dial-breaker.ts`：`DirectDialBreaker` 组合 `DialBreaker({ skipKinds: signaling-not-ready / primary-wait / '', trackAttempts: false })`，`noteFailure` 仍返回 `boolean`（`.counted`）；`remainingCooldownMs` 保留。

三个失败分类器原样未动：`classifyWsDialFailure` / `classifyRtcDialFailure` / `classifyDirectDialFailure`。

### 2. 未改 `package.json`，也未碰主 barrel

没有新增 `@tmex/shared/net` subpath，也没有改 `packages/shared/src/index.ts`（会撞 `index.test.ts` 导出快照，且与任务 H 争同一文件）。包装层按任务 H 的 `read-body` 先例走相对路径：

- gateway：`../../../../../packages/shared/src/net/dial-breaker`
- ws-client：`../../../../packages/shared/src/net/dial-breaker`

指挥官若要把 `DialBreaker` 挂到 `@tmex/shared` 主入口，需同步改 `packages/shared/src/index.ts` 与 `index.test.ts` 的运行时导出快照。

### 3. `dialWsSecureCandidate` CC 22 → 10

在 `peer-ws-race.ts` 抽出：

- `createDialBudget(signal, totalMs)` → `{ combined, budgetExpired(), connectTimeoutMs(base), handshakeTimeoutMs(elapsed), dispose() }`。超时算术与原来一致：`totalAc && totalMs != null` 才 `setTimeout` abort、`Math.min(base, Math.max(1, totalMs))`、`Math.max(1, totalMs - elapsed)`。
- `handshakeOrClose(ws, opts, combined)`：先 stale/abort 再算 elapsed / handshake timeout，再 try/catch 清理（有 session 则 `close('stopped')`，否则 `closeWsTransport`）。

`dialWsSecureCandidate` 实测 **CC 10 / 57 行**（目标 ≤ 12）。`classifyWsDialFailure` 仍为 CC 35，按任务要求不拆。

### 4. 删除死掉的 `@deprecated` 成员

全仓 grep（含测试）后：

| 符号 | 处置 |
|---|---|
| `RtcDialBreaker.shouldSkip` | 删除。除定义外零引用。 |
| `RtcDialBreaker.noteSuccess` | 删除。唯一引用是本文件测试「no longer reset cooling」；测试改为只断言 `notePeerChanged`。 |
| `RtcDialBreakerOptions.onOpen` | 删除。无外部传入者；构造里的 onOpen→onTrip 适配一并去掉。 |
| `RTC_DIAL_BREAKER_MS_DEFAULT` | **保留**。`apps/gateway/src/mesh/rtc/index.ts:95` 仍 re-export（该文件不在本任务范围内）。无最终业务消费者，但删掉会让 `rtc/index.ts` 编译失败。 |

## 验证

- `packages/shared && bun test`：451 pass / 0 fail（基线 447 + 本任务 4 条直测）。
- `packages/ws-client && bun test`：340 pass / 0 fail（基线 319；多出的是其他并行任务加的用例，本包装测试 3/3 绿）。
- `apps/gateway && bun test`：3795 pass / 6 fail / 1 error。本任务相关：
  - `rtc-dial-breaker.test.ts` 11/11 绿（含 PeerManager DataChannel breaker）。
  - `peer-ws-race.test.ts`、`peer-direct-attempt.test.ts` 全绿。
  - 全量失败与已知 flake 对齐或可在隔离重跑转绿：`PeerManager > replay cache is per-peer`、multi-hub token、`RtcPeerManager > ice failed summary`；`dc-handshake.test.ts` 两条隔离重跑 10/10 绿；`executeRunCommand` alternate 屏不在本任务文件内。
- 共享直测覆盖：N 次失败 trip、指数退避封顶、60s healthy 窗口复位、skipKinds 过滤。
- `bunx tsc --noEmit -p .`：shared 0、ws-client 0、gateway 0（均 ≤ 基线）。
- `bunx biome check` 对本任务改动文件通过。
- `bun scripts/complexity/gate.ts --report`：`dialWsSecureCandidate` 不再出现在 CC>15 榜；定点实测 CC 10。

## 未改文件（遵守占用矩阵）

未碰 `peer-manager.ts` / `mesh-runtime.ts` / `uplink-pool.ts` / `rtc-peer-manager.ts` / `rtc-log.ts` / `direct-carrier-controller.ts` / `direct-diagnostics.ts` / `client.ts` / `transport*.ts` / 任何 `package.json` / allowlist。
