# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# O3 — Hub primary/standby switch from the node table

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/O3-result.md`

## Context
Node table (`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`) shows a `HubTag` (主 Hub / 备 Hub) on hub rows. The user wants a「切换」button right of that tag: on a standby hub → 「设为主 Hub」; on the current writer → 「设为备 Hub」. Backend pieces (read their result reports and code first):
- Signed hub authorization `admit-hub` (`sub/G2-result.md`): shared helpers `buildAdmitHubPayload` in `packages/shared/src/auth` (see how `revoke-node` records are built and submitted in `apps/fe/src/node/enrollment.ts` ~L512-537 and `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts` `revokeNodeRecord` → `POST /api/auth/keylog?hub=sync`); `GET /api/mesh/hubs` hubs now carry `authorization: 'signed'|'env'|'self'` (api-client typed by O1b); writer answers 409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES { minVersion, nodes[] }` when old nodes exist (force header `X-Tmex-Force-Keylog: 1`).
- Role API (`sub/G3-result.md`, contract `packages/shared/src/contracts/hub-role.ts`): `POST /n/<hubNodeId>/api/hub/role { mode, writerEpoch?, operationId }` → 202 `HubRoleTransition`; `GET /n/<hubNodeId>/api/hub/role/status?operationId=` ; errors `HubRoleErrorCode`; target 404/405 → treat as `HUB_ROLE_UNSUPPORTED`. The hub restarts itself after persisting → its `/n/<id>/...` will be unreachable for a while; reuse the wait/poll helper in `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts`.

## Requirements
1. `HubApi` (`apps/fe/src/node/hub-api.ts`): add `role(hubNodeId, req)` and `roleStatus(hubNodeId, operationId)` targeting `/n/<hubNodeId>/api/hub/role[...]` (not the entry's hub), mapping 404/405 to `HUB_ROLE_UNSUPPORTED`.
2. New `use-hub-role-switch.ts` implementing「设为主 Hub」for target X with current writer A:
   a. If `hubs.find(X).authorization` is not `signed` → build + sign `admit-hub` (credential prompt, same as revoke) and submit; on 409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` show a dialog listing the old nodes 「以下节点版本低于 {{minVersion}}，须先升级：…」 with a checkbox 「仍然继续（旧节点将无法再同步）」 that retries with the force header; wait until `/api/mesh/hubs` shows X `authorization: 'signed'`.
   b. `newEpoch = max(all hubs.writerEpoch) + 1`, `operationId = crypto.randomUUID()`.
   c. If A is online → `POST /n/A/api/hub/role {mode:'standby', operationId}`; if A is offline/unreachable → skip with a warning line in the confirm dialog (「原主 Hub 不可达，将依靠更高纪元围栏它」).
   d. `POST /n/X/api/hub/role {mode:'active', writerEpoch:newEpoch, operationId}`.
   e. Poll: `roleStatus` on X until `complete`/`failed` (X restarts: tolerate unreachable for up to 90 s using the restart waiter), and `/api/mesh/hubs` until `writerHubId === X`. Then `refreshAll`.
   「设为备 Hub」on the writer X: if another authorized hub Y exists → same as above with Y as new primary (confirm dialog says which Y); if none → `POST /n/X/api/hub/role {mode:'standby'}` with an explicit warning 「之后将没有可写 Hub」.
   Persist `{operationId, targetHubId, fromHubId, startedAt}` in `sessionStorage` (`tmex.nodes.hub-role-switch`) so a refresh resumes polling; row shows 「切换中」 (reuse the `operation` row state style from uninstall; kind `'role-switch'` is already in `MeshNodeOperationKind` but this one is FE-local — do not expect it from the server).
3. UI: `nodes-table.tsx` `HubTag` gets a sibling `icon-xs` button (`ArrowLeftRight`) with `title` 「设为主 Hub」/「设为备 Hub」; disabled with reason when: hub offline, `!hubWritable` for admit step (only if admit is needed), another switch in progress, upgrade/uninstall busy on that row, or `authorization` unknown (old backend). One `AlertDialog` confirm summarizing the plan (steps a–e with names/epochs). Toasts: started / done / failed with `HubRoleErrorCode` messages (`nodes.hubs.role.*` keys).
4. Copy per `/Users/konata/code/tmex-copy-guidelines.md`, zh → en → ja, `bun run --filter @tmex/shared build:i18n`.
5. Tests: hook logic with mocked `HubApi`/fetch (admit needed vs not, old-nodes 409 → force path, A offline path, polling through restart, resume from sessionStorage), table button states. Baselines: `cd apps/fe && bun test src/` all green (report numbers), tsc 0.

Scope: `apps/fe/src/node/hub-api.ts` (+test), `apps/fe/src/pages/settings/nodes/management/{nodes-table.tsx,nodes-management.tsx,use-hub-role-switch.ts (new),hub-role-dialog.tsx (new),nodes-management.test.tsx,use-hub-role-switch.test.ts (new)}`, `apps/fe/src/node/enrollment.ts` (only to add the admit-hub record builder next to revoke), locales `translation.nodes.hubs.*`. No git.
