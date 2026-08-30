# Task O1 — Remote-node agent sessions (frontend)

Read `common-rules.md` in this directory first (ground rules, baselines, fixed contracts).

## Goal
In mesh mode, the browser's entry gateway (self) now owns and runs ALL agent sessions, including sessions bound to a pane on a REMOTE node (`AgentSessionDto.nodeId`, `CreateAgentSessionRequest.nodeId`; `fetchAgentSessions(client, { nodeId })` filters: undefined → all, `'self'` → local only, `<id>` → that node). The backend (another agent, G1) is implementing `POST/GET /api/agent/sessions` with nodeId, the remote pane RPC, and offline propagation (sessions of an offline node go `status: 'error'`, `lastError: 'NODE_OFFLINE'`; on reconnect the user can just send again). You make the frontend use it.

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-agent-report.md section 1 (UI/store/API/WS chain; the two route matchers that lack the `/n/:nodeId` prefix) and section 5.

## Scope (files you own)
- packages/stores/src/agent*.ts (+ tests), packages/stores/src/index.ts (append exports only)
- packages/panels/src/agent/** (+ tests)
- apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx, use-sidebar-agent-sessions.ts, sidebar-device-list-runtime.tsx, app-sidebar.tsx (agent tab part only) and their tests; apps/fe/src/node/** ONLY if you need a tiny helper to reach the self runtime (`appNodeRuntimes.get(SELF_NODE_ID)`) — another agent (O3) edits apps/fe/src/node/mesh-nodes.ts and device-node-badges.tsx: do not touch those two.
- i18n: only the `agent` sub-object of the three locale JSONs.

## Requirements
1. Agent state is always served by the SELF runtime (its API client + its agent WS), regardless of the current `/n/:nodeId` route. The device tree / pane data for the route still comes from the route node's runtime. Concretely: the agent adapter/store used by the Agent tab and by the sidebar "start agent for pane" action must be `self`'s agent store, and every create/draft carries `nodeId` = route node id (`null`/omitted when the route is self). Sessions shown in the Agent tab / sidebar on route X are those with `nodeId === X` (self route → sessions with `nodeId === null`). Keep a single sessions list in the self store; filter by nodeId in selectors; avoid re-fetching per route.
2. Route matching: `useRoutePane` (packages/panels/src/agent/use-agent-tab-state.ts) and navigation in `use-agent-tab-actions.ts` must use the runtime's `host.appPath` / `nodeAppPath` helpers (see packages/panels/src/device-tree/device-tree-navigation.ts) so `/n/:nodeId/devices/:deviceId/windows/:windowId/panes/:paneId` works; add tests.
3. Empty state copy: `agent.session.selectPaneHint` becomes "选择一个会话" (en: "Select a session", ja: "セッションを選択") — the user explicitly wants the shorter phrase. Note the sidebar/terminal tab reference is dropped.
4. Offline: when the route node is offline (mesh node `online === false` from apps/fe/src/node/mesh-nodes.ts state — read-only use) or a session has `lastError === 'NODE_OFFLINE'`, the Agent tab shows a compact banner "节点离线，会话已暂停" / "Node offline. Session paused." with the input disabled; when the node is back online the banner disappears and input is enabled again (the session stays in error until the user sends; sending clears it as today). Sidebar rows for remote sessions of an offline node are rendered muted (same styling as offline device rows) and not clickable-into-error.
5. Pane-attached detection (`isSessionAttached`) must look at the snapshot of the session's node, not the current route.
6. Fix test fixtures broken by the required `nodeId` field in your scope (stores/panels/fe). Add tests for: nodeId filtering, self-runtime routing of create, remote route matcher, offline banner.

Verify: `cd packages/stores && bun test && bunx tsc --noEmit -p .`; same for packages/panels; `cd apps/fe && bun test src/ && bunx tsc --noEmit -p .`; biome on changed files.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O1-result.md
