# V1 result — Gateway viewport policy review fixes (RV3)

Fixed four viewport-policy defects plus two mesh isolation tests. Touched `apps/gateway/src/ws/{viewport-policy,tmux-command-handlers,index.test,viewport-claims,viewport-policy.test,tmux-command-handlers.test}.ts`, `apps/gateway/src/mesh/integration/mesh.integration.test.ts`, and `docs/terminal/2026090101-viewport-policy.md`.

## Fixes

1. **Sized `TMUX_SELECT`.** Select never applies size directly. A sized select records a visible claim; `applyViewportPolicy` resizes only if that session is the window winner. Follower pane switches stay at owner geometry; owner selects still apply.
2. **Live geometry vs cache.** Winner apply compares snapshot window geometry (pane size or layout), falling back to `lastAppliedViewport` only when the snapshot has no size. After apply, in-memory snapshot geometry is synced so stale snapshots do not re-fire. An out-of-band snapshot change makes the same sync apply again.
3. **Same-window pane switch.** A claim whose `paneId` differs from the session’s previous claim on that window is treated as `notifyFirst`, so the new pane gets `TERM_VIEWPORT_POLICY` immediately (`owner:false` for a follower).
4. **Stale window keys.** Before resolving a winner, claims are re-bound against the snapshot; missing or moved panes are dropped and the destination window is recomputed. Resize is targeted at the policy `windowId`. `lastAppliedViewport` / `lastViewportWinnerId` for gone windows are pruned.
5. **Mesh isolation tests.** Forged login uses a B-issued challenge with A’s `target`/`target_pk` → `TARGET_MISMATCH`. Session test issues a B SID bound to `self` and presents it on A’s forwarder → `via_mismatch`.

## Verification

- `cd apps/gateway && bun test`: **3126 pass / 0 fail** (baseline 3115 + new regressions)
- `bunx tsc --noEmit -p .`: **21** `error TS`
- `bun scripts/complexity/gate.ts`: no gateway violations
- `bunx biome check` on touched files: clean
