# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# G1 — Remote clean uninstall of a node (backend + CLI)

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/G1-result.md`

## Goal
From the entry node's UI (「设置 → 多节点互联 → 节点管理」) the user selects remote nodes and picks「卸载 tmex」. The entry must ask each target node to cleanly uninstall itself (stop + remove the launchd/systemd service, delete install dir, shim, `app.env`, database), record the operation so a page refresh still shows「卸载中」, and let the FE afterwards revoke the node on the hub (the FE already has a signed `revoke-node` flow; you do NOT implement revoke).

## Contract already committed (read, do not edit): `packages/shared/src/contracts/system.ts`
`UninstallState`, `UninstallStatus`, `StartUninstallRequest`, `MeshUninstallErrorCode`, `MeshUninstallError`, `MeshNodeOperationKind`, `MeshNodeOperation`; and `MeshNode.operation?: MeshNodeOperation | null` in `packages/api-client/src/auth/types.ts`.

## Existing code to build on (from a code exploration — verify by reading)
- Target system API: `apps/gateway/src/api/system.ts` (`handleSystemApiRequest`: `/api/system/info` returns `upgradeCapabilities: ['staged-package','upgrade-cancel']`; upgrade handlers), `apps/gateway/src/api/system-routes.ts`, install detection `apps/gateway/src/system/install-info.ts` (`installedViaCli`, `deployment: 'launchd'|'systemd'|'none'`, `installDir`, `serviceName`), `apps/gateway/src/system/info-public.ts` (`canSelfUpdate`), upgrade spawn pattern `apps/gateway/src/system/upgrade.ts:729-806` (detached child so the HTTP response can return), upgrade service `apps/gateway/src/system/upgrade-service.ts`, remote job `apps/gateway/src/system/remote-upgrade-job.ts`.
- Entry relay for upgrade: `apps/gateway/src/mesh/mesh-routes.ts:226-293` (`POST/GET/DELETE /api/mesh/nodes/:id/upgrade` → local service or forward to target over the peer link with the node session; error codes `NODE_LOGIN_REQUIRED`, `NODE_UNREACHABLE`, 501 for old targets); node projection for `GET /api/mesh/nodes` at `mesh-routes.ts:325-355`.
- KV store: `apps/gateway/src/db/kv.ts` (`getGatewayKv/setGatewayKv`, table `gateway_kv`).
- CLI uninstall: `packages/app/src/commands/uninstall.ts` (`--install-dir`, `--yes`, `--purge`, `--service-name`), service control `packages/app/src/lib/service.ts` (stop/disable/bootout/remove for launchd & systemd-user), shim removal `packages/app/src/lib/cli-shim.ts:235-262`, layout `packages/app/src/lib/install-layout.ts`. The CLI bundle is built by `packages/app` `build:cli` (`bun build --target node`) to `dist/cli/...`; at runtime the installed CLI lives at `<installDir>/current/cli/bin/tmex.js` (check `install-layout.ts` / `install-info.ts` for the exact path helper). `hub leave` / membership reset: `packages/app/src/runtime/membership-reset.ts`, `packages/app/src/runtime/local-routes.ts` (`POST /api/local/leave`).

## Requirements

### A. Target side: `POST /api/system/uninstall` + `GET /api/system/uninstall` (`apps/gateway/src/api/system.ts` + new `apps/gateway/src/system/uninstall.ts`)
- Preconditions → 409 `{ code: 'UNINSTALL_NOT_ALLOWED', reason }` when `!installedViaCli` or `deployment === 'none'` (docker / manual deploy) or `isManagedBuild()/isManagedExternally()`; 409 `UPGRADE_IN_PROGRESS` when an upgrade is downloading/executing; idempotent: a second POST while `scheduled` returns 202 with the same status.
- Body `{ mode?: 'full' }` (only `full` accepted; anything else 400).
- Action: resolve the installed CLI entry file (`<installDir>/current/cli/bin/tmex.js`, resolve the `current` symlink to a real `versions/<v>` path) and **copy the whole `cli` directory to a fresh temp dir** (`os.tmpdir()/tmex-uninstall-<random>/`) so the uninstaller does not run from the tree it deletes. Spawn `node <tmp>/bin/tmex.js uninstall --yes --purge --install-dir <installDir> [--service-name <name>] --delay-ms 1500` **detached** (`detached: true`, `stdio: 'ignore'`, `child.unref()`), then return 202 `{ state: 'scheduled', startedAt, error: null }` immediately. Use the same node-binary resolution the upgrade spawner uses (read `upgrade.ts`; if it uses `process.execPath`/bun for the CLI, mirror it — the CLI is Node-compatible and also runs under bun).
- `GET /api/system/uninstall` → `UninstallStatus` (in-memory; after the service is gone the endpoint is unreachable, that is expected).
- Add `'uninstall'` to the capability list returned by `GET /api/system/info` (`upgradeCapabilities`), so the entry can tell old targets apart.

### B. CLI: `packages/app/src/commands/uninstall.ts` (+ `packages/app/src/lib/args.ts`, `help.ts`)
- New flag `--delay-ms <n>` (default 0): sleep before doing anything, so the gateway's 202 response is flushed before the service is stopped.
- Non-interactive `--yes --purge` must remove: service (stop + disable/bootout + unit/plist file), install dir contents (`versions/`, `current`, `staging`, `backups`, `upgrade-state.json`, logs, `run.sh`, `install-meta.json`, `app.env`, `data/` incl. the SQLite db + `-wal/-shm`), and the managed shims (`~/.local/bin/tmex`, `~/.bun/bin/tmex` only when they carry the tmex marker). Finally remove the temp copy of itself (best effort: `fs.rm(dirname(process.argv[1])/.., {recursive, force})` after everything else). Must never touch anything outside `installDir`, the unit file and the marked shims.
- Must not fail when the service manager is already gone or the process is not running; log each step to stderr (there is no user; keep messages terse).

### C. Entry side (`apps/gateway/src/mesh/mesh-routes.ts` + new `apps/gateway/src/mesh/node-operations.ts`)
- `POST /api/mesh/nodes/:id/uninstall`: `id === self` → 409 `UNINSTALL_SELF_BLOCKED`; node must be logged-in on the entry like upgrade (`NODE_LOGIN_REQUIRED`) and reachable (`NODE_UNREACHABLE`); forward to the target `POST /api/system/uninstall` over the peer link (same helper the upgrade relay uses); target 404/405 → 501 `UNINSTALL_UNSUPPORTED`; propagate 409 bodies (`UNINSTALL_NOT_ALLOWED`, `UPGRADE_IN_PROGRESS`). On 202 write the operation record.
- Operation store (`node-operations.ts`) persisted in `gateway_kv` under `mesh.node-op.<nodeId>` as JSON `MeshNodeOperation`: phases `requested` (before forwarding) → `uninstalling` (target 202) → `failed` (with `error`) ; TTL 30 min from `updatedAt` (expired records are dropped on read). `DELETE /api/mesh/nodes/:id/operation` clears a record. Records are also cleared automatically when the node is no longer in the entry's node list (revoked / removed) — do this lazily inside the `GET /api/mesh/nodes` projection.
- `GET /api/mesh/nodes` rows gain `operation` (null when none). `GET /api/mesh/nodes/:id/operation` returns the record or 404.
- Session/auth: same requirements as the upgrade relay routes.

### D. Tests
- Gateway: system uninstall handler (not allowed / in-progress / scheduled + spawn args asserted through an injected spawner / idempotent / capability listed), node-operations store (TTL, clear, lazy cleanup), relay route (self blocked, login required, unsupported 501, 409 passthrough, 202 → record `uninstalling`, projection shows `operation`). Follow the patterns in the existing upgrade route tests (`mesh-routes*.test.ts`, `system*.test.ts`). Baseline `apps/gateway`: full `bun test` all green (≈3346 pass), `bunx tsc --noEmit -p .` **0 errors**.
- `packages/app`: uninstall command tests with a fake fs/service manager for `--delay-ms`, `--yes --purge` file set, shim marker check, self-cleanup. Baseline `packages/app`: `bun test` all green (629 pass), `bunx tsc --noEmit -p .` **1 error (pre-existing; do not add more)**.
- Update docs: add a「远程卸载」section to the most relevant existing doc under `docs/hub/` (operations guide `docs/hub/2026082800-hub-node-operations.md`).

## Scope — files you may edit
`apps/gateway/src/api/system.ts`, `apps/gateway/src/api/system-routes.ts`, `apps/gateway/src/system/uninstall.ts` (new), `apps/gateway/src/system/install-info.ts` (read; extend only if a path helper is missing), `apps/gateway/src/mesh/mesh-routes.ts`, `apps/gateway/src/mesh/node-operations.ts` (new), their tests, `packages/app/src/commands/uninstall.ts`, `packages/app/src/lib/args.ts`, `packages/app/src/cli/help.ts`, `packages/app/src/**/uninstall*.test.ts`, `docs/hub/2026082800-hub-node-operations.md`. Do NOT touch `apps/gateway/src/tunnel/**` (another agent), `apps/fe/**`, `packages/shared/**`, `packages/api-client/**`.
