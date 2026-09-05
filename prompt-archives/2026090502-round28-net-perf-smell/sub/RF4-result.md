# RF4：隧道边缘解析重试 / 缓存 / 自愈可观测性

## 自愈为什么没触发（读码结论）

真因是**连接器轮询根本没启动**，不是 `resolveEdge` 静默失败：

1. `startProcess()` 里顺序是 `waitUntilRunning()` → `probeAndStoreConnector()` → `syncConnectorPoll()`。fake-IP 下 cloudflared 永远不注册连接，named 模式没有 quick URL 行，`supervisor.state` 一直停在 `starting`，`waitUntilRunning` 到 `runningWaitMs`（30 s）**抛 `process_failed`**，后面两行永远执行不到 → 30 s 轮询循环从未建立 → `edgeRecovery.maybeRecover` 一次都没被调用，所以既没有第二条 `edge resolution` 日志，也没有重启。
2. 即使后续有别的路径调 `syncConnectorPoll()`，也没用：`start()` 的 catch 把 `supervisor.state` 置为 `error`，而 `shouldProbeConnector()` 只认 `running/degraded/starting`，直接拒绝开轮询。
3. `canRestart()`（`lastStartOpts` + `isManagedProcessActive()`）本身没问题——`lastStartOpts` 在 `supervisor.start()` 之前就赋值了，自动启动同样满足；`inFlight` 也确实在 `finally` 里复位。这两项无需修。
4. 附带发现：注册超时后 state 钉在 `error`，`supervisor.handleLine` 只在 `starting|degraded` 时才翻回 `running`，晚到的注册无法把状态救回来。

## 改动

- `edge-resolver.ts`：DoH 失败时最多重试 3 次、间隔 1.5 s，整段共用 `10 s + 5 s` 预算（`resolveEdgeViaDoh` 新增 `budgetMs`）；新增 `EdgeCache`/`CachedEdge`/`EdgeSource`，DoH 成功即写缓存，失败且缓存 < 7 天则回落 `mode:'static' source:'cache'` 并保留 `lastError`（前端仍显示 DoH 失败）；`describeEdge` 输出 `source=doh|cache|env`。`sleep` 可注入。
- `edge-cache.ts`（新）：`tunnel.lastStaticEdge` 走既有 `db/kv.ts` 的 `getGatewayKv/setGatewayKv`，含 `parseCachedEdge` 校验；manager 默认解析器注入该缓存（测试环境仍是 `async () => null`）。
- `edge-recovery.ts`：每次尝试固定一行 `[tunnel] edge recovery attempt=N result=static|system|cancelled|error degraded=Ns …`；降级期间每个轮询 tick 都会重试。
- `manager.ts`：`waitUntilRunning()` 包 try/finally，**起不来也开轮询**；`shouldProbeConnector()` 改为进程还活着（`isManagedProcessActive()`）就探。
- `supervisor.ts`：`error` 状态收到注册行也能翻回 `running`。
- `connector-poll.ts`（新）：把轮询循环从 manager 抽出（manager 1436 → 1415 行，未改 allowlist）。

## 测试

新增：DoH 两次失败第三次成功（注入 fetch/sleep）、静态结果落盘并在 DoH 失败时按 `source=cache` 复用、超 7 天不复用、缓存抛错不影响解析、`parseCachedEdge`；recovery 的 90 s 门槛 + 逐次日志 + 解析抛错后仍继续；manager 两例（named 自动启动且永不注册 → 轮询持续 tick；> 90 s 零连接 → 一次 `--edge` + `--protocol http2` 重启，日志 attempt=1 system / attempt=2 static）。两个 manager 用例在回滚修复后确认会失败。

`bun test src/tunnel src/api/tunnel-routes.test.ts` 226 pass / 0 fail；`bunx tsc --noEmit -p apps/gateway` 无错；`bunx biome check .` 干净；`bun scripts/complexity/gate.ts` ok。
