# API contract: local membership leave (batch 1)

## `POST /api/local/leave`
Registered next to `POST /api/local/direct` in `packages/app/src/runtime/local-routes.ts`.
Auth: standalone → 400 `not_member` (nothing to leave). mesh (`node` / `hub,node`) → requires the same self-session auth as `/api/local/direct`.
Request body: `{ "expectedRole": "node" | "hub,node" }` (must match current role, else 409 `role_mismatch`).
Behaviour (inside the existing setup transition lock; 409 `setup_in_progress` if busy):
1. Stop/quiesce the uplink client and hub runtime if present (best effort).
2. In ONE DB transaction delete all mesh membership state: `users` + all derived rows (`user_key_log`, `user_keys`, `node_sessions`, `node_certs`), `nodes`, `enrollment_tokens`, `peer_cache`, `hub_trust`, and the `node_identity` row (a fresh identity is generated on next start by `ensureNodeIdentity()`).
3. Write env: `TMEX_ROLES=standalone`, `TMEX_HUB_URL=`, `TMEX_HUB_PUBLIC_URL=` (merge with existing env, same writer used by join/becomeHub).
4. Schedule the standard 300 ms restart (same as setup endpoints).
Response 200: `{ "ok": true, "fromRole": "node" | "hub,node", "restarting": true }`
Errors: `{ "error": "not_member" | "role_mismatch" | "setup_in_progress" | "env_write_failed" | "unauthorized" }` with appropriate status.

## api-client
`packages/api-client/src/local/`: add `LocalLeaveRequest`, `LocalLeaveResponse` types and a `leave(body)` method on the same local API object that exposes `setDirect`. Also complete `LocalTlsStatus` with `listenerRunning: boolean; tlsPort: number | null`.

## Frontend usage (f2)
- Role select: target standalone → confirm dialog → `leave` → `waitForRestart` → reload to `/settings?tab=nodes`.
- Target other mesh role from a mesh role → write `sessionStorage['tmex.setup.intent'] = 'become-hub' | 'join-hub'` → same leave flow → after reload the standalone wizard opens that path (`HubSetupWizard.initialPath`) and clears the marker.
- "Change hub" on a node → intent `join-hub` (optionally prefill hub URL from a `tmex.setup.hubUrl` sessionStorage marker) → best-effort self revoke on old hub (existing revoke signing flow, allow self) → leave.
