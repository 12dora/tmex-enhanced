# C2: Remote node upgrade — backend (gateway)

You are the backend coder working in /Users/konata/code/tmex-enhanced-wt-r10 (tmex monorepo, Bun runtime — use `bun`/`bunx`, never node/npm for running). Other agents work in the SAME worktree in parallel. You MUST only modify the files listed under "File ownership". NO git commands (the commander commits). Never touch the production tmex install (`~/Library/Application Support/tmex/`, port 9883) or any tmux session named `tmex`.

## Goal

New feature: Settings → Node management lets the user upgrade any mesh node (including a remote node and the local node) to the latest released version. Backend chain: local gateway exposes mesh-upgrade endpoints; for remote targets it forwards over the existing peer-link HTTP stream to the target node's existing `POST /api/system/upgrade`.

READ FIRST: the full exploration + design in `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/EX2-result.md` (sections 1, 2, 4, "推荐实现设计", "后端工作包", "风险和注意事项"). Follow that design. Key points:

- `GET /api/mesh/upgrade/latest` — local session required; resolves the latest GitHub release (extract a reusable helper from `apps/gateway/src/system/update-check.ts`), verifies the `tmex-cli-<v>.tgz` asset exists, returns `{ latestVersion, changelog, publishedAt }`. Do NOT use entry-node `hasUpdate` for remote decisions.
- `POST /api/mesh/nodes/:nodeId/upgrade` — empty body; local gateway resolves the concrete latest version itself; validates the node is enrolled & not revoked; for remote targets requires the stored target-node session (else `NODE_LOGIN_REQUIRED`); optionally checks target `/api/system/info`; already-at-or-above-latest → `UPGRADE_ALREADY_LATEST`; forwards `POST /api/system/upgrade {version}` over the existing forwarder (no auto-retry on POST); target 404 → `UPGRADE_UNSUPPORTED`; unreachable → `NODE_UNREACHABLE`; propagate 409 as `UPGRADE_IN_PROGRESS`, 403 as `UPGRADE_NOT_ALLOWED`. For the LOCAL node target, call the local upgrade controller directly (same as `/api/system/upgrade` semantics).
- `GET /api/mesh/nodes/:nodeId/upgrade` — status: local → `upgradeController.status()`; remote → forward `GET /api/system/upgrade` (GET may retry per existing forwarder semantics).
- Error codes (stable strings in response JSON): `NODE_LOGIN_REQUIRED`, `NODE_UNREACHABLE`, `UPGRADE_NOT_ALLOWED`, `UPGRADE_IN_PROGRESS`, `UPGRADE_ALREADY_LATEST`, `UPGRADE_UNSUPPORTED`, `RELEASE_UNAVAILABLE`.
- Do NOT add anything to `/api/mesh-internal/*` (it bypasses user sessions) and do NOT touch the uplink codec / peer-manager / hub protocol.

## File ownership (modify only these)

- `apps/gateway/src/mesh/mesh-routes.ts` (+ its test file)
- `apps/gateway/src/mesh/forwarder.ts` (+ test) — add an authorized-forward helper if needed
- `apps/gateway/src/mesh/mesh-http.ts` — wire dependencies
- `apps/gateway/src/system/update-check.ts` (+ test) — extract latest-release resolution helper
- `apps/gateway/src/api/system.ts` (+ test) — extract shared start/status logic if needed
- NEW files under `apps/gateway/src/system/` or `apps/gateway/src/mesh/` (e.g. `upgrade-service.ts`) and their tests
- `packages/shared/src/contracts/system.ts` — add response/type contracts for the new endpoints (keep it browser-safe: types/schemas only, no node imports)

Do NOT modify FE files, i18n locale JSON files, `apps/gateway/src/system/upgrade.ts` core controller behavior (you may add small exported accessors if strictly needed), or anything else.

## Verification (mandatory, record numbers in your report)

- Baselines BEFORE coding: `cd apps/gateway && bunx tsc --noEmit -p . 2>&1 | wc -l` (baseline ~21 errors — must not increase) and targeted `bun test src/mesh src/system src/api` pass/fail counts (strip ANSI color from summary: `sed 's/\x1b\[[0-9;]*m//g'`).
- After: same commands — no tsc increase, no new test failures, your new tests pass.
- `bunx biome check <each changed file>` clean (never `--write` on files you don't own).
- macOS has no `timeout` command. Do not run `grep -c` inside `&&` chains (exit 1 on zero matches).

## Report

When done, write a concise report (endpoints, files changed, test/tsc numbers, any deviations from the design and why) to the ABSOLUTE path `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/C2-result.md` as your LAST action before exiting.
