# Task B3 — Join-token v2 with CA fingerprint; hub-side CA exposure; node-side CA trust for hub-client and uplink; CLI parity

Read first:
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch2.md → section "Join-token v2 (batch 2 B3)" is your spec
- prompt-archives/2026082900-hub-ui-tls/sub/explore-backend.md → section 7 (token format, producers/consumers, trust seams) and section 3 (Bun fetch/WebSocket `tls.ca` facts)
- prompt-archives/2026082900-hub-ui-tls/sub/b2-result.md → `TlsService.status().caFingerprint` and `caPem()` are the hub-side sources; `tls-config-store` for reading
- prompt-archives/2026082900-hub-ui-tls/sub/b1-result.md → `performHubJoin` (you extend it; it is now the single join implementation for CLI and setup API)

Another grok task (B2b) is concurrently editing `packages/app/src/runtime/{assemble.ts,server.ts,local-routes.ts}` and `apps/gateway/src/db/managed-migrations.ts` (appending `0021`). Do NOT touch assemble.ts/server.ts/local-routes.ts. For `managed-migrations.ts`: do your append (`'0022_hub_trust.sql'`) as the LAST step of your task, re-reading the file immediately before editing.

## Deliverables

1. **Shared** `packages/shared/src/auth/enrollment.ts` (+ tests): `JoinToken` gains `caFingerprint?: string`; `encodeJoinToken(sk, rootPk, headHash, caFingerprint?)` emits `<128 base64url>` or `<128 base64url>.<64 lowercase hex>`; `decodeJoinToken` accepts both, validates the hex segment strictly, rejects anything else with a clear error. Keep the browser-safe constraints (no node imports).

2. **Browser encoder** `apps/fe/src/node/enrollment.ts` `encodeJoinTokenZeroing(...)`: same optional segment. The fingerprint comes from the hub enrollment-created response (`ca_fingerprint`) — thread it through `apps/fe/src/node/hub-api.ts` types (`HubEnrollmentCreated`) and whatever call site in `apps/fe/src/pages/nodes/enrollment-section.tsx` / `nodes-management.tsx` builds the token (minimal, surgical edits; those files belong to the frontend agents' finished work — only add the parameter plumbing). Update `apps/fe` tests that cover the encoder.

3. **Hub side** `apps/gateway/src/hub/hub-runtime.ts`: enrollment-created response includes `ca_fingerprint: string | null` and `ca_cert_pem: string | null`; `HubRuntime` gets an injected `tlsInfo: () => { caFingerprint: string | null; caPem: string | null }` provider (default null). `apps/gateway/src/mesh/auth-routes.ts` `/api/auth/mode` adds `caFingerprint: string | null` via the same provider. Add the provider to whatever deps object mesh/hub runtime construction takes (`packages/app/src/runtime/assemble.ts` will pass `() => tlsService...` — B2b owns that file; state the exact one-line wiring needed in your result and make the dep optional so nothing breaks before it is wired). `packages/api-client/src/auth/types.ts` `AuthModeResponse.caFingerprint?: string | null`.

4. **Node side trust store**: new table `hub_trust` (`hub_url` text pk, `ca_pem` text, `fingerprint` text, `created_at`) in `apps/gateway/src/db/schema.ts`, migration `0022_hub_trust` (drizzle-kit generate or hand-written SQL + journal + snapshot; `bunx drizzle-kit check` must pass), `apps/gateway/src/auth/hub-trust-store.ts` (+ test): `get(hubUrl)`, `put({hubUrl, caPem, fingerprint})`, `delete(hubUrl)`.

5. **Join** (`packages/app/src/commands/hub.ts` `performHubJoin`): when the decoded token has `caFingerprint`: fetch `GET <hubUrl>/api/tls/ca.crt` with `tls: { rejectUnauthorized: false }` for that single request only; parse PEM, compute SPKI sha256 (reuse `spkiFingerprint` from `packages/app/src/tls/cert-authority.ts`); mismatch → `JoinError('join_failed', 'ca_fingerprint_mismatch')`; on match build a `fetcher` = `(input, init) => fetch(input, { ...init, tls: { ca: [pem] } })` used for all subsequent hub-client calls in this join, and persist to `hub_trust` inside the same commit as the join (or immediately after `commitVerifiedJoin` succeeds). Without a fingerprint: unchanged behaviour. `assertHubJoinUrl` unchanged. Tests in `join.test.ts` with an injected fetcher covering v1 token, v2 match, v2 mismatch.

6. **Uplink** `apps/gateway/src/mesh/uplink-client.ts` default `wsFactory`: accept an optional `tlsCa: string[] | null` resolved by `mesh-runtime.ts` from `hub_trust` for `config.hubUrl` at construction (`new WebSocket(url, { tls: { ca } })` when present). `packages/app/src/lib/hub-client.ts` callers in `enroll.ts` (non-hub polling) use a fetcher built from `hub_trust` too — add a helper `createHubFetcher(hubTrustStore, hubUrl): typeof fetch` in `packages/app/src/lib/hub-client.ts` and use it in `enroll.ts`.

7. **CLI `enroll`** (`packages/app/src/commands/enroll.ts`): when the local node is the hub and TLS mode is selfsigned, include the CA fingerprint in the printed join token (read via `TlsConfigStore` + `spkiFingerprint`); non-hub `enroll` gets it from `/api/auth/mode.caFingerprint`.

8. **Docs**: update `docs/hub/2026082800-hub-node-operations.md` join-token description (v1/v2 format, CA pin semantics, that the pin is per hub URL and stored in `hub_trust`), in Simplified Chinese matching the doc style. Keep it short.

## Scope (files you may touch)
- packages/shared/src/auth/enrollment.ts (+ test)
- apps/fe/src/node/{enrollment.ts,hub-api.ts} (+ tests), minimal plumbing in apps/fe/src/pages/nodes/{enrollment-section.tsx,nodes-management.tsx}
- apps/gateway/src/hub/hub-runtime.ts (+ test), apps/gateway/src/mesh/{auth-routes.ts,uplink-client.ts,mesh-runtime.ts,mesh-deps.ts} (+ tests), apps/gateway/src/db/schema.ts, apps/gateway/drizzle/** (0022), apps/gateway/src/auth/hub-trust-store.ts (+ test), apps/gateway/src/db/managed-migrations.ts (append only, last step)
- packages/app/src/commands/{hub.ts,enroll.ts,join.test.ts,enroll.test.ts}, packages/app/src/lib/hub-client.ts (+ test)
- packages/api-client/src/auth/types.ts
- docs/hub/2026082800-hub-node-operations.md
Forbidden: packages/app/src/runtime/**, packages/app/src/tls/** (read-only reuse), locale files, other fe files.

## Baselines (current)
packages/app 308/0 tsc 1; apps/gateway 2445/0 tsc 21; packages/shared 335/0 tsc 0; apps/fe `bun test src/` 413/0 tsc 0; api-client 128/0 tsc 5.

## Result
`prompt-archives/2026082900-hub-ui-tls/sub/b3-result.md` — include the exact one-line wiring B2b/commander must add in assemble.ts for the `tlsInfo` provider.
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
