## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: `GET /healthz` reports `env: development` under a production install

Scope: `apps/gateway/src/**` files that implement healthz and config/env loading, `packages/shared/src/env/load-env.ts` and its tests. Do NOT touch `apps/gateway/src/mesh/**`, CLI code under `packages/app`, or any harness under `scripts/`.

Symptom: on a packaged production install (launchd service, env from installed `app.env` + `run.sh` exporting `NODE_ENV=production`), `curl /healthz` returns an `env` field equal to `development`. This predates the current branch. Find the exact source of the value (grep `healthz`, `env:` in gateway; check `loadEnv()` in `packages/shared/src/env/load-env.ts` and `docs/env/2026061301-three-tier-env.md`; check `apps/gateway/src/config.ts` or similar for how NODE_ENV is read, and whether a build-time constant / vite define / bun build `--define` bakes it in — look at `packages/app/scripts/build-runtime.ts`). Reproduce with a temporary instance in the repo (NOT the production install): start the gateway with `NODE_ENV=production` and temp env overrides (`DATABASE_URL=<tmp>`, `GATEWAY_PORT=19984`, `TMEX_BIND_HOST=127.0.0.1`, `TMEX_MASTER_KEY=$(openssl rand -hex 32)`, `TMEX_FE_DIST_DIR`, `TMEX_MIGRATIONS_DIR` pointing to repo paths) both from source and from the built runtime (`packages/app/dist/runtime/server.js` exists — rebuild with `bun run build:runtime` only if needed) and show the healthz output before/after your fix. Fix the root cause, add/adjust a unit test. Keep the fix minimal.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-healthz-result.md`
