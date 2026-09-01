# G4b result — RV2 11 findings

对照 RV2 的 11 条 finding 全部按指挥官决策修完。未改 `stream-targets.ts`（finding 4 的 413 通道问题在目标侧停止 `reader.cancel()` 即可，in-memory link 实测入口看到 413 而非 503）。未改 `packages/shared` 契约（非法 `source` 由 API 层 400，类型仍是 `'release' | 'staged'`）。

## Finding → 修复

| # | 决策 | 修复 |
|---|---|---|
| 1 | staged PUT/POST 必须已认证 | `apps/gateway/src/api/system.ts`：`requestIsStagedAuthenticated(req)` 看 `requestDispatchContext`（mesh forwarded：`viaNodeId !== 'self'`，或 `uid` 已设）以及 mesh 上下文的 `sid+uid`（本机已登录会话）。open-mode 短路不挂 sid/uid，因此可区分，**没有**改 dispatcher / `mesh-runtime.ts`。未认证 → `403 { code:'UPGRADE_NOT_ALLOWED', reason:'staged_requires_auth' }`。`source:'release'` 不变。 |
| 2 | PUT/POST 互斥 + 原子消费 | `UpgradeController.stagingInFlight`：PUT 流式期间另一 PUT 或任意 POST → `409 UPGRADE_IN_PROGRESS`。PUT 写 `*.tgz.part-<16hex>`。`run()` 先把 staged `.tgz` **rename** 进 `staging/<txnId>/`，再对该路径流式哈希一次后解压。 |
| 3 | WriteStream 错误处理 | `release-download.ts` 用 `node:stream/promises.pipeline` + `Transform` 哈希，open/write/close 失败会 reject，不再摘掉唯一 `error` listener。 |
| 4 | 413 不 cancel 源流 | `Content-Length` 超限时 API 层直接 413、不读 body。中流超限：关文件、删 part、`reader.releaseLock()`，**不** `cancel()`。`stream-targets.ts` 未改：`cancel()` 才会 `stream.reset('request-cancelled')`。forwarder in-memory link 测试断言入口收到 413。 |
| 5 | 分步超时 | download 10 min、push 15 min、start 60 s（job 层 `withTimeout` + `AbortSignal.timeout` 传给 forwarder `input.signal`）；`SHA256SUMS` fetch 30 s；tarball fetch 10 min。push 失败会 `cancel()` 未被 forwarder 消费的文件流。测试可注入 `timeouts.pushMs`。 |
| 6 | 先查 active-job | `handleMeshNodeUpgradeStart` 在 GitHub latest / GET info **之前** 对远程节点 `hasRunningRemoteUpgradeJob` → `409 UPGRADE_IN_PROGRESS`。 |
| 7 | failedAt TTL | job 记录 `failedAt`，10 min TTL 从失败时刻算。 |
| 8 | GC 保留名 + 共享 cache | `sweepOrphanStaging` 永不删 `staged` / `release-cache`。本地 `stageGithubRelease` 走 `resolveReleaseCacheDir(installDir)`（`<installDir>/staging/release-cache` 或 `TMEX_RELEASE_CACHE_DIR`），不再用 per-txn `.release-cache`。 |
| 9 | finalize try/finally | PUT 与 release-cache：rename + sidecar 失败时清理 `.part` / final / sidecar，PUT 返回 `500 STAGE_FAILED`。无 sidecar 的孤儿 `.tgz` 由 prune 扫掉。 |
| 10 | 流式哈希一次 | `lookupStaged` 只做存在性 + sidecar sha 字符串比较。真正 sha256 只在原子 move 之后对 txn 内文件 `sha256File` 一次，解压复用该路径。release 下载也不再 `readFileSync` 整包二次哈希。 |
| 11 | 非法 source | `POST` 的 `source` 若出现且不是 `release\|staged` → `400`。 |

## 新测试

- `system.test.ts`：open-mode PUT/POST staged → 403 `staged_requires_auth`；release 不被同样拦截；非法 `source` → 400；`Content-Length` 超限 → 413 且不 cancel body
- `upgrade.test.ts`：unique `.part-<id>`；PUT 期间并发 PUT/POST → 409；原子 move 进 txn；413 不 cancel；sidecar 失败 → `STAGE_FAILED` 并清理；孤儿 tgz 被 prune；本地升级写共享 `release-cache`
- `remote-upgrade-job.test.ts`：push 永不响应 → `push timeout` 并释放节点；failedAt TTL
- `upgrade-service.test.ts`：运行中 job 时 GitHub 挂掉仍 409（服务入口）
- `release-download.test.ts`：不可写 cache dir reject 且无 unhandled error；sidecar 失败清理
- `forwarder.test.ts`：真实 `stagePackage` + in-memory link，入口看到 413 不是 503
- `upgrade-gc.test.ts`：`staged` / `release-cache` 保留，orphan txn 仍删

## 验证计数

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/system src/api src/mesh/forwarder.test.ts src/mesh/mesh-routes.test.ts` | **629 pass / 0 fail** |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **0 errors**（本任务文件；未引入 uplink/hub 错误） |
| `cd packages/app && bun test src/lib/upgrade-gc.test.ts` | **7 pass / 0 fail**（+1 保留目录测） |
| `cd packages/app && bunx tsc --noEmit -p .` | **1 pre-existing**：`Cannot find type definition file for 'node'` |
| biome（15 个改动文件） | 干净 |

## 未改 / 指挥官无需额外合入

- `stream-targets.ts`：finding 4 不需要改。`requestBodyFromLink.cancel()` 仍会 RST；修复是目标 handler 在写 413 之前不要 cancel。
- `packages/shared/src/contracts/system.ts`：非法 source 不进入类型。
- `system-managed.ts`：G4 已对 PUT package 返 403，无需再动。
- `mesh-routes.ts` / `mesh-runtime.ts` / `uplink-*` / `hub/**` / `apps/fe/**`：未碰。forwarder `input.signal` 为可选字段，mesh-routes 透传即可。

## 风险

- 崩溃留下的 `.part-<id>` 要等下一次成功 PUT 的 prune 才清。
- 测试若走真实 `defaultDownload` 且共用 `$TMPDIR/tmex-release-cache`，同版本会命中脏缓存；相关测试已设独立 `TMEX_RELEASE_CACHE_DIR`。
