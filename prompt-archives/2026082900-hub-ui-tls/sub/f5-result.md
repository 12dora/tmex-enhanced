# F5 result — direct add-on install/remove button + linked enable switch

Status: **done**. `apps/fe` 470 pass / 0 fail, tsc **0** errors; `packages/shared` 344 pass / 0 fail,
tsc 0. `bunx biome check` clean on every file I touched.

B4's api-client half **landed while I was working**, so the temporary local type shim described in the
brief was written and then removed: the card now imports `LocalDirectAction`, `LocalDirectStatus` and
`LocalDirectResponse` (with `enabled`) straight from `@tmex/api-client/local/types` and calls
`LocalApi.setDirect(action)`. Nothing under `packages/api-client` was edited by me.

## What changed

### `apps/fe/src/pages/settings/nodes/local-machine-card.tsx` (rewritten direct section)

The single "on/off downloads or deletes the add-on" switch is gone. The row is now two controls:

- **Button** — `Install add-on` (`local-machine-direct-install`, outline + download icon) when not
  installed, `Remove add-on` (`local-machine-direct-remove`, destructive + trash icon) when installed.
  Remove goes through an `AlertDialog` (`local-machine-direct-remove-confirm`, `…-ok` / `…-cancel`)
  before anything is written. Both variants are disabled when the platform is unsupported or while
  any mutation / restart is in flight; the pending action shows a spinner in place of its icon.
- **Switch** — `local-machine-direct-switch`, bound to `direct.enabled`, `checked={installed && enabled}`
  so a never-installed machine (env absent ⇒ `enabled: true`) does not render an "on" switch for an
  add-on that is not there. Toggling calls `enable` / `disable`. Disabled when unsupported, not
  installed, or busy; when supported-but-not-installed it is accompanied by the hint
  `local-machine-direct-hint` ("Install the add-on first."). No hint on unsupported platforms — there
  is nothing to install.

Status badges: `…-supported` / `…-unsupported`, `…-installed` (shows `directInstalledVersion` with the
version when the backend reports one, plain `directInstalled` otherwise, `directNotInstalled` when
absent), `…-active` when `capable`, `…-disabled` when installed and `enabled === false`. `active` and
`disabled` are deliberately independent: after `disable` the runtime is still `capable` until the
restart, and showing both is the truthful state ("loaded now, off after restart").

Any successful action sets the existing restart panel (`local-machine-restart-required` +
`local-machine-restart-now`, reusing `useRestartGateway` from `restart/use-restart-now`) and calls
`onRefresh()` to invalidate `['local-status']`.

New internals in the same file (kept there because the task scope is one file):

- `DirectMutationController` / `useDirectMutations` — one lock across all four actions, plus the
  remove confirmation state. Same subscribable-controller shape as `https/tls-mutations.ts`, and for
  the same reason: `apps/fe` has no DOM in `bun test`, so the lock and the confirm/cancel flow are
  only testable if they live outside React state. `finally` always calls `onRefresh()` — on failure
  too, because a failed install may still have wiped `native/`.
- `describeDirectError(t, error)` — mirrors `setup/error-messages.ts`: a per-code localized headline
  (`direct_unsupported`, `direct_download_failed`, `direct_not_installed`, generic fallback) combined
  with the server's `message` through `directErrorDetail` when that message carries information
  (skipped when it is empty or equal to the code). Rendered inline as
  `local-machine-direct-error` instead of a toast — a 60 s download failure is exactly the message a
  user must be able to re-read.
- Optimistic overlay: the action response (`installed` / `enabled` / `capable`) is applied on top of
  the fetched status until a new `status.direct` object arrives, so the switch does not sit on the
  stale value during the refetch. Implemented with the render-phase "adjust state on prop change"
  pattern, not an effect.

`api` prop type narrowed from `LocalApi` to a structural `DirectApi { setDirect(action) }` (the real
`LocalApi` still satisfies it and is still the default), so tests can inject a fake without building a
whole client. `nodes-tab.tsx` passes no `api`, so it needed no change.

### `apps/fe/src/pages/settings/nodes/local-machine-card.test.tsx` (new, 17 tests)

- 6 static renders: unsupported / supported-not-installed / installed+enabled(+version, capable) /
  installed+disabled, plus version-absent and status-absent. They assert badge presence, which button
  is rendered, native `disabled` on the button and `aria-disabled` / `aria-checked` on the switch
  (base-ui renders the switch as `<span role="switch">`, so a plain `disabled=""` match is
  meaningless — see open issue 3).
- 7 controller tests with an injected api that holds requests open: install → `setDirect('install')`
  + `onResult` + one refresh; everything else refused while an action is in flight; remove requires
  `requestRemove` → `confirmRemove` (nothing is sent by `requestRemove` alone, and no other action is
  accepted while the dialog is open); cancel sends nothing; the switch path sends `enable` / `disable`;
  a `direct_download_failed` rejection reports through `onError`, still refreshes and still unlocks;
  subscribers are notified exactly on state transitions.
- 4 `describeDirectError` tests (detail appended, detail suppressed when it equals the code,
  not-installed code, unknown-error fallback), using a probe `t` so the composition is actually
  observable (i18next is not initialized in `bun test`, so real `t()` returns the key).

### i18n — `nodes.machine.*` in the three locale JSONs (+ `bun run build:i18n`)

Removed: `directCapable`, `directEnable`, `directDisable` (all three were referenced only by this
card). Added / reworded: `direct` ("Direct connection add-on"), `directInstalledVersion`,
`directActive`, `directDisabled`, `directInstall`, `directRemove`,
`directRemoveConfirm.{title,description,confirm,cancel}`, `directSwitch`, `directSwitchHint`,
`directFailed` (now a sentence), `directErrorUnsupported`, `directErrorDownloadFailed`,
`directErrorNotInstalled`, `directErrorDetail`. Everything else in the namespace is untouched.
Keys were reordered into reading order inside `nodes.machine`; the JSON round-trip was verified
byte-identical on the untouched parts, so the diff is +24/-5 lines in en_US and +22/-4 in the other
two. `packages/shared/src/i18n/{resources.ts,types.ts}` regenerated by the script, never hand-edited
or linted.

## Out-of-scope change I had to make (4 lines)

B4 made `LocalDirectStatus.enabled` **required**, which broke two `apps/fe` test fixtures that B4's
scope did not cover and that nobody else owns, taking apps/fe tsc from 0 to 4 errors:

- `apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx` (2 fixtures)
- `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx` (2 fixtures)

I added `enabled: true,` to each `direct` literal (matching the contract's "env absent ⇒ true"); no
assertion or logic in those files was touched. Both files had been idle for hours. Without this the
tree does not type-check.

## How to verify

```bash
cd apps/fe         && bun test src/ && bunx tsc --noEmit -p .
cd packages/shared && bun test      && bunx tsc --noEmit -p .
cd <repo root>     && bunx biome check apps/fe/src/pages/settings/nodes packages/shared/src/i18n/locales
```

Manual (needs B4's backend): `/settings` → **Nodes** → *This machine*. On a supported platform with
nothing installed: the switch is off, disabled, and hinted; "Install add-on" downloads (spinner, both
controls locked), then the badges flip to Installed/Turned-on, the switch becomes usable and the
restart panel appears. Toggle the switch off → "Turned off" badge + restart panel, files untouched.
"Remove add-on" must ask first. Kill network access to the release host and press Install: the row
shows "Could not download the add-on. (…cause…)" and stays interactive.

## Numbers (before → after)

| package | tests before | tests after | tsc before | tsc after |
|---|---|---|---|---|
| `apps/fe` (`bun test src/`) | 453 / 0 | **470 / 0** | 0 | **0** |
| `packages/shared` | 344 / 0 | **344 / 0** | 0 | **0** |

(+17 = the new `local-machine-card.test.tsx`. The 4 tsc errors that appeared mid-task came from B4's
type change and are fixed, see above.)

## Open issues / needed from others

1. **The remove confirmation cannot be asserted in a static render.** `@base-ui/react`'s
   `AlertDialog` content goes through a Portal, which `renderToStaticMarkup` drops. The flow is
   therefore tested at the controller level (request → confirm → `setDirect('remove')`, and cancel →
   nothing), exactly as `https/tls-mutations.test.ts` does for the TLS lockout dialog. A DOM harness
   (`@happy-dom/global-registrator` as an `apps/fe` devDependency) would close this gap for both.
2. **Copy pass pending.** English wording is functional product copy as instructed; the follow-up
   copy-rewrite task should go over `nodes.machine.direct*` together with the rest. Keys are stable
   and descriptive, and no key is shared with another namespace.
3. **`nodes-tab.test.tsx`'s switch-disabled assertion is weak** —
   `/data-testid="local-machine-direct-switch"[^>]*disabled/` matches the Tailwind
   `data-disabled:cursor-not-allowed` class as well, so it would pass even on an enabled switch. It
   still passes and I left it alone (out of scope); the new card test checks `aria-disabled` properly.
   Worth tightening whoever next owns that file.
4. **Success is signalled only by the restart banner** (plus the badges changing); the old failure
   `toast` was replaced with the inline, persistent error line. If the reviewer wants a success toast
   as well it is a two-line addition in `onResult`.
5. **`useLocalStatus` has no `setStatus`** (unlike `useTlsStatus`), which is why the optimistic
   overlay lives in the card. If someone adds `setStatus` there, the overlay in
   `local-machine-card.tsx` can be deleted in favour of it.
