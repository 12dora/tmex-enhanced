# G3 — Notification sink declaration moved to a user-signed key-log record

## What was built

The multi-node notification sink was declared by the node itself (`inventory.notifySink` on
`node.status`), so any compromised node could self-declare as a sink and receive every other
node's events (pane titles, watch matches). The declaration is now a **user-signed key-log
record** (`notification-sink`), replicated like every other key-log record; the inventory flag is
gone and is never read again.

### Record (`packages/shared/src/auth/notification-sink-record.ts`)

```
type    = notification-sink
payload = Borsh { node_id: bytes(16), enabled: bool, at: u64 }
signer  = root | passkey        (KEY_LOG_SIGNER_MATRIX)
```

- `applyNotificationSink` projects into a new `UserKeyState.notificationSinks` map
  (`nodeId hex → enabled`), mirroring `nodeNames` from `rename-node`: latest record wins,
  unknown node → `unknown_node`, bad payload → `malformed_payload`, cleared by `reset-root`.
- Version gate registered in `KEYLOG_RECORD_COMPAT`:
  `MIN_NOTIFICATION_SINK_RECORD_VERSION = '1.1.39'`, `allowForce: false` — the existing
  hub/relay append gate (`inspectHubAuthRecordCompat`) refuses the write with
  `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` while any non-revoked node is older.

### Gateway

- `mesh/notification-sink-records.ts` (new): replays `type='notification-sink'` rows from the
  local `user_key_log` by ascending `seq` into `Map<nodeId, enabled>` — no new table, no cache
  (a handful of rows; caching would have to track key-log sync/join/reset invalidation).
- `mesh/notification-sink-set.ts`: `collectMeshNotificationSinks` now takes `declared:
  ReadonlySet<string>` and no inventory at all; `peer_cache` / `user_nodes` / `node.list` are
  only used for display name + online state. Self is a sink only when **record AND local switch**
  are both on.
- `mesh/notification-bridge-wiring.ts`: new `userIdOf` input, new bridge method
  `selfSinkEnabled()` = local kv && own declaration.
- `mesh/mesh-internal-notifications-routes.ts`: default `sinkEnabled` is now
  `bridge.selfSinkEnabled()` (was local kv only) → 404 when the user never signed the
  declaration. Origin forgery was already blocked (`origin.nodeId` must equal the verified peer
  marker → 400); kept and covered by tests.
- `mesh/mesh-runtime.ts`: `inventory` is back to `{ version }`; the now-dead
  `advertise()` plumbing (status replay on toggle) was removed from the bridge, wiring, runtime
  and the PUT route.
- `api/notifications-mesh-routes.ts`: `MeshNotificationState` gained `selfNodeId` (the browser
  needs it to write the record's payload); PUT no longer replays mesh status.
- `auth/key-log-store.ts`: `projectPayloadJson` decodes the new type.
- DB: `user_key_log` type CHECK extended → migration **`0052_notification_sink_keylog.sql`**
  (+ journal entry idx 52, + one line in `managed-migrations.ts`). G1's 0051 was left untouched.

### Frontend

- `node/notification-sink.ts` (new): `setNotificationSinkViaKeyLog` — head → sign → `POST
  /api/auth/keylog?hub=sync`, inside the key-log write lock (copy of the `rename-node` path).
- `pages/settings/notifications/mesh-sink-toggle.ts` (new): `submitMeshSinkToggle` signs the
  record **first**, only then PUTs the local switch; user cancel → `null` (nothing changes, no
  error); rejection → `MeshSinkError` with localized text (version gate gets its own sentence).
- `pages/settings/notifications/use-mesh-sink-toggle.ts` (new): `useCredentialPrompt` +
  `usePasskeys` + `useSharedAuthMode`, same shape as `use-node-rename-channel`; passkey-only
  users go through the identical dialog. New purpose `notifySink` in `CredentialPurpose`.
- `mesh-notification-card.tsx`: mutation now goes through the hook and renders `toggle.dialog`.
- `mesh-api.ts`: `toState` now carries `selfNodeId` through (see "bug found" below).
- i18n (zh source + en/ja + `build:i18n`): `settings.notifications.mesh.nodesTooOld`,
  `settings.notifications.mesh.unavailable`, `auth.credential.purpose.notifySink`.

### Docs

`docs/notify/2026090603-mesh-notification-sink.md` rewritten where it described the inventory
broadcast: new "汇聚声明（用户签名记录）" section (record shape, replay rule, the 3-step browser
flow, record-vs-local-switch table), updated sink-side 404 criterion, API table, security
boundary (the old "compromised hub can forge `notifySink`" trade-off is now closed), a new
"兼容性" section and a note about record/switch divergence.

## Compatibility (asked for explicitly)

Old nodes **reject unknown record types**: `KeyLogType` is a Borsh `nativeEnum`, so
`decodeKeyLogRecord` throws, and `user_key_log` additionally has a type CHECK constraint — an
unknown record would wedge that node's key-log sync at that seq. So the record is gated behind
the existing mesh-wide version check (1.1.39, no force). Old nodes keep publishing
`inventory.notifySink`; new nodes ignore it, so in a mixed-version mesh an old sink simply stops
receiving forwarded events until the whole mesh is upgraded and the user flips the switch once.

## Deviation the commander must confirm

**`packages/app/package.json` bumped 1.1.38 → 1.1.39.** The version gate must name the first
release that understands the record; the repo bumps the version at the *start* of a sub-round
(precedent: `8c66f5f9` bumped to 1.1.26 before the `readmit-node` commit `84f253eb`, which gated
on 1.1.26). Without the bump the gate blocks every write in dev/e2e/production, so the required
mesh e2e could not pass. If this round ships as something other than 1.1.39, change
`MIN_NOTIFICATION_SINK_RECORD_VERSION` (`packages/shared/src/auth/key-log-compat.ts`), the
`packages/app/package.json` version and `packages/shared/src/auth/notification-sink-record.test.ts`
together. CHANGELOG was not touched (release step owns it).

Two smaller deviations: (1) `key-log.ts` would have exceeded its allowlisted line ceiling, so the
version-gate table was extracted to `packages/shared/src/auth/key-log-compat.ts` and re-exported
from `key-log.ts` (allowlist ratcheted 717 → 701, "只降不升"); (2) the dead `advertise()` bridge
method was removed rather than left as a no-op.

## Bug found while running the e2e

`mesh-api.ts`'s `toState()` rebuilds the state object field by field and silently dropped
`selfNodeId`, so the toggle failed with "cannot save" and never opened the credential dialog.
Fixed, with a regression test (`mesh-api.test.ts`).

## Tests

New: `packages/shared/src/auth/notification-sink-record.test.ts` (7),
`apps/gateway/src/mesh/notification-sink-records.test.ts` (3),
3 default-deps cases in `mesh-internal-notifications-routes.test.ts` (signed declaration + local
switch required; no bridge → 404), rewritten `notification-sink-set.test.ts` (8, inventory cases
replaced by declaration cases), `apps/fe/src/node/notification-sink.test.ts` (5),
`apps/fe/src/pages/settings/notifications/mesh-sink-toggle.test.ts` (7),
`mesh-api.test.ts` (3).

| Suite | Result |
| --- | --- |
| `bunx tsc` shared / gateway / fe / api-client | 0 errors from my files (gateway still reports 2 pre-existing errors in G2's `src/system/upgrade*.ts`) |
| `packages/shared` `bun test src/auth src/contracts` | 167 pass / 0 fail |
| `packages/shared` full | 1 fail — `src/index.test.ts` export snapshot, caused by G2's 10 new release-signing exports (my only edit there was deleting `MESH_NOTIFY_SINK_INVENTORY_KEY`; G2 must add their names) |
| `apps/gateway` full | 5123 pass / 13 fail — 10 are the documented baseline (9 mesh phase-2 + 1 flaky 8 MiB DataChannel), the other 3 are G2's upgrade work (`mesh upgrade routes` ×2, `system/info upgradeCapabilities` staged-package-resume) |
| `apps/fe` `bun test src/` | 2868 pass / 0 fail |
| `packages/app` | 982 pass / 0 fail (version bump has no test impact) |
| mesh e2e `--project mesh --grep notify` | **3 passed** (fills the credential dialog with the account password; the record replicates to node B, B forwards, the toast on the hub page names node B) |
| `bunx biome check` on touched dirs | clean (remaining offenders are G2's `system/upgrade-manifest.ts`, `api/system.test.ts`, `mesh/mesh-routes.test.ts`) |
| `bun scripts/complexity/gate.ts` | my files clean; 2 remaining violations are G2's `release-download.ts` / `upgrade.ts` |

Note: the mesh e2e serves the prebuilt `apps/fe/dist`, so `bun run build` in `apps/fe` is
required before running it (dist is gitignored).

## Files touched

New: `packages/shared/src/auth/notification-sink-record.ts` (+test),
`packages/shared/src/auth/key-log-compat.ts`,
`apps/gateway/src/mesh/notification-sink-records.ts` (+test),
`apps/gateway/drizzle/0052_notification_sink_keylog.sql`,
`apps/fe/src/node/notification-sink.ts` (+test),
`apps/fe/src/pages/settings/notifications/{mesh-sink-toggle.ts,use-mesh-sink-toggle.ts,mesh-sink-toggle.test.ts,mesh-api.test.ts}`.

Modified: `packages/shared/src/auth/{encoding.ts,key-log.ts,index.ts}`,
`packages/shared/src/contracts/mesh-notifications.ts`, `packages/shared/src/index.test.ts`
(one deleted line), the three locale JSONs + generated i18n,
`apps/gateway/src/mesh/{notification-sink-set.ts,notification-sink-state.ts,notification-bridge-wiring.ts,notification-mesh-bridge.ts,mesh-internal-notifications-routes.ts,mesh-runtime.ts}`,
`apps/gateway/src/api/notifications-mesh-routes.ts`, `apps/gateway/src/auth/key-log-store.ts`,
`apps/gateway/src/db/{schema/users-auth.ts,managed-migrations.ts}`,
`apps/gateway/drizzle/meta/_journal.json` (appended entry 52 only),
`apps/fe/src/auth/credential-prompt.tsx` (one purpose added),
`apps/fe/src/pages/settings/notifications/{mesh-notification-card.tsx,mesh-api.ts}`,
`apps/fe/tests/mesh-notify.spec.ts`, `scripts/complexity/allowlist.json` (one number),
`packages/app/package.json` (version), `docs/notify/2026090603-mesh-notification-sink.md`.
Test-only stub updates: `apps/gateway/src/events/channels/mesh-forward.test.ts`,
`apps/gateway/src/api/notifications-mesh-routes.test.ts`.

---

# Review follow-up (R1-pane-grant-sink-review findings 4, 5, 6)

Findings 1–3 and 7 are pane-grant (G1); untouched here.

## 4 — Version gate now fails closed for members whose version is unknown

`failClosedUncached` moved into the compatibility **specification** instead of another type list:
`KeyLogRecordCompatSpec` gained the optional flag, set on `notification-sink` and
`readmit-node`; `inspectHubAuthRecordCompat` now reads `spec.failClosedUncached` and the
`READMIT_NODE_RECORD_TYPES` / `NOTIFICATION_SINK_RECORD_TYPES` lists were deleted (dead once the
policy lives in the spec).

Tests: `apps/gateway/src/auth/notification-sink-compat.test.ts` — hub-mode block, **relay mode
with a cached up-to-date peer plus an uncached admitted member → blocked** (this is the case the
reviewer reproduced), relay mode all-cached → allowed, and a control case showing `rename-node`
still skips uncached members. `packages/shared/src/auth/key-log.test.ts` /
`notification-sink-record.test.ts` assert the spec shape.

## 5 — Delivery rechecks signed membership; revoked sinks lose their queue

- `MeshNotificationBridge.sinkAuthorized(nodeId)` (declared set, self excluded) is now consulted
  by the forwarder before **every** attempt (first try and each retry) — `drain()` calls it
  before dequeuing — and by `bridge.deliver()` itself, which returns a synthetic 403 without
  going on the wire, so no caller can bypass it.
- On revocation the lane is dropped via `forget(id, 'unauthorized')`: queue entries are discarded
  with `reason=unauthorized` (counted + logged), the retry timer is cleared and the in-flight
  request is aborted. `MeshForwardQueue.discard(reason)` was added for the counted discard, and
  the forwarder keeps a `retiredDropped` total so removed lanes still show in the UI's dropped
  count. `enqueue` also refuses unauthorized sinks.
- Removal is now driven by the key log, not only by the next retry: `bindKeyLogProjection` calls
  `meshForwardChannel.pruneUnauthorizedSinks()` when a `notification-sink` record is applied.
- `buildMeshNotificationBridge` takes `declaredSinks: () => ReadonlySet<string>` (mesh-runtime
  passes `listNotificationSinkNodeIds(userIdOf())`), so the wiring is testable without a DB.

Tests: `apps/gateway/src/events/mesh-forwarder.test.ts` — revocation between the failed first
attempt and the retry stops delivery, discards the lane, logs `reason=unauthorized`, counts the
drop, and refuses re-enqueue; `pruneUnauthorized()` aborts an in-flight attempt.
`apps/gateway/src/mesh/notification-bridge-wiring.test.ts` — `deliver` returns 403 and does not
call `forwardInternalHttp` once the declaration is gone.

## 6 — Passkey counter advances once, atomically with the accepted record

- `apps/gateway/src/auth/passkey.ts`: verification core split out;
  `makeDeferredVerifyPasskeyAssertion(userStore)` verifies **without** writing the counter and
  accumulates the highest counter per credential; `commitPasskeyCounters` applies them.
  `makeVerifyPasskeyAssertion` (login, relay enroll, delegation) keeps its immediate write.
- `previewKeyLog` (the `hub=sync` preview) now uses the deferred verifier and never commits, so
  the preview is side-effect-free.
- `UserKeyService` takes `deferredPasskeyVerifier` (mesh-runtime supplies it); the counters ride
  on `AppliedKeyLogStep.passkeyCounters` and are written by `persistApplied` **inside the record's
  transaction** — one commit, rolled back with the record if it is not persisted. This covers the
  inner `admit-node`/`readmit-node` authorization assertions too, which a
  parse-the-signature-at-persist-time shortcut would have missed.
- `apps/gateway/src/auth/index.ts` re-exports the new helpers (a missing barrel export showed up
  as 13 runtime load errors before it was added).

Tests: `apps/gateway/src/mesh/auth-key-log-passkey-counter.test.ts` — full route regression with
a synthetic counter-incrementing ES256 authenticator: a passkey-signed `rename-node` submitted
through `POST /api/auth/keylog?hub=sync` returns 200, the record lands, the stored counter moves
exactly one step, and a second record with the next counter still works; a replayed/rewound
counter is rejected 400 with no head movement and no counter write. Verified the test reproduces
the reported defect: restoring the committing verifier in the preview turns the first case into
400. `apps/gateway/src/auth/passkey.test.ts` adds a unit test that the deferred verifier accepts
the same assertion twice before commit, writes nothing until `commitPasskeyCounters`, and rejects
it after.

## Housekeeping

`user-key-service.ts` would have exceeded its allowlisted ceiling, so its local `bytesEqual` copy
was replaced with the shared `@tmex/shared/auth` one (net −13 lines); allowlist ratcheted
867 → 865.

## Gates after the follow-up

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` shared / gateway / fe / api-client | 0 errors (all four) |
| gateway `bun test src/auth src/mesh src/events` | 1660 pass / 0 fail |
| gateway full `bun test` | 5191 pass / 10 fail — exactly the documented baseline (9 `mesh phase-2 integration` + 1 flaky 8 MiB DataChannel); the 3 upgrade-route failures seen earlier are gone |
| `packages/shared` full | 851 pass / 0 fail (the index export snapshot G2 broke earlier is green again) |
| `apps/fe` `bun test src/` | 2868 pass / 0 fail |
| mesh e2e `--project mesh --grep notify` | 3 passed (one earlier run's *setup* timed out only because the gateway suite was running concurrently; alone it boots in 4.5 s) |
| `bunx biome check` (gateway/shared/fe src) | clean |
| `bun scripts/complexity/gate.ts` | ok |

Docs: `docs/notify/2026090603-mesh-notification-sink.md` updated with the per-delivery recheck,
the `pruneUnauthorizedSinks` trigger, the fail-closed version gate, and the send-side revocation
guarantee.
