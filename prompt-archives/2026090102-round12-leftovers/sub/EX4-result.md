# EX4 — Lazy sidebar agent session hydration

## 1. Current behaviour

### Boot and node scope

`agentUi` defaults to enabled. The root layout permanently mounts the sidebar under the self-node runtime, while the sidebar content is selected by the active tab. `apps/fe/src/main.tsx:129-148`, `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:249-262`, `packages/stores/src/runtime.ts:319-325`

When Terminals is active, `DeviceTree` creates the agent adapter and mounts `SidebarAgentSessionsProvider`. Its effect calls `ensureInitialized()` and then `loadSessions()` when the shared store is not loaded. `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:39-61`, `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:343-356`

`loadSessions()` fetches the unfiltered `/api/agent/sessions` list. Requests are deduplicated within the store, including StrictMode and rapid tab-switch races. `packages/stores/src/agent-session-crud-actions.ts:239-269`

Round 11’s remote runtime change is effective:

- Self is always rendered with a runtime.
- An online remote node mounts a runtime only when its section is expanded.
- Collapsed remote sections mount no runtime, WebSocket, or direct negotiation.
- Therefore, the provider code runs for self plus expanded remote sections only. `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:383-429`, `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:432-449`

However, this is not one agent bootstrap per node. Every section uses the same self-owned agent store, and the session table is global on the entry gateway. `apps/fe/src/node/self-agent-store.ts:1-15`, `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:315-355`

Result: multiple provider effects may run, but they converge on one self-gateway list request through the store’s in-flight dedupe. The Agent tab itself also calls `loadSessions()` on mount. `packages/panels/src/agent/use-agent-tab-state.ts:161-166`, `packages/panels/src/agent/use-agent-tab-state.ts:220-241`

### What the Terminals tab renders

The sidebar does not show an agent count on device headers. Device and pane rows receive an agent adapter, and each pane renders its matching session rows below the pane. `packages/panels/src/device-tree/device-row-header.tsx:15-52`, `packages/panels/src/panels/device-tree/pane-row.tsx:20-31`, `packages/panels/src/device-tree/window-pane-list.tsx:24-31`

Each attached session row renders:

- Bot icon
- Session title
- Status dot: running, error, waiting-confirmation, or neutral
- Rename/delete menu

`apps/fe/src/components/page-layouts/components/agent-session-row.tsx:20-35`, `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:103-143`

Orphan sessions render a collapsible count and rows with origin pane title, process name, and creation time. `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:112-171`, `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:145-195`

There is no agent unread indicator or per-device/session count. The visible bell icon belongs to terminal bell events, not agent unread state. `packages/panels/src/device-tree/pane-row-content.tsx:14-18`, `packages/stores/src/agent-state.ts:46-65`

The Agent tab body is a chat view, not a session list. Its header contains the binding chip, session-switch button, and new-session button; switching returns to Terminals, where the session rows live. `packages/panels/src/agent/agent-tab.tsx:11-80`, `packages/panels/src/agent/agent-binding-status.tsx:29-82`, `packages/panels/src/agent/use-agent-tab-actions.ts:197-210`

Minimal sidebar data:

| Consumer | Minimum useful fields |
|---|---|
| Attached rows | `id`, `title`, `nodeId`, `deviceId`, `paneId`, `status`, `lastError`; ordering also needs `updatedAt` or server order. `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:321-340`, `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:103-143` |
| Orphan rows | Above plus `originPaneTitle`, `originProcessName`, `createdAt`. `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:124-168`, `apps/fe/src/components/page-layouts/components/agent-session-row.tsx:157-162` |
| Agent tab | Full session configuration plus messages, progress, confirmations, and queue state. `packages/panels/src/agent/use-agent-tab-state.ts:59-70`, `packages/stores/src/agent-state.ts:46-65` |

Messages, system prompt, model/provider configuration, hosted tools, and step limits are unnecessary for the Terminals sidebar.

### REST response and retention

The list route accepts `nodeId`, `deviceId`, and `paneId`, then returns every matching session mapped through the full DTO. It has no `status`, `limit`, `since`, cursor, or pagination handling. `apps/gateway/src/api/agent-session-routes.ts:89-103`

The DTO contains 19 fields, including configuration and origin metadata, but no messages. Messages and confirmations use separate endpoints; only the message endpoint supports `afterSeq`. `apps/gateway/src/api/agent-dtos.ts:25-46`, `apps/gateway/src/api/agent-message-routes.ts:18-36`, `apps/gateway/src/api/agent-confirmation-routes.ts:8-15`

Using representative short values, the current JSON is approximately 457 bytes per session, 472 bytes for one session, 4.6 KB for ten, and 45.8 KB for one hundred, before HTTP overhead. Long titles, prompts, errors, and hosted-tool arrays increase this. The estimate follows directly from the DTO fields above and `packages/shared/src/contracts/agent.ts:14-38`.

There is no retention or cleanup policy in the session model. The list reads all rows ordered by `updatedAt`; deletion is explicit, with messages/queues/confirmations deleted by cascade. `apps/gateway/src/db/agent.ts:148-170`, `apps/gateway/src/db/agent.ts:207-210`, `apps/gateway/src/db/schema.ts:202-301`

## 2. Subscription restore and notifications

`ensureInitialized()` restores subscriptions for persisted active-session selections. On `READY`, it resends every remembered subscription and reloads history for each active session because the send queue can lose messages during reconnect. `packages/stores/src/agent.ts:114-159`, `packages/stores/src/agent-node-state.ts:20-37`

Selecting a session unsubscribes the previous session, subscribes the new one, and loads its history. Thus subscriptions are primarily for one selected session per node, not every hidden session. `packages/stores/src/agent-session-crud-actions.ts:286-313`

Per subscription, the client sends only a session ID. The server then performs a session lookup, reads pending confirmations and queued messages, reads the maximum message sequence, and sends one sync event. Subsequent agent events are sent only to subscribers; each client is capped at 64 subscriptions. `packages/ws-client/src/message-builder.ts:356-367`, `apps/gateway/src/agent/ws-hub.ts:23-55`, `apps/gateway/src/agent/ws-hub.ts:91-142`

A completed turn updates store state and schedules history, but does not invoke the browser notification sink. Agent error and credential-warning events do invoke that sink. `packages/stores/src/agent-event-router.ts:285-327`

The server also emits `agent_turn_finished` through the generic EventNotifier and broadcasts it as `KIND_NOTIFY_EVENT` to connected clients. `apps/gateway/src/agent/run-finish.ts:48-63`, `apps/gateway/src/events/index.ts:24-69`, `apps/gateway/src/ws/theme-settings-broadcaster.ts:115-124` The current frontend transport decoder does not register that kind, and the agent event handler ignores non-`AGENT_EVENT` messages. `packages/ws-client/src/transport-message-decoder.ts:212-220`, `packages/stores/src/agent-event-router.ts:388-410`

Therefore, hidden-session subscriptions are not currently required for a browser completion toast. They remain necessary for live state, confirmations, errors, and chat updates of persisted active sessions.

## 3. Design options

### A — Compact summary endpoint

Add a summary view, ideally returning all sidebar-relevant sessions:

`id`, `title`, `nodeId`, `deviceId`, `paneId`, `status`, `lastError`, origin metadata, and timestamps.

An active-only filter could support badge-only consumers, but would hide current idle, stopped, and error rows. The current UI therefore needs `view=summary` without restricting status, or must intentionally change its UX. This would minimize payload and avoid configuration hydration while preserving current rows.

### B — Defer `loadSessions()`

Remove sidebar list loading until Agent tab open and derive only `bound/generating` state from lightweight WebSocket events. The existing pane-state selector supports those three states. `packages/stores/src/use-pane-agent-state.ts:22-67`

This cannot reproduce current attached session titles, action menus, or orphan count. Also, agent events are subscription-scoped, while only selected active sessions are subscribed. `apps/gateway/src/agent/ws-hub.ts:130-142`

### C — Do nothing

The endpoint contains no history and is roughly 0.5 KB per short session. For installations with empirically small session counts and no measurable startup problem, the engineering cost of splitting summary/full state may exceed the savings. The unbounded retention model makes this less attractive over time.

## 4. Recommendation and affected files

Recommend A as a two-phase design:

1. Load a compact all-session summary for the Terminals sidebar.
2. Keep restoring lightweight subscriptions for persisted active sessions.
3. On first Agent-tab open, load full session DTOs and history as needed.
4. Update the summary from status/title/delete events without falling back to full `loadSessions()`.

The final step matters because unknown status events currently trigger a full list reload. `packages/stores/src/agent-event-router.ts:99-125`

Affected areas:

- Gateway projection and route: `apps/gateway/src/api/agent-session-routes.ts:89-103`, `apps/gateway/src/api/agent-dtos.ts:25-46`, `apps/gateway/src/db/agent.ts:148-170`
- Contract/client: `packages/shared/src/contracts/agent.ts:14-72`, `packages/api-client/src/agent.ts:37-47`
- Store split and event updates: `packages/stores/src/agent-state.ts:46-70`, `packages/stores/src/agent-session-crud-actions.ts:239-269`, `packages/stores/src/agent.ts:114-159`
- Sidebar and first-open hydration: `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:321-356`, `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:84-171`, `packages/panels/src/agent/use-agent-tab-state.ts:161-187`

Estimated size: approximately 8–12 production files and 180–300 LOC, plus 100–180 LOC of tests.

## 5. Risks and test strategy

Test:

- Summary route filtering, status coverage, no message leakage, and response size.
- One request despite self plus multiple expanded remote providers.
- Remote-node grouping, orphan classification, and ordering.
- READY subscription resend, history restoration, and the 64-subscription limit.
- Summary updates during concurrent load, rename, delete, and status events; existing race tests provide a model. `packages/stores/src/agent-session-crud-actions.test.ts:151-238`
- Agent-tab first-open loading and no duplicate draft creation. The current auto-draft effect runs before the list is guaranteed loaded. `packages/panels/src/agent/use-agent-tab-state.ts:169-187`, `packages/panels/src/agent/use-agent-tab-state.ts:239-241`

An explicit first-open loading state would be a UX change. The current lazy boundary uses `fallback={null}`, so adding a visible state likely requires an i18n key. `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:254-261`

## 6. When not to do it

Do not implement this solely to enable completion notifications: the current browser completion-toast path does not consume the generic agent notification broadcast. If telemetry shows only a few sessions per installation and no startup latency or memory issue, C is reasonable. Retention/cleanup should remain a separate concern rather than being coupled to sidebar hydration.