## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: TOTP login scenario in the single-machine docker hub e2e harness

Scope (only these files): `scripts/hub-e2e/run.sh`, `scripts/hub-e2e/driver/login.ts`, `scripts/hub-e2e/driver/lib.ts`, new files under `scripts/hub-e2e/driver/`, `scripts/hub-e2e/build-driver.sh`, `docs/hub/2026082801-hub-docker-e2e.md` (only the single-machine sections, do NOT edit the "分体拓扑" section or anything under `scripts/hub-e2e/split/`).

Background: `docs/hub/2026082801-hub-docker-e2e.md` describes the harness; scenarios 1–8 exist in `run.sh`. Leftover item: cover TOTP. Read `docs/hub/2026082800-hub-node-operations.md` (§账号安全 TOTP, §改密) and the gateway code: `apps/gateway/src/mesh/auth-routes.ts` (login body `totp`, error code `TOTP_INVALID`, `totpEnabled`), the CLI `hub user totp <user>` (find it under `packages/app/src` / `apps/gateway/src` — grep `totp`), and how TOTP codes are derived (grep `totp` in `packages/shared/src` — there is a TOTP implementation used for verification; reuse it to compute codes in the driver, do not reimplement if an export exists).

Add scenario 9 (after 8, before the report) to `run.sh`:
1. On the hub container run `hub user totp <user>` non-interactively (check how the CLI takes the password: `TMEX_PASSWORD` env, see how `hub user add` is invoked in run.sh) and capture the printed otpauth URI → extract the base32 secret.
2. Assert login WITHOUT totp now fails with `TOTP_INVALID` (or whatever the exact code/HTTP status is — verify in `auth-routes.ts`), and login with a wrong code fails with the same code.
3. Assert login WITH a correct code (driver `login.ts` gains `--totp-secret <base32>` that computes the current code, and/or `--totp <code>`; also honor env `TMEX_TOTP`) succeeds, and `/api/auth/mode` or the session/me endpoint reports `totpEnabled:true` (check what endpoint exposes it).
4. Run `hub user passwd <user>` (rotate-root; non-TTY uses `TMEX_PASSWORD_OLD` + `TMEX_PASSWORD`) and assert TOTP is cleared: login with the new password and no totp succeeds. Then either keep the new password for the rest of the script (update the `PASSWORD` var) — scenario 9 is last so this is fine.
Each assertion is a `pass`/`fail` row in the report like existing scenarios. Do not break scenarios 1–8.

Verification: `bun test` for the driver if any tests exist; `bunx tsc` on driver files if the harness has a tsconfig (check); `bash -n run.sh`; `scripts/hub-e2e/build-driver.sh` must still produce `driver-dist/*.js`. You MAY run the full harness locally: `TMEX_TARBALL=/Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/build/tmex-cli.tgz scripts/hub-e2e/run.sh` (Docker Desktop, qemu amd64, ~15–25 min per round; `run.sh down` to clean). If you run it, report the resulting `scripts/hub-e2e/out/report.md`. If you decide not to run it, say so explicitly.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-totp-result.md`
