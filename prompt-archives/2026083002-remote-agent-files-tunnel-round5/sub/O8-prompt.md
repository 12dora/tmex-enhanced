# Task O8 — Fix review findings: remote agent sessions / node offline state (frontend)

Read `common-rules.md`, then `O1-result.md`, `O5-result.md` and `review-fe-1-report.md` (authoritative; fix all 5 items).

## Scope (files you own)
apps/fe/src/node/** (mesh-nodes.ts subscription ownership, node-offline.ts), apps/fe/src/components/page-layouts/components/app-sidebar.tsx, use-sidebar-agent-sessions.ts, sidebar-agent-sessions.tsx, agent-session-row.tsx, apps/fe/src/components/global-device-provider.tsx or AppRoot-level host file if a resident mesh subscription owner has to live there (list it), packages/stores/src/agent*.ts, packages/panels/src/agent/** + tests. Two other agents run in parallel: O6 (i18n wording sweep over locale JSONs + hard-coded strings elsewhere) and O7 (terminal-page header/toolbar components) — do not touch their areas; targeted, add-only edits to locale JSONs if you need a key.

## Fix list
1. Mesh node state must keep updating while the Agent/Files sidebar tabs are shown (today only `SideBarDeviceList` owns the `/api/mesh/nodes` fetch + event subscription and it unmounts on those tabs). Put a resident owner at the host level (only when mesh mode is active), and let sidebar/agent/files consumers read the shared snapshot.
2. Sidebar rows: after a node comes back online, sessions with a stale `lastError === 'NODE_OFFLINE'` must be clickable again — reuse the tri-state `isNodePaused()` semantics (mesh online state authoritative; `NODE_OFFLINE` fallback only when mesh state is unknown).
3. Missing node row after the list has loaded ≠ online: `isNodeOffline` becomes tri-state (`undefined` before first load / standalone; offline when loaded and the row is missing — revoked/removed; else `!online`). Agent tab `nodeOffline` keeps `boolean | undefined`.
4. Switching routes between nodes with the Agent tab open must not destroy the other node's active session / draft: keep `activeSessionId` and the draft per normalised nodeId (e.g. maps keyed by nodeId with the current view derived), switch only the current view + subscription, never `startDraft` for node B by cancelling node A's selection. Update event-router/history-sync/persist as needed with tests (the reviewer's repro: select session on A → navigate to B pane → back to A → A's session still selected, no extra draft).
5. Copy nit: `nodes.badge.icePlaceholder` (three locales) → zh「暂无直连详情。」 en "Direct connection details unavailable." ja「直接接続の詳細はありません。」.

Verify stores / panels / fe tests + tsc + biome. Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O8-result.md
