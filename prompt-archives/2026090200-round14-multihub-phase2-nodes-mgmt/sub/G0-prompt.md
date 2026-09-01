# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# G0 — Tunnel robustness (backend): cloudflared connector health, degraded state, external logfile tail

Result file (write when finished): `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/G0-result.md`

## Background (diagnosed on a real machine today)

The user's Cloudflare Tunnel was down for ~2 hours but the settings page said the tunnel was "running" and「检查连通性」passed, and「显示日志」was empty. Root causes:

1. `TunnelManager.jobCheck` (`apps/gateway/src/tunnel/manager.ts` ~L871) fetches `https://<hostname>/healthz`. The hostname is behind **Cloudflare Access**, so the edge answers `302 → *.cloudflareaccess.com` **before the request ever reaches the origin**. `isAccessProtectedHealthResponse` (~L115) turns that into `step('access_protected')` = success. A dead tunnel behind Access therefore always "passes".
2. The tunnel is **externally managed** (launchd `com.tmex.cloudflared`, argv `cloudflared tunnel --protocol http2 --no-autoupdate --logfile <path>/cloudflared.log --loglevel info run --token-file <path>/token`). `external-detect.ts` sets `running = cand.pid != null` (~L309): process alive ≠ edge connections. cloudflared's log showed hours of `"TLS handshake with edge error: ... i/o timeout"` / `"Unable to establish connection with Cloudflare edge"` with the process happily alive.
3. `status().log` comes from the in-memory `LogRingBuffer` that only receives lines from processes tmex spawned itself. For external processes `parseArgv` already extracts `logFile` (`--logfile`) but nobody reads it.

The authoritative health signal is cloudflared's local metrics server: `GET http://127.0.0.1:20241/ready` → `{"status":200,"readyConnections":4,"connectorId":"..."}` (returns 503 and `readyConnections: 0` when no edge connection). cloudflared picks `127.0.0.1:20241`–`20245` by default (first free) unless `--metrics <addr>` is passed; it also logs `Starting metrics server on 127.0.0.1:20241/metrics` at startup. `/metrics` (Prometheus) additionally exposes `cloudflared_tunnel_ha_connections N`.

## Contract already committed (do NOT edit `packages/shared/src/contracts/tunnel.ts`; read it)

- `TunnelProcessState` gained `'degraded'` (process alive, zero edge connections).
- `TunnelErrorCode` gained `'connector_down'`.
- New `TunnelConnectorStatus { reachable: boolean|null; metricsAddr; readyConnections; connectorId; checkedAt; lastError }` and `TunnelStatusResponse.connector` (required). `apps/gateway/src/tunnel/connector-health.ts` currently only exports `EMPTY_CONNECTOR`; `manager.status()` returns `connector: { ...EMPTY_CONNECTOR }` as a placeholder — replace with the real thing.
- `TunnelJobStatus.step` after `check`: `ok` | `access_protected` | `access_protected_unverified` (see the doc comment there).

## Scope — files you may edit (backend only)

`apps/gateway/src/tunnel/connector-health.ts` (new module, flesh out), `apps/gateway/src/tunnel/manager.ts`, `apps/gateway/src/tunnel/supervisor.ts`, `apps/gateway/src/tunnel/provider.ts`, `apps/gateway/src/tunnel/spawn.ts`, `apps/gateway/src/tunnel/external-detect.ts`, `apps/gateway/src/tunnel/log-buffer.ts`, `apps/gateway/src/tunnel/errors.ts`, `apps/gateway/src/tunnel/fake-spawn.ts`, any `apps/gateway/src/tunnel/*.test.ts`, `apps/gateway/src/api/tunnel-routes.ts` + its test, and the remote-access doc under `docs/` (grep `docs -ril cloudflared` and add a short「连接器健康」section to the most relevant existing doc; do not create a new doc unless none fits). Do not touch `apps/fe`, `packages/*`.

## Requirements

A. **`connector-health.ts`**
   - `parseMetricsAddrFromLog(lines)`: regex for `metrics server on <host:port>` (both JSON `"message":"Starting metrics server on 127.0.0.1:20241/metrics"` and text `INF Starting metrics server on ...` formats).
   - `discoverMetricsAddr({ spawnedAddr, argvAddr, logLines })` priority: tmex-spawned explicit addr → external argv `--metrics` → log → default scan `127.0.0.1:20241..20245`.
   - `probeConnector(addr, fetch, { timeoutMs: 1500 })` → `TunnelConnectorStatus`: GET `/ready`; 200 or 503 with JSON `{readyConnections, connectorId}` → `reachable: true`; connection refused / timeout / non-JSON → `reachable: false` for that addr. Scanning: first addr that answers wins; result `reachable: null` + `metricsAddr: null` when nothing answers.
   - `extractLastError(lines)`: last line that is an error (JSON `"level":"error"` → prefer its `error` field then `message`; text format ` ERR `) → redacted via `redactSecrets`; null if none.
   - `readLogTail(path, { maxBytes: 64*1024, maxLines: 200 })` using `node:fs/promises` (open + read the last N bytes, split lines, drop the first partial line). Redact each line.

B. **Supervisor (`supervisor.ts`)**: track edge connections from log lines in both formats: `Registered tunnel connection` + `connIndex` adds; `Unregistered tunnel connection` / `Connection terminated` + `connIndex` removes. Expose `edgeConnections` (Set size). When state is `running` and the set becomes empty → `state = 'degraded'` (do NOT restart; cloudflared retries by itself); when a registration arrives while `degraded` → `running`. `starting` → `running` behaviour unchanged. Keep `lastError` updated from error lines.

C. **Provider/spawn**: when tmex spawns cloudflared (`spawnNamedRun` / `spawnQuickRun`) pass `--metrics 127.0.0.1:<port>` with a free port chosen at spawn time (Node `net` `createServer().listen(0)` then close; inject a `pickPort` dep for tests) and surface the chosen addr to the manager (e.g. return it on the SpawnHandle or via supervisor start opts). Update tests that assert exact argv.

D. **External detection (`external-detect.ts`)**: `parseArgv` also extracts `--metrics` → `metricsAddr: string|null` on the detected/external result (internal type only; `TunnelExternalStatus` in the shared contract is NOT changed — keep it internal to gateway).

E. **Manager (`manager.ts`)**
   - Keep `lastConnector: TunnelConnectorStatus`. A poll loop (`connectorPollMs` opt, default 30 000; disabled in tests unless set) runs while the tunnel is expected to be up (managed: supervisor `running|degraded|starting`; external: `lastExternal.running`). Also probe right after a successful `start`, after `refreshExternal({force:true})`, and inside `jobCheck`. The probe must never throw out of the loop.
   - `status()`: `connector: lastConnector`; `process.state`: managed → supervisor.state (already `degraded`-aware) but also `degraded` when supervisor says `running` and `lastConnector.reachable === true && readyConnections === 0`; external → `pid` alive: `degraded` if connector reachable with 0 connections, else `running`; not alive → `stopped`. `process.lastError` for external = `lastConnector.lastError`. `publicUrl` stays populated for `degraded` (the address exists; FE will flag it).
   - `status().log`: when `externallyManaged` and `lastExternal.logFile` is set → `readLogTail` of that file (cache result ~2 s to avoid a disk read per poll; inject `now`); otherwise the ring buffer as before. Never throw if the file is unreadable (return `[]`).
   - `GET /api/tunnel/status` must not block noticeably: if `lastConnector.checkedAt` is older than the poll interval (or null) kick a background probe (fire-and-forget, deduped) and return the cached value; do not await more than ~800 ms.
   - **`jobCheck` rewrite**: (1) probe connector; if `reachable === true && readyConnections === 0` → `throw new TunnelError('connector_down', <lastError ?? 'cloudflared has no edge connections'>)` — this must fail even when the edge would answer Access 302. (2) edge probe as today; on `access_protected` set step `access_protected` when connector verified `readyConnections > 0`, else `access_protected_unverified`; on 200 + startedAt match → `ok` (origin proven, regardless of connector knowledge). Edge failure messages must include connector info when known, e.g. `health check HTTP 530 (connector: 0 edge connections)`. Map `connector_down` to HTTP 503 in `tunnelHttpStatus`.

F. **Tests** (bun): connector-health unit tests (parsing, discovery priority, probe 200/503/refused/timeout/non-JSON, log tail incl. partial first line + redaction, extractLastError both formats); supervisor degrade/recover through log lines in JSON and text formats; manager: external + Access 302 + connector 0 → check job error `connector_down`; external + Access 302 + connector 4 → done with step `access_protected`; external + Access 302 + no metrics → `access_protected_unverified`; managed 200 startedAt → `ok`; external logfile tail appears in `status().log`; status `degraded` derivation; poll loop with fake timers/injected sleep. Existing tests must keep passing (`apps/gateway`: `bun test src/tunnel src/api/tunnel-routes.test.ts` baseline 142 pass / 0 fail; whole-package `bun test` currently all green; `bunx tsc --noEmit -p .` baseline **0 errors**).

Use the existing fake spawn / fake fetch helpers in the tunnel tests (`fake-spawn.ts`, `manager.test.ts` patterns) rather than inventing new frameworks. Keep the code style of the surrounding files.
