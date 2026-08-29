You are a senior backend engineer working in the tmex monorepo at the current directory (Bun runtime, `export PATH=$HOME/.bun/bin:$PATH`; code is NOT Node-compatible). Several other agents are editing FRONTEND files in this same worktree concurrently. You may ONLY edit files under `packages/app/src/`, `apps/gateway/src/` (auth/db/hub/mesh layers), and `packages/api-client/src/local/`. Do NOT touch apps/fe, packages/ui, packages/theme, packages/stores, packages/panels, locale JSON files. Do NOT run any git command (no add/commit/stash/checkout/reset). Never touch the machine's production tmex (~/Library/Application Support/tmex, port 9883) or the tmux session named `tmex`; tests must use temp dirs / in-memory DBs like the existing tests do.

## Task: "leave hub" local membership reset API + CLI reuse

Read `prompt-archives/2026082901-nodes-settings-devices-polish/sub/api-contract.md` (the contract you must implement) and `prompt-archives/2026082901-nodes-settings-devices-polish/sub/explore-local-role.md` (a precise map of the role/hub-address model, all local state tied to a hub, existing cleanup helpers, restart mechanics — use its file:line anchors, but verify against the code).

Implement:
1. A reusable service function (e.g. `packages/app/src/runtime/membership-reset.ts` or inside `setup-service.ts`) `leaveMesh({ expectedRole })` that, under the existing setup transition lock (`withSetupTransition` in `packages/app/src/runtime/setup-service.ts`):
   - validates current role is a mesh role and equals `expectedRole`;
   - quiesces uplink/hub runtime best-effort (do not crash if absent);
   - in ONE sqlite transaction deletes: all `users` and derived rows (`user_key_log`, `user_keys`, `node_sessions`, `node_certs` — reuse the existing derived-state deletion helper in `apps/gateway/src/auth/user-key-service.ts` ~1107-1119 if usable, else write a dedicated `MeshMembershipStore.clearAll()` in apps/gateway/src/auth/), `nodes`, `enrollment_tokens`, `peer_cache` (`UserStore.deleteAllPeers()` exists), `hub_trust` (all rows), and the `node_identity` row (`NodeIdentityStore.clear()` exists) so a fresh identity is generated on next start;
   - writes env via the same env writer used by `joinHub()`/`becomeHub()`: `TMEX_ROLES=standalone`, `TMEX_HUB_URL=`, `TMEX_HUB_PUBLIC_URL=` (empty values; confirm how the env writer represents empty — must not leave stale values);
   - schedules the same 300 ms restart used by setup endpoints.
2. Route `POST /api/local/leave` in `packages/app/src/runtime/local-routes.ts` with the auth rules from the contract (standalone → 400 `not_member`; mesh → same self-session guard as `/api/local/direct`). Error mapping exactly per contract.
3. CLI `hub leave` (`packages/app/src/commands/hub.ts` ~794-807) must call the same reset function instead of its partial cleanup (keep its CLI UX/messages; update `join.test.ts` expectations that asserted the local user survives `hub leave` — the new behaviour is a full membership reset, adjust the test to assert that).
4. `joinHub()` (setup-service ~648-718) and CLI join must also clear `TMEX_HUB_PUBLIC_URL` when the resulting role is `node`.
5. `packages/api-client/src/local/`: add `LocalLeaveRequest`/`LocalLeaveResponse` types, a `leave(body)` method on the local API object next to `setDirect`, and complete `LocalTlsStatus` with `listenerRunning: boolean; tlsPort: number | null`. Export them from the package's index if other local types are exported there.
6. Tests (bun test, same style as the neighbouring tests): unit/integration test for the reset function (seed users/nodes/peer_cache/hub_trust/node_identity, call leave, assert tables empty + env written + role validation errors), route test for `/api/local/leave` (standalone 400, mesh unauthenticated 401, happy path). Also update `setup-routes`/`local-routes` tests if they enumerate routes.

Verification before you finish (report exact numbers):
- `cd packages/app && bun test` — baseline 396 pass / 0 fail; `bunx tsc --noEmit -p .` — baseline 1 error (pre-existing; do not increase).
- `cd apps/gateway && bun test` — baseline 2453 pass / 0 fail; `bunx tsc --noEmit -p .` — baseline 21 errors (pre-existing).
- `cd packages/api-client && bun test` — baseline 128 / 0; tsc baseline 5 errors.
- `bunx biome check <each file you changed>` from the repo root and fix what it reports (never lint generated files).
- macOS has no `timeout` command; bun test summary lines contain ANSI colour codes.

Final output: write a concise English report to `prompt-archives/2026082901-nodes-settings-devices-polish/sub/b1-result.md` — files changed, exact API behaviour, anything you deviated from in the contract and why, test/tsc numbers. Do not leave TODOs or partial implementations.
