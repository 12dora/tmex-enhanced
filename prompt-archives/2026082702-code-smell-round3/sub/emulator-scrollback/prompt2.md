# Common rules (read fully)

You are a backend engineer working in the tmex monorepo at /Users/konata/code/tmex-enhanced-wt-tabs (Bun runtime, TypeScript, biome). Read AGENTS.md first.
- OTHER AGENTS ARE EDITING OTHER FILES IN THIS SAME WORKTREE IN PARALLEL. Only modify the files listed in "Scope" below, plus new files you create in the same directories and their tests. Never touch files outside scope; if you believe a change outside scope is required, describe it in your result file instead.
- Do NOT run any git command that changes state (no add/commit/stash/checkout/reset). The commander commits.
- Never touch the production tmex service (~/Library/Application Support/tmex, port 9883) or the tmux session named `tmex`. Tests run with NODE_ENV=test only (bun test does this via test.env).
- Verification before finishing: `cd apps/gateway && bun test <relevant test files>` (and the whole package `bun test` at the end — other agents' in-flight edits may cause unrelated transient failures — mention them, don't fix them), `bunx tsc --noEmit -p .` must not add errors (gateway baseline: 25 errors, all pre-existing), `bunx biome check --write <your files>`.
- Code style: no unnecessary comments; standard English identifiers; keep functions small (target CC ≤ 12, ≤ 60 lines); no `as never`/`any` escapes; no TODOs, no partial versions. Preserve public behavior unless the task says it is a bug.
- Every bug fix needs a regression test that fails before and passes after.
- Do not create prompt-archives/ folders or docs; write your final report to the path given in "Report" (markdown: what changed, files, bugs fixed, test/tsc results, anything left out and why).


# Task: emulator-scrollback

Follow-up to a units fix: packages/ghostty-terminal createTerminal(cols, rows, scrollbackLines) now correctly converts lines → ghostty's byte budget (previously any value ≤ ~1.7 MiB was clamped to ~1129 lines). apps/gateway/src/tmux-client/pane-emulator-create.ts has DEFAULT_SCROLLBACK = 5000, which used to yield ~1129 lines and now really allocates 5000 lines per headless pane emulator (80 cols ≈ 5.5 MiB, 200 cols ≈ 13.6 MiB) — and all HeadlessTerminal instances share ONE wasm linear memory that only grows. The gateway's PaneEmulator.render() only reads the viewport and history paging uses tmux capture-pane, so this scrollback is unused. Verify those claims by reading pane-emulator.ts, pane-emulator-create.ts, packages/ghostty-terminal/src/headless.ts and any reader of the emulator's scrollback (grep for scrollback / readScrollbar / history in apps/gateway/src/tmux-client and agent/tools/run-command*), then lower DEFAULT_SCROLLBACK to the smallest value that keeps every existing use working (likely a few hundred lines; if some consumer does read scrollback, size it to that consumer's needs and say so). Add a test asserting the default and that a memory-sensitive path (e.g. creating 50 emulators) stays under a bound if measurable via WebAssembly.Memory buffer byteLength through the bindings. Do not touch packages/ghostty-terminal.
Scope: apps/gateway/src/tmux-client/pane-emulator-create.ts (+test), pane-emulator.ts only if a constant lives there.

Report: write to prompt-archives/2026082702-code-smell-round3/sub/emulator-scrollback/result.md
