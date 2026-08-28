## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: enrollment redeem returns `409 node_exists` when the same node re-joins (re-enroll after a failed/partial join or hub rebuild)

Scope: `apps/gateway/src/hub/**` (enrollment redeem / nodes registry + tests), `apps/gateway/src/mesh/integration/**` (extend an existing join integration test), `packages/app/src/commands/hub.ts` only if the CLI must change ordering, `docs/hub/2026082800-hub-node-operations.md` (§加入 / 排障 table). Do NOT touch `apps/gateway/src/mesh/rtc/**`, `peer-manager.ts`, `scripts/**`, `apps/fe/**`.

Real reproduction (2026-08-28): node `home` (stable nodeId, stable identity keypair) ran `hub join` with token T1; the hub's redeem succeeded and created the `nodes` row, but the node's local write failed (that local bug is fixed in commit 33f7484). The user then ran `enroll` again on the hub (token T2) and `hub join --token T2` on `home` → hub replies `HTTP 409 node_exists` and the node is stuck: it cannot join and the operator has no CLI to clear the stale row except the destructive `hub user reset`.

Required: redeem must be idempotent for the same node identity. When the redeeming node's public key equals the existing `nodes` row's public key (same nodeId), accept the redeem: replace the row's enrollment/cert fields (new cert from the new enrollment, name update if provided), keep online state, and let the enroller's admit flow proceed as for a new node. Only reject with `node_exists` when the nodeId collides with a DIFFERENT public key (identity mismatch). Also: if the existing row is for a revoked node, decide per the design doc (`docs/hub/2026082700-hub-node-architecture.md` §吊销 / registry) — likely re-admit requires a fresh admit-node record which the enroller signs anyway; document the choice. Add tests: same key re-redeem succeeds and yields one row; different key → 409; and extend the mesh join integration test with "node joins twice (second enrollment) and stays reachable".

Verification: `cd apps/gateway && bun test` 0 fail (baseline 2351), tsc ≤ 21, biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-hub-redeem-result.md`
