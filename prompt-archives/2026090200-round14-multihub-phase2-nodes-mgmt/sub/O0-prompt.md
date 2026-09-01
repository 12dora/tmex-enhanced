# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# O0 — Tunnel robustness (frontend): show connector health, `degraded` state, precise check results, external logs

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/O0-result.md`

## Background
The user's Cloudflare Tunnel was down for hours while「设置 → 远程访问」showed 运行中, 「检查连通性」passed and「显示日志」was empty. Backend causes (being fixed in parallel by another agent in `apps/gateway/src/tunnel/**`): the check probed `https://<hostname>/healthz`, which is intercepted by Cloudflare Access at the edge (302) before reaching the origin, and was counted as success; the externally-managed cloudflared's "running" only meant the process existed; its `--logfile` was never read.

## Contract (already committed in `packages/shared/src/contracts/tunnel.ts` — read it, do not edit it)
- `TunnelProcessState` now includes `'degraded'` = process alive but zero edge connections → the public address is NOT reachable.
- `TunnelStatusResponse.connector: TunnelConnectorStatus { reachable: boolean|null; metricsAddr; readyConnections; connectorId; checkedAt; lastError }` (required field; `reachable === null` = metrics endpoint not found, unknown).
- `TunnelErrorCode` gained `'connector_down'` (check job fails with it when the connector has 0 edge connections).
- `TunnelJobStatus.step` after a finished `check` job: `'ok'` (edge + origin proven), `'access_protected'` (edge intercepted by Access, connector verified online), `'access_protected_unverified'` (Access intercept and connector could not be probed → reachability NOT proven).
- `status.log` will now also be filled for externally managed tunnels (tail of the cloudflared log file) — nothing to change in the log component except copy.

## Scope — files you may edit (frontend only)
- `apps/fe/src/pages/settings/remote-access/**` (status-card.tsx, tunnel-actions.ts, tunnel-model*.ts, external-card.tsx, tests)
- `apps/fe/src/components/side-panels/connect-devices/host-status.ts`, `access-addresses.ts` and their tests (treat `degraded` like "tunnel not usable" wherever `process.state === 'running'` gates the tunnel address; read the code)
- `apps/fe/src/pages/settings/remote-access/*.test.*` and every FE test fixture that builds a `TunnelStatusResponse` (currently failing tsc because `connector` is missing: `host-status.test.ts`, `access-model.test.ts`, `remote-access-tab.test.tsx`, `tunnel-actions.test.ts`, `tunnel-model.test.ts`)
- i18n: `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — edit ONLY inside `translation.settings.remoteAccess` (and add keys there). zh_CN is the source language; **read `/Users/konata/code/tmex-copy-guidelines.md` first** and follow it strictly (short, no 第二人称, 全角标点, state over explanation). After editing locales run `bun run --filter @tmex/shared build:i18n` (regenerates `resources.ts`/`types.ts`; never hand-edit or lint those).
- Do NOT touch `apps/gateway`, `packages/shared/src/contracts`, other FE pages.

## Requirements
1. **Fixtures**: add a `connector` object to every `TunnelStatusResponse` fixture so `cd apps/fe && bunx tsc --noEmit -p .` is back to **0 errors**.
2. **Status card** (`status-card.tsx`):
   - Process state `degraded`: show a warning-tone notice (reuse `SetupNotice`) 「隧道进程运行中，但无边缘连接，公网地址当前不可达。」 + `process.lastError` / `connector.lastError` on a second line when present. The state badge/label that currently renders 运行中/已停止 must have a distinct label for degraded (e.g. 「无连接」/"No Edge Connections").
   - Connector row (only when `configured`/adopted): 「连接器：4 条边缘连接」 when `reachable && readyConnections > 0`; 「连接器：无边缘连接」 (destructive tone) when `reachable && readyConnections === 0`; 「连接器：无法探测（未找到 metrics 端点）」 (muted) when `reachable === null`; nothing when `checkedAt` is null and reachable null? — no: still show 「未探测」. Put `metricsAddr` in a `title` tooltip, not inline. Keep it to one line.
   - Check result: extend `TunnelCheckResult` with `step: string | null` and `code: TunnelErrorCode | null`; `checkResultOf` reads `job.step`/`job.error.code`. Render: `ok` → success 「本机经公网地址可达。」; `access_protected` → success 「公网地址受 Cloudflare Access 保护，连接器在线。」; `access_protected_unverified` → **warning** tone 「公网地址受 Cloudflare Access 保护；未探测到连接器，无法确认本机可达。」; error `connector_down` → error 「连接器无边缘连接：{message}」; other errors as today. Current copy keys under `settings.remoteAccess.check.*` — extend, keep existing keys working.
   - Log panel: when `status.config.externallyManaged` and log is empty show 「外部 cloudflared 未提供日志文件（启动参数无 --logfile）。」 instead of the generic empty text.
   - The check button must also be available when state is `degraded`.
3. **connect-devices host-status / access-addresses**: wherever the tunnel address is considered available only when `process.state === 'running'`, `degraded` must NOT count as available; if the panel shows a tunnel status line, add the degraded wording (「无边缘连接」). Read the code and tests before deciding; keep changes minimal.
4. Tests: update/add unit tests in the existing test files for every rendering branch above (degraded notice, connector row 3 states, check result 4 branches, external empty-log copy, host-status degraded). Baselines: `cd apps/fe && bun test src/pages/settings/remote-access` = 188 pass / 0 fail; `bun test src/components/side-panels/connect-devices` currently all green; full `bun test src/` all green (report your final numbers). `bunx tsc --noEmit -p .` must be 0. `bunx biome check` on changed files clean.
5. Keep the visual style of the existing card (Tailwind classes already used there). No new dependencies.
