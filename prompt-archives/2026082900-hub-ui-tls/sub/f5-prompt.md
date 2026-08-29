# Task F5 — Frontend: direct add-on install/remove button + enable switch (linked)

Read: prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch3.md, sub/f1-result.md and sub/f-fix-result.md (LocalMachineCard, restart hook), plan-00-result.md.

A backend agent (B4) is concurrently implementing the contract and updating `packages/api-client/src/local/{types.ts,local-api.ts}` (`LocalDirectStatus.enabled`, `LocalDirectAction = 'install'|'remove'|'enable'|'disable'`, `LocalApi.setDirect(action)`). Code against those names; if they are not there yet when you type-check, add a minimal local type alias in your file and note it in the result — do NOT edit packages/api-client.

Implement in `apps/fe/src/pages/settings/nodes/local-machine-card.tsx` (+ test):
- Direct add-on row → two controls: a **Button** "Install add-on" / "Remove add-on" (remove asks for confirmation via `AlertDialog`; while a mutation is pending both controls disabled; shows download failure with cause) and a **Switch** "Direct connections" bound to `direct.enabled`.
- Linking: switch disabled (with hint) when not installed; after install succeeds the switch reflects `enabled=true`; after remove it reflects `false`; toggling the switch calls `enable` / `disable`. Any successful action shows the existing "restart required" hint + "Restart now" (reuse `useRestartNow`), and refreshes `['local-status']`.
- Status badges: supported / installed (+ version) / active (`capable`) / disabled.
- i18n: rework `nodes.machine.direct*` keys in the three locale JSONs (English source wording should be concise product copy — a separate copy-rewrite task will polish all namespaces afterwards; keep keys stable and descriptive). Run `bun run build:i18n`.
- Tests: static render for the four states (unsupported / not installed / installed+enabled / installed+disabled) and the action → status refresh flow with an injected client.

Scope: apps/fe/src/pages/settings/nodes/local-machine-card.tsx, local-machine-card.test.tsx (new or existing), the three locale JSON files (only `nodes.machine.*`), generated i18n via the script. Nothing else (setup/**, https/** untouched).
Baseline: apps/fe `bun test src/` 453/0 tsc 0.
Result: prompt-archives/2026082900-hub-ui-tls/sub/f5-result.md
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
