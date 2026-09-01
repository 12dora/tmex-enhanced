# G0 result — Tunnel robustness (backend)

## 做了什么

进程存活不再等于隧道可用。连接器健康以 cloudflared 本地 `GET /ready` 为准；0 条边缘连接标 `degraded`，连通性检查走 `connector_down`（HTTP 503），即使 Cloudflare Access 返回 302 也不能当成成功。外部托管进程会读 `--logfile` 尾部填 `status.log`。

## 行为要点

- **connector-health**：解析 JSON/文本 metrics 日志；发现顺序 spawned `--metrics` → argv `--metrics` → 日志 → 缺省 `127.0.0.1:20241–20245`；`/ready` 200/503 JSON 为 `reachable: true`；单地址失败为 `false`，扫描全失败为 `null`；`extractLastError` / `readLogTail` 均脱敏。
- **Supervisor**：跟踪 `Registered` / `Unregistered` / `Connection terminated` 的 `connIndex`（JSON + 文本）。`running` 且集合空 → `degraded`（不重启）；再注册 → `running`。`Unregistered` 不再被 `Registered` 正则误匹配。
- **Spawn**：`spawnNamedRun` / `spawnQuickRun` 注入 `--metrics 127.0.0.1:<port>`（`pickPort` 可注入；默认 `net.createServer().listen(0)`）。
- **external-detect**：`parseArgv` 提取 `--metrics` → 内部 `metricsAddr`，不进入共享契约 `TunnelExternalStatus`。
- **Manager**：`lastConnector` + 轮询（默认 30s，测试默认关闭）；`status()` 推导 `degraded`、外部 `lastError`、外部 logfile 2s 缓存；`jobCheck` 先探连接器再探边缘；`GET /api/tunnel/status` 最多等 800ms。测试环境默认不扫 20241–20245，避免碰到本机生产 cloudflared。

## 文件

- `apps/gateway/src/tunnel/connector-health.ts`（充实）
- `apps/gateway/src/tunnel/connector-health.test.ts`（新）
- `apps/gateway/src/tunnel/supervisor.ts`
- `apps/gateway/src/tunnel/supervisor.test.ts`（新）
- `apps/gateway/src/tunnel/provider.ts`
- `apps/gateway/src/tunnel/spawn.ts`
- `apps/gateway/src/tunnel/external-detect.ts`
- `apps/gateway/src/tunnel/external-detect.test.ts`
- `apps/gateway/src/tunnel/errors.ts`
- `apps/gateway/src/tunnel/manager.ts`
- `apps/gateway/src/tunnel/manager.test.ts`
- `apps/gateway/src/tunnel/util.test.ts`
- `apps/gateway/src/api/tunnel-routes.ts`
- `apps/gateway/src/api/tunnel-routes.test.ts`
- `docs/hub/2026082800-hub-node-operations.md`（「连接器健康」）

未改：`log-buffer.ts`、`fake-spawn.ts`（范围内但不需要）。未碰 `packages/shared` 契约与 `apps/fe`。

## 验证

- `bun test src/tunnel src/api/tunnel-routes.test.ts`：**170 pass / 0 fail**（基线 142 pass）
- 整包 `bun test`（`apps/gateway`）：**3374 pass / 0 fail**
- `bunx tsc --noEmit -p .`：**0 errors**（基线 0）
- `bunx biome check`（上述改动文件）：clean

## 未做

- 前端展示 `degraded` / `connector_down` / `access_protected_unverified` 不在本任务范围。
- 测试环境关闭缺省 20241–20245 扫描；生产默认开启。
