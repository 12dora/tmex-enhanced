# F-fix result — frontend review fixes (batch 1–2)

Status: **done**. All nine items implemented. `apps/fe` 453 pass / 0 fail, tsc 0; `packages/shared`
337 pass / 0 fail, tsc 0; `packages/api-client` 128 pass / 0 fail, tsc 5 (unchanged pre-existing).
`bunx biome check` clean on every file I touched.

One item could not be delivered exactly as written — see **Open issues / needed from others §1**
(the `SettingsPage` tab-selection test): `apps/fe` has no DOM test environment, so a click cannot be
simulated and `SettingsPage.tsx` is outside my file scope.

## 1. Blocker — v2 join token accepted by the wizard

- `apps/fe/src/pages/settings/nodes/setup/validation.ts`
  - `TOKEN_PATTERN` (`/^[A-Za-z0-9_-]+$/`, any length, no dot) replaced by
    `JOIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{128}(?:\.[0-9a-f]{64})?$/` plus an exported
    `isValidJoinToken(token)`. `validateJoinHub` uses it after `normalizeToken`.
- i18n (all three locales): `nodes.setup.fields.tokenPlaceholder`, `nodes.setup.fields.tokenHint`
  and `nodes.setup.errors.invalid_token` now describe both forms (128 base64url, optionally
  `.<64 lowercase hex CA fingerprint>`). The placeholder is rendered by `join-hub-form.tsx` through
  `tokenPlaceholder`, so no component change was needed.
- Tests (`setup/validation.test.ts`): v1 accepted (incl. pasted whitespace/newlines), v2 accepted
  (bare and padded with whitespace), rejected: empty, 127 chars, 129 chars, non-base64url chars,
  uppercase hex fingerprint, 63-char fingerprint, two dots, fingerprint-only, trailing dot,
  non-hex fingerprint.

The browser-side *generation* of `ca_fingerprint` (B3's half of the blocker) is untouched:
`apps/fe/src/node/{enrollment.ts,hub-api.ts}` and `apps/fe/src/pages/nodes/**` were out of scope.

## 2. TLS mutation serialization (one lock)

- **new** `apps/fe/src/pages/settings/nodes/https/tls-mutations.ts`
  - `stopsRunningListener(req, status)` and `isTlsBusy(pending, status)` — pure predicates;
    `isTlsBusy` is `pending !== null || status?.acme?.status === 'pending'`.
  - `TlsMutationController` — a subscribable state machine holding
    `{ pending: 'save' | 'renew' | null, confirming: TlsUpdateRequest | null }`.
    `requestSave` / `confirmSave` / `cancelSave` / `renew` all **guard on `busy`** (and on a pending
    confirmation) before touching the API, so the lock is enforced in the handlers, not only in the
    disabled attributes. Deliberately not React state: the lock is then testable without a DOM.
  - `useTlsMutations(api, status, callbacks)` — `useSyncExternalStore` wrapper; `status` and
    `callbacks` are read through refs so the controller identity is stable.
- `https/https-section.tsx` — the two independent `savePending` / `renewPending` flags are gone;
  the section now passes `busy` (disable everything) and `pending` (which spinner to show) down.
- `https/{mode-chooser,external-panel,selfsigned-panel,acme-panel}.tsx` — every mode radio, input,
  switch, fieldset, save button and renew button is now `disabled={busy}`; the spinners use
  `savePending` / `renewPending`. `mode-chooser.tsx` additionally got
  `data-testid="https-mode-<mode>-input"` on the radio input (the existing testid is on the label,
  which cannot carry `disabled`).

## 3. Lockout confirmation before stopping a running listener

- `https/https-section.tsx` — new `StopListenerConfirm` using `@tmex/ui/alert-dialog`
  (`AlertDialog` / `Content` / `Header` / `Title` / `Description` / `Footer` / `Cancel` / `Action`,
  same shape as `SettingsPage`'s restart dialog). It renders only while
  `mutations.confirming !== null`; the confirm button is `variant="destructive"`.
- The decision lives in the controller: `requestSave` registers the request instead of PUTting when
  `stopsRunningListener(req, status)` (mode `none` or `external` while `status.listener.running`).
- i18n `nodes.https.confirmStop.{title,description,requirement,confirm,cancel}` in all three
  locales. `description` interpolates the live listener port and the target mode title;
  `requirement` spells out that another reachable HTTP/proxy endpoint must already exist.

## 4. Restart poll consolidated into one core

- **new** `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts`
  - `waitForRestart({ previousStartedAt, fetchImpl, timeoutMs = 60000, intervalMs = 1000, signal,
    now, sleep, onElapsed })` → `'restarted' | 'timeout' | 'aborted'`.
  - Every probe goes through `probeHealth(fetchImpl, budgetMs, signal)`, which uses
    `cache: 'no-store'` and **its own `AbortController` whose timer is the remaining deadline**, and
    also aborts when the outer signal aborts. This is the actual fix for the review's finding: a
    tunnel that holds `/healthz` open can no longer outlive the 60 s budget.
  - `readStartedAt(fetchImpl, budgetMs = 5000, signal)` for the pre-restart read;
    `delay(ms, signal)` resolves early on abort.
- **new** `apps/fe/src/pages/settings/nodes/restart/use-restart-now.ts`
  - `useRestartNow({ client, timeoutMs, intervalMs, onRestarted })` →
    `{ state, waiting, elapsedMs, start(previousStartedAt), cancel }`; unmount **aborts** the
    in-flight request (not just the `setState`).
  - `useRestartGateway(client, onRestarted)` → `{ state, waiting, run }` — the "Restart now" button
    flow: read `startedAt`, `POST /api/settings/restart`, then `start(before)`.
- Deleted duplicates: `https/use-restart-now.ts` (whole file) and the inline `useRestartNow` +
  `readStartedAt` + `delay` at the bottom of `local-machine-card.tsx`. Both call sites now use
  `useRestartGateway`; both gained `cache: 'no-store'`, which they were missing.
- `setup/use-restart-waiter.ts` is now a 20-line wrapper keeping the wizard's names
  (`RestartWaiter { state, elapsedMs, start }`), so `become-hub-form.tsx`, `join-hub-form.tsx` and
  `form-parts.tsx` are unchanged.
- `setup/use-restart-waiter.test.ts` was **deleted**; its cases were ported to
  `restart/wait-for-restart.test.ts` (13 tests) which additionally covers: `no-store` + per-request
  `AbortSignal` present, abort before the first probe (zero requests), abort mid-wait aborting the
  in-flight request, and a hanging `/healthz` that must still return `'timeout'` inside `timeoutMs`.
- `packages/api-client/src/local/setup-api.ts` was **not** changed: `readHealthStartedAt` is still
  used by `setup/submit.ts`, and `probeHealth` keeps its own tests.

## 5. Renew error path refetches

`TlsMutationController.renew()`'s catch calls `onError` **and** `onRefresh` (the save path already
did). Covered by `tls-mutations.test.ts` ("续签失败同样重拉状态").

## 6. Cause-bearing setup errors keep the server message

`setup/error-messages.ts` — `DETAIL_BEARING_CODES` = `join_failed`, `hub_unreachable`,
`env_write_failed`, `direct_unsupported`, `direct_download_failed`, `direct_failed`. For those, the
localized text is combined with `SetupApiError.message` through the new i18n key
`nodes.setup.errors.withDetail` (`{{base}} ({{detail}})` / `{{base}}（{{detail}}）`). The message is
skipped when it is empty or identical to the code, so envelopes that carry no extra information stay
clean; every other code keeps its static text. New file `setup/error-messages.test.ts` (5 tests).

## 7. `restartRequired` cleared on restart success

`local-machine-card.tsx` — `useRestartGateway(client, onRestarted)` where `onRestarted` clears the
local `restartRequired` flag **before** calling `onRefresh()`, so the banner and the enabled
"Restart now" button disappear instead of inviting a second restart.

## 8. Strict IPv6

`https/tls-form.ts` — the `/^[0-9A-Fa-f:]+$/` check is replaced by `isIpv6Address` (and a split-out
`isIpv4Address`): at most one `::`, no empty groups, each group 1–4 hex digits, optional trailing
embedded IPv4 counting as two groups, exactly 8 groups uncompressed / at most 7 when compressed.
Tests in `tls-form.test.ts`: accepts `::`, `::1`, `fe80::1`, `2001:db8::8a2e:370:7334`, the full
8-group form, `::ffff:192.168.0.1`, `1:2:3:4:5:6:7::`; rejects `::::`, `1:2:3:4:5:6:7:8:9`,
`12345::1`, `1::2::3`, 7-group, trailing/leading single colon, `::ffff:192.168.0.1.2`,
`::ffff:999.1.1.1`, `::gggg`.

## 9. Tests

| file | tests | covers |
|---|---|---|
| `https/tls-mutations.test.ts` (new) | 12 | renew refused while a save is in flight (and vice versa), everything refused while ACME is `pending`, subscriber notifications, `port_in_use` on save → `onRefresh`, renew failure → `onRefresh`, stop-listener confirmation registered/confirmed/cancelled, no confirmation when the listener is down, nothing accepted while a confirmation is open |
| `restart/wait-for-restart.test.ts` (new) | 13 | restart detection, downtime tolerance, `previousStartedAt === null` fallback, timeout, `no-store` + per-request signal, abort (pre-flight and mid-wait), hanging-request timeout, `probeHealth` / `readStartedAt` |
| `setup/error-messages.test.ts` (new) | 5 | detail appended for the six cause-bearing codes, suppressed when redundant, static text preserved, unknown-code fallback |
| `pages/SettingsPage.test.tsx` (new) | 2 | six tab triggers render, `settings-tab-nodes` sits between devices-and-files and notifications, panels are mutually exclusive (NodesTab not mounted on the default tab) |
| `https/https-section.test.tsx` (+6) | 17 | renew disabled while a save is pending, save disabled while a renew is pending, both enabled when idle, everything (mode radios included) disabled while ACME is `pending`, confirmation dialog absent by default and harmless when armed |
| `https/tls-form.test.ts` (+4) | 21 | strict IPv6 (above) |
| `setup/validation.test.ts` (+3) | 21 | v1/v2 join tokens (above) |

`https-section.test.tsx` replaces `./tls-mutations`'s `useTlsMutations` with a probe (spreading the
real module so `tls-mutations.test.ts` still sees the real exports) to drive `pending`; `busy` is
still computed by the **real** `isTlsBusy`, so the test exercises the actual wiring.

Two testids were added for testability: `https-mode-<mode>-input` (radio inputs) and
`https-confirm-stop*` (dialog).

## Files changed

New:
- `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts`
- `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.test.ts`
- `apps/fe/src/pages/settings/nodes/restart/use-restart-now.ts`
- `apps/fe/src/pages/settings/nodes/https/tls-mutations.ts`
- `apps/fe/src/pages/settings/nodes/https/tls-mutations.test.ts`
- `apps/fe/src/pages/settings/nodes/setup/error-messages.test.ts`
- `apps/fe/src/pages/SettingsPage.test.tsx`

Deleted:
- `apps/fe/src/pages/settings/nodes/https/use-restart-now.ts`
- `apps/fe/src/pages/settings/nodes/setup/use-restart-waiter.test.ts`

Modified:
- `apps/fe/src/pages/settings/nodes/https/{https-section.tsx,https-section.test.tsx,mode-chooser.tsx,external-panel.tsx,selfsigned-panel.tsx,acme-panel.tsx,tls-form.ts,tls-form.test.ts}`
- `apps/fe/src/pages/settings/nodes/setup/{validation.ts,validation.test.ts,error-messages.ts,use-restart-waiter.ts}`
- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` (+ generated `resources.ts` / `types.ts`
  via `bun run build:i18n`; the generated files were not linted)

## How to verify

```bash
cd apps/fe             && bun test src/ && bunx tsc --noEmit -p .
cd packages/shared     && bun test      && bunx tsc --noEmit -p .
cd packages/api-client && bun test      && bunx tsc --noEmit -p .
cd <repo root>         && bunx biome check apps/fe/src/pages/settings/nodes apps/fe/src/pages/SettingsPage.test.tsx packages/shared/src/i18n/locales
```

Manual (needs the batch-1/2 backend): `/settings` → **Nodes**. Start a save in the HTTPS card and
confirm every control including "Renew now" greys out; put ACME into `pending` and confirm the whole
card is read-only until issuance settles; with the built-in listener running, pick "Off" or
"External reverse proxy" and confirm the AlertDialog appears before anything is written.

## Numbers (before → after)

| package | tests before | tests after | tsc before | tsc after |
|---|---|---|---|---|
| `apps/fe` (`bun test src/`) | 415 / 0 | **453 / 0** | 0 | **0** |
| `packages/shared` | 337 / 0 | **337 / 0** | 0 | **0** |
| `packages/api-client` | 128 / 0 | **128 / 0** | 5 | **5** |

`apps/fe` baseline was 415 when I started (the brief said 413; two more tests had landed from a
concurrent task). Net +38 = 45 new tests minus the 7 in the deleted `use-restart-waiter.test.ts`.

## Open issues / needed from others

1. **`SettingsPage` tab-selection test is incomplete, and needs a change I am not allowed to make.**
   `apps/fe` has no DOM in `bun test` (no happy-dom/jsdom anywhere in the tree; component tests use
   `react-dom/server` + `renderToStaticMarkup`). A render-phase state update from a child is ignored
   by React's SSR renderer (verified with a throwaway probe), so there is no way to flip
   `SettingsPage`'s `activeTab` from a test without either
   (a) a one-line export in `apps/fe/src/pages/SettingsPage.tsx` — extract the
   `{activeTab === 'x' && <XTab/>}` chain into an exported `SettingsTabPanel({ tab, form })`, which
   a test can then render with `tab="nodes"` and assert `data-testid="settings-nodes-tab"`, or
   (b) adding `@happy-dom/global-registrator` as an `apps/fe` devDependency and a client-render test
   harness.
   `SettingsPage.tsx` and `apps/fe/package.json` are both outside my scope, so the delivered test
   asserts what is provable statically: all six triggers render, `settings-tab-nodes` is in the right
   position, and the panels are mutually exclusive. **Recommendation: (a)**, it is three lines and
   makes every tab's dispatch testable.
2. **B3 still owns the other half of the blocker**: `HubEnrollmentCreated.ca_fingerprint` and
   appending it to browser-generated tokens in `apps/fe/src/node/{enrollment.ts,hub-api.ts}` +
   `apps/fe/src/pages/nodes/{enrollment-section.tsx,nodes-management.tsx}`. The wizard now accepts
   what B3 will emit; nothing else is needed from my side.
3. **The AlertDialog cannot be asserted in a static render** — `@base-ui/react`'s `AlertDialog`
   content goes through a Portal, which `renderToStaticMarkup` drops (it does not throw). The
   confirmation *flow* is therefore tested at the controller level in `tls-mutations.test.ts`, and
   the section test only asserts that arming a confirmation does not break the rest of the card.
   A DOM harness (see §1b) would close this gap too.
4. **`busy` intentionally includes `acme.status === 'pending'`**, so while Let's Encrypt issuance is
   running the whole HTTPS card is read-only — including switching away from ACME. That is what the
   review asked for; if it turns out to be too strict in practice (a stuck `pending` would need a
   gateway restart to clear), the narrower rule would be to keep the mode chooser enabled and lock
   only save/renew.
5. **`nodes.machine.*` needed no new keys** — clearing `restartRequired` reuses the existing strings.
