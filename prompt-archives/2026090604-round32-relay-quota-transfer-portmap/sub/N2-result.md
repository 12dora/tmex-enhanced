# N2 — Non-standard ports: web setup forms

Scope delivered: port picker on the two "become" forms, port probing on the two "join" forms,
relay port resolution before `proof-material`, public HTTPS address on the HTTPS card, i18n for
all of it, and unit tests.

## ⚠️ Commander: read this first

While bootstrapping I overwrote N1's freshly created (untracked)
`packages/shared/src/net/port-candidates.ts` with a minimal stub, before noticing N1 had already
landed it. **I reconstructed the full implementation from N1's surviving
`port-candidates.test.ts`** (which specifies the whole contract), and all **27 of N1's tests pass**
against the reconstruction, plus `packages/shared` tsc 0 and biome clean.

The reconstruction implements exactly the exports N1's `net/index.ts` re-exports:
`SUGGESTED_HIGH_PORTS`, `PROBE_DEFAULT_{TIMEOUT,GRACE,STAGGER}_MS`, `isLoopbackHostname`,
`parseProbeTarget`, `candidateUrls`, `probeAddressPorts`, `pickSuggestedPort`,
`pickSuggestedPortAvoiding`, and the types `ProbeKind` / `ProbeTarget` / `PortProbeResult` /
`ProbeFetch` / `ProbeAddressPortsOptions`. Semantics: explicit port ⇒ single confirmation;
no port ⇒ 443 first with a grace window, then the candidate table staggered, 443 still wins if it
answers late; relay checks `GET /api/relay/health` (`ok === true`), hub checks `GET /healthz`
(`status === 'ok'`); `redirect: 'error'`, per-request `AbortSignal.timeout`, optional
`resolveDialUrl` rewrites the dial target but not the reported url.

**N1 should diff it against what they intended and replace it if their version differed** (e.g. a
different internal factoring). Nothing else of N1's was touched. One deviation worth keeping:
`pickSuggestedPort` / `pickSuggestedPortAvoiding` return the literal union
`(typeof SUGGESTED_HIGH_PORTS)[number]`, not `number` — required for N1's own test
`expect(SUGGESTED_HIGH_PORTS).toContain(pickSuggestedPortAvoiding(...))` to typecheck under
`as const`.

## What was built

### New files (apps/fe)
- `apps/fe/src/pages/settings/nodes/setup/address-probe.ts` — address helpers + probe state machine.
  - `splitAddress` / `formatAddress` / `readAddressPort` / `replaceAddressPort`: a regex split of
    the authority so **only the port component** is rewritten (scheme, case, userinfo, path,
    trailing slash all byte-preserved; unparseable input is returned unchanged).
  - `shouldProbeAddress(raw)`: only parseable + no explicit port + non-loopback.
  - `createAddressProbeCore()` / `useAddressProbe()`: `idle | probing | resolved(port) | failed`
    over the repo's `createStateStore` pattern. Every `run`/`reset` bumps a ticket, so a result
    that lands after the user edited the address (or after unmount — the hook resets on unmount)
    is dropped and never written back into the field.
  - `precheckProbe(client)`: adapter over `SetupApi.precheck`, reading `probed` / `resolvedUrl`.
- `apps/fe/src/pages/settings/nodes/setup/port-picker.tsx` — `PortPicker`: segmented control
  「标准 443 / 建议 {{port}} / 自定义」 (radio group, styled like the existing ACME challenge
  chooser), custom numeric input 1–65535, one-line hint. The suggested port is drawn once per
  mount via `pickSuggestedPort()` and stays stable; tests inject it via `suggestedPort`.
  The selected segment is derived from the port already in the URL, so the URL field stays the
  single source of truth. When the address field is empty/unparseable there is no port component
  to rewrite, so the control renders disabled (fill the address first).
- Tests: `address-probe.test.ts` (15), `port-picker.test.tsx` (9),
  `pages/settings/nodes/relay/relay-enroll-resolve.test.ts` (5).

### Edited
- `setup/become-hub-form.tsx`, `setup/become-relay-form.tsx` — `<PortPicker>` under the public URL
  field; new optional `suggestedPort` prop (test injection only).
- `setup/join-hub-form.tsx`, `setup/join-relay-form.tsx` — on blur of the address field, when it
  has no explicit port and is not loopback and has no validation error, probe and (on a
  non-default port) rewrite the field; the three states render through `AddressProbeNotice`.
  Submit is never gated on the probe. Editing the address invalidates the previous conclusion.
- `setup/form-parts.tsx` — new `AddressProbeNotice` (info / success / warning).
- `relay/use-relay-actions.ts` — `resolveEnrollUrl()` (exported for tests) calls
  `relayApi.resolveRelayAddress(url)` **before** `enrollRelay` → `proof-material`, because the
  enroll proof is signed over `hubHostFromUrl(url)` (port included). Explicit ports and loopback
  are never probed; a `null` result or a 404 from an old node falls back to the typed URL so the
  real failure surfaces later. Covers all four intents (enroll / add / migrate / reauth) since
  they share `submitEnroll`.
- `nodes/https/https-section.tsx` — new `PublicUrlLine`: when `GET /api/tls`'s `https.publicUrl`
  is present it is shown as 「对外地址」 with the existing `CopyableCode` affordance. Suppressed in
  the "reverse-proxy, unverified" case, where `accessProxyInferred` already prints the URL.
  (Extracted as its own component to keep `StatusHeader` under the CC gate.)
- `nodes/https/https-section.test.tsx` — 3 new cases for that row.
- i18n (zh_CN source, en_US / ja_JP synced, `bun run build:i18n` run):
  `nodes.setup.fields.publicPort{,Standard,Suggested,Custom,Value,Hint}`,
  `nodes.setup.probe.{probing,resolvedHub,resolvedRelay,failed}`,
  `nodes.https.status.publicUrl`. Only these keys appear in the locale diff (15 added lines/file).

### Refactors forced by the complexity gate (behaviour-neutral)
`JoinHubForm` was over the 150-line function limit after the probe wiring, so the address field
became `HubAddressField` and the success card became `JoinHubResult` (matching the pattern the
other three forms already use).

## Deviations from the brief

1. **Join-relay probes through `/api/setup/precheck`, not `/api/mesh/relay/resolve`.** The setup
   wizard runs on a **standalone** instance: only `/api/setup/*` is registered there, and
   `/api/mesh/relay/*` requires a node session, so `resolveRelayAddress` is unreachable from that
   form. `/healthz` is served by the same single listener on a relay machine (EX4 §2.1), so the
   hub-shaped precheck probe resolves a relay's port correctly. `resolveRelayAddress` **is** used
   where it is available and required — the authenticated settings page, before `proof-material`.
2. **Probe fires on blur only, not additionally "before submit".** The brief allows either. A
   pre-submit probe would need to rewrite `values` and submit in the same tick, while
   `useHubSetupSubmit`'s `submit` closure captures `values` at render time — the submit would race
   the state update and send the un-rewritten URL. Blur covers the button path (mousedown blurs
   the input first); the keyboard-Enter path submits the typed address, which the brief explicitly
   allows ("keep the submit enabled — the user may still submit an explicit address").
3. **The port picker is disabled while the address field is empty/unparseable** — there is no port
   component to rewrite yet. Deriving the segment from the URL avoids any stale-sync bug at the
   cost of this one restriction.

## Gates

- `bunx tsc --noEmit -p apps/fe` → **0 errors**; `-p packages/shared` → **0 errors**.
- `bun test src/pages/settings` → **1397 pass / 0 fail** (69 files).
- `bun test src/` (apps/fe) → **2833 pass / 0 fail** (177 files); baseline was 2801+, +32 from
  this work (29 new + 3 in `https-section.test.tsx`).
- `packages/shared` `bun test` → **826 pass / 0 fail**, incl. N1's 27 `port-candidates` tests.
- `bunx biome check` on every touched path → clean.
- `bun scripts/complexity/gate.ts` → no violation in any file I touched. One unrelated violation
  remains: `packages/app/src/commands/hub.ts: 1319 lines > 1298` (N1's CLI work).
- `bun run build` (apps/fe) succeeds; `bun run budget` ok (entry gzip 286992 / 300000) — this is
  the first FE consumer of the `@tmex/shared/net` subpath and it stays browser-safe (no `node:*`
  anywhere under `packages/shared/src/net`).

## To verify manually

Screenshot check (per the copy guidelines) of the two "become" forms' segmented control and of the
join forms' three probe notices at ~600px panel width was **not** done — no browser instance was
started (repo-local temp instance only, production untouched).

---

# Round 2 — review fixes (R1-ports-review findings 3 FE half, 4, 5)

Base: commit `8051bc32`. No git operations performed.

## (3) Relay discovery must use the relay health predicate

`join-relay-form.tsx` probed through `precheckProbe`, whose backend checked `/healthz` with the
hub predicate — with 443 blocked, a Hub or standalone node on a candidate port could win and get
written into the field, after which submission treated that port as explicit.

- `packages/api-client/src/local/setup-api.ts` — `precheck(url, kind?)` now sends
  `{ url, kind }`; new `SetupPrecheckKind = 'hub' | 'relay'` in `local/types.ts`. (N1 had not
  landed this yet, so I added it per the coordinator's instruction; the field is omitted entirely
  when `kind` is absent, so old gateways are unaffected.)
- `address-probe.ts` — `precheckProbe(client, kind)`; `kind` is now required at every call site.
- `join-hub-form.tsx` passes `'hub'`, `join-relay-form.tsx` passes `'relay'`.

## (4) Submission no longer races blur discovery

The port is now decided **inside the submit path**, not read from state that a blur probe may not
have written yet (or may never have run at all).

- `submit.ts` — new `submitJoinHubDiscovered(values, nodeEnv, discover, client)` and
  `submitJoinRelayDiscovered(values, discover, client)`: `await discover(typedUrl)` and pass the
  returned URL straight into the existing submit function. The ordering contract lives in one
  place and is directly testable (same rationale as the file's existing startedAt-ordering note).
- Both join forms pass their `resolveHubUrl` / `resolveRelayUrl` as `discover`; the same function
  is still the blur handler, so a blur-discovered port needs no second probe (the field then has
  an explicit port and `shouldProbeAddress` short-circuits). Explicit ports are never probed.
- Submit button shows the probing state: `SetupSubmitRow` gained an optional `pendingLabel`, and
  both join forms pass `nodes.setup.probe.probing` while `probe.phase === 'probing'`.

New tests in `submit.test.ts` (`提交前定端口`, 4 cases) drive the **real** chain
(`createAddressProbeCore` + `precheckProbe` + a recording `ApiClient`):
- credentials filled, portless address typed last, submitted immediately with no blur ever having
  run → requests are exactly `/api/setup/precheck` then `/api/setup/join`, precheck body is
  `{url, kind:'hub'}`, and the join body carries `https://hub.example.com:13443`;
- explicit port → precheck is never called and the typed port is submitted verbatim;
- nothing answers → the typed address is submitted so the backend reports the real failure;
- relay path sends `kind:'relay'` and the discovered port reaches `/api/setup/relay-join`.

## (5) Custom port is a controlled draft, and invalid values block submit

`port-picker.tsx` rewritten around a controlled draft plus pure decision functions:

- `value={draft}` (was `defaultValue`); an effect re-syncs the draft from the URL's port whenever
  that port changes, so editing the address from `:9443` to `:8443` updates the displayed port.
  The same effect clears the manual "custom" marker, so the segment is re-derived from the URL and
  cannot be left as an orphan state.
- Empty / non-numeric / out-of-range (`0`, `65536`, …) values **do not rewrite the URL** and are
  reported as the error key `nodes.setup.errors.invalid_port`, rendered under the input in place
  of the hint. Selecting 「自定义」 while no port is set reports the same error.
- `onChange` is now `(url, error) => void`. `become-hub-form.tsx` and `become-relay-form.tsx` hold
  `portError` and feed it into `hasErrors` (and, for the pure-relay path, into
  `pureRelaySubmitPlan(values, nodeEnv, portInvalid)`), so submission is blocked instead of
  silently keeping the previous port.
- Extracted pure, exported: `parsePort`, `customPortChange(url, raw)`, `modeChange(url, mode,
  suggested, draft)`, `modeOf(...)` — the no-DOM test convention this repo already uses for
  `become-relay-gate` / `use-relay-switch`.
- New i18n key `nodes.setup.errors.invalid_port` (zh_CN 「端口须在 1 到 65535 之间。」 + en/ja),
  `bun run build:i18n` run. Locale diff is exactly these three lines.

Tests: `port-picker.test.tsx` gained 5 cases (parse table; invalid values keep the URL and raise
the error; segment switching; mode derivation; controlled input shows the URL's port), and
`become-relay-gate.test.ts` gained one asserting `portInvalid` forces `'invalid'`.

### Refactor forced by the complexity gate
`BecomeRelayForm` went to 125 lines (limit 120), so the confirm-dialog state machine moved into
`usePureRelayGate(handleSubmit)` in `become-relay-gate.ts` — that file already owns this exact
decision/transition logic; the component now just consumes `{ confirming, step }`.

## Gates (round 2)

- `bunx tsc --noEmit -p apps/fe` → 0; `-p packages/api-client` → 0.
- `bun test src/pages/settings` → **1439 pass / 0 fail** (72 files).
- `bun test src/` (apps/fe) → **2843 pass / 0 fail** (177 files); +10 over the committed 2833.
- `packages/api-client` `bun test` → 282 pass / 0 fail.
- `bunx biome check apps/fe/src packages/api-client/src` → clean.
- `bun scripts/complexity/gate.ts` → **complexity gate ok** (whole repo; N1's earlier `hub.ts`
  violation is also gone).

## Notes for the commander / N1

- `precheck`'s `kind` is currently accepted and forwarded by the client only — **N1 must validate
  and honour it server-side** (`setup-routes.ts` → `precheckHubUrl`), using
  `probeAddressPorts(..., { kind })` so relay discovery hits `/api/relay/health` with
  `ok === true`. Until then the relay form's probe still resolves against `/healthz`; the client
  side of finding 3 is done and the wire field is in place.
- Findings 1, 2 and 6 are backend/CLI and were left to N1 as assigned.
