# Task O5 — Remote agent frontend leftovers (small)

Read `common-rules.md` in this directory first. Then read `O1-result.md` sections 「已知遗留 / 风险」 items 1 and 4, and `O2a-result.md` section 4 (`isRouteNodeOffline`).

## Scope (files you own)
- packages/stores/src/react.tsx, packages/stores/src/use-pane-agent-state.ts (+ tests)
- apps/fe/src/node/** (new small module for the offline helper; do NOT touch mesh-nodes.ts / device-node-badges.tsx / mesh-events.ts logic beyond importing)
- apps/fe/src/components/page-layouts/components/app-sidebar.tsx and use-sidebar-agent-sessions.ts (only to swap the duplicated helper for the shared one) + their tests

## Requirements
1. `usePaneAgentState` must read the agent store resolved through `resolveAgentStore(useRuntime().stores.agent)` (see packages/stores/src/agent-host-store.ts) and filter sessions by `isSessionOnNode(session, normalizeAgentNodeId(runtime.nodeId))`, so the split-pane "agent bound / generating" badge lights on `/n/:id` routes. Add a test.
2. Merge O2a's `isRouteNodeOffline` (app-sidebar.tsx) and O1's `isNodeOffline` (use-sidebar-agent-sessions.ts) into ONE exported pure function in a new `apps/fe/src/node/node-offline.ts` (choose the clearer name, keep both call sites' semantics: self route → entry row; node missing from the list → online) and delete the duplicates; move/merge their tests.
3. Verify: stores, fe tests + tsc + biome. Backend agents are still editing apps/gateway — ignore that package.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O5-result.md
