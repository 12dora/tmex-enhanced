# K1 — Frontend: keep-alive terminals — warm instance, cold subscription

Worktree: `/Users/konata/code/tmex-enhanced-wt-r12` (branch `feat/round12-leftovers`). Bun-only monorepo. **Other agents edit other files concurrently (M1 in `apps/fe/src/node/**`; H1 in `packages/ws-client/**`; G1 in `apps/gateway/**`). Touch only the files in "Scope". Never run git commands.** Comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

Read `prompt-archives/2026090102-round12-leftovers/sub/EX1-result.md` first (audit with `path:line`; re-verify lines against current code).

## Problem

The keep-alive pool (`packages/panels/src/device-console/terminal-keep-alive.ts`) keeps up to 3 terminal instances mounted (1 visible + up to 2 hidden, `opacity:0`). Every mounted `Terminal` registers a pane sink **and** contributes its pane to the wire subscription set (`usePaneSinkRegistration.ts` → `packages/stores/src/pane-subscriptions.ts`, union of mounted panes). The gateway delivers live output for selected ∪ subscribed panes, so hidden keep-alive panes keep receiving and rendering output (bandwidth + CPU on phones). Hidden instances already do **not** participate in viewport arbitration (`useViewportClaims` only for the visible pane) — keep it that way.

## Required behaviour

1. **Grace period**: a keep-alive instance that becomes hidden stays fully subscribed for a grace period of **60 s** (constant, exported, overridable in tests). Re-showing within the grace period is the current instant "warm" switch — no history refetch, no flash.
2. **Cold subscription after grace**: after 60 s hidden, the instance's pane is removed from the wire subscription set (`set-pane-subscriptions` no longer includes it) while the Ghostty instance and its **sink registration stay** (so nothing gets buffered in the sink registry; verify `pane-sink-registry` does not start buffering because the sink is still registered). Mark the instance as `cold` in the keep-alive state.
3. **Re-show of a cold instance**: route reconciliation must treat it as a **cold select** (`wantHistory:true`, going through the existing select transaction / switch barrier, preserving the `selectPaneWithSize` ordering — see `packages/stores/src/select-pane-dispatch.ts` and `use-pane-route-reconciliation.ts:96-107`), so the terminal is reset and history replayed exactly like a first open (no duplicated scrollback). After the select the pane is subscribed again and the instance returns to `warm`.
4. Page hidden (`document.visibilityState === 'hidden'`) does not need special handling in this task (H1 handles the heartbeat); but make sure timers are cleaned up on unmount / pane removal / device disconnect, and that a pane deleted while cold does not leak state.
5. Multiple browser sessions and manual subscriptions (`pane-subscriptions.ts` manual set) must keep working: only the *mounted-instance contribution* of a cold pane is withdrawn; a manual subscription for the same pane still keeps it subscribed.

## Scope

`packages/terminal-ui/src/components/{Terminal.tsx,types.ts}`, `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts` (+ tests), `packages/panels/src/device-console/{terminal-stage.tsx,terminal-keep-alive.ts,use-pane-route-reconciliation.ts}` (+ tests), `packages/stores/src/pane-subscriptions.ts` (+ test) only if the existing mount API cannot separate sink lifetime from subscription lifetime. Do **not** edit `packages/ws-client/**`, `apps/gateway/**`, `apps/fe/src/node/**`.

Pick the smallest clean design: e.g. a `subscribe?: boolean` (default true) prop on `Terminal` that `usePaneSinkRegistration` uses to decide whether to call the subscription `mountPane`, while sink registration is unconditional; the keep-alive state machine (`warm` → hidden timer → `cold`) lives in `terminal-keep-alive.ts` / `terminal-stage.tsx`.

## Tests (bun test, existing patterns in the same dirs)

- hidden instance stays subscribed within grace; unsubscribed after grace (fake timers); sink still registered.
- re-show within grace → warm select (`wantHistory:false`); re-show after grace → cold select (`wantHistory:true`) and instance back to warm + subscribed.
- unmount / pane removal clears timers; manual subscription survives a cold instance.
- `set-pane-subscriptions` payload excludes cold panes (pane-subscriptions test).

## Verification (must pass before reporting)

Baselines (before your change): see "Baselines" below. Run `bun test` and `bunx tsc --noEmit -p .` in `packages/terminal-ui`, `packages/panels`, `packages/stores`; pass counts must not drop, tsc stays at baseline; `bunx biome check <touched files>` clean. Do not run Playwright e2e (commander does).

## Baselines

`packages/panels` 724 pass / tsc 0; `packages/terminal-ui` 358 pass / tsc 0; `packages/stores` 415 pass / tsc 1 (pre-existing); `packages/ws-client` 286 pass / tsc 0; `apps/fe` (`bun test src/`) 1130 pass / tsc 0.

## Report (final message, < 400 words)

Files changed, the exact state machine and where it lives, how re-show decides warm vs cold, test counts before/after per package, anything unfinished.
