# Task G3 — Directory browse API for the graphical path picker (backend)

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
Settings → Devices & files lets users add a directory root by typing a path. We are adding a graphical picker; it needs an endpoint that lists sub-directories of ANY directory on a device (local or SSH), independent of the configured file roots. Contract is fixed: `BrowseDirectoryResponse` / `BrowseDirectoryEntryDto` in packages/shared/src/contracts/files.ts, client `browseDirectory` in packages/api-client/src/file-resources.ts (`GET /api/files/browse?deviceId=&path=&hidden=1`).

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-devices-report.md section 4 (existing file APIs, device-storage.ts, SSH listing).

## Scope (files you own)
- apps/gateway/src/api/file-browser-routes.ts (add the route) or a new `apps/gateway/src/api/directory-browse-routes.ts` registered from apps/gateway/src/api/files.ts
- apps/gateway/src/files/** new file(s) e.g. `directory-browse.ts` (reuse the local/SSH listing primitives in device-storage.ts / the ssh helpers WITHOUT the root containment checks; do not change existing exported behaviour of device-storage.ts)
- tests next to them (apps/gateway/src/api/files.test.ts may be extended)

## Requirements
- Requires the normal authenticated API session (same middleware as the other /api/files routes). Works through `/n/:id` forwarding automatically.
- `path` empty → start directory: local device → `os.homedir()`; SSH device → remote login user's home (`$HOME` via the existing ssh exec helper, fall back to `/`). Otherwise `path` must be absolute; normalize with `path.posix.resolve`; `~` is NOT supported (400 `invalid`).
- Returns only directories (plus symlinks that resolve to directories, flagged `symlink: true`), sorted by name (case-insensitive), hidden (dot-prefixed) entries only when `hidden=1`. `parent` = dirname, or null at `/`. Cap at 2000 entries → `truncated: true`. Entries that cannot be stat'ed are skipped.
- Errors map to the existing `FileErrorCode` set (`not_found`, `not_a_directory`, `permission_denied`, `device_not_found`, `connection_failed`, `timeout`, `invalid`) through the existing error mapping in apps/gateway/src/api/file-http.ts.
- SSH: one command per request with a timeout; robust to names with spaces/unicode (e.g. `find -maxdepth 1 -mindepth 1 \( -type d -o \( -type l -xtype d \) \) -print0` and detect symlink via a second flag, or whatever the existing ssh helper supports; test with a fake exec).
- Tests: local browse on a temp dir (hidden filtering, symlink-to-dir flagged, files excluded, truncation, not-a-directory error), SSH browse via the existing fake/mocked ssh pattern in files tests, 400 on relative path / missing deviceId, 404 unknown device.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/G3-result.md
