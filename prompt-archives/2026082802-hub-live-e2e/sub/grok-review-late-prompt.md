## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: late-review should-fixes (re-join admit signalling, X25519 binding, hub auth-reject log hygiene)

Scope: `apps/gateway/src/hub/**` (+tests), `packages/app/src/commands/enroll.ts`, `packages/app/src/commands/hub.ts` (+tests), `apps/gateway/src/mesh/integration/mesh.integration.test.ts`. No other files (nobody else is editing now, but keep to scope).

Read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-late.md`. Fix all three should-fixes:
1. **Duplicate admit from a lagging entry:** the hub's redeem result / `enroll.redeemed` event / `GET /api/hub/enrollments/:id` poll must carry `already_admitted: true` plus the admitted certificate; the enroll CLI (and the Nodes-page path if it shares the same DTO — check `mesh-routes`/FE contract but don't edit FE) must skip `admit-node` when the hub says already admitted, regardless of local `node_certs`. Test: entry without the old cert locally, node re-joins → no second admit-node, enroll prints `already admitted`.
2. **Bind X25519 too:** the PoP/re-use check on the hub and `assertJoinCertReusable()` in the CLI must compare both Ed25519 and X25519 public keys with the current identity; mismatch → hub 409 `node_exists`, CLI refuses with a clear error.
3. **Auth-reject log hygiene:** validate `auth.response.node_id` as 32 lowercase hex before use anywhere (protocol decode), escape/normalize any logged client-provided field, and add a global (and per-remote-address if available) rate limit for auth-reject logs independent of the attacker-chosen key (e.g. max 20 lines / 10 s globally, with a `suppressed=N` summary). Tests for: non-hex nodeId rejected at decode; log volume bounded under rotating fake ids.

Verification: `cd apps/gateway && bun test src/hub src/mesh/integration/mesh.integration.test.ts` then full `bun test` 0 fail (baseline 2432); `cd packages/app && bun test src` 0 fail (247); tsc ≤ baselines; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-review-late-result.md`
