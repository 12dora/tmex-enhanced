# EX1 — PWA load and steady-state transfer audit

## Executive finding

The largest avoidable costs are not blind terminal-output broadcasts to every browser. The gateway filters legacy terminal output per client and pane. The main regressions are:

1. Remote node runtimes and direct-connection controllers start for online/logged-in nodes even when their terminal or section is hidden.
2. Keep-alive terminals remain mounted and continue consuming live output when not visible.
3. Mesh discovery is resident, polled every 30 seconds, and independently instantiated by more than one consumer.
4. The app has no service worker or explicit static-asset cache policy; the default font assets alone total approximately 2.48 MB, and Ghostty WASM is approximately 0.55 MB.
5. The current browser transport does not negotiate the newer compressed/diff/canonical protocol.

## 1. Boot sequence

The exact timing of post-render effects is concurrent rather than strictly serial.

### Browser and blocking startup

The browser loads the HTML, `/api/manifest.webmanifest`, the entry module, and its static module graph. The manifest and module entry are declared in `apps/fe/index.html:16-25`.

Before React renders, i18next dynamically imports only the selected locale chunk. `apps/fe/src/i18n/index.ts:6-18` uses `import.meta.glob`; `:28-53` initializes i18next and awaits the selected locale. React rendering is deferred until that promise resolves in `apps/fe/src/main.tsx:315-331`. This is a deliberate blocking request, although it is much smaller than loading all locales.

`RootLayout` always mounts the site settings bridge, mesh-node resident owner, self-node runtime, sidebar, and side-panel host (`apps/fe/src/main.tsx:129-155`). The terminal page itself is lazy-loaded: terminal routes use `deviceModule` at `apps/fe/src/main.tsx:237-275`; `apps/fe/src/page-wrapper.tsx:32-85` starts the module load from an effect.

### Immediate application HTTP requests

After the initial React tree mounts, these requests can begin concurrently:

- `/api/settings/site`: the always-mounted sidebar title calls the site-settings loader (`apps/fe/src/components/page-layouts/components/sidebar-title.tsx:19-24`; `packages/api-client/src/site.ts:6-14`).
- `/api/capabilities`: `NodeSessionInit` calls `loadCapabilities()` without awaiting it (`apps/fe/src/main.tsx:177-190`; `packages/api-client/src/capabilities.ts:13-20`).
- `/api/auth/mode`: mesh mode detection uses a single-flight request (`apps/fe/src/node/mesh-nodes.ts:256-291`).
- `/api/mesh/nodes`: the resident mesh owner immediately refreshes the node list and starts a 30-second interval (`apps/fe/src/node/mesh-nodes.ts:299-318`, `:345-386`).
- `/mesh/ws`: the shared mesh event source opens its WebSocket (`apps/fe/src/node/mesh-events.ts:188-194`, `:317-323`, `:386-421`).
- `/api/devices`: `GlobalDeviceProvider` issues the device query (`apps/fe/src/components/global-device-provider.tsx:297-356`; `packages/api-client/src/devices.ts:11-35`).

The device query is observed by the provider, sidebar device tree, and console, but these use the same `['devices']` key and fetch function (`packages/panels/src/device-tree/use-sidebar-device-stats.ts:1-3`; `packages/panels/src/device-tree/sidebar-device-list.tsx:70-83`; `packages/panels/src/device-console/use-console-targets.ts:28-79`). React Query normally collapses this into one physical request.

There are two independent `useMeshNodes()` consumers: the resident owner and the sidebar list (`apps/fe/src/node/mesh-nodes-resident.tsx:1-12`; `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:93-95`). The fetch itself is single-flight while concurrent, but each consumer installs its own 30-second timer (`apps/fe/src/node/mesh-nodes.ts:299-317`, `:371-377`). This can produce duplicate steady-state requests.

### Primary gateway WebSocket

`WatchEventsInit` is mounted globally and calls `ensureSocketConnected()` (`packages/panels/src/watch/watch-events-init.tsx:200-208`). The primary gateway socket then:

1. Opens and sends `HELLO` (`packages/ws-client/src/client.ts:253-295`, `:401-416`).
2. Receives the server hello/capabilities and enters READY; it immediately starts heartbeat activity (`packages/ws-client/src/client.ts:346-354`; `apps/gateway/src/ws/index.ts:515-550`).
3. Resends device and pane state on READY (`packages/stores/src/tmux.ts:64-79`).
4. Sends `connect-device` for each connected/visible device (`packages/stores/src/tmux.ts:160-178`).
5. Receives device state/events; the client may send `set-window-style` after device connection (`packages/stores/src/tmux-event-router.ts:112-122`).

Self devices default to visible, and the sidebar ensures visible devices are subscribed (`packages/stores/src/sidebar-device-visibility.ts:4-20`; `packages/panels/src/device-tree/sidebar-device-list.tsx:190-216`).

The client advertises `supportsCompression:false`, `supportsDiffSnapshot:false`, and does not advertise atomic-screen or cursor-history support (`packages/ws-client/src/client.ts:401-416`; `packages/ws-client/src/websocket-transport.ts:15-23`).

### Agent and remote-node branches

The sidebar agent provider is enabled by default (`packages/stores/src/runtime.ts:319-325`; `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:39-61`). It asynchronously calls `loadSessions()` (`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:343-356`), which performs a full `/api/agent/sessions` request (`packages/stores/src/agent-session-crud-actions.ts:239-270`). It also restores active agent subscriptions and resends them after READY (`packages/stores/src/agent.ts:114-159`). This is not necessary for the first terminal unless agent decorations are required.

For each online/logged-in remote node, `SidebarNodeSection` creates a `NodeRuntimeScope` even though the section’s visible child may later return `null` (`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:318-353`; `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:64-102`). The runtime starts a direct-carrier controller (`apps/fe/src/node/node-runtimes.ts:195-235`). A direct attempt can issue, in order:

1. `GET /api/mesh/connection?cid=...`
2. `GET /api/mesh/rtc-config`
3. `POST /api/rtc/authorize`

These are triggered by `apps/fe/src/node/direct-carrier-controller.ts:444-476`, with the individual fetches at `:526-604`. This is substantial control-plane work for nodes whose terminals are not displayed.

### First terminal interaction

After the lazy device module resolves, `DevicePage` renders `DeviceConsole` (`apps/fe/src/pages/DevicePage.tsx:20-30`). Route reconciliation dispatches pane selection once the device is connected (`packages/panels/src/device-console/use-pane-route-reconciliation.ts:70-122`; `packages/stores/src/select-pane-dispatch.ts:38-80`).

A terminal mount then:

- Registers a pane sink and sends a pane-subscription set update (`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:42-109`; `packages/stores/src/pane-subscriptions.ts:25-75`).
- Sends `select-pane`; on a cold legacy pane, the selection requests history (`packages/stores/src/select-pane-dispatch.ts:38-80`; `packages/shared/src/ws-borsh/schema.ts:81-89`).
- Does not request an atomic screen or cursor history with current browser capabilities (`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:111-123`; `packages/ws-client/src/websocket-transport.ts:15-23`).
- May send an initial resize/sync-size after layout measurement (`packages/terminal-ui/src/components/Terminal.tsx:107-122`; `packages/terminal-ui/src/components/terminal-resize-reporter.ts:152-183`; `packages/terminal-ui/src/components/useTerminalResize.ts:117-122`).
- Starts terminal resource initialization, including fonts and Ghostty WASM (`packages/terminal-ui/src/components/hooks/terminal-surface-lifecycle.ts:96-119`; `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:234-323`).

The terminal controller is configured with a 10,000-line scrollback (`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:172-192`), but the current legacy browser path does not request history for panes that were never selected. History is targeted to the switching/selected client (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:296-338`; `apps/gateway/src/ws/tmux-command-handlers.ts:420-465`).

## 2. PWA and caching

There is no configured service worker:

- Vite has only Tailwind, React, and visualizer plugins (`apps/fe/vite.config.ts:45-75`).
- The package has no PWA/Workbox dependency (`apps/fe/package.json:15-25`).
- `index.html` contains a manifest link and module script but no service-worker registration (`apps/fe/index.html:16-25`).

Therefore:

- There is no precache manifest.
- There is no network-first runtime cache.
- Ghostty WASM and fonts are not service-worker cached.
- There is no app-defined version bump that invalidates all caches.
- No code forces a complete redownload on every launch; the browser’s normal HTTP cache is the only relevant mechanism.

The static frontend server sets content type but no explicit `Cache-Control`, ETag, or immutable policy (`packages/app/src/runtime/serve-frontend.ts:45-81`). The manifest is explicitly `no-store` (`apps/gateway/src/api/http.ts:11-18`), so manifest refetches are expected.

The default font files measured in the worktree total approximately 2,484,968 bytes; Ghostty WASM is approximately 554,837 bytes. Their loading paths are `apps/fe/src/index.css:17-44`, `packages/theme/src/fonts/index.ts:45-65`, and `packages/ghostty-terminal/src/ghostty-wasm.ts:1541-1615`. These loads are not React-render blocking, but they delay terminal readiness.

## 3. Steady-state traffic

| Source | Closed/hidden panel | Background page | Non-visible terminal |
|---|---|---|---|
| Mesh REST polling | Continues because the resident owner is always mounted; sidebar adds another timer (`apps/fe/src/node/mesh-nodes-resident.tsx:1-12`; `apps/fe/src/node/mesh-nodes.ts:345-386`) | No visibility check | Unrelated to terminal visibility |
| Mesh WebSocket | Shared singleton remains open (`apps/fe/src/node/mesh-events.ts:448-467`) | Remains open | Continues |
| Gateway heartbeat | Continues | Visibility handling only reconnects/checks when becoming visible; it does not pause background heartbeats (`packages/ws-client/src/client.ts:577-604`; `packages/ws-client/src/heartbeat-controller.ts:20-47`) | Continues |
| Terminal output | Selected/subscribed panes only on browser wire (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:246-273`) | No visibility gate | Keep-alive hidden terminals remain mounted and consume live output (`packages/panels/src/device-console/terminal-stage.tsx:273-316`) |
| TERM_HISTORY | Targeted to selected/switching client; not broadcast to all clients (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:296-338`) | Same | Not sent to never-shown panes |
| File directory polling | Only while the directory query is enabled/expanded; collapsed file sections unmount their tree (`packages/panels/src/files/use-directory-listing.ts:23-38`; `packages/panels/src/files/files-node-section.tsx:54-106`) | `refetchIntervalInBackground:false` (`packages/panels/src/files/use-directory-listing.ts:29-38`) | Not terminal-related |
| Watch state polling | Only while the watch detail/dialog is mounted; 5-second interval (`packages/panels/src/watch/use-watch-rules.ts:75-83`; `packages/panels/src/watch/watch-dialog.tsx:89-93`) | Not a global terminal poll | Not terminal-related |
| Agent events | Only subscribed sessions receive agent events (`apps/gateway/src/agent/ws-hub.ts:120-143`) | Persistent while runtime exists | Hidden agent-enabled node runtimes may remain active |
| Watch events | Encoded once but sent to every negotiated gateway WS client (`apps/gateway/src/agent/ws-hub.ts:145-165`) | Persistent | Not pane-specific |
| Direct-carrier stats | Local `getStats()` every 2 seconds while active (`packages/ws-client/src/direct/direct-carrier-controller.ts:932-970`) | No visibility gate shown | CPU overhead; not significant network payload |

Keep-alive retains up to three terminal instances (`packages/panels/src/device-console/terminal-keep-alive.ts:20`, `:75-100`, `:107-151`). Hidden instances retain sinks and therefore can continue receiving output. The sink registry buffers output only when no sink exists (`packages/ws-client/src/pane-sink-registry.ts:171-198`).

The gateway’s tmux control-mode source is broader than browser delivery: it receives and parses every `%output` from the attached tmux control session (`apps/gateway/src/tmux-client/control-mode-subscription.ts:102-109`; `apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:153-209`). Browser delivery is filtered, but upstream tmux/SSH parsing continues even when no client displays a pane. The broadcaster avoids downstream batching when there are no observed panes (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:217-232`).

The only explicit document-visibility gate found is clipboard handling (`packages/stores/src/tmux-event-router.ts:250-258`); terminal output, mesh traffic, agent traffic, and heartbeat do not use the same gate.

## 4. Gateway fan-out and Borsh protocol

The current browser uses the legacy transport, not canonical feed: canonical capabilities are false in `packages/ws-client/src/websocket-transport.ts:15-23`.

For legacy terminal output, the gateway maintains per-client observed-pane state using reference counts (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:33-102`). Output is sent only to the selected/subscribed clients for that pane, and the encoded payload is reused rather than independently encoded per client (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:246-273`). This part is sound.

However, full state snapshots and metadata patches are sent to every non-canonical client attached to the device (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:186-215`, `:234-244`). Generic device events and errors are also delivered to all clients in the device entry (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:340-375`). The payload may be encoded once, but the bytes are repeated per recipient.

The Borsh envelope contains fixed metadata plus a length-prefixed payload (`packages/shared/src/ws-borsh/schema.ts:8-15`). The newer canonical protocol bounds frames to 32 KiB and uses active/hot pane subscriptions (`packages/shared/src/ws-borsh/canonical-state.ts:12-16`, `:80-106`, `:298-334`), with 16 ms/64 KiB pane batching (`apps/gateway/src/ws/canonical/pane-stream.ts:94-142`). Those optimizations are not used by the current PWA.

Mesh REST nodes are relatively rich: the projection includes a base64 public key, endpoints, inventory, reachability, transport, RTT, and direct-failure data (`apps/gateway/src/mesh/node-list-projection.ts:151-212`; DTO fields `packages/api-client/src/auth/types.ts:178-220`). The public key alone represents 32 bytes as roughly 44 base64 characters; with endpoint, inventory, and diagnostic fields, the response is on the order of hundreds of bytes per node before headers. It is retransmitted every poll.

## 5. Ranked waste items

### Highest impact

1. **Remote runtimes/direct dialing for hidden nodes — needs design**

   Online/logged-in remote nodes can create runtimes and start direct-carrier negotiation even when their terminal is not visible (`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:318-353`; `apps/fe/src/node/node-runtimes.ts:217-234`; `packages/ws-client/src/direct/direct-carrier-controller.ts:444-604`). Impact is roughly O(remote nodes) in HTTP requests, PeerConnection setup, signaling, and mobile CPU/battery. Gate runtime creation and direct dialing on an actually visible/selected node, while preserving a lightweight presence/relay status path. The trade-off is that relay badges and “instant” remote switching become less real-time.

2. **Keep-alive panes still receive live output — needs design**

   Up to three hidden terminals stay mounted and consume output (`packages/panels/src/device-console/terminal-keep-alive.ts:20-100`; `packages/panels/src/device-console/terminal-stage.tsx:273-316`). Impact is proportional to output volume, plus decoding and terminal-render work for hidden panes. Separate “warm terminal state” from “live subscription”: retain the instance but unsubscribe its pane when hidden, then request a bounded screen/history snapshot when shown.

3. **Gateway parses all control-mode pane output — needs design**

   The gateway/SSH control source processes all `%output` frames before browser filtering (`apps/gateway/src/tmux-client/control-mode-subscription.ts:102-109`). This does not necessarily increase mobile bytes, but it consumes gateway CPU and upstream bandwidth for unseen panes. A per-pane upstream retention/subscription strategy would reduce this, but requires tmux/control-mode lifecycle design and can affect reconnect correctness.

4. **Background heartbeat and mesh signaling remain active — safe quick win**

   The gateway heartbeat and mesh WebSocket remain active while the page is hidden (`packages/ws-client/src/client.ts:577-604`; `packages/ws-client/src/heartbeat-controller.ts:20-47`; `apps/fe/src/node/mesh-events.ts:448-467`). Individual messages are small, but the cost is continuous radio wakeups and battery use. Pause or lengthen heartbeat/presence work while hidden and reconnect on visibility; trade-offs are stale presence and reconnect latency.

5. **Duplicate mesh polling — safe quick win**

   Resident mesh ownership and sidebar consumption each install a 30-second poll (`apps/fe/src/node/mesh-nodes-resident.tsx:1-12`; `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:93-95`; `apps/fe/src/node/mesh-nodes.ts:345-386`). Keep the resident owner as the sole poller and expose its cached result to sidebar consumers.

6. **Full mesh DTO on every poll — safe API optimization**

   Endpoints, inventory, public key, RTT, and failure diagnostics are included in the main node projection (`apps/gateway/src/mesh/node-list-projection.ts:20-37`, `:151-212`). Split compact presence from on-demand diagnostics, or add ETag/diff support. The trade-off is extra API complexity and a second request when the diagnostics panel opens.

7. **Agent session bootstrap in the sidebar — safe quick win**

   The default agent UI loads the full session list and restores active subscriptions before the Agent tab is selected (`apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:39-61`; `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:343-356`; `packages/stores/src/agent-session-crud-actions.ts:239-270`). Make the sidebar use a compact status endpoint and defer full session hydration until the Agent tab opens.

8. **No service-worker/static cache policy — safe quick win**

   Fonts and WASM are fetched through normal browser caching only (`apps/fe/src/index.css:17-44`; `packages/ghostty-terminal/src/ghostty-wasm.ts:1541-1615`), while the static server adds no explicit cache headers (`packages/app/src/runtime/serve-frontend.ts:45-81`). Add immutable caching for hashed assets and an explicit policy for WASM/fonts. A service worker is optional; HTTP caching alone may be sufficient.

9. **Device query can begin before remote login gate — safe quick win**

   `GlobalDeviceProvider` is outside `NodeRouteGate` (`apps/fe/src/node/node-runtime-boundary.tsx:40-69`), while the gate’s purpose is to delay page requests until remote authentication is ready (`apps/fe/src/auth/use-node-login.ts:68-107`). Move the provider inside the gate or bind its `enabled` condition to gate readiness to avoid a premature remote `/api/devices` request.

### Checked and found acceptable

- Legacy terminal output is pane/client filtered, not broadcast blindly (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:33-51`, `:246-273`).
- TERM_HISTORY is targeted and not sent to never-selected panes (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:296-338`).
- File directory polling stops in the background and collapsed file sections unmount (`packages/panels/src/files/use-directory-listing.ts:23-38`; `packages/panels/src/files/files-node-section.tsx:54-106`).
- Auth, site settings, mesh refresh, and device requests use single-flight or shared query caching (`apps/fe/src/node/mesh-nodes.ts:256-317`; `packages/stores/src/site-settings-loader.ts:93-110`; `packages/panels/src/device-tree/use-sidebar-device-stats.ts:1-3`).
- Lazy locale, terminal, settings, and side-panel modules avoid loading those feature bundles on the first terminal route (`apps/fe/src/i18n/index.ts:6-53`; `apps/fe/src/main.tsx:237-275`; `apps/fe/src/components/side-panels/side-panel-host.tsx:20-79`).

## 6. Recent regressions

- **Remote agent:** `2c082794`, `c0aa4daa`, `36ed6bfa`, and `2a08b932` added node-aware agent/session infrastructure. The current full session load and active subscription behavior is evidenced by `apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:343-356` and `packages/stores/src/agent.ts:114-159`. Payload size is dynamic and should be measured from representative session counts.
- **Files multi-node:** `4ee1152c` introduced node-oriented file sections. The selected Files view can issue roots, devices, providers, and system-info requests per mounted node (`packages/panels/src/files/files-node-roots.tsx:91-119`), producing roughly four request classes per active node.
- **Relay badge/direct diagnostics:** `06f0a6b2` and `96ba9a92` added reachability, endpoint, RTT, and direct-failure fields to mesh refreshes (`apps/fe/src/node/mesh-nodes.ts:299-318`; `apps/gateway/src/mesh/node-list-projection.ts:151-212`).
- **Keep-alive stack:** `de145abf` and `310af64f` added the recent-pane retention behavior now visible in `packages/panels/src/device-console/terminal-keep-alive.ts:20-100` and `packages/panels/src/device-console/terminal-stage.tsx:273-316`.
- **Node upgrade:** `650be310`, `b0cce406`, and `dc59ab32` add upgrade/status traffic only when the settings upgrade flow is active (`apps/fe/src/pages/settings/use-node-upgrade.ts:93-103`, `:130-181`); they are not first-terminal traffic.
- **Onboarding/connect-devices:** `2194208a`, `cb6eb71f`, `d9c00832`, `251a924f`, and `d162a33d` are behind lazy side-panel rendering (`apps/fe/src/components/side-panels/side-panel-host.tsx:20-79`). Their address/tunnel requests are panel-scoped, not global boot requests (`apps/fe/src/components/side-panels/connect-devices/use-access-addresses.ts:17-35`).