# Task G4 — Remote access: Cloudflare Tunnel manager (backend)

## Ground rules (read carefully)
- Repo: tmex monorepo, Bun-only runtime (`bun`, `bunx`; never node/npm/npx for running). Worktree root: /Users/konata/code/tmex-enhanced-wt-r5. Work ONLY inside this worktree.
- Several other agents are editing this same worktree in parallel. Touch ONLY the files/directories listed in your scope (plus new files you create inside those directories). Do NOT run `git add/commit/stash/checkout/reset`. Do NOT run formatters over the whole repo; `bunx biome check --write <your files>` only.
- Never edit generated files: `packages/shared/src/i18n/resources.ts`, `packages/shared/src/i18n/types.ts`, anything under `resources/`, `dist/`. For i18n, edit the source locale JSONs `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` (all three, same keys, only inside the sub-object named in your scope) — the commander runs `bun run build:i18n`. If you need the generated types updated to typecheck, you may run `bun run build:i18n` from the repo root yourself (it only regenerates from the JSONs).
- Copy (UI strings) must be concise, professional and plain — the tone of mature large-scale software (think VS Code / GitHub settings). No exclamation marks, no chatty phrasing. zh_CN uses Chinese punctuation.
- Comments in code: only when the logic is genuinely non-obvious; existing comments in this repo are in Simplified Chinese — follow that.
- Do not touch anything about the production tmex install (`~/Library/Application Support/tmex`, port 9883) or any tmux session named `tmex`. Tests must use isolated tmux sockets / test env only.
- Never leave TODOs, stubs, or "simplified versions". Finish the whole scope. If something in the scope is impossible, explain exactly why in your result file.
- Verify before finishing: run the relevant package tests (`cd <pkg> && bun test` — for apps/fe use `bun test src/`), `bunx tsc --noEmit -p .` in each package you touched (error count must not exceed the baseline given below), and `bunx biome check <files you changed>`. Baseline (before this round): apps/gateway 2500 pass / tsc 21 errors (pre-existing); apps/fe 671 / 0; packages/panels 507 / 0; packages/stores 282 / 1; packages/shared 365 / 0; packages/api-client 132 / 5 (pre-existing); packages/ui 47 / 0. Note: the commander already changed shared contracts (agent `nodeId`, MeshNode `reach`/`rttMs`, files browse, tunnel) so some test fixtures now fail tsc until the owning agent updates them — that is expected and yours to fix if in your scope.
- Shared contracts are already written and are FIXED (do not change their shape; you may add doc comments): `packages/shared/src/contracts/agent.ts` (`AgentSessionDto.nodeId`, `CreateAgentSessionRequest.nodeId`), `packages/shared/src/contracts/files.ts` (`BrowseDirectory*`), `packages/shared/src/contracts/tunnel.ts`, `packages/api-client/src/auth/types.ts` (`MeshNode.reach: 'lan'|'wan'|'relay'|null`, `rttMs`), api-client functions `browseDirectory` (file-resources.ts), `fetchAgentSessions(client, {nodeId})` (agent.ts), `fetchTunnelStatus/runTunnelAction` (local/tunnel-api.ts).
- When done, write a concise result report (what changed, file list, test/tsc/biome numbers, anything left or risky) to the absolute path given in your task, then exit.


## Goal
A new Settings tab "远程访问 / Remote access" lets the user go from nothing to a working Cloudflare Tunnel for THIS machine's tmex, graphically. You build the backend. Contract is FIXED: packages/shared/src/contracts/tunnel.ts (read it in full — every field must be populated) and client packages/api-client/src/local/tunnel-api.ts (`GET /api/tunnel/status`, `POST /api/tunnel/actions`). The frontend is built in parallel by another agent against this contract.

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-tunnel-report.md sections 2–3 (what exists: TLS external mode writes TMEX_TRUST_PROXY through packages/app; the gateway has no process manager; `apps/gateway/src/system/upgrade.ts` spawns a child; `packages/app/src/lib/process.ts`, `env-file.ts` are CLI-side helpers).

## Scope (files you own)
- NEW apps/gateway/src/tunnel/** (manager, cloudflared provider, download, job runner, log ring buffer, config store) + tests
- NEW apps/gateway/src/api/tunnel-routes.ts, registered in apps/gateway/src/api/index.ts (one line)
- apps/gateway/src/config.ts: add `TMEX_TUNNEL_DIR` (default: a `tunnel` directory next to the sqlite db file) — minimal change
- gateway boot/shutdown wiring (apps/gateway/src/index.ts or runtime.ts): start the manager on boot (auto-start if configured) and stop it on shutdown — minimal lines
- Persist config in the DB: add a small table via schema + drizzle migration (`tunnel_config`: single row id='default', mode, hostname, tunnel_name, tunnel_id, auto_start, updated_at). NOTE: another agent (G1) is also adding a migration this round (agent_sessions.node_id) — generate yours with the repo's drizzle workflow, use a distinct name, and if the drizzle journal ends up conflicting say so in the report (the commander will resolve).
- TMEX_TRUST_PROXY: find how `packages/app/src/tls/tls-service.ts` external mode patches app.env through a dep injected into the gateway from the packages/app runtime, and reuse the SAME injection path (add an optional `patchHostEnv`-style dep to the tunnel manager; when it is absent — dev from source — `set_trust_proxy` returns error code `not_configured` with message "Host environment is not managed by tmex-cli"). You may add the wiring in the packages/app/src/runtime file that wires TLS deps — minimal, list every line in the report.

## Behaviour
- `supported`: darwin/linux on x64/arm64 only.
- binary: check managed path `<TMEX_TUNNEL_DIR>/cloudflared` first, then PATH (`which cloudflared`); `version` from `cloudflared --version` (parse `cloudflared version 2025.x.y`), cached.
- `install` job: download the official GitHub release asset for the platform (https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-<os>-<arch> ; on darwin the asset is a `.tgz` containing the binary) into TMEX_TUNNEL_DIR atomically (tmp + rename), chmod 755, verify by running `--version`. Steps: download → extract → verify. Downloader must be injectable for tests.
- `login` job: spawn `cloudflared tunnel login`; cert.pem must land in TMEX_TUNNEL_DIR (check `cloudflared tunnel login --help` for the origin-cert flag / `TUNNEL_ORIGIN_CERT` env; if no cloudflared is on this machine (`which cloudflared`), download one into your scratch dir under /private/tmp/claude-501/ to inspect help — do not add it to the repo). Parse the auth URL from stdout/stderr into `auth.loginUrl`; the job completes when cert.pem appears (poll), times out after 10 min → `login_timeout`. `cancel_login` kills it.
- `create` job (named mode): validate hostname (RFC 1123, lowercase), tunnelName default `tmex-<first hostname label>`; run `cloudflared tunnel create <name>` (parse tunnel id + credentials file path; if it already exists, reuse via `cloudflared tunnel list -o json`), then `cloudflared tunnel route dns <name> <hostname>` (error `dns_route_failed` carrying cloudflared's message), write `<TMEX_TUNNEL_DIR>/config.yml` with ingress `hostname → http://127.0.0.1:<originPort>` plus `http_status:404` fallback, persist mode=named, then start.
- `quick_start`: `cloudflared tunnel --url http://127.0.0.1:<originPort> --no-autoupdate`, parse `https://<random>.trycloudflare.com` from output → `process.publicUrl`; persist mode=quick (a quick tunnel gets a new URL every start — fine).
- `start`/`stop`: supervise the child (`Bun.spawn`), state stopped→starting→running (running once cloudflared logs a registered connection, e.g. "Registered tunnel connection", or the trycloudflare URL line) → error on unexpected exit; auto-restart with backoff 1 s → 30 s max while enabled, `restarts` counter; `stop` disables auto-restart and sends SIGTERM (SIGKILL after 5 s). Kill the child on gateway shutdown. `autoStart` → start on boot.
- `remove`: stop, delete config.yml/credentials of the named tunnel (keep cert.pem), `cloudflared tunnel delete -f <name>` best-effort, mode=off.
- `check`: fetch `https://<hostname or publicUrl>/healthz` with a 5 s timeout and compare its `startedAt` with ours; result reflected in job step `ok` or an error.
- originPort = the gateway's listening port from config.
- Log ring buffer of the last 200 lines; redact token-like strings (base64/hex ≥ 32 chars) before storing.
- `trustProxy`: from config; `set_trust_proxy` patches env via the injected dep and sets `restartRequired`.
- Jobs: only one at a time (`busy` → 409). Status is a cheap snapshot (no spawning per call).
- Errors as `{ error: { code, message } }` with the contract's `TunnelErrorCode`; the routes require the normal authenticated session.

## Tests
Provider with an injected fake spawner (scripted stdout/exit) covering: version parse, login URL parse + cert poll + timeout, create parses id / existing, route dns failure, quick URL parse, supervisor state machine + backoff + stop, redaction, routes (status shape, busy 409, validation 400), migration apply. No real network in tests.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/G4-result.md
