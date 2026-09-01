# T-series shared contract — per-client terminal viewport policy ("largest visible client owns the PTY size")

Problem: one tmux pane = one shared PTY. Today every browser's `terminal-resize` / `terminal-sync-size` calls `resize-window`, so opening the pane on a phone shrinks the desktop's view. Goal: the PTY (tmux window) size follows the **largest currently-visible client**; smaller clients ("followers") keep the PTY geometry locally and pan; keyboard/mouse input stays shared (unchanged). When the larger client hides (document hidden) or disconnects, the next largest visible client becomes owner and the window is resized to it.

## Protocol (Borsh, `packages/shared/src/ws-borsh`)

### C2S `TERM_VIEWPORT` (new kind, command name `terminal-viewport`)

```
{ deviceId: string, paneId: string, cols: u16, rows: u16, visible: bool }
```

Client semantics:
- `visible=true` + measured geometry: sent when a pane surface becomes the active visible surface (mount/switch) and on `document.visibilitychange → visible`.
- `visible=false`: sent on `document.visibilitychange → hidden`, and when the surface is unmounted / no longer the visible pane (keep-alive hidden instances are not visible). `cols/rows` may be the last measured values.
- Every `terminal-resize` / `terminal-sync-size` also counts as a `visible=true` claim with that geometry (backwards compatible: a client that never sends `terminal-viewport` behaves as a permanently visible claimant while connected).

### S2C `TERM_VIEWPORT_POLICY` (new kind, event name `terminal-viewport-policy`)

```
{ deviceId: string, windowId: string, paneId: string, owner: bool, cols: u16, rows: u16 }
```

- `paneId` = the pane the recipient claimed with (so the client can key by pane); `windowId` = the tmux window the policy applies to (claims are resolved per window because tmux resizes per window).
- `owner=true`: the recipient's geometry is the applied one — it should keep reporting resizes (`sizingMode='report'`).
- `owner=false`: another visible client owns the size; the recipient must **stop reporting** its container size (`sizingMode='follow'`), keep its local emulator at the authoritative `cols×rows` (which also arrives via snapshot `PaneWire.width/height`), and pan locally.
- Sent to every session that holds a claim on that window whenever the winner or applied geometry changes, and immediately after a session's first claim on a window (so a new follower learns at once).

## Gateway policy (`apps/gateway/src/ws`)

- Claims live on `GatewaySession`: `Map<"deviceId/windowId", { paneId, cols, rows, visible, at }>`. `paneId → windowId` is resolved from the device runtime's current snapshot (same lookup `handleTermResize` uses).
- Winner per (device, window) among **visible** claims of sessions attached to that device entry: max `cols*rows`, then `cols`, then `rows`, then lowest session id (deterministic).
- tmux is resized (existing `resizeWindow`/`resizePane` path) only when the winner's geometry differs from the last applied geometry for that window; resize requests from non-winners are recorded as claims but **not** applied.
- No visible claims (everyone hidden) → keep current size.
- Claims are dropped on session close, device detach and reconnect-failure cleanup; the winner is recomputed and applied for affected windows.
- Single-client case must be byte-for-byte identical to today's behaviour (the sole claimant is always the owner).

## Frontend

- Store: `packages/stores` keeps `viewportPolicy: Record<paneKey, { owner: boolean; cols: number; rows: number; windowId: string }>` updated from `terminal-viewport-policy`; default (no policy received) = owner.
- Single-pane view (`packages/panels/src/device-console/terminal-stage.tsx`): visible surface uses `sizingMode = owner ? 'report' : 'follow'`; hidden keep-alive instances stay `'local'`. On follower → owner transition, force one `report()` so the new owner's geometry is applied. Split-screen panes are already `'follow'` and unchanged.
- Follower rendering (`packages/ghostty-terminal` + `packages/terminal-ui`): the PTY-sized surface is drawn in full inside a pan viewport (`overflow:auto` both axes, `overscroll-behavior: contain`); touch: nested-scroll rule — vertical drag pans while the pan viewport can still move in that direction, otherwise falls through to scrollback (`scrollLines`); horizontal drag pans; mouse-reporting / alt-scroll semantics unchanged. Desktop: wheel = scrollback (unchanged), horizontal wheel / scrollbars pan.
