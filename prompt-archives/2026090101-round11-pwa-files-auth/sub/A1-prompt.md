# A1 — Frontend: silent cross-node sign-in that survives PWA relaunch

## Context

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo (`bun`, not node). **Other agents are editing other parts of this worktree in parallel. Only touch the files listed under "Scope". Do not run any git command (no add/commit/stash/checkout).** Commander commits.

Language: code comments only where logic is non-obvious, in Simplified Chinese like the surrounding code. Reply/report in English.

### Problem

Mesh auth (read `docs/hub/2026082700-hub-node-architecture.md` §2 first, then `apps/fe/src/auth/session-key-store.ts`, `apps/fe/src/auth/session-login.ts`, `apps/fe/src/auth/use-node-login.ts`, `apps/fe/src/auth/NodeLoginButton.tsx`, `apps/fe/src/pages/devices/node-device-group.tsx`, `apps/fe/src/pages/LoginPage.tsx`, `packages/shared/src/auth/{delegation,login,encoding,root-key}.ts`, `packages/api-client/src/auth/*`):

- The browser signs in to the entry node with a password → derives root key → generates an ephemeral Ed25519 `sk_sess` + a root-signed `delegation` (TTL exactly 18 h, verified by nodes) → logs in to the entry. Remote nodes B are logged in lazily via `ensureNodeLogin()` using the same `sk_sess`/delegation (challenge → `signLogin` → B issues its own `tmex_s_<B>` cookie).
- `sk_sess`/delegation are **memory-only** (`session-key-store.ts`). Consequence: on an iOS PWA every cold launch is a new document → the entry node is still logged in (HttpOnly cookie), but `sk_sess` is gone → every remote node shows "Sign in to this node" and asks for the password again, one node at a time. That is the user's complaint.
- Additionally, the Devices page (`node-device-group.tsx:~150`) renders `NodeLoginButton` for an online-but-not-logged-in node instead of going through the silent gate `useNodeLoginGate()`, so even with a live session key the user must click.

### Design decision (already made — implement it, do not re-litigate)

1. **Persist the session key across documents, without ever exposing the private key bytes to JS**:
   - When `crypto.subtle` supports Ed25519 (`generateKey({name:'Ed25519'}, false, ['sign','verify'])` succeeds — Safari 17+, Chrome 137+, Firefox 130+), generate `sk_sess` as a **non-extractable** WebCrypto `CryptoKey` and sign logins with `crypto.subtle.sign('Ed25519', key, encodeLogin(login))` (the signature is standard 64-byte Ed25519, identical to `@noble` output, so the gateway needs no change). Export the public key raw (32 bytes) for the delegation.
   - Store `{ info (SessionKeyInfo), privateKey: CryptoKey (non-extractable), sessPk, delegationBytes, delegationSig }` in **IndexedDB** (structured clone of a non-extractable CryptoKey is supported and keeps it non-extractable). Database name e.g. `tmex-auth`, single object store, single record keyed by entry node id or a constant. **Never persist `kTotp` or `totpCode`** — TOTP-enabled password sessions keep today's behaviour (`TOTP_REQUIRED` → manual code entry on the login page). Passkey-method sessions may be persisted the same way (their `delegationSig` is the encoded WebAuthn assertion — it is not secret).
   - When WebCrypto Ed25519 is unavailable, fall back to the current `@noble` raw-key path and **do not persist** (memory-only as today). Detect once and cache.
   - On module init / first `ensureNodeLogin()`/`hasSessionKey()` call, **restore** from IndexedDB if the record exists and `expiresAt` is in the future; drop expired records. Restoration is async → `hasSessionKey()` is sync today; introduce an async `restoreSessionKey()` that the gate awaits (e.g. `ensureNodeLogin` awaits restore before deciding `NO_SESSION_KEY`; `useNodeLoginGate` stays `pending` until restore settled). Keep `getSessionKey()` sync for callers that only display state.
   - `clearSessionKey()` must also delete the IndexedDB record. Find the logout path(s) (search for `clearSessionKey` / logout API in `apps/fe/src` and `packages/api-client`) and make sure logout clears persistence.
   - Wrap every IndexedDB access in try/catch: private mode / quota / blocked → behave as memory-only, never throw into the UI.
   - Rationale to document (update `docs/hub/2026082700-hub-node-architecture.md` §2 constraint text and add a short section, in Chinese, following `docs` conventions): the persisted key is non-extractable and bounded by the 18 h delegation TTL; an on-origin XSS could use it to sign logins while the page is open, which is the same exposure class as the existing HttpOnly `tmex_s_*` cookies (an XSS can already call the API with them); device theft exposure is bounded by the same 18 h. Nothing about the node-side verification changes; a stolen node session still cannot be replayed elsewhere.

2. **Silent login on the Devices page**: in `node-device-group.tsx`, for online nodes that are not logged in, run the silent gate (`useNodeLoginGate(nodeId)` or `ensureNodeLogin` directly with the known row) and show a small pending state; only when the gate is `blocked` render the existing `NodeLoginButton` (fallback to `/login?node=<id>&next=…` with username prefilled — that already exists). Do not fan out to all nodes on page load unless the node group is actually rendered/expanded on screen — check how the page renders groups; if all groups are rendered at once, login attempts for all online-not-logged-in nodes are acceptable (they are cheap, one challenge+login each), but they must be sequential-per-node deduped (already handled by `nodeLoginsInFlight`).

3. **Failure UX**: when a silent attempt fails with a credential/auth failure (anything other than `NETWORK_ERROR`/`NODE_LIST_FAILED`), show the existing button plus a one-line hint. Add i18n keys only if a suitable key does not already exist; if you add keys, edit `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` (all three, zh_CN is the source language; follow `/Users/konata/code/tmex-copy-guidelines.md` — read it before writing any copy) and tell the commander in your report; **do not run `build:i18n` yourself** and do not edit `packages/shared/src/i18n/resources.ts`/`types.ts`.

## Scope (files you may edit)

- `apps/fe/src/auth/**` (all files, including tests)
- `apps/fe/src/pages/devices/node-device-group.tsx` and its test(s)
- `apps/fe/src/pages/LoginPage.tsx` only if strictly needed
- `packages/shared/src/auth/**` only to add small exported helpers (e.g. a `SessionSigner` type or a WebCrypto Ed25519 feature-detect helper); do not change existing function signatures used by the gateway (`signLogin`, `verifyLogin`, `createDelegation` …) — the gateway (`apps/gateway`) must keep compiling untouched.
- `packages/shared/src/i18n/locales/*.json` (only your new keys)
- `docs/hub/2026082700-hub-node-architecture.md` (the §2 constraint + a short new subsection)
- `apps/fe/tests/mesh-login.spec.ts` + `apps/fe/tests/helpers/mesh.ts`: add a mesh-project e2e case: sign in to home → SPA-navigate to Devices → remote node becomes logged in **without** the password form; and `page.reload()` before opening the remote node → still silent (persisted key). Note the helper comment says reload loses the session key — update that comment. Do not run the e2e suite yourself (it takes >10 min and conflicts with other agents' vite HMR); the commander runs it.

## Verification (must pass before you report)

- `cd apps/fe && bun test src/` — baseline 1098 pass / 0 fail; your new tests add to it. Unit-test the IndexedDB persistence with a fake `indexedDB` (bun test has no IndexedDB; use a minimal in-memory fake or `fake-indexeddb` only if it is already in node_modules — check `ls node_modules/fake-indexeddb`; do not add dependencies) and a fake `crypto.subtle` that records `sign` calls; test restore/expiry/clear-on-logout/fallback-to-memory paths.
- `cd apps/fe && bunx tsc --noEmit -p .` — baseline 0 errors.
- `cd packages/shared && bun test` — baseline 392 pass; `bunx tsc --noEmit -p .` 0 errors.
- `cd apps/gateway && bunx tsc --noEmit -p . 2>&1 | grep -c 'error TS'` must stay at the baseline **21** (pre-existing, unrelated).
- `bunx biome check <each file you touched>` clean (do not use `--write` on files you did not touch; do not lint generated files).

## Report

Final message: what you changed (file list), the persistence format, how restore is sequenced with the gate, any i18n keys added, test counts before/after, and anything you could not finish. Keep it under 500 words.
