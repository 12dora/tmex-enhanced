# Task O10 — Fix: closing a pane from the split view gets stuck on "connecting" (frontend)

Read `common-rules.md`, then the diagnosis `explore-split-close-report.md` in this directory (sections 2–5 are authoritative). Implement candidates 1, 2 and 3 of section 5.

## Scope (files you own)
packages/terminal-ui/src/components/split/SplitPaneView.tsx (+tests), packages/panels/src/device-console/** EXCEPT `command-input-collapse.tsx`, `editor-input-panel.tsx`, `device-console-toolbar.tsx` (owned by a finished agent — read-only for you; if you must touch `device-console.tsx` keep the collapse wiring intact), packages/stores/src/tmux*.ts, pane-subscriptions.ts, tmux-selection-actions.ts, tmux-event-router.ts (+tests), packages/ws-client/src/state-machine.ts only if needed. Other agents in parallel: O6 (i18n string sweep), O8 (agent stores/panels/agent — `packages/stores/src/agent*.ts` are theirs), O9 (remote access tab), backend agents in apps/gateway. Do not touch their files.

## Requirements
1. Closing the pane that the URL points to must first navigate to a fallback (same window: tmux active pane if it is not the one being closed, else the first remaining pane; no remaining pane → another window's active pane; none → `/devices` via `hostAppPath`), THEN send `close-pane`. Closing a non-routed pane sends `close-pane` only. Put the decision in a pure function (e.g. `resolveCloseFallback(snapshot, windowId, paneId)`) in packages/panels/src/device-console with unit tests; the split-view close control calls a panel-level action (`onClosePane`) instead of the store directly.
2. Once a metadata snapshot has confirmed the routed pane is gone, `TerminalStage` must not mount a `Terminal` for it (no stale mount/subscribe during the 2.5 s grace) — render the recovery/resolving branch instead; keep the grace period for deep links that arrive before the snapshot.
3. When a snapshot removes the currently selected pane, cancel that pane's pending select transaction and clear/rebase `selectedPanes` for it so no ACK/progress timeouts or 250 ms reselect retries run against a dead pane. Tests in stores.
4. Keep the overlay copy unchanged; ensure the "connecting" overlay is not shown when `selectedPane` is missing because it was just closed by the user.
5. Verify: terminal-ui, panels, stores tests + tsc + biome. If you can, add/adjust an e2e spec under apps/fe/tests for close-from-split (do NOT run e2e — other agents edit fe and vite HMR pollutes it; just make it consistent with existing specs).

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O10-result.md
