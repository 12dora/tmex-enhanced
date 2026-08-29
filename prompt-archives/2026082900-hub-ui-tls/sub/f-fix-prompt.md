# Task F-fix — Frontend review fixes (batch 1–2)

Read: prompt-archives/2026082900-hub-ui-tls/sub/review-frontend.md (the review), f1/f2/f3-result.md (what exists), api-contract-batch1.md / batch2.md. All findings below are accepted; implement every one.

Another task (B3) is concurrently editing `apps/fe/src/node/{enrollment.ts,hub-api.ts}` and `apps/fe/src/pages/nodes/{enrollment-section.tsx,nodes-management.tsx}` to add `ca_fingerprint` to browser-generated tokens — do NOT touch those. Your part of the blocker is only the wizard side.

1. **Blocker (wizard side)**: `apps/fe/src/pages/settings/nodes/setup/validation.ts` — accept exactly `/^[A-Za-z0-9_-]{128}(?:\.[0-9a-f]{64})?$/` for the join token; update placeholder/help text and i18n; tests for v1 and v2 accepted, junk rejected.
2. **TLS mutation serialization** (`https/https-section.tsx`, `acme-panel.tsx`, other panels): one `busy` lock covering save, renew and `status.acme?.status === 'pending'`; disable all mode/form/save/renew controls and guard the handlers while busy.
3. **Lockout confirmation**: when saving `none` or `external` while `status.listener.running`, show an `AlertDialog` confirmation (from `@tmex/ui/alert-dialog`) explaining that the current HTTPS endpoint will stop and another reachable HTTP/proxy endpoint must already exist. i18n keys under `nodes.https.confirmStop.*`.
4. **Restart poll consolidation**: create `apps/fe/src/pages/settings/nodes/restart/wait-for-restart.ts` (pure core: `waitForRestart({ previousStartedAt, fetchImpl, timeoutMs=60000, intervalMs=1000, signal })` using `cache: 'no-store'` and an `AbortSignal` per request capped by the remaining deadline) and `use-restart-now.ts` (hook: `{ state, start(previousStartedAt), cancel }` that aborts on unmount). Make `setup/use-restart-waiter.ts`, `local-machine-card.tsx` and `https/use-restart-now.ts` all use the shared core (delete the duplicated implementations; keep the setup hook as a thin wrapper if the wizard needs its state names). Unit-test the core with fake timers/injected fetch including timeout and abort.
5. **Renew error path** refetches TLS status (`https-section.tsx`).
6. **`join_failed` and other cause-bearing errors** (`setup/error-messages.ts`): append/interpolate `SetupApiError.message` for `join_failed`, `hub_unreachable`, `env_write_failed`, `direct_*`; keep static text for codes whose message adds nothing.
7. **Clear `restartRequired`** in `local-machine-card.tsx` on restart success before refreshing status.
8. **Strict IPv6 check** in `https/tls-form.ts`: replace the loose regex with a small browser-safe parser (group count ≤ 8, at most one `::`, hex groups 1–4 chars, optional embedded IPv4 tail); tests for `::1`, `fe80::1`, `2001:db8::8a2e:370:7334`, `::ffff:192.168.0.1`, and malformed `::::`, `1:2:3:4:5:6:7:8:9`, `12345::1`.
9. **Tests**: add interaction/state tests (injected client + `act`/state-machine style used elsewhere in apps/fe, no testing-library) for: mutation lock (renew disabled while save pending), `port_in_use` → status refetched, restart core abort/timeout, listener-stop confirmation appears, and one `SettingsPage` test that selecting the `nodes` tab renders `NodesTab`.

i18n: add keys under `nodes.https.*` / `nodes.setup.*` / `nodes.machine.*` in all three locale JSONs (no other agent is editing them now), then `bun run build:i18n`.

## Scope
- apps/fe/src/pages/settings/nodes/** EXCEPT nothing under apps/fe/src/pages/nodes/** and apps/fe/src/node/**
- apps/fe/src/pages/SettingsPage.test.tsx (new) 
- packages/api-client/src/local/setup-api.ts (only if the shared core replaces `readHealthStartedAt`/`probeHealth` — keep exports used by tests)
- three locale JSONs + generated i18n via the script

## Baselines
apps/fe `bun test src/` 413/0 tsc 0; api-client 128/0 tsc 5; shared 335/0.

## Result
`prompt-archives/2026082900-hub-ui-tls/sub/f-fix-result.md`.
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
