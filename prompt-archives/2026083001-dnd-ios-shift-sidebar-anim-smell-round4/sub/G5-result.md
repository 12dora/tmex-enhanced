# G5 结果：forwarder + packages/app CLI flows

## 文件变更（一行摘要）

| 文件 | 摘要 |
| --- | --- |
| `apps/gateway/src/mesh/forwarder.ts` | 去掉成功路径上第二次 `flushQueue`（改在 `failingOver=false` 之后冲一次）；HTTP abort listener 在 `finally` 里卸掉；删掉从未读取的 `lastError`/`lastErr`；session cookie 写入抽 `appendNodeCookie` |
| `apps/gateway/src/mesh/forwarder.test.ts` | 回归：failover 排队帧只 flush 一次；HTTP 成功/失败都卸 abort listener |
| `packages/app/src/commands/enroll.ts` | `sleep` 在 timer 正常完成时卸 abort listener；显式空 TOTP 拒绝；拆 local / remote / poll+admit |
| `packages/app/src/commands/enroll.test.ts` | 空 `totpCode` 拒绝；轮询 sleep 不堆积 abort listener |
| `packages/app/src/commands/init.ts` | `buildInitConfig` 交互/非交互合并为一次 `ask`（未改 `runInit`） |
| `packages/app/src/commands/hub.ts` | `prepareHubJoin`（token/url/TLS pin + uid）；TLS 错误文案去重；`stopForLeave` 并入 `maybeStop` |
| `packages/app/src/runtime/http.ts` | 抽出共享 `mapError` |
| `packages/app/src/runtime/setup-routes.ts` | 复用 `mapError` |
| `packages/app/src/runtime/local-routes.ts` | 复用 `mapError`（保留 `direct_failed` / `leave_failed` fallback） |

## `git diff --stat`（仅本 scope）

```
 apps/gateway/src/mesh/forwarder.test.ts  | 106 ++++++++++
 apps/gateway/src/mesh/forwarder.ts       | 138 ++++++-------
 packages/app/src/commands/enroll.test.ts |  89 ++++++++
 packages/app/src/commands/enroll.ts      | 344 +++++++++++++++++--------------
 packages/app/src/commands/hub.ts         |  76 +++----
 packages/app/src/commands/init.ts        | 174 ++++++----------
 packages/app/src/runtime/http.ts         |  10 +
 packages/app/src/runtime/local-routes.ts |  18 +-
 packages/app/src/runtime/setup-routes.ts |  18 +-
 9 files changed, 546 insertions(+), 427 deletions(-)
```

含测试净 +119；**生产文件净 -76**（见下行数表）。

## 行数（`wc -l`）

| 文件 | 前 | 后 | Δ |
| --- | ---: | ---: | ---: |
| `apps/gateway/src/mesh/forwarder.ts` | 1061 | 1049 | -12 |
| `packages/app/src/commands/enroll.ts` | 478 | 502 | +24 |
| `packages/app/src/commands/init.ts` | 370 | 316 | -54 |
| `packages/app/src/commands/hub.ts` | 884 | 862 | -22 |
| `packages/app/src/runtime/setup-routes.ts` | 74 | 60 | -14 |
| `packages/app/src/runtime/local-routes.ts` | 112 | 104 | -8 |
| `packages/app/src/runtime/http.ts` | 23 | 33 | +10 |
| **生产小计** | **3002** | **2926** | **-76** |
| `apps/gateway/src/mesh/forwarder.test.ts` | 910 | 1016 | +106 |
| `packages/app/src/commands/enroll.test.ts` | 568 | 657 | +89 |

enroll 生产 +24 是拆 local/remote/poll+admit 的函数签名税，由 init/hub/routes 的删除覆盖。

## 测试 / tsc / biome

### 前（基线）

- `apps/gateway && bun test`：2482 pass / 0 fail
- `apps/gateway && bunx tsc --noEmit -p .`：21 errors
- `packages/app && bun test`：407 pass / 1 fail（`cpu-features stub plugin`，既有）
- `packages/app && bunx tsc --noEmit -p .`：1 error（`Cannot find type definition file for 'node'`）
- `forwarder.test.ts` 切片：42 pass

### 后

- `apps/gateway && bun test`：2497 pass / 0 fail（全仓 +15 含其他 agent 与本 scope +2）
- `forwarder.test.ts`：44 pass / 0 fail（+2 回归）
- `apps/gateway && bunx tsc --noEmit -p .`：23 errors。**本 scope 文件 0 条**；多出的 2 条在 G4 的 `auth-routes.ts:702/710`，未改
- `packages/app && bun test`：409 pass / 1 fail（+2 回归；既有 cpu-features 仍 fail）
- `packages/app` 范围内：`enroll/init/hub/join/setup-routes/local-routes` 81 pass；空 TOTP + sleep listener 2 pass
- `packages/app && bunx tsc --noEmit -p .`：1 error（与基线相同）
- `bunx biome check` 上述 9 个文件：No fixes applied

## 修掉的 bug

1. **`flushQueue` 连调两次**：成功路径原先 flush → `failingOver=false` → 再 flush。第二次在无并发入队时是 `splice(0)` 空操作；窗口期内若有新帧，第一次 flush 之后、flag 翻转之前仍会入队，必须靠第二次才发出。现改为 **只在 `failingOver=false` 之后 flush 一次**。回归：failover 期间入队的不可解码帧在新链路上恰好发送 1 次。
2. **`handleRemoteHttp` abort listener 泄漏**：`req.signal.addEventListener('abort', …)` 从不 `removeEventListener`。现用 named `onAbort` + `finally` 卸掉。回归覆盖成功 200 与 POST 失败 503。
3. **显式空 TOTP 不可达分支**：`if (io?.totpCode) { if (!io.totpCode) throw }` 内层永假，`totpCode: ''` 会落到 `promptPassword`（非 TTY 时报 `set TMEX_TOTP`）。现 `io?.totpCode !== undefined` 时空串抛 `TOTP code cannot be empty`。
4. **`enroll.sleep` abort listener 堆积**：timer 正常完成不卸 listener，轮询共享 signal 上监听器累加。现 `{ once: true }` + timer 回调里 `removeEventListener`。`forwarder.defaultSleep` 同样修了（同文件同类泄漏）。

## 刻意跳过

- **未把 `adaptResponse` 拆成三个模块级函数**：纯搬家会加行；只抽了真正去重的 `appendNodeCookie`。401 / MIME / session-header 逻辑仍在 `adaptResponse` 内，行为不变。
- **未抽 `forwardHttpAttempts`**：8 参数包装比内联 try/finally 更长。
- **tracked 帧（如 TMUX_SELECT）在 replay + queue 各发一次**：这是 `noteOutbound` + `flushQueue` 的既有语义，不是二次 `flushQueue`。未扩 scope 去改 replay 去重。
- **未碰** `runInit`、`assemble.ts`、`peer-manager.ts`、`uplink-client.ts`、发版文件、前三轮保留热点。
- **gateway tsc 21→23**：G4 `auth-routes.ts`，不在 G5 文件集。
- `stream-failover.integration.test.ts` 被 `apps/gateway && bun test` 收录（`.integration.test.ts`，不是 `*.integration.ts`），随全量 2497 pass。

## 生产行数目标

生产 -76，达到「净 -70 或更好」。回归测试按任务要求新增，未计入该 -76。
