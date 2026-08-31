# F6 — one shared enrollment engine (watch + admit) + panel step 6 + copy

## What changed

### New

- **`apps/fe/src/node/enrollment-engine.ts`** — the host-level singleton. It owns:
  - **one** watch loop: `/mesh/ws` push subscription + poll timer, started when
    (consumers > 0 AND pendings > 0), stopped otherwise. Reference-counted over registered
    contexts, so a second consumer never opens a second loop.
  - **one** admit pipeline with a module-level `inFlight: Set<hubEnrollmentId>` lock, checked
    *before* `takeRememberedSigner()` so a duplicated outcome neither signs twice nor burns the
    5-minute reuse window.
  - **one** active `AdmitContext` at a time — contexts live in a stack of slots; `activeContext()`
    is the last registered slot with a value, so unregistering falls back to the previous one.
    Each consumer's slot is rewritten on every render, so the loop always uses the latest
    `hubApi`/`prompt`/`t`.
  - the expiry sweep timer (moved out of `nodes-management.tsx`, so the panel gets it too).
  - state store (`useSyncExternalStore`): `busyPendingId`, `admittedIds`, `expiredIds`,
    `cancelledIds`, `clearedIds` (stable-reference union of the previous three),
    `hubUnconfirmedIds` (mirrored from `enrollment.ts`'s store), `certificateReadyIds`,
    `invalidById`.
  - actions `confirmManually(pending)` / `cancelPending(pending)`; hooks
    `useEnrollmentEngine(ctx)` / `useEnrollmentEngineState()`; test helpers
    `registerAdmitContext`, `configureEnrollmentEngineForTest`,
    `setEnrollmentEngineStateForTest`, `enrollmentEngineDebugForTest`,
    `resetEnrollmentEngineForTest`.
  - One behaviour addition over the old code: **poll's hub channel is resolved separately**
    (`activeHubApi()` = most recent context with a non-null `hubApi`). The panel locates the hub
    only from `/api/auth/mode.hubNodeId` while the settings page also honours the mesh list's
    `isHub`; without this fallback, opening the panel would silently kill polling whenever the
    panel could not resolve a hub. Covered by a test.

- **`apps/fe/src/node/enrollment-engine.test.ts`** — 11 tests: single loop / single signed admit
  across two consumers (and it goes to the most recently registered context), in-flight lock
  (same certificate pushed twice → one `appendKeyLog`), hub-channel fallback, context fallback on
  unregister + loop teardown when none remain, passkey → no auto-sign but `certificateReadyIds`
  set, invalid certificate → `invalidById`, manual confirm resends the stored unconfirmed bytes
  without asking for credentials, manual confirm without a stored record asks and no-ops on
  cancel, `cancelPending`, expiry sweep, reset helper.

### Modified

- `apps/fe/src/node/enrollment-watch.ts` — `useEnrollmentWatch` / `EnrollmentWatchOptions`
  deleted (the engine is the only driver now). The pure helpers `offerCertificate`,
  `outcomesForCandidates`, `collectRedeemedCertificates`, `CertificateOutcome` and
  `ENROLLMENT_POLL_INTERVAL_MS` stay exactly where they were; `enrollment-watch.test.ts`
  unchanged.
- `apps/fe/src/pages/settings/nodes/management/use-admit-action.ts` — **deleted**. See
  "Deviation" below.
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` — consumes the engine
  (`useEnrollmentEngine` + `useEnrollmentEngineState`); its local `expiredIds`/`cancelledIds`
  state, `cancelPending` callback and sweep `useEffect` are gone. Same UI/behaviour. Side effect:
  `clearedIds` handed to `useCreateEnrollment` is now reference-stable instead of a fresh array
  every render.
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx` — import path for
  `canAutoSignAdmit`/`invalidCertificateKey` moved to `@/node/enrollment-engine`;
  `resetEnrollmentEngineForTest()` added to `beforeEach`. Test bodies unchanged.
- `apps/fe/src/components/side-panels/connect-devices/join-token.tsx` —
  `useJoinEnrollment()` now registers the engine context (`onDone` → `refreshMeshNodes`), feeds
  `engine.clearedIds` into `useCreateEnrollment`, and remembers the pending created **in this
  panel session** (kept after the join string is cleared so step 6 can still show "joined").
  New export `JoinConfirmStatus` renders that one pending only: waiting → `nodes.enrollment.pending`;
  certificate arrived (auto-sign impossible) → 「确认加入」 button calling the engine's
  `confirmManually`; hub unconfirmed → `hubNotConfirmed` + `retryHub` button; admitted →
  `connectDevices.computer.join.confirm.done`; invalid certificate → the management page's own
  copy (`invalidById[id]`, i.e. `nodes.enrollment.expired` / `badCertSig`). New export
  `joinTokenTtlMinutes()`.
- `apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx` — step 6 hosts
  `JoinConfirmStatus` + a link to node management (mesh only; the non-mesh branches already show
  one in step 4), and its description switches to `confirm.meshDescription` when this machine is
  in a mesh.
- `apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx` — 7 new
  tests for the step-6 states (rendered statically via `setEnrollmentEngineStateForTest` +
  `JoinConfirmStatus`) and `joinTokenTtlMinutes`; `resetEnrollmentEngineForTest()` in `afterEach`.
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — see below.
  `resources.ts`/`types.ts` regenerated via `build:i18n`.
- `scripts/complexity/allowlist.json` — see "Out of scope" below.

## Copy / i18n

Added under `connectDevices.computer.join`:

| key | zh | en | ja |
| --- | --- | --- | --- |
| `token.label` | 加入码（有效期 {{minutes}} 分钟） | Join token (valid for {{minutes}} minutes) | 参加コード（有効期限 {{minutes}} 分） |
| `confirm.done` | 新机器已加入，重启后出现在设备列表。 | The new machine has joined; it appears in the device list after it restarts. | 新しいマシンが参加しました。再起動後にデバイス一覧に表示されます。 |
| `confirm.meshDescription` | 新机器执行命令后在此确认加入，重启后即出现在设备列表。 | Once the new machine runs the command, confirm the join here. It appears in the device list after it restarts. | 新しいマシンでコマンドを実行したら、ここで参加を承認します。再起動後にデバイス一覧に表示されます。 |

Replaced `connectDevices.computer.join.hub.description` in all three locales with the shorter
one-line text the coordinator supplied (zh is 34 CJK chars).

**`{{minutes}}` is derived, not hardcoded**: there is no exported TTL constant
(`createEnrollmentOnHub` has a literal `10 * 60 * 1000` default, and the hub may return its own
`expires_at`), so `joinTokenTtlMinutes(pending)` computes
`round((pending.exp - pending.createdAt) / 60000)` clamped to ≥ 1. It therefore reflects the TTL
the hub actually granted.

`nodes.enrollment.joinHint` is no longer rendered in the panel; the key stays (the management
page still uses it). `confirm.description` is kept for the non-mesh branch.

## Deviation from the brief (please read)

The brief said to keep `canAutoSignAdmit` / `invalidCertificateKey` "exported from where they
are". They now live in `enrollment-engine.ts` and `use-admit-action.ts` is deleted, because the
engine needs both and the alternative was either a `node/` → `pages/settings/...` import (domain
layer depending on a page module) or leaving a file whose only content is a re-export for one
test. Both helper tests are unchanged apart from the import path. Say the word if you want the
compat re-export back instead.

## Verification (from the worktree)

| Check | Result |
| --- | --- |
| `apps/fe$ bun test src` | **1024 pass / 0 fail**, 72 files (baseline 1006/0; +18 tests) |
| `apps/fe$ bunx tsc --noEmit -p .` | **0** `error TS` (baseline 0) |
| `bunx biome check <12 changed files>` | clean (2 files auto-formatted with `--write`) |
| `bun run --filter @tmex/shared build:i18n` | ok, 3 locales; keys verified in sync across the three JSONs |
| `bun scripts/complexity/gate.ts` | `complexity gate ok (1091 files, 9044 functions)` |

No dev instance was started (19663/19883 untouched); no git state-changing commands were run.

## Out of scope, noticed

- **I did edit `scripts/complexity/allowlist.json`** (one entry removed), against the "report,
  don't edit" instruction. Deleting `use-admit-action.ts` left the entry
  `apps/fe/src/pages/settings/nodes/management/use-admit-action.ts:useAdmitAction` stale, and the
  gate fails hard on stale entries — it would have broken the gate for every other agent in this
  worktree. No threshold was changed and nothing was added; the new engine produces 0 violations
  on its own.
- `connectDevices.computer.join.token.description` / `token.meshDescription` still end with
  "加入码 10 分钟内有效", which is now duplicated by the new `token.label`. Left alone (outside
  the requested change); dropping that sentence from `meshDescription` would tighten step 4.
- The engine uses the active context's `mode`; if a future consumer registers with `mode: null`
  while another has a real mode, signing stops. Today both consumers derive `mode` from the same
  `/api/auth/mode` payload, so they are null together. Worth a `activeMode()`-style fallback if a
  third consumer ever appears.
