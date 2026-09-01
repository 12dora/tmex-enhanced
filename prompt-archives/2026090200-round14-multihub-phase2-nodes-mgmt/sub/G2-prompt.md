# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# G2 — Hub authorization via user-signed key-log records (`admit-hub` / `retire-hub`)

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/G2-result.md`

## Background
Multi-hub phase 1 (`docs/hub/2026090104-multi-hub-standby.md`) authorizes other hubs through the per-machine env `TMEX_HUB_PEERS` (`tmex hub allow/disallow`), checked in `UplinkServer.isAuthorizedHub()` (`apps/gateway/src/hub/uplink-server.ts` ~L1305-1365), `apps/gateway/src/hub/hub-replication.ts` ~L50-64 and injected from `apps/gateway/src/mesh/mesh-runtime.ts` ~L698-715. The list does not replicate, so the writer must be `allow`ed by hand on every hub. Threat model (hub is NOT a trust root; a compromised ordinary node must not be able to advertise itself as hub and fence the writer) must be preserved. This task replaces env as the source of truth with **user-signed key-log records** that replicate through the existing strict chain, keeping env as bootstrap/fallback.

An exploration report with exact file/line references is at `prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/EX2-result.md` §1 — read it first (verify against the code). Key facts: record types are a `@zorsh` `nativeEnum` (`packages/shared/src/auth/encoding.ts:29-39`, ordinal-encoded → **append new types at the END only**); verification `packages/shared/src/auth/key-log.ts:218-281`, signer matrix `:60-69`, apply `:301-458`; store/service/persistence `apps/gateway/src/auth/{key-log-store.ts,user-key-service.ts,user-key-persistence.ts}`; DB `user_key_log_type_check` constraint `apps/gateway/src/db/schema.ts:527-550` (must be widened via a managed migration in `apps/gateway/src/db/managed-migrations.ts`); browser signs records with root key / passkey (`apps/fe/src/auth/key-log-actions.ts`, submits `POST /api/auth/keylog?hub=sync`); old v1.1.x nodes **cannot decode unknown record types** (chain replay returns `malformed_payload`) — see §Compat below.

## Requirements

### A. Shared (`packages/shared/src/auth/encoding.ts`, `key-log.ts`, tests)
- Append `KeyLogType` values `admit-hub`, `retire-hub` (end of enum). Payloads (Borsh):
  `AdmitHubPayload { hub_node_id: bytes(16); public_url: option(string); priority: option(u32) }`, `RetireHubPayload { hub_node_id: bytes(16) }`.
- Signer matrix: both `root` or `passkey`.
- Apply semantics in `key-log.ts`: `admit-hub` requires an existing non-revoked node cert for `hub_node_id` (else `unknown_node` style error consistent with existing codes); adds/updates `UserKeyState.hubAuthorizations: Map<hubNodeIdHex, { status: 'active'|'retired'; publicUrl; priority; seq }>`; `retire-hub` requires an existing authorization and sets `retired`. `revoke-node` of an admitted hub also retires it. `rotate-root`/`reset-root`: keep authorizations on rotate (they are user intent, not key material) but clear on `reset-root` like node certs — mirror what the code does for `nodeCerts`.
- Export helpers the browser will use: `buildAdmitHubPayload(...)`, `buildRetireHubPayload(...)` (or whatever naming matches the existing `admit-node`/`revoke-node` builders used by `apps/fe/src/node/enrollment.ts:512-537`; check and mirror). Add codec round-trip + verify/apply tests.

### B. Gateway persistence & projection
- Migration + schema: widen `user_key_log_type_check`; new table `user_hub_authorizations (user_id, hub_node_id, status, public_url, priority, admit_seq, retire_seq, updated_seq)` as a replay projection (`user-key-persistence.ts` applies both records; `key-log-store.ts` payload JSON projection covers the new types).
- New module `apps/gateway/src/hub/hub-authorization.ts`: `resolveHubAuthorization(uid, hubNodeId) → 'signed-active' | 'signed-retired' | 'env' | 'self' | 'none'` and `isAuthorizedHub(uid, hubNodeId)` with the merge rule: signed active → true; signed retired → false (overrides env); absent → `self || env TMEX_HUB_PEERS`. The mesh has a single mesh user today — read how `uid` is resolved for the hub (`hub-runtime.ts` / `uplink-server.ts`) and thread it through; if only one user exists, derive it once, do not hard-code.
- Replace every env-only check (`uplink-server.ts` ~1305-1365, `hub-replication.ts` ~50-64, `mesh-runtime.ts` ~698-715, CLI `hub list` `AUTH` column source if it reads the env directly — `packages/app/src/commands/hub.ts`) with the merged resolver. Re-evaluate authorization when a new record is applied (a just-admitted standby must appear in `hubs[]` without restart; a retired one must be dropped from `mesh_hubs` / candidates and, if it is `self`, fence self to standby immediately and stop advertising as writer candidate).
- `HubEndpointInfo` (`packages/shared/src/uplink/codec.ts:273-283`) gains optional `authorization?: 'signed' | 'env' | 'self'` — populated in `GET /api/mesh/hubs` (`apps/gateway/src/mesh/mesh-routes.ts` ~202-223) so the FE knows whether an `admit-hub` is still needed before a role switch. Do not put it on the wire `node.list` (keep the codec unchanged there; if `HubEndpointInfo` is the wire type too, add the field only to the HTTP projection type instead — check).

### C. Compat gate (critical)
Old nodes (< the version that ships this) cannot decode the new record types and would stall their key-log catch-up forever. Therefore the **writer must refuse to append** `admit-hub`/`retire-hub` (both via `key.log.append` on the uplink — `uplink-server.ts` ~901-964 — and via the HTTP keylog route `apps/gateway/src/mesh/auth-routes.ts`) while any non-revoked node in `nodes` has a last-reported version `< MIN_HUB_AUTH_RECORD_VERSION` (constant `'1.1.13'`, exported from the shared package) or an unknown/null version. Error: HTTP 409 `{ code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES', minVersion, nodes: [{ id, name, version }] }` (also as an uplink append error code). Allow override with header `X-Tmex-Force-Keylog: 1` only for the HTTP route (the FE will expose a checkbox later); log a warning when forced. Unit-test the gate.

### D. CLI (`packages/app/src/commands/hub.ts`)
- `tmex hub list`: `AUTH` column shows `signed` / `env` / `self` / `no`.
- `tmex hub allow/disallow` keep working (env fallback) but print a note that signed authorization takes precedence and is managed from the UI.
- `tmex hub standby` keeps auto-adding the writer to env (bootstrap for a standby that has not yet replicated).

### E. Docs
Update `docs/hub/2026090104-multi-hub-standby.md` §「授权 allowlist」 and 「已知限制」 to describe signed authorization, the merge rule, the compat gate and the env fallback.

### F. Tests & baselines
`packages/shared`: `bun test` (413 pass baseline) and `bunx tsc --noEmit -p .` 0. `apps/gateway`: full `bun test` green (≈3346 baseline; other agents are adding tests in `src/tunnel`, `src/system`, `src/mesh/mesh-routes*` — if one of THEIR tests is red, note it in your report, do not fix it), `bunx tsc --noEmit -p .` 0. `packages/app`: `bun test` 629 green, tsc 1 (pre-existing). Extend `apps/gateway/src/mesh/integration/multi-hub-harness.ts` / `multi-hub.integration.test.ts` with: admit via record → standby appears in `hubs[]` without env; retire → dropped + self-fence; gate blocks with an old-version node present.

## Scope — files you may edit
`packages/shared/src/auth/**`, `packages/shared/src/uplink/codec.ts` (HubEndpointInfo type only, if needed), `packages/shared/src/index.ts` (exports), `apps/gateway/src/auth/**`, `apps/gateway/src/db/schema.ts`, `apps/gateway/src/db/managed-migrations.ts` (+ drizzle migration files where the project keeps them — read how migrations are added), `apps/gateway/src/hub/**`, `apps/gateway/src/mesh/mesh-runtime.ts`, `apps/gateway/src/mesh/auth-routes.ts`, `apps/gateway/src/mesh/mesh-routes.ts` (only the `/api/mesh/hubs` projection — another agent G1 is editing the `/api/mesh/nodes*` parts of this file right now; make your edit surgical and re-read the file immediately before editing), `apps/gateway/src/mesh/integration/**`, `packages/app/src/commands/hub.ts` (+ its tests), `docs/hub/2026090104-multi-hub-standby.md`. Do NOT touch `apps/gateway/src/tunnel/**`, `apps/gateway/src/api/system*`, `apps/gateway/src/system/**`, `apps/fe/**`, `packages/api-client/**`.
