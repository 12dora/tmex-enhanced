# T1 — make CI green: fix the deterministic test failures and tsc baseline

Result file (write it when done, then exit): /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T1-result.md

## Scope (files you may edit)
- apps/gateway/src/relay/relay-hardening.test.ts
- packages/panels/src/device-folders/device-folder-tree.test.tsx and, if you choose the runner approach, packages/panels/package.json (only the `test` script) and a new small script under packages/panels/scripts/
- packages/stores/src/host-services.test.ts
- packages/api-client/src/client.test.ts, packages/api-client/src/files-download.test.ts
- packages/app/src/lib/native-datachannel.ts (only the dynamic import line) — or apps/gateway/tsconfig.json if you go the `allowImportingTsExtensions` route AND it is a noEmit-only config (verify first).
- scripts/ci/unit-tests.ts (optional improvement, see 5)
- apps/gateway/src/mesh/auth-routes.ts + its test (see 6)

## Tasks

1. `cd apps/gateway && bun test src/relay` passes all 126 tests but reports `2 errors` ("Unhandled error between tests", `LinkError: relay-rst`) and exits 1, which fails CI on every push. Root cause (already diagnosed): `relay-hardening.test.ts:198` does `void stream.readable.getReader().read();` with no catch; on harness cleanup `abortBoth()` resets both sides synchronously over `InMemoryLink`, the pending `read()` rejects and nobody observes it. Fix the test properly: keep the readers, cancel/await them before harness cleanup or attach a `.catch(() => undefined)`. Do NOT change `packages/shared/src/link/mux.ts` or the relay router, do NOT add global unhandledRejection filtering. Verify `bun test src/relay` → 0 errors, exit 0. Then run the full `cd apps/gateway && bun test` and confirm exit 0.

2. `cd packages/panels && bun test` → 907 pass / 15 fail. Root cause: `packages/panels/src/device-folders/device-folder-tree.test.tsx:11` does a process-wide `mock.module('react-i18next', …)` returning raw keys, polluting the other test files in the same process (chat-thread, files-tab, files-node-section, watch-rule-list, watch-rule-state-view, use-row-action-items, tool-call-card). Preferred fix: remove the `mock.module` from that test and instead render with the real i18n (look at how sibling tests in packages/panels initialise i18n — e.g. `files-tab.test.tsx` / `chat-thread.test.tsx` — and mirror that; assert on translated text or on structure instead of raw keys). Alternative if the real-i18n route is genuinely not feasible: make the panels `test` script run mock.module-using files in isolated processes like `scripts/ci/unit-tests.ts` does. Verify `bun test` in packages/panels → 0 fail.

3. tsc baseline to zero:
   - packages/stores: `host-services.test.ts:65` helper type lacks `value` (used at :93) → add `value: string`.
   - packages/api-client: `client.test.ts:41/:47` mock inferred as zero-arg tuple → annotate the mock with the proper fetch-like signature; `files-download.test.ts:11` `Uint8Array<ArrayBufferLike>` not assignable to `BodyInit` → build the body from an `ArrayBuffer` / `new Blob([...])`.
   - apps/gateway: the single TS5097 comes from `packages/app/src/lib/native-datachannel.ts:135` (dynamic import with a `.ts` suffix). Check how that import is resolved at runtime (Bun handles both) and whether `packages/app` build (`bun build --target node` for the CLI, `--target bun` for runtime) needs the extension; if removing the `.ts` suffix is safe for the bundlers, do that. Otherwise document why and leave it.
   Verify with `bunx tsc --noEmit -p .` in each of packages/stores, packages/api-client, apps/gateway → 0 errors (or explain the one you couldn't clear).

4. Run the root `bun run lint` — must stay green.

5. Optional (only if cheap): in `scripts/ci/unit-tests.ts`, make the gateway retry target per test *file* instead of per directory so a failure is isolated to the file; keep exit-code semantics, do not filter by error text.

6. Backend part of the "login username shows a UUID" bug: `GET /api/auth/mode` (apps/gateway/src/mesh/auth-routes.ts ~:263-277) returns `username: user.username`. On nodes that joined via `tmex relay join` / `tmex hub join`, the user row's `username` is the key-log genesis uid (a UUID) because `packages/app/src/commands/relay-join.ts:338` passes `genesisUid` as username and `verifyChainForJoin` in `apps/gateway/src/auth/user-key-service.ts:522` does the same. Change `/api/auth/mode` to return `username: null` when the stored username equals the user id (or matches a UUID / 32-hex pattern), so the UI never sees an identifier as a display name. Add/adjust the test in `apps/gateway/src/mesh/auth-routes.test.ts`. (The frontend side is being handled by another agent: it will no longer prefill the field and will fall back to `mode.uid` when the username is empty or when `mode.username` is null.)

Baselines: apps/gateway `bun test` = 4312 pass / 0 fail (+ the 2 errors above); packages/panels 907/15; stores tsc 1 error, api-client tsc 5, gateway tsc 1; root lint green.
