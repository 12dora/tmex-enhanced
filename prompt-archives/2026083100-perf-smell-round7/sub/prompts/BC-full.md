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
# Task BC: skip full reprojection when tmux snapshot is unchanged

## [perf, medium-high risk] Every successful tmux snapshot runs full metadata/retention/history reconcile even when nothing changed
Evidence: apps/gateway/src/tmux-client/runtime/event-bridge.ts:74 computes `changed` but :76 unconditionally calls `metadata.reconcile`, :84 unconditionally runs `paneRetention.reconcilePanes`, :87 invalidates history sessions per pane; `changed` only gates broadcasting (:93). MetadataProjection.reconcile rebuilds the desired map every time (metadata-projection.ts:156, metadata/hierarchy-builder.ts:42); retention rescans all panes (pane-retention.ts:106, retention/policy-scheduler.ts:104). At 5000 panes reconcile alone is ~10.9ms per snapshot.

Fix carefully — do NOT simply skip everything when `changed === false`:
- Split dirty dimensions: (a) pane-set/topology changes (panes added/removed, ids changed) gate retention reconcile + history invalidation; (b) snapshot fingerprint/baseRevision unchanged gates metadata rebuild. Study how `changed` is computed and what revision/conflict/rebase semantics MetadataProjection has (metadata revision bumps, concurrent source events) before deciding the exact skip conditions.
- The invariant to preserve: any observable state transition that today eventually reaches consumers must still reach them; only pure no-op recomputation may be skipped.
- If after reading you conclude only part of this is safely skippable (e.g. retention/history but not metadata), implement that part and explain the rest in your report.

Add tests: identical consecutive snapshots → no retention/history invalidation calls (spy/count), metadata revision unchanged; a pane-set change still triggers full path; a metadata-only field change still propagates.

## Scope (only these)
apps/gateway/src/tmux-client/** and its tests. Do NOT touch ws/**, mesh/**, hub/**, agent/**.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BC-result.md
