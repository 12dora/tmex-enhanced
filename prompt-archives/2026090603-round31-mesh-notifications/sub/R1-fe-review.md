Found five defects in the frontend change.

1. **P2 — Forwarded events can duplicate existing toasts after navigation**  
   [entry-notify-toasts.tsx:58](/Users/konata/code/tmex-r31/apps/fe/src/notifications/entry-notify-toasts.tsx:58)

   The current route is not the only runtime capable of displaying notifications. Visit node B, then navigate to `/settings`: B’s `WatchEventsInit` handler remains registered because it never unsubscribes. Its runtime survives for the 30-second release grace period, or longer when retained by the sidebar. A subsequent B watch event produces both the original `WATCH_EVENT` toast and the new forwarded toast. Device subscriptions retained by the sidebar can similarly duplicate terminal-notification toasts.

   **Fix:** Make notification presentation ownership explicit. Unsubscribe watch handlers on their final owner’s unmount, and coordinate direct and forwarded presentation per origin/event type. Add a B → self navigation test that delivers both representations and asserts exactly one toast.

2. **P2 — The route-node exclusion also drops events that have no direct toast consumer**  
   [entry-notify-toasts.tsx:58](/Users/konata/code/tmex-r31/apps/fe/src/notifications/entry-notify-toasts.tsx:58)

   Conversely, being on `/n/B/settings` does not guarantee B’s terminal notification will reach this browser. The gateway sends tmux notifications only to the originating device’s subscribed clients (`DeviceFeedBroadcaster` uses `entry.clients`). If another browser maintains that device connection, this browser can receive the forwarded event through the entry while receiving no direct device event; this filter discards its only toast. Watch events are also lost while B’s login gate is pending or blocked, before `NodeSessionInit` mounts.

   The new unit test asserting unconditional suppression for the current route enshrines this incorrect assumption.

   **Fix:** Suppress the forwarded copy only when an active, ready direct consumer owns presentation for that event/device, or deduplicate actual deliveries using shared event identity. Cover an unsubscribed device and a blocked route gate.

3. **P2 — An explicit entry-node URL mounts duplicate watch listeners and shows the wrong scope banner**  
   [main.tsx:239](/Users/konata/code/tmex-r31/apps/fe/src/main.tsx:239), [notify-scope-banner.tsx:23](/Users/konata/code/tmex-r31/apps/fe/src/pages/settings/notifications/notify-scope-banner.tsx:23)

   `/n/<entryNodeId>/settings` is a supported local alias: the gateway’s `rewriteSelf()` explicitly recognizes the actual entry ID. These checks recognize only the literal `self`. Consequently, the page mounts watch listeners through both the `self` runtime and the separate UUID runtime, producing two toasts for entry-local watch events. The banner also incorrectly describes these local settings as remote.

   **Fix:** Normalize the actual entry ID to `self` before selecting runtimes and determining scope. Reuse that identity consistently; merely hiding the extra component leaves previously registered watch listeners alive. Test both `/settings` and `/n/<entryNodeId>/settings`.

4. **P2 — The sink list and queue counters remain stale while the card stays open**  
   [mesh-notification-card.tsx:130](/Users/konata/code/tmex-r31/apps/fe/src/pages/settings/notifications/mesh-notification-card.tsx:130)

   The query refreshes on local mutation/settings invalidation, but remote sink changes propagate through mesh inventory/status updates. The backend broadcasts `notifications-mesh` settings invalidation only on the node handling the PUT. Thus, while viewing A’s card, enabling/disabling B or changing B’s reachability does not refresh A’s sink list. Queue growth and draining likewise emit no settings update. `staleTime` alone does not schedule a refetch.

   **Fix:** Invalidate the query when relevant mesh inventory/reachability changes, and add bounded polling while the card is mounted to refresh queue counters and cover missed updates.

5. **P2 — The e2e test can pass on a watch failure instead of the intended trigger**  
   [mesh-notify.spec.ts:128](/Users/konata/code/tmex-r31/apps/fe/tests/mesh-notify.spec.ts:128)

   The assertion accepts any toast containing the remote node name. Forwarded `watch_rule_error` and `watch_model_unavailable` events contain that same origin label. A capture failure can therefore satisfy the test even when the token never triggers the rule.

   **Fix:** Match the expected trigger toast using the unique token and rule name, assert its trigger title, and verify the rule’s triggered state. Also assert exactly one matching toast.

Validation: **66 targeted Bun tests passed**, including core i18n coverage. The settings deep-link construction and same-node settings-broadcast query-key mapping are correct. Live e2e was not run in the read-only sandbox.