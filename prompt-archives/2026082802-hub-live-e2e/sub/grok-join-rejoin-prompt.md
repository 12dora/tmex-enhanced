## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: `hub join` fails with `UNIQUE constraint failed: users.username` when re-joining a rebuilt hub

Scope: `packages/app/src/commands/hub.ts` (+ `hub.test.ts` / `join.test.ts`), the gateway auth/user store code that `hub join` writes through (grep `ensureNodeIdentity`, `userStore`, `insertUser`/`createUser`, `user_key_log` writers under `apps/gateway/src/auth/**` and `apps/gateway/src/mesh/auth-*.ts`), `docs/hub/2026082800-hub-node-operations.md` (§灾难恢复 / §加入). Do NOT touch `apps/gateway/src/mesh/peer-manager.ts`, `apps/gateway/src/mesh/rtc/**`, `scripts/**`, `apps/fe/**`.

Real reproduction today (2026-08-28): node `home` had joined hub H1 as user `alice`. H1 was destroyed and a new hub H2 was created with a fresh root key, same username `alice`. On `home`: `hub leave` (role → standalone), then `hub join https://… --token <H2 token> --name home` → `UNIQUE constraint failed: users.username`, join aborted. The design doc (`docs/hub/2026082700-hub-node-architecture.md`) and ops doc say after `reset-root` / hub rebuild every other machine must `enroll` + `hub join` again — so join MUST succeed when a user row with the same username but a different uid/root key already exists locally.

Required behavior: `hub join` verifies the token's chain as today, then atomically replaces the local user state for that username: delete the stale user's `user_key_log`, `user_keys` (passkeys/TOTP), `node_sessions`, `node_certs` issued under the old root, `peer_cache`/`nodes` rows tied to the old hub if any, and the old `users` row; then insert the new user/log/certs/`node_identity` as in a fresh join. Keep the node's own identity keypair (nodeId stays stable) unless the design requires otherwise — check `ensureNodeIdentity`. If the SAME root key / same uid joins again (idempotent re-join to the same hub), it must also succeed without duplicating rows (upsert). Print a clear message when stale state was replaced (i18n key in `packages/app/src/i18n`, zh-CN + en + ja if the file has three locales). Also make `hub leave` NOT the prerequisite: joining directly from role `node` to a different hub must work (leave is just role/env cleanup).

Tests (TDD): unit test on the join write path with a pre-existing user of same username/different uid; same-uid idempotent re-join; and if there is an existing integration test that joins a node to a hub (grep `hub join` / `runHubJoin` under `apps/gateway/src/mesh/integration` and `packages/app/src/commands/*.test.ts`), extend it with "hub rebuilt → node re-joins".

Verification: `cd packages/app && bun test src` 0 fail (baseline 240 pass), `cd apps/gateway && bun test` 0 fail (baseline 2336), tsc ≤ baselines (app 1, gateway 21), biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-join-rejoin-result.md`
