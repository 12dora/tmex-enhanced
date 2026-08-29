# F3 result — HTTPS configuration section (external / self-signed / Let's Encrypt)

Status: **done**. All deliverables implemented; tests and type checks at or above the baselines given.

## Files changed

### api-client (`packages/api-client/src/local/`)

- **new** `tls-types.ts` — line types mirroring the batch-2 contract: `TlsMode`, `TlsChallenge`, `TlsAcmeState`, `TlsCertificateInfo`, `TlsListenerStatus`, `TlsAcmeStatus`, `TlsStatusResponse`, the four `TlsUpdate*Request` members and their union `TlsUpdateRequest`, plus `TlsErrorCode`, `DEFAULT_TLS_PORT` (9443), `DEFAULT_TLS_BIND_HOST` (`0.0.0.0`), `TLS_RENEW_WINDOW_DAYS` (30).
- **new** `tls-api.ts` — `class TlsApi { status(); update(req); renew(); caDownloadUrl() }` on an injected `ApiClient` (defaults to `defaultApiClient`, i.e. the entry machine). Typed errors follow `local-api.ts`: `TlsApiError { code, message, status }` parsed from `{ error: { code, message } }`, tolerating the legacy `{ error: "code" }` envelope. Paths are built through `resolveNodeUrl(SELF_NODE_ID, …)` and exported as `TLS_PATH` / `TLS_RENEW_PATH` / `TLS_CA_PATH`; `caDownloadUrl()` returns `client.url(TLS_CA_PATH)` so it can go straight into `<a href download>`. Exports `defaultTlsApi`.
- **new** `tls-api.test.ts` — 13 tests with a recorded transport: GET/PUT/POST URL + method + body assertions for all four modes (incl. "acme without `cloudflareToken` must not put the key in the body"), 401 / `invalid_sans` / `port_in_use` / `not_applicable` typed errors, unparseable-body fallback, legacy envelope, and `caDownloadUrl()` for both an empty and a `/n/<id>` baseUrl.
- `index.ts` — added `export * from './tls-types'; export * from './tls-api';`.
- `types.ts` — `LocalTlsStatus.mode` now references the shared `TlsMode` instead of repeating the literal union (wire-compatible, keeps the two in sync).

Cross-checked against the backend that landed in parallel (`packages/app/src/tls/tls-service.ts`, `packages/app/src/runtime/tls-routes.ts`): `TlsStatus`, `HttpsListenerState`, `ApplyModeInput` and the `port_in_use` / `not_applicable` 409s match the types above field for field.

### FE — `apps/fe/src/pages/settings/nodes/https/` (new directory)

- `use-tls-status.ts` — `useTlsStatus(api = defaultTlsApi)` on React Query, key `['tls-status']` (`TLS_STATUS_QUERY_KEY`). Returns `{ status, loading, loginRequired, error, refresh, setStatus }`; 401 becomes `loginRequired` (and is not retried); `refetchInterval` is 3 s **only** while `acme.status === 'pending'`, `false` otherwise; `setStatus` writes a mutation response straight into the cache (the PUT/renew response is the GET shape).
- `use-restart-now.ts` — the `/healthz.startedAt` restart poll, **copied** into `https/` as instructed rather than imported from `setup/` (see open issue 1).
- `tls-form.ts` — pure logic: `isValidSan` (hostname or IPv4/IPv6, rejects an all-numeric last label so `999.1.1.1` is neither a valid IP nor a valid hostname), `parseSansInput` (comma / semicolon / whitespace / newline separated, de-duplicated), `validateSans` / `validatePort` / `validateBindHost` / `validateDomain` (no wildcards) / `validateEmail` — all returning i18n keys — plus `defaultSans` (skips loopback), `daysUntil`, `formatTimestamp`.
- `tls-errors.ts` — `tlsErrorKey(code)` for the nine contract codes (plus `unauthorized`) and `describeTlsError(t, err)` falling back to `errors.unknown` with the raw message.
- `parts.tsx` — local `Notice` / `Field` / `InfoRow` / `ListenerFields` (tlsPort + bindHost, text hints only, never auto-detected) / `CopyableCode`.
- `mode-chooser.tsx` — four radio cards (external / self-signed / ACME / off) with an "in effect" marker on the mode the backend currently runs.
- `external-panel.tsx` — explanation that TLS is terminated by Cloudflare Tunnel / nginx / caddy, a `trustProxy` switch whose detail notice spells out what changes (cookie `Secure` flag + passkey origin taken from the forwarded host, forgeable if the plain port is directly reachable, env-file write → restart), save → `PUT { mode:'external', trustProxy }`.
- `sans-editor.tsx` — chip list with per-chip remove, an add field (Enter or the Add button), invalid chips highlighted.
- `selfsigned-panel.tsx` — SANs editor prefilled from `status.sans` or `window.location.hostname` (loopback excluded), tlsPort/bindHost, save → `PUT { mode:'selfsigned', … }`. Once a CA exists: a "browsers reject this until you install the CA" warning, the copyable CA fingerprint, `<a href={caDownloadUrl} download="tmex-ca.crt">`, the install guide and a **Renew certificate** button → `POST /api/tls/renew`.
- `ca-install-guide.tsx` — collapsible (`<details>`, so the content is in the DOM without hydration) per-platform steps: macOS Keychain, iOS/iPadOS profile + Certificate Trust Settings, Windows `certmgr.msc` (with the Firefox-has-its-own-store caveat), Android user CA, Linux `update-ca-certificates` / `update-ca-trust`.
- `acme-panel.tsx` — domain, contact email, http-01 / dns-01 radio cards, Cloudflare token (password input, shown for dns-01 only; "token stored — leave empty to keep" when `hasCloudflareToken`), staging switch (default off) with the rate-limit note, tlsPort/bindHost, save → `PUT { mode:'acme', … }` (the token key is omitted when left empty). Status block: state badge, in-progress spinner + "refreshes every 3 s", last attempt, next renewal, **Renew now** (disabled while pending), and on failure the raw `lastError` plus plain-language hints — http-01 needs public port 80 mapped to this machine's plain port (NAT port mapping; a user-level Linux service cannot bind 80 at all, so map it on the router or use dns-01), dns-01 needs a Cloudflare token with `Zone:DNS:Edit`.
- `https-section.tsx` — the orchestrator: card header, login-required / loading / load-failed branches, status header (mode badge, listener running-on-port / stopped / failed, certificate subject / names / issuer / valid-until with days-left or "expired"), the `restartRequired` banner with **Restart now** wired to the copied poll, the mode chooser and the panels. Save and renew share one pending flag (the save button is disabled while a mutation is in flight), write the response into the query cache, toast success, and on failure toast `describeTlsError(...)` **and** re-fetch — `409 port_in_use` still persists the mode, so `listener.error` only shows up after a refresh.
- Tests: `tls-form.test.ts` (17) and `https-section.test.tsx` (11 static-render tests: login-required, load failure, the standalone hub-URL hint, the four mode cards, the external panel + restart banner, the self-signed CA block / download link / all five guide platforms / SAN prefill and loopback non-prefill, and both ACME challenges incl. the error hints). `./use-tls-status` is replaced with `mock.module` (a *local* module path) because `src/pages/FilePage.test.tsx` globally replaces `@tanstack/react-query` for the whole `bun test` process.

### Mount

- `apps/fe/src/pages/settings/nodes/nodes-tab.tsx` — `<HttpsSection />` renders in both modes: standalone above `HubSetupWizard` with `showHubUrlHint` (one line: a hub's public URL must be https, provided here or by an external proxy), mesh below `LocalMachineCard` and above `NodesManagement`.
- `apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx` — the existing 4 tests keep passing; the standalone and mesh cases now also assert `https-section` renders, and that the hub-URL hint appears only in standalone. `./https/use-tls-status` is mocked there for the same React-Query reason.

### i18n

`nodes.https.*` added to all three locale JSONs (en_US / zh_CN / ja_JP, 152 lines each, inserted right after `nodes.machine`), then `bun run build:i18n` from the repo root. Sub-trees: `mode.{none,external,selfsigned,acme}`, `listener`, `certificate`, `external`, `selfsigned` (incl. `guide.{macos,ios,windows,android,linux}`), `acme` (incl. `status`, `hints`), `errors` (the nine contract codes + `unauthorized` + `unknown`), `validation`, plus the top-level title / description / hubUrlHint / port / bindHost / restart / save strings. No `nodes.setup.*` keys were touched. The insertion was a JSON round-trip verified byte-identical on the untouched parts (`git diff` on the three files is additive only). Generated `resources.ts` / `types.ts` were regenerated by the script and not linted.

## How to verify

```bash
cd apps/fe             && bun test src/ && bunx tsc --noEmit -p .
cd packages/api-client && bun test      && bunx tsc --noEmit -p .
cd packages/shared     && bun test      && bunx tsc --noEmit -p .
cd <repo root>         && bunx biome check apps/fe/src/pages/settings/nodes packages/api-client/src/local
```

Manual (needs the B2 endpoints): `/settings` → **Nodes** tab → the HTTPS card. Standalone shows it above the wizard with the hub-URL hint; mesh shows it under the machine card. Self-signed: add a name, save, then the CA fingerprint, the `tmex-ca.crt` download and the install guide appear; Let's Encrypt: save with staging on and watch the status block flip pending → ok/error on its own (3 s poll).

## Numbers (before → after)

| package | tests before | tests after | tsc before | tsc after |
|---|---|---|---|---|
| apps/fe (`bun test src/`) | 385 pass / 0 fail | **413 pass / 0 fail** | 0 | **0** |
| packages/api-client | 115 pass | **128 pass / 0 fail** | 5 (pre-existing) | **5** |
| packages/shared | 335 pass | **335 pass / 0 fail** | 0 | **0** |

My additions: 28 fe tests (17 `tls-form` + 11 `https-section`) and 13 api-client tests. `bunx biome check` is clean on every file I touched (locale JSONs included; generated i18n outputs were not linted).

## Open issues / notes for others

1. **The restart poll now exists three times**: `setup/use-restart-waiter.ts` (F2), the inline copy in `local-machine-card.tsx` (F1) and `https/use-restart-now.ts` (mine, copied as instructed). `packages/api-client/src/local/setup-api.ts` already exports `probeHealth` / `readHealthStartedAt`. Once all three tasks land, someone owning the whole directory should collapse the two card-level copies onto `readHealthStartedAt`; the two files are byte-identical in behaviour, so it is a mechanical merge.
2. **Transient tsc discrepancy, already resolved.** Mid-run `packages/api-client` briefly showed 6 tsc errors: `local/local-api.test.ts:72` did not carry the now-required `LocalDirectResponse.restartRequired`. Another agent fixed that test while I was working; the count is back to the 5 pre-existing errors in `client.test.ts` / `files-download.test.ts`. Nothing of mine was involved (verified by reverting my `types.ts` edit and re-running).
3. **Backend error codes for a malformed PUT body.** `tls-routes.ts` maps a non-boolean `trustProxy` and a bad `challenge` to `tls_failed` / `invalid_domain` rather than a dedicated code. The UI validates those fields client-side first, so it only matters for hand-crafted requests — no change requested, just flagging the mismatch with the contract's wording.
4. **`nodes.setup.*` keys are still absent from the three locale JSONs**, so F2's wizard currently renders raw key paths. That is the commander's merge step, per the task brief — out of my scope, listing it so it is not forgotten.
5. **ACME polling only runs while the section is mounted.** If the user leaves the Nodes tab during issuance, the status is refetched on return (React Query default), not in the background. That matches the contract (the backend keeps issuing regardless); worth knowing when reading the UX.
