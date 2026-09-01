# EX1 report — keep-alive terminals

## 1. Current behaviour

The keep-alive pool is limited to three mounted panes total, including the visible pane, so the normal maximum is two hidden panes. The pool retains pane IDs in MRU order and keeps their React instances alive. `packages/panels/src/device-console/terminal-keep-alive.ts:1-20`, `packages/panels/src/device-console/terminal-keep-alive.ts:56-72`

Hidden panes are not `display:none` or offscreen. Each slot remains an `absolute inset-0` box and uses `opacity:0`, `pointer-events:none`, and `z-index:0`; the visible slot uses `z-index:1`. The inner Ghostty mount is independently activated with `visibility:visible`, which is why ancestor `visibility:hidden` cannot be used. `packages/panels/src/device-console/terminal-stage.tsx:220-250`, `packages/terminal-ui/src/components/hooks/terminal-render-target.ts:54-73`

Every mounted `Terminal` registers both a pane sink and a pane subscription, without checking whether the instance is visually hidden. The subscription manager forms the union of manual subscriptions and all mounted panes. `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:97-109`, `packages/stores/src/pane-subscriptions.ts:25-47`

A legacy client considers a pane wanted when it is either selected or subscribed. The gateway’s observed-pane set also unions selected and subscribed panes, so the “observed pane” filter does not eliminate hidden keep-alive panes. They continue through batching and are delivered immediately when subscribed but not selected. Selected output alone may be held by the select switch barrier. `apps/gateway/src/ws/legacy-feed-broadcaster.ts:34-53`, `apps/gateway/src/ws/legacy-feed-broadcaster.ts:219-234`, `apps/gateway/src/ws/legacy-feed-broadcaster.ts:248-275`

`TERM_HISTORY` is different: the legacy broadcaster sends it only to the pane’s select transaction or to clients whose selected pane matches. A subscribed-but-not-selected hidden pane does not receive history refreshes. `apps/gateway/src/ws/legacy-feed-broadcaster.ts:298-339`

Round 11’s viewport policy is already correct. `useViewportClaims` is instantiated only for `resolvedPaneId`; hidden terminals use `sizingMode="local"` and have no resize/sync callbacks. The gateway winner resolver ignores `visible:false` claims. Hidden keep-alive panes therefore do not participate in viewport arbitration. `packages/panels/src/device-console/terminal-stage.tsx:311-359`, `packages/panels/src/device-console/use-viewport-claims.ts:104-120`, `apps/gateway/src/ws/viewport-policy.ts:44-68`

On a retained target, route reconciliation currently requests a warm select; `dispatchSelectPane` then sends `wantHistory:false`. On a cold select, it sends `wantHistory:true`; the gateway records a visible viewport claim and calls `selectPaneWithSize` when dimensions are available. `packages/panels/src/device-console/use-pane-route-reconciliation.ts:96-107`, `packages/stores/src/select-pane-dispatch.ts:55-80`, `apps/gateway/src/ws/tmux-command-handlers.ts:144-207`

The existing legacy resync path is full history, not screen-only. Both `request-pane-screen` and `request-pane-history` encode to the same legacy fetch command, and the gateway returns `fetchPaneHistory`, which captures bounded history plus the current screen. `packages/ws-client/src/transport-command-encoder.ts:67-71`, `apps/gateway/src/ws/tmux-command-handlers.ts:780-804`, `apps/gateway/src/tmux-client/external/session-commands.ts:342-399`

The existing restore writes into the current terminal after resizing and restoring modes. `TerminalSurface` explicitly documents that recovery rewrites the visible terminal and accepts one visible flash. `packages/terminal-ui/src/components/terminal-snapshot.ts:157-192`, `packages/terminal-ui/src/components/TerminalSurface.ts:102-110`

Sequence metadata exists in the type model, but not on the current direct legacy browser path: legacy WebSocket capabilities set `sequencedTerminal`, `atomicScreen`, and `cursorHistory` to false, and the legacy decoder drops `seqStart`/`seqEnd`. The local subscription generation is also omitted by the legacy encoder and is not accepted by `handleSubscribePanes`. `packages/ws-client/src/websocket-transport.ts:15-23`, `packages/ws-client/src/transport-message-decoder.ts:125-131`, `packages/stores/src/pane-subscriptions.ts:38-46`, `packages/ws-client/src/transport-command-encoder.ts:67-71`, `apps/gateway/src/ws/tmux-command-handlers.ts:750-778`

The sink registry is bounded. If a sink is absent, pending output is capped at 2 MiB and overflow becomes `resource_exhausted`; if the sink remains registered while the wire subscription is removed, no hidden output arrives and this buffer does not grow. `packages/ws-client/src/pane-sink-registry.ts:171-198`, `packages/ws-client/src/pane-sink-registry.ts:248-275`

The heartbeat currently does not pause or lengthen when the page is hidden. The client uses a fixed 5-second interval and 10-second PONG timeout; the visibility handler acts only when the page becomes visible. `packages/ws-client/src/client.ts:62-70`, `packages/ws-client/src/heartbeat-controller.ts:20-47`, `packages/ws-client/src/client.ts:577-604`

The inspected gateway WebSocket path responds to PING with PONG and contains no socket idle timer. Its separate device-runtime idle timer releases a device connection entry only after it has no attached clients; that is not a WebSocket inactivity timeout. `apps/gateway/src/ws/index.ts:453-541`, `apps/gateway/src/ws/device-connection-registry.ts:81-96`

## 2. Design options

| Option | Trade-off |
|---|---|
| A. Unsubscribe hidden panes; full history on show | Smallest legacy change. Reuses the existing cold select, `TERM_HISTORY`, and switch barrier. It replays up to the legacy history limit and may cause the existing visible rewrite flash, but preserves correctness. `apps/gateway/src/ws/borsh/switch-barrier.ts:173-243`, `packages/terminal-ui/src/components/terminal-snapshot.ts:173-192` |
| B. Unsubscribe hidden panes; screen-only snapshot on show | Lower bandwidth and preserves the conceptual old scrollback, but not cheap here. The current browser path does not consume canonical screen transactions, and `writeCanonicalSnapshot` resets and rewrites the terminal rather than preserving its scrollback. `packages/ws-client/src/transport-message-decoder.ts:38-42`, `packages/terminal-ui/src/components/terminal-snapshot.ts:115-134` |
| C. Keep subscribed; only remove viewport participation | Already effectively implemented for keep-alive panes. It avoids resync complexity but does not reduce hidden output delivery. `packages/panels/src/device-console/terminal-stage.tsx:316-359`, `apps/gateway/src/ws/legacy-feed-broadcaster.ts:34-53` |
| D. Do nothing | Justifiable only if telemetry shows hidden-pane output is negligible. The observed-pane filter alone is not evidence for this because subscribed panes are explicitly observed. Existing metrics already distinguish source and recipient output volume. `apps/gateway/src/ws/legacy-feed-broadcaster.ts:219-245`, `apps/gateway/src/ws/legacy-feed-broadcaster.ts:248-274` |

## 3. Recommendation

Choose A for the current legacy browser transport:

- Keep the Ghostty instance and registered sink mounted.
- Decouple sink registration from the `mountPane` wire-subscription reference; only the visible keep-alive instance contributes its pane to the wire subscription set.
- On re-show, force a cold selection instead of treating a retained instance as warm. Reuse the existing `wantHistory:true` select transaction and switch barrier.
- Keep the existing reset-before-history behaviour so the old scrollback is replaced rather than appended.

This provides the requested “warm instance, cold subscription” behaviour without introducing a new legacy protocol. The canonical screen transaction should be reconsidered only after canonical transport is used by the browser.

## 4. Affected files and estimated diff

Likely production changes: approximately 40–80 lines.

- `packages/terminal-ui/src/components/types.ts`, `Terminal.ts`, and `usePaneSinkRegistration.ts`: add a visible/subscription participation prop while leaving sink registration independent. `packages/terminal-ui/src/components/Terminal.tsx:19-39`, `packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:97-121`
- `packages/panels/src/device-console/terminal-stage.tsx`: pass visibility into each keep-alive terminal. `packages/panels/src/device-console/terminal-stage.tsx:330-362`
- `packages/panels/src/device-console/use-pane-route-reconciliation.ts` and possibly `terminal-keep-alive.ts`: prevent retained-but-unsubscribed panes from taking the warm path. `packages/panels/src/device-console/use-pane-route-reconciliation.ts:96-107`
- `packages/stores/src/pane-subscriptions.ts`: only if the existing mount API cannot cleanly separate sink lifetime from subscription lifetime. `packages/stores/src/pane-subscriptions.ts:10-19`

Expected test additions/updates: approximately 80–160 lines across terminal-stage, pane-subscription, warm-selection, sink-registry, and gateway broadcaster tests.

## 5. Risks and test strategy

Test that hidden instances remain mounted and retain their same keys, while the outgoing `set-pane-subscriptions` excludes them. Test that re-showing sends `wantHistory:true`, delivers history before live output, and does not append duplicate scrollback. The existing switch barrier and pane-history tests provide the relevant ordering patterns. `apps/gateway/src/ws/borsh/switch-barrier.ts:298-364`, `packages/ws-client/src/pane-sink-registry.test.ts:310-327`

Also test output races during unsubscribe/resubscribe, pane deletion, reconnect, multiple browser sessions, and manual subscriptions. `handleSubscribePanes` flushes pending output before replacing the set, so that ordering must remain intact. `apps/gateway/src/ws/tmux-command-handlers.ts:770-778`, `apps/gateway/src/ws/index.test.ts:687-705`

A hidden pane may display stale content briefly before the cold history arrives; this is the existing accepted flash model. A new sequence number is not required for option A because the select barrier provides the recovery boundary, but it would be required for a true screen-only incremental design. `packages/terminal-ui/src/components/TerminalSurface.ts:102-110`, `apps/gateway/src/ws/borsh/switch-barrier.ts:216-243`

Lengthening hidden-page heartbeat intervals is orthogonal. It would touch `HeartbeatController` and the client visibility handler, likely requiring an interval restart or mutable interval API plus heartbeat tests. No gateway idle timeout currently requires coordination, but external proxies could impose one. `packages/ws-client/src/heartbeat-controller.ts:13-47`, `packages/ws-client/src/client.ts:577-604`

## 6. When not worth doing

Do not implement this if per-pane metrics show that hidden output is consistently trivial; the added lifecycle and resync race surface may then exceed the bandwidth savings. Do not pursue B before canonical transport becomes the browser default, because the current legacy path lacks the required atomic snapshot and sequence delivery support.