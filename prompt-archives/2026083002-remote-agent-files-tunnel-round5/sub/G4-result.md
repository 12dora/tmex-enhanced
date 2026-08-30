# G4 result — Cloudflare Tunnel manager (backend)

## What changed

Gateway 新增 Cloudflare Tunnel 管理器：安装/登录/创建 named tunnel、quick tunnel、进程监督（backoff 重启）、日志脱敏、单飞 job、以及 `GET /api/tunnel/status` + `POST /api/tunnel/actions`。契约字段全部填充；状态快照不 spawn。

`TMEX_TUNNEL_DIR` 默认是 sqlite 旁的 `tunnel/`（`:memory:` 则落到 `os.tmpdir()/tmex-tunnel`）。`originPort` 用 `config.port`。

Boot：`createGatewayRuntime` 在 watch 之后 `tunnelManager.start()`（`autoStart && mode !== 'off'` 才拉起进程；`NODE_ENV=test` 不跑 `--version`）。Shutdown：`stop()` 里先杀 cloudflared。

`set_trust_proxy` 走注入的 `patchHostEnv`（与 TLS external 同一条 `withEnvLock` + `readEnvFile`/`writeEnvFile` 写 `TMEX_TRUST_PROXY`）。缺省（源码 dev、未 assemble）返回 `not_configured` / `"Host environment is not managed by tmex-cli"`。

## packages/app wiring（assemble.ts，每一行）

```
35: import { tunnelManager } from '../../../../apps/gateway/src/tunnel/manager';
40: import { readEnvFile, writeEnvFile } from '../lib/env-file';
41: import { withEnvLock } from '../lib/env-mutation';
316-330: tunnelManager.setPatchHostEnv(async (trustProxy) => {
         const envPath = resolveSetupEnvPath();
         await withEnvLock(async () => { readEnvFile → writeEnvFile TMEX_TRUST_PROXY });
       });
```

插在 `buildTlsLifecycle` 里 `tlsSlot.service = tls` 之后，与 TLS 共用 `resolveSetupEnvPath()`。

## Migration

- `drizzle/0027_tunnel_config.sql`：`tunnel_config`（id=`default`，mode/hostname/tunnel_name/tunnel_id/auto_start/updated_at）
- Journal：G1 已写入 `0026_acoustic_roughhouse`，本任务生成 **0027**，**无冲突**（顺序衔接）。若 G1 之后重生成 0026，commander 只需保证 0026 在 0027 之前。

## File list

- `apps/gateway/src/db/schema.ts`（仅追加 `tunnelConfig` 表与类型）
- `apps/gateway/src/config.ts`（`resolveTunnelDir` / `config.tunnelDir`）
- `apps/gateway/src/runtime.ts`（start/stop 各一行 + import）
- `apps/gateway/src/api/index.ts`（`...tunnelRoutes`）
- `apps/gateway/src/api/tunnel-routes.ts` + `tunnel-routes.test.ts`
- `apps/gateway/src/tunnel/**`（manager/provider/download/supervisor/spawn/store/logs + tests）
- `apps/gateway/drizzle/0027_tunnel_config.sql`、`drizzle/meta/0027_snapshot.json`、`drizzle/meta/_journal.json`
- `packages/app/src/runtime/assemble.ts`（上表 wiring）

## Tests / tsc / biome

- `apps/gateway bun test`：**2581 pass / 0 fail**（基线 2500；本任务约 +24）
- 本任务用例覆盖：version 解析、login URL + cert poll + timeout、create 解析 id / already-exists 复用、dns_route_failed、quick URL、supervisor backoff + stop、redaction、status 形状、busy 409、validation 400、migration apply、`set_trust_proxy` not_configured、check healthz（注入 fetch，无真实网络）
- `bunx tsc --noEmit -p .`（gateway）：**26 errors**（基线 21）。**本任务文件 0 条**。多出的来自并行 G1 `agent_sessions.nodeId` fixture 等，不在本 scope。
- `packages/app` assemble 测试 27 pass；该包 tsc 仍有预存的 `Cannot find type definition file for 'node'`
- `bunx biome check` 上述文件：**通过**

## Left / risky

- `quick_start` 的 job.kind 为契约里的 `start`（`TunnelJobKind` 无 `quick_start`）。
- 认证与其它 `/api/*` 一样走 mesh `localUiGuard`（standalone 放行）。
- named `start` job 会等到 `Registered tunnel connection`（默认 30s），超时则 `process_failed`。
- 未跑过真实 cloudflared / GitHub 下载；downloader/spawner/fetch 均可注入。
- 源码 `bun run dev` 不走 assemble 时 `set_trust_proxy` 会 `not_configured`（符合题意）。
