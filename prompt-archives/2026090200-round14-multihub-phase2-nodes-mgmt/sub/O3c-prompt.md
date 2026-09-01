# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# O3c — FE role-switch: unconfirmed must enter recovery; no unhandled rejections

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/O3c-result.md`

Read `sub/RV3-result.md` findings 11 and 12 (the two FE ones) and `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts` (~L580/946/514/987).

1. When the old writer has already been demoted (a recovery context exists), an `unconfirmed` outcome (target request/read-back timeout, writer never converged) must behave like `failed`: enter the forced recovery dialog (retry target / rollback to old primary) and keep the sessionStorage resume record until the user resolves; only a confirmed `done` (or explicit dismiss in the recovery dialog) clears it. Plain `unconfirmed` without recovery context keeps today's toast.
2. Wrap the whole `drive`/run pipeline and the `io.hubs()` polling in error boundaries: network exceptions during the switch (entry briefly unreachable) are retried within the existing budget; an unexpected exception ends as `failed` (recovery dialog when context exists) — never an unhandled rejection or UI stuck at `running=true`.

Tests in `use-hub-role-switch.test.ts`: unconfirmed-with-context → recovery dialog + record kept; unconfirmed-without-context → toast + record cleared; io.hubs throwing mid-poll → retried then recovered; drive-level throw → failed/recovery, `running` returns to false. Baselines: `cd apps/fe && bun test src/` all green (report numbers), tsc 0, biome clean.

Scope: `apps/fe/src/pages/settings/nodes/management/{use-hub-role-switch.ts,use-hub-role-switch.test.ts,hub-role-dialog.tsx}` and locale keys under `translation.nodes.hubs.role.*` if new copy is needed (follow /Users/konata/code/tmex-copy-guidelines.md, then `bun run --filter @tmex/shared build:i18n`). No git. A backend agent (G7) edits `apps/gateway/**` in parallel.
