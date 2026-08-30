# Shared rules (read carefully)

You are a backend engineer in the tmex monorepo worktree /Users/konata/code/tmex-enhanced-wt-r7 (Bun runtime; the gateway runs ONLY on Bun, not Node). Several other agents work in the SAME worktree in parallel — modify ONLY files inside your declared scope; if a fix seems to require touching a file outside your scope, note it in your report instead of editing.

Rules:
- NO git commands whatsoever (no add/commit/stash/checkout). The commander commits.
- Code comments in Simplified Chinese, and only where logic is non-obvious.
- Keep functions under CC 15 / 120 lines, files under 900 lines (a complexity gate runs in `bun run lint`; scripts/complexity/allowlist.json locks current values — if you reduce complexity of an allowlisted file, do NOT edit the allowlist, the commander handles it).
- Verify the exploration claims yourself by reading the code BEFORE changing anything. If a claim is wrong or the fix is not worth the risk, say so in your report with reasons instead of forcing a change.
- Every behavior change needs unit tests (extend existing test files next to the code). No benchmarks unless asked.
- Verification before you finish: `cd apps/gateway && bun test` must be 2800+ pass / 0 fail (baseline 2800). `bunx tsc --noEmit -p .` in apps/gateway has 21 PRE-EXISTING errors — do not add new ones. If you touch packages/shared: `cd packages/shared && bun test` baseline 376 pass / 0 fail, tsc 0 errors. Run `bunx biome check <changed files>`.
- macOS has no `timeout` command. bun test summary lines contain ANSI colors — strip with `sed 's/\x1b\[[0-9;]*m//g'` before grepping. Never put `grep -c` inside a `&&` chain (returns exit 1 on zero matches).
- When done, write a result report in Simplified Chinese (claim verification, what changed, design decisions, risks, test counts before/after) to the absolute path given in your task, then exit. Writing the result file is the LAST thing you do.
# Task BI: consolidate the TMEX_ROLES role model into one shared module

Exploration found the role model maintained THREE times with drifting semantics (verify all claims first):
- apps/gateway/src/config.ts:75-92 — `TmexRoles`, `parseTmexRoles`; empty/whitespace string REJECTS (fail-closed)
- packages/app/src/lib/roles.ts:1-31 — `TmexRoleName`, `TmexRoles`, `parseTmexRoleName`, `parseTmexRoles`, `isStandaloneRoles`, `roleNameFromFlags`; empty → standalone
- apps/gateway/src/mesh/mesh-deps.ts:52-58,252-254 — `MeshRoles`, another `isStandaloneRoles`
- packages/app/src/runtime/assemble.ts:4-8,362-363 imports gateway's parser directly while other app commands use lib/roles

Refactor: move the PURE parts (role types, role-name conversion, `isStandaloneRoles`, flag mapping) into a new Node-free module in packages/shared (e.g. packages/shared/src/roles.ts, exported from the main barrel — check how other pure modules are exported). Gateway keeps its own env-input validation wrapper preserving the empty-string fail-closed semantics; packages/app keeps its default-normalization wrapper. mesh-deps re-uses the shared types/helpers. Remove assemble.ts's direct dependency on gateway config's parser (use the shared module + app's wrapper as appropriate — read what assemble.ts actually needs). Add cross-package consistency tests: undefined, empty string, whitespace, invalid role, standard values — asserting gateway wrapper rejects empties while app wrapper normalizes, and both agree on valid inputs.

IMPORTANT: packages/shared main entry must stay browser-safe (no node:fs etc.) — the roles module must be pure TS. Do not change any runtime behavior: existing tests in all three packages must pass unchanged except where they assert implementation details you relocated.

## Scope (only these)
packages/shared/src/roles.ts (new) + barrel + tests; apps/gateway/src/config.ts (+tests); apps/gateway/src/mesh/mesh-deps.ts; packages/app/src/lib/roles.ts (+tests); packages/app/src/runtime/assemble.ts. Do NOT touch apps/gateway/src/mesh/mesh-runtime.ts, ws/**, tunnel/**, stream-replay-state.ts (another agent owns them). packages/app baseline: bun test 414 pass / 1 pre-existing fail (cpu-features stub), tsc 1 pre-existing error. shared baseline: 387/0, tsc 0. gateway baseline: bun test 2854/0, tsc 21 pre-existing.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BI-result.md
