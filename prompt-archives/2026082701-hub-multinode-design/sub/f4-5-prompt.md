# Task F4-5 — remaining frontend review items after F4-fix / F4-4

You are a senior frontend engineer in the git worktree `/Users/konata/code/tmex-enhanced-wt-hub` (branch `feat/hub-node`). Concurrent: grok agents edit `apps/gateway/**`; Opus F3-1-fix may still be editing `packages/ws-client/src/{direct/**,carrier-switch.ts,client.ts}` and `apps/fe/src/node/node-runtimes.ts` — if `sub/f3-1-fix-result.md` exists those files are free, otherwise avoid them. **Only touch files in your scope. Never run git commands that change state. Do not run `bun install`.** Bun `/Users/konata/.bun/bin/bun`; `cd apps/fe && bun test src/`, `cd packages/stores && bun test`; tsc per package; biome. Baselines: fe (see `sub/f4-4-result.md` for the latest count) / tsc 0; stores 123 / 1.

Review `sub/f4-fix-review.md` — coordinator decisions: items about passkey node management are done by F4-4 (`sub/f4-4-result.md`); the `hub=sync` server behaviour is fixed by B2-6 (`sub/b2-6-result.md`: hub rejection → 409 with nothing persisted, timeout → 504 `HUB_TIMEOUT`; the UI keeps pending and offers retry with the SAME record only when the server says nothing was persisted; adapt the NodesPage logic to those codes). The backend will filter passkey login options by exact origin (queued) — the frontend must NOT fall back to `allowCredentials[0]`: if no trusted origin metadata is available, pass the server's list unchanged to WebAuthn and let the browser choose (no client-side pick), and remove the `rp_id` fallback in `passkeysForOrigin`.

Fix each with a regression test:
1. Stale storage purge: on load, any pending record containing `enrollSk`/`joinToken` or unknown secret-looking fields → delete the storage key immediately and rewrite only the public projection.
2. Passkey selection as decided above (no `[0]` fallback; exact-origin only).
3. NodesPage `hubAck` handling per B2-6 codes; retry re-sends the identical stored record bytes, never re-signs a new seq.
4. 4401 wiring through the real host factory: `appNodeRuntimes`/`createNodeConnection` must pass the close-code hook so `node-connection-manager` receives 4401 from the actual `ws-client` connection; test through the real host construction path (no manual `notifyClose`).
5. Seed/key ownership: `try/finally` from creation for enrollment (hub request failure), password change (second Argon2 failure), and passkey session setup (user cancel); `encodeJoinToken` caller zeroes the temporary 96-byte array (if the shared encoder copies internally, wrap and zero the copy — report if the shared function must change).
6. Shell-quote the join command URL with the existing `shellQuote()` after validating it is an https URL.
7. Polling path emits `unknown` outcomes like the push path (warning toast).
8. Register `disposeNodeQueryClient(nodeId)` on the real manager instance's dispose callback.
9. Fix `apps/fe/src/node/mesh-events.test.ts` "ENROLL_REDEEMED 缺证书 / 签名长度不对时作废" to match the tightened `EnrollRedeemedSchema` (`certSig` fixed 64 bytes, `enrollPk` 32) — decoder must return null for malformed frames; add the i18n key used by `node-runtimes.ts` direct-disconnect toast (currently `defaultValue`).

File scope: `apps/fe/src/auth/**`, `apps/fe/src/node/{enrollment,enrollment-watch,node-runtimes}*.ts` (node-runtimes only if F3-1-fix is finished), `apps/fe/src/pages/NodesPage*`, `packages/stores/src/node-connection-manager*.ts`, i18n locale JSON. Result: `prompt-archives/2026082701-hub-multinode-design/sub/f4-5-result.md`.
