# Task F3 — HTTPS configuration section (external proxy / self-signed CA / Let's Encrypt) in the Settings "Nodes" tab

Read first:
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch2.md (TLS API contract — backend implemented in parallel; code strictly against it)
- prompt-archives/2026082900-hub-ui-tls/sub/f1-result.md (the tab shell you plug into: `apps/fe/src/pages/settings/nodes/nodes-tab.tsx`, `local-machine-card.tsx`, `use-local-status.ts`; api-client `packages/api-client/src/local/`)
- prompt-archives/2026082900-hub-ui-tls/sub/explore-frontend.md (UI kit, i18n, test conventions)
- prompt-archives/2026082900-hub-ui-tls/plan-00.md

Task F2 (wizard) is still running in `apps/fe/src/pages/settings/nodes/setup/**` — do not touch that directory. Task F1 is finished; you may now edit `nodes-tab.tsx` to insert your section.

## Deliverables

1. **api-client** `packages/api-client/src/local/tls-types.ts` (types mirroring the contract: `TlsStatusResponse`, `TlsMode`, `TlsUpdateRequest` union, `TlsAcmeStatus`…) and `tls-api.ts` (+ test): `class TlsApi { status(); update(req: TlsUpdateRequest); renew(); caDownloadUrl(): string /* '/api/tls/ca.crt' via resolveNodeUrl for self */ }` with the same typed-error pattern as `local-api.ts`. Add `export * from './tls-types'; export * from './tls-api';` to `packages/api-client/src/local/index.ts`. Also widen `LocalTlsStatus.mode` in `types.ts` if needed (keep it compatible).

2. **HttpsSection** `apps/fe/src/pages/settings/nodes/https/https-section.tsx` (+ sub-components in the same dir, + tests):
   - Header: current mode badge, listener state (running on port / stopped / error), certificate summary (subject, SANs, valid until with days-left, issuer), `restartRequired` banner with a "Restart now" button reusing the same inline restart poll approach as `local-machine-card.tsx` (copy the small helper into `https/` rather than importing from setup/).
   - Mode chooser (3 cards + "none"): **External reverse proxy** (explain: TLS is terminated by Cloudflare Tunnel / nginx / caddy; toggle `trustProxy` with explanation of what it changes: cookie Secure + passkey origin; save → PUT external), **Self-signed (private CA)** (SANs editor: chips/list of hostnames/IPs, prefilled with `window.location.hostname` when not localhost; tlsPort (default 9443) + bindHost (default 0.0.0.0); save → PUT selfsigned; after success show CA fingerprint, "Download CA certificate" link (`<a href={caDownloadUrl} download>`), and a collapsible per-platform install guide: macOS Keychain, iOS profile, Windows certmgr, Android, Linux `update-ca-certificates`; "Renew certificate" button → POST renew), **Let's Encrypt** (domain, email, challenge radio http-01 / dns-01, Cloudflare API token field shown for dns-01 (password input; if `hasCloudflareToken` show "token stored — leave empty to keep"), staging checkbox (default off) with a note about rate limits, tlsPort/bindHost; save → PUT acme; status area polls `GET /api/tls` every 3 s while `acme.status==='pending'`; show lastError with plain-language hints: http-01 needs public port 80 → this machine's plain port (explain NAT port mapping; on Linux user services cannot bind 80 — map 80→plain port on the router or use dns-01); dns-01 needs a Cloudflare token with Zone:DNS:Edit; show nextRenewAt; "Renew now" button).
   - Port hints: never auto-detect; just text.
   - Disable the save button while a mutation is pending; toasts on success/error; map error codes (`invalid_sans`, `invalid_domain`, `invalid_email`, `cloudflare_token_required`, `invalid_port`, `port_in_use`, `tls_failed`, `not_applicable`, `no_ca`).
   - Hook `use-tls-status.ts` (React Query key `['tls-status']`).

3. **Mount** in `nodes-tab.tsx`: render `<HttpsSection />` for all modes — in standalone above the wizard (with a one-line hint that the hub public URL must be https and can be provided here or by an external proxy), in mesh below `LocalMachineCard`. Keep existing tests passing; add a test that the section renders in both modes.

4. **i18n**: keys under `nodes.https.*` in all three locale JSONs (`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`), then `bun run build:i18n` from the repo root. F1 already added `settings.tabGroup.nodes` and `nodes.machine.*`; F2's `nodes.setup.*` keys are merged separately by the commander — do not add any `nodes.setup.*` keys.

## Scope (files you may touch)
- packages/api-client/src/local/{tls-types.ts,tls-api.ts,tls-api.test.ts,index.ts,types.ts}
- apps/fe/src/pages/settings/nodes/https/** (new), apps/fe/src/pages/settings/nodes/nodes-tab.tsx (+ its test)
- the three locale JSON files (only `nodes.https.*`) + generated i18n via the build script
Forbidden: `apps/fe/src/pages/settings/nodes/setup/**`, everything under apps/gateway and packages/app.

## Baselines (after F1)
apps/fe `bun test src/` 385 pass / 0 fail, tsc 0; packages/api-client 115 pass, tsc 5 (pre-existing); packages/shared 335, tsc 0.

## Result
Write `prompt-archives/2026082900-hub-ui-tls/sub/f3-result.md` when done.
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
