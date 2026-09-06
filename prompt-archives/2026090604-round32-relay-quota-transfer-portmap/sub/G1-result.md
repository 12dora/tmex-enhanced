# G1 — Remote agent pane grant (plan-03)

Closes the hole where `/api/mesh-internal/tmux/{send-input,capture,pane-info}` was authorised by the
peer marker alone, so any admitted mesh node could inject keystrokes into / read any pane of any other
node. Implemented per `plan-03-pane-grant.md` with no design deviation of substance.

## What was built

### Target side (node Y)
- Migration **0051** `agent_pane_grants` table + `agent_sessions.remote_grant` column
  (`apps/gateway/drizzle/0051_agent_pane_grants.sql`, appended to `drizzle/meta/_journal.json`
  and `src/db/managed-migrations.ts`; schema in `src/db/schema/agent.ts`).
- `src/agent/pane-grant/store.ts` — issue / verify / revoke / sweep. Token returned once, SHA-256
  hash stored, constant-time compare; sliding expiry 7 d per use, hard cap 30 d from issue; expired
  rows deleted on touch; 6 h sweep timer (skipped under `NODE_ENV=test`) plus a sweep on every issue.
- `src/agent/pane-grant/routes.ts` — `POST /api/agent/pane-grants` (node-session auth; body
  `{fromNodeId?, deviceId, paneId}` → `{grantId, token, expiresAt}`; validates device exists and
  pane id format) and `DELETE /api/agent/pane-grants/:id`. Registered via `src/api/agent.ts`
  (one line — no edit to the shared `src/api/index.ts`).
  **Hardening beyond the plan:** when the request arrives over mesh the grant is bound to the peer
  marker, and a body `fromNodeId` that disagrees is rejected — a forwarding node cannot mint a grant
  naming a third node. Body `fromNodeId` is required 32-hex on the direct-browser path.
- `src/agent/pane-grant/rpc-guard.ts` — the gate; `src/agent/pane-grant/revoke.ts` — hook called from
  `mesh-runtime.ts` `emitNodeEvent` on `revoked` (drops every grant of that node).
- `src/mesh/mesh-internal-tmux-routes.ts` gains one `verifyGrant` dep and one call inside
  `readRequiredIds`, so all three routes are gated (file 231 lines, well under the gate). Order is
  args → device → grant, so a grant failure never leaks whether another pane exists.
  403 codes: `PANE_GRANT_REQUIRED` (missing) / `PANE_GRANT_INVALID` (everything else — token, peer,
  device, pane, expiry — deliberately not distinguished).

### Initiator side (node X)
- `MeshAgentBridge` now carries `selfNodeId` and `forwardAuthorizedHttp` (wired from
  `mesh-runtime.ts` to `http.forwarder.forwardAuthorizedHttp`, mirroring `forwardInternalHttp`).
- `src/agent/pane-grant/client.ts` — mints via `forwardAuthorizedHttp` with the incoming browser
  request, encrypts the grant with the master key (`src/crypto`) into `agent_sessions.remote_grant`,
  decrypt cache keyed by ciphertext, stale-marking, and `ensureSessionGrant()`.
- `src/api/agent-remote-pane.ts` — remote-pane prep for session creation (online lookup + mint),
  keeps `handleCreateSession` under the complexity gate.
- `RemotePaneRuntime` takes an optional `PaneGrantSource` and sends `grant` on every RPC; on a
  `PANE_GRANT_*` 403 it marks the session stale and retries **once** if a concurrent request already
  minted a fresher grant. `acquireRuntime(nodeId, deviceId, sessionId)` threads the session id
  (`run-deps.ts` → `run-resource-scope.ts` → `run.ts`).
- Re-mint points (all user-authenticated, cookie-bearing): `POST /sessions` (create),
  `POST /sessions/:id/messages`, `POST /sessions/:id/queue`, and `PATCH /sessions/:id` **only when
  the pane actually changed** (a plain rename must not be able to fail with a node-login 401).
  `DELETE /sessions/:id` best-effort revokes the grant on Y.

### Compatibility
- New X → old Y: mint 404 (a `device_not_found` 404 is *not* treated as "old") → proceed with no
  grant; memoised per node for 10 min so old targets are not probed on every message. That memo is
  dropped the moment an RPC comes back `PANE_GRANT_*`, so a target that upgrades mid-window heals on
  the next request instead of waiting out the cache.
- Old X → new Y: rejected (documented as KI-10; self-heals on X's first user action after upgrade).
- Browser has no session for Y: the 401 `{code:NODE_LOGIN_REQUIRED, nodeId}` from
  `forwardAuthorizedHttp` is passed straight through. The existing FE path handles it
  (`api-client` `session-interceptor` → `mesh-nodes` marks that node logged out and prompts login),
  so **no FE change and no new i18n string**.

## Tests
- `src/agent/pane-grant/store.test.ts` (7), `routes.test.ts` (5), `client.test.ts` (12).
- `src/agent/remote-pane-runtime.test.ts` +4 (grant on every RPC, retry-once, no retry on non-grant 403).
- `src/mesh/mesh-internal-tmux-routes.test.ts` +4 against the real ledger (missing / valid / wrong
  peer / wrong pane / expired / forged token); existing cases keep a permissive `verifyGrant` stub.
- `src/mesh/integration/pane-grant.integration.test.ts` (5) — real `LinkMux` + real mesh-internal
  routes + real issue route + `NodeSessionStore`: peer without grant → 403 on all three RPCs;
  browser-path session creation mints and `send-input` succeeds (pane-info during creation also
  passes the gate); grant is bound to the pane; old-target fallback; missing Y session → 401.
- `src/db/agent-pane-grants.migration.test.ts` — 0051 applied to a pre-0051 db.

### Numbers
- `bunx tsc --noEmit -p apps/gateway`: 0 errors in my scope. (27 errors exist in
  `src/system/remote-upgrade-job.test.ts` + `src/test-support/release-signing.ts` — another agent's
  in-flight release-signing work, untouched by me.)
- `bun test src/agent src/api src/mesh src/db`: **2373 pass / 3 fail**; the 3 are the concurrent
  agent's upgrade work (`mesh upgrade routes` ×2, `GET /api/system/info upgradeCapabilities`).
- Full `bun test` (apps/gateway): 5106 pass / 30 fail — 7 mesh phase-2 + 3 DC 8 MiB (known baseline)
  and 20 upgrade/system failures owned by the concurrent agent. Zero pane-grant failures on a stable
  tree (one pane-grant test failed in that run only because the file was being rewritten mid-run;
  it passes in the re-run above and in isolation).
- `bunx biome check` on `apps/gateway/src/{agent,api,mesh,db}` and `docs`: clean.
- `bun scripts/complexity/gate.ts`: my files produce no violation or near-limit entry; the 2 remaining
  violations are `src/system/release-download.ts` and `src/system/upgrade.ts` (other agent).
- `packages/shared` untouched (no contract change — the grant payload is node↔node internal).

## Docs
- `docs/agent/2026090606-remote-pane-grant.md` (威胁 / 设计 / 接口 / 兼容 / 验收).
- `docs/known-issues.md` — **KI-10**: old initiator node against an upgraded target is refused until
  the initiator is upgraded.

## For the commander
- Migration numbering: I took **0051**; the notification agent took 0052. Journal, manifest and the
  guard test are consistent as of this writing — re-check `bun test src/db/managed-migrations.test.ts`
  after merging all branches.
- Rollout order matters: upgrading a *target* node before its *initiator* nodes breaks remote-pane
  agent sessions from those initiators until they are upgraded (KI-10). Upgrade entry nodes first, or
  accept a short window.
- No FE/i18n/contract changes are needed for this feature.

---

# G1 round 2 — review fixes (R1 findings 1, 2, 3, 7)

Findings 4/5/6 belong to G3 and were not touched. No git operations were run.

## 1 (P1) — key-log revocation now invalidates grants and links from the commit path

- `apps/gateway/src/auth/user-key-persistence.ts` — the `revoke-node` projection deletes that node's
  grants **inside the commit transaction** (`deletePaneGrantsForNode(hex, stores.db)`). The projection
  is shared by `commitVerified` (single `apply`) and `commitPrepared` (`applyMany`), so peer key-log
  sync and relay-mode catch-up are covered by construction; a rolled-back commit rolls the deletion
  back with it. `reset-root` and `wipeUserDerivedState` clear all grants the same way (the latter now
  takes the tx db handle — passing the global one broke three existing join/rebuild tests).
- `apps/gateway/src/mesh/key-log-projection.ts` — new `onNodeRevoked` dep: a committed `revoke-node`
  closes the peer link (`peerManager.onRevoked`) and emits the `revoked` node event, wired in
  `mesh-runtime.ts`. Previously nothing closed the link on the sync path. (G3 rewrote this file
  concurrently and dropped my branch once; the new test file guards it.)
- `apps/gateway/src/agent/pane-grant/store.ts` — `verifyPaneGrant` additionally rejects grants whose
  `node_certs.revoked_log_seq` is set and drops that node's remaining grants, so an established link
  that has not been torn down yet still cannot use a grant. A missing cert row is not treated as
  revoked (the link handshake requires a cert; re-admission via `admit-node` clears the flag).
- Tests: `src/auth/pane-grant-revocation.test.ts` (single `apply`, batch `applyMany` with a mixed
  batch, re-bootstrap/genesis `reset-root`), `src/mesh/key-log-projection.test.ts` (link close fires,
  self-revocation and other record types do not), plus store-level revoked-cert coverage.

## 2 (P1) — superseded grants are serialized, re-checked and revoked

- `apps/gateway/src/agent/pane-grant/client.ts`:
  - per-session mint chain (`withSessionLock`) with an in-lock re-check, so concurrent requests mint
    **one** grant instead of several with only one reference kept;
  - `persistSessionGrant` computes the ciphertext first, then re-reads the session and verifies the
    binding is unchanged **with no await between check and write**; a mismatch aborts the write and
    queues the just-minted grant for revocation;
  - a retained revocation queue per node (`enqueueGrantRevocation` / `flushGrantRevocations`,
    inspectable via `pendingGrantRevocations`): ids stay queued until the target answers 200 or 404
    and are retried on the next cookie-bearing request; capped at 64 per node so a permanently
    unreachable target cannot grow it without bound. Session deletion goes through the same queue.
- Tests in `client.test.ts`: concurrent mint issues one grant; the superseded id is queued and later
  DELETEd; a failed revoke stays queued and clears on the next flush; a binding changed under the
  mint is not overwritten; `prepareSessionGrant` writes nothing.

## 3 (P1) — grants are bound to the tmux server generation

Pane ids restart at `%0` after a tmux server restart, so `deviceId + paneId` is not an identity.
Grants now also carry the target's `@tmex-server-epoch` (`ensureStableServerEpoch`, stored in a tmux
global option, stable across gateway restarts and changing exactly on tmux restart).

- migration **0053** `agent_pane_grants.server_epoch` (0051 left untouched; journal, manifest and the
  guard test updated — G3's 0052 sits between them);
- the issue route reads the epoch through an injectable dep and **refuses to sign** without one
  (503 `pane_unavailable`), so a grant that is not bound to a generation never exists; grants with a
  null epoch (rows written by the 0051-era build on this branch) are rejected;
- `mesh-internal-tmux-routes.ts` is now two-phase: binding is verified before tmux is touched (an
  unauthorized peer must not spin up the target's tmux), the generation is compared after the runtime
  is acquired, and a mismatch deletes the grant and returns 403 `PANE_GRANT_INVALID`;
- the initiator re-mints on the next user request like any other `PANE_GRANT_*` failure.
- Tests: store (epoch stored/returned, null epoch rejected), routes (503 when the epoch is
  unavailable), `mesh-internal-tmux-routes.test.ts` (restart → 403 and the grant is gone), and an
  end-to-end integration case (restart breaks send-input, re-mint restores it).

## 7 (P2) — a rejected pane rebind no longer changes the session

`handleUpdateSession` now splits: a PATCH that changes `paneId` on a remote session goes through
`commitPaneRebind`, which mints against the **proposed** pane first (session untouched), then commits
binding + ciphertext in one `updateAgentSessionIfUnchanged` call. A 401 returns with the database
untouched; a concurrent change returns 409 `apiError.agentSessionChanged` and queues the fresh grant
for revocation. The CAS compares `updatedAt` **and** the binding triple — `updatedAt` alone is a
millisecond ISO string and two writes in the same millisecond compare equal (verified: the test only
failed the race with the timestamp-only check).

- New i18n key `apiError.agentSessionChanged` (zh_CN source + en_US + ja_JP, `bun run build:i18n` run).
- Tests: `src/api/agent-pane-rebind.test.ts` (commit + old grant queued, 401 leaves every field and
  `updatedAt` untouched, concurrent rebind → 409 with the new grant queued, plain rename mints nothing).

## Gates (round 2)

- `bunx tsc --noEmit -p apps/gateway`: **0 errors**; `packages/shared`: 0.
- `bun test` in apps/gateway (full): **5199 pass / 10 fail** — exactly the known baseline
  (9 mesh phase-2 + 1 DataChannel 8 MiB); all ten also pass when their files are run in isolation
  (`src/mesh/integration` alone: 92 pass / 0 fail, `mesh.integration.test.ts`: 18/18).
- `bun test src/agent src/api src/db src/auth`: 1060 pass / 0 fail; `src/mesh` alone: 1366 / 0 fail.
- `packages/shared`: 851 pass / 0 fail (i18n locale-consistency included).
- `bunx biome check apps/gateway/src packages/shared/src/i18n/locales`: clean.
- `bun scripts/complexity/gate.ts`: **ok**, no violations.

## Notes for the commander

- Migration order on this branch is now 0051 (pane grants) → 0052 (G3, notification sink) →
  0053 (pane grant server epoch). Journal, `managed-migrations.ts` and the guard test agree.
- `docs/agent/2026090606-remote-pane-grant.md` was updated (generation binding, revocation on commit,
  replacement/serialization, the rebind protocol). KI-10 is unchanged and still accurate.
- Upgrade note unchanged: upgrade initiator nodes before or together with targets.
