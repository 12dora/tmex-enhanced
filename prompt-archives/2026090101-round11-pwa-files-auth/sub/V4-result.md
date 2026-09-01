# V4 result — sized cold-select ordering + snapshot claim rebind

Fixed two remaining viewport-policy defects. Touched `apps/gateway/src/ws/{tmux-command-handlers,viewport-policy,legacy-feed-broadcaster,index}.ts` (+ tests) and `docs/terminal/2026090101-viewport-policy.md`.

## Fixes

1. **Sized cold select ordering.** `handleTmuxSelect` records the claim and resolves the window winner before dispatch. Owner `wantHistory` always uses `selectPaneWithSize` (resize then capture), including when snapshot/`lastAppliedViewport` already match (tmux drift / reconnect). Policy resize is skipped on that path so `fire()` cannot race history capture. Followers use unsized `selectPane`; if live geometry differs from the winner they use `selectPaneWithSize` at the winner size. Single-client sized select is byte-identical to pre-round-11. `wantHistory:false` still `focusPane`; size applies only via policy.

2. **Snapshot-install rebind.** `broadcastStateSnapshot` installs `lastSnapshot` then reconciles all claims on that device entry: drop missing panes, re-key moved panes, prune gone-window `lastAppliedViewport`/`lastViewportWinnerId`, then apply/notify source and destination. Off the per-output-frame path. Gone windows are not rewritten into winner maps.

## Verification

- `cd apps/gateway && bun test`: **3133 pass / 0 fail** (baseline 3126 + 7)
- `bunx tsc --noEmit -p .`: **21** `error TS`
- `bun scripts/complexity/gate.ts`: ok
- `bunx biome check` on touched files: clean
