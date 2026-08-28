## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: final-review fixes, batch A (hub redeem PoP, peer-name spoof, unhandled rejection)

Scope: `apps/gateway/src/hub/**` (+tests), `apps/gateway/src/mesh/peer-manager.ts` (+test), `apps/gateway/src/mesh/mesh-routes.ts` (+test), `packages/app/src/commands/hub.ts` only if the join flow must send a proof. Other agents are editing `apps/gateway/src/mesh/rtc/**`, `packages/shared/src/link/**`, `forwarder.ts`, `mesh-http.ts`, `link-stream-carrier.ts` — do not touch those.

Read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-final.md` sections 4, 6 and the "Should-fix：失败的 DC upgrade retry 产生未处理 Promise rejection" item in section 7. Fix:
1. **Redeem proof-of-possession (§4):** binding a new enrollment token to an EXISTING nodeId must require proof that the redeemer holds that node's Ed25519 private key — e.g. the redeem request carries a signature over (enrollment_id, nodeId, cert bytes/hash) by the node key, verified against the stored ed_pk; without/with a bad proof → 409 `node_exists`. Same-token exact replay stays idempotent. Check what the CLI join already sends (`packages/app/src/commands/hub.ts` → `redeem`), add the proof there if a new field is needed, keep backward compatibility for first-time redeems. Tests for: same key + valid PoP → ok; same key without PoP → 409; different key → 409.
2. **Peer-name spoof (§6):** `peer status` from a peer must NOT update the display name in `peer_cache`/DTO; names come only from hub `node.list` or the local hub registry (fallback to id). Adjust `applyPeerStatus` in peer-manager.ts and the name priority in mesh-routes.ts; tests: a peer advertising a different name does not change what `/api/mesh/nodes` shows.
3. **Unhandled rejection (§7 should-fix):** `void pending.finally(...)` at the upgrade-retry site in peer-manager.ts must attach a `.catch(() => {})` (or handle/log the failure); add a test that a rejected upgrade does not produce an unhandled rejection (Bun: `process.on('unhandledRejection')` counter in the test).

Verification: `cd apps/gateway && bun test src/hub src/mesh/peer-manager.test.ts src/mesh/mesh-routes.test.ts` and full `bun test` 0 fail (baseline 2386+); tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-review-final-a-result.md`
