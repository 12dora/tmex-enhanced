# F2 result — standalone "enable hub" wizard + restart waiter + setup API client

Status: complete. All deliverables implemented, tested, type-checked and biome-clean.

## Files added

### packages/api-client
- `packages/api-client/src/local/setup-api.ts`
  - `class SetupApi { precheck(url); becomeHub(req); joinHub(req) }` on an injected `ApiClient`.
  - `class SetupApiError extends Error { code, message, status }` — `readError()` follows the
    `HubApi.readError()` pattern and understands both `{error:{code,message}}` (batch-1 contract)
    and the legacy `{error:"code"}` envelope; falls back to a per-endpoint code on non-JSON bodies.
  - `probeHealth(client): Promise<{ ok, startedAt }>` and `readHealthStartedAt(client)` for
    `GET /healthz`. `probeHealth` never throws — network errors and non-2xx both return `ok:false`,
    which is what the restart waiter needs to distinguish "process is down" from "process answered".
- `packages/api-client/src/local/setup-api.test.ts` — 19 tests (transport injection).

`src/local/index.ts` (written by the commander) already re-exports `./setup-api`; I did not touch it.

### apps/fe — `apps/fe/src/pages/settings/nodes/setup/`
- `hub-setup-wizard.tsx` — `HubSetupWizard({ localStatus, client?, initialPath?, origin?, hostname?, onRestarted? })`.
  Renders a loading line while `localStatus` is null, renders **nothing** when `role !== 'standalone'`,
  otherwise an intro card + a two-card radio group (`<label>` + visually hidden `<input type="radio">`;
  a `role="radio"` button trips biome `a11y/useSemanticElements`) and the selected form below.
- `become-hub-form.tsx` — `BecomeHubForm`. Prefills `hubPublicUrl` from the page origin per contract,
  four fields + `directEnable` switch, a "Check reachability" button calling `precheck`, submit →
  result card (fingerprint / public URL / username / direct outcome) → `useRestartWaiter.start()`.
- `join-hub-form.tsx` — `JoinHubForm`. `hubUrl`, `token` (textarea, whitespace stripped),
  `name` (defaults to the browser hostname, else `node`), `directEnable`, and `insecureLocal`
  rendered only when `nodeEnv !== 'production'`.
- `use-restart-waiter.ts` — `useRestartWaiter()` → `{ state, elapsedMs, start(previousStartedAt) }`
  plus the injectable core `waitForRestart(previousStartedAt, { client, pollIntervalMs, timeoutMs,
  now, sleep, shouldContinue, onElapsed })`. 1 s poll, 60 s timeout; success when `startedAt`
  differs, or — when the pre-submit read returned null — on the first healthy response *after* at
  least one unreachable probe. Unmount cancels via `shouldContinue`.
- `submit.ts` — `submitBecomeHub` / `submitJoinHub`: read `/healthz.startedAt` **first**, then POST.
  Trims inputs, normalizes the token, and omits `insecureLocal` entirely in production.
- `validation.ts` — pure validators returning i18n keys, `classifyHubUrl`, `normalizeToken`,
  `defaultHubPublicUrl`, `defaultNodeName`, and `setupErrorKey(code)` (backend code → i18n key,
  `null` for unknown).
- `error-messages.ts` — `describeSetupError(t, error)`: known code → localized text; unknown →
  `nodes.setup.errors.unknown` with the raw message.
- `form-parts.tsx` — `SetupNotice`, `FormField`, `SwitchRow`, `ResultRow`, `RestartPanel`,
  `directOutcomeLabel`.
- `browser-location.ts` — `currentOrigin()`, `currentHostname()`, `navigateToLogin()`.

Tests: `validation.test.ts`, `use-restart-waiter.test.ts`, `submit.test.ts`,
`hub-setup-wizard.test.tsx` — 45 tests total.

### i18n
- `prompt-archives/2026082900-hub-ui-tls/sub/f2-i18n-keys.json` — 73 keys under `nodes.setup.*`
  for `en_US` / `zh_CN` / `ja_JP` (identical key sets, verified programmatically). Locale JSON was
  **not** touched, per the task.

## Deviations from the task text (deliberate)

1. **No `setup/i18n.ts` `ts()` helper.** The task made it conditional on tsc rejecting unknown keys.
   It does not: the repo declares no `i18next` `CustomTypeOptions` augmentation, so `t()` accepts an
   arbitrary `string`. Verified with a throwaway probe file (`t('nodes.setup.zzz.nonexistent')`
   compiled with 0 errors) which was then deleted. Plain `t('nodes.setup.…')` is used everywhere, so
   **no conversion is needed after the i18n merge**.
2. **`/login` navigation is a hard navigation** (`window.location.assign('/login')` in
   `navigateToLogin()`), not react-router `navigate()`. After the role change the module-level auth
   mode store, mesh store and the `/mesh/ws` connection are all stale; an in-SPA transition would
   keep a standalone-shaped app running against a mesh gateway. Both forms accept an `onRestarted`
   override, so a caller can substitute router navigation if that is preferred.
3. **Validation-message rendering is covered without a test-only prop.** `renderToStaticMarkup`
   cannot drive a submit, and the forms only reveal errors after one. Rather than add a
   `showErrors` prop that exists solely for tests, coverage is split: `validation.test.ts` asserts
   every validator returns the right i18n key, and `hub-setup-wizard.test.tsx` renders `FormField`
   directly to assert the `data-testid="<id>-error"` markup and that the hint is suppressed.
4. **Precheck lives on the become-hub form only**, as specified. The join form does not call it.
5. **Extra client-side rules beyond the contract** (all fail-closed, backend still authoritative):
   confirm-password match (`password_mismatch`), node name 1–64 chars (`invalid_name`, non-ASCII
   allowed — the ops doc uses `--name 书房`), token must be non-empty base64url after whitespace
   stripping, and an http:// local hub URL requires the `insecureLocal` switch
   (`insecure_local_required`). These three keys are local-only and are included in the i18n JSON.
6. `directEnable` defaults to `localStatus.direct.supported` and its switch is disabled with an
   explanatory hint when the platform has no pinned native manifest.

## Verify

```bash
cd apps/fe && bun test src/ && bunx tsc --noEmit -p .
cd packages/api-client && bun test && bunx tsc --noEmit -p .
bunx biome check apps/fe/src/pages/settings/nodes/setup packages/api-client/src/local/setup-api.ts \
  packages/api-client/src/local/setup-api.test.ts
```

## Numbers

| | baseline given | after |
|---|---|---|
| `apps/fe` `bun test src/` | 333 pass / 0 fail | **385 pass / 0 fail** (includes F1's concurrent tests; mine are 45) |
| `apps/fe` tsc | 0 | **0** |
| `packages/api-client` `bun test` | 96 pass | **115 pass / 0 fail** (mine are 19) |
| `packages/api-client` tsc | 5 pre-existing | **6** — see below |
| biome (my files) | — | clean, no diagnostics |

packages/api-client tsc detail. When I started, the package actually reported **7** errors: the 5
pre-existing ones (`client.test.ts` ×4, `files-download.test.ts` ×1) plus two
`Cannot find module './local-api' / './setup-api'` from the barrel `src/local/index.ts`. Creating
`setup-api.ts` cleared one of those; F1's `local-api.ts` cleared the other. The current 6th error is
**not mine**: `src/local/local-api.test.ts(72,25): error TS2769` in F1's new test file. Excluding
that, the package is back to its 5-error baseline.

## Needed from others (out of my scope)

1. **Commander:** merge `sub/f2-i18n-keys.json` into the three locale JSON files under
   `translation.nodes.setup`, then run `bun run build:i18n` from the repo root. No code change is
   required after the merge (see deviation 1). Until it lands, the wizard renders raw key strings.
2. **F1:** `nodes-tab.tsx` already renders `<HubSetupWizard localStatus={local.status} />`, which
   matches the implemented signature — no change needed. If the tab wants to preselect a path it can
   pass `initialPath`.
3. **F1 / commander:** the 6th api-client tsc error lives in `src/local/local-api.test.ts:72`.
4. **Backend:** the wizard codes strictly against `sub/api-contract-batch1.md`. It depends on
   `GET /healthz` exposing `startedAt` — without it the waiter falls back to the weaker
   "one unreachable probe, then one healthy probe" rule, which cannot distinguish a transient
   network blip from a real restart.

## Open issues / notes

- Not exercised end-to-end against a live gateway (per ground rules, no ad-hoc server was started
  and the backend endpoints are being written in parallel). The submit/restart path is covered by
  injected-transport unit tests only; a manual pass on a temporary instance is worth doing once the
  batch-1 backend lands.
- The precheck "not reachable" hint points at `docs/hub/2026082800-hub-node-operations.md` sections
  「Cloudflare Tunnel 与反代」 and 「首次搭 hub」 as plain text — the docs are not served by the app,
  so there is no clickable link.
- `apps/fe` unit tests run without an i18next instance, so react-i18next logs one
  `NO_I18NEXT_INSTANCE` warning per test file and `t()` returns the key. That is the existing
  convention in this repo (`NodesPage.test.tsx` behaves the same way).
