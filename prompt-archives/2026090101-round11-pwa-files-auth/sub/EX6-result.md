# EX6 findings

## 1. Rendering pipeline

`packages/ghostty-terminal` uses Canvas 2D, not WebGL: `CanvasRenderer` obtains a `2d` context and reports `kind = 'canvas'` (`packages/ghostty-terminal/src/canvas-renderer.ts:150-169`). One terminal surface actually owns four layered canvases—main, link, selection, and cursor—not one canvas (`packages/ghostty-terminal/src/canvas-renderer.ts:162-169,209-227`). The renderer test confirms four canvases are mounted (`packages/ghostty-terminal/src/terminal.canvas.test.ts:1564-1565`).

DPR is handled by rounding the CSS cell dimensions to integer device pixels. For a frame of `cols × rows`, each canvas receives a bitmap of `cols * deviceCellWidth` by `rows * deviceCellHeight`, while its CSS width and height are set to the corresponding dimensions divided by DPR (`packages/ghostty-terminal/src/canvas-renderer.ts:324-383`). The DOM cell measurement uses the same DPR alignment (`packages/ghostty-terminal/src/terminal-dom.ts:211-218`).

When `terminal.resize(cols, rows)` is called, the WASM terminal is resized first, then the controller updates its local `cols`/`rows` and schedules rendering (`packages/ghostty-terminal/src/terminal.ts:395-415`). Rendering subsequently resizes all four canvas layers to the frame geometry and draws rows using the full terminal width (`packages/ghostty-terminal/src/canvas-renderer.ts:241-260,501-559`).

Therefore, today an oversized local emulator is rendered as an oversized canvas surface and clipped by its ancestors. The root `.xterm` is `position:absolute; inset:0; width:100%; height:100%; overflow:hidden`; `.xterm-viewport` is also fixed at `100%` with `overflow:hidden`; `.xterm-screen` is fixed at `100%`; and `CanvasRenderer` explicitly sets the screen to `overflow:hidden` (`packages/ghostty-terminal/src/terminal-dom.ts:22-57`; `packages/ghostty-terminal/src/canvas-renderer.ts:201-207`). The canvas CSS dimensions are changed to the PTY-sized surface, not kept at the container size (`packages/ghostty-terminal/src/canvas-renderer.ts:370-383`). The result is “full surface drawn, visible rectangle clipped,” not “container-sized canvas with only a partial renderer pass.”

`Terminal.tsx` adds no terminal overflow rule: its wrapper and measured container are `h-full/w-full`, with the generation host absolutely filling the container (`packages/terminal-ui/src/components/Terminal.tsx:172-186`). `terminal-render-target.ts` only controls hidden mounting and activation visibility; it does not alter geometry (`packages/terminal-ui/src/components/hooks/terminal-render-target.ts:54-72`). The outer page wrapper is independently `overflow-auto` (`apps/fe/src/page-wrapper.tsx:74-85`), while the application root/body are globally `overflow:hidden` (`apps/fe/src/app.css:1-18`).

## 2. Split windows and fitting

The tmux layout parser represents pane positions and dimensions in cells (`packages/shared/src/tmux-layout.ts:1-25`). `computeSplitLayoutGeometry()` converts each leaf to pixel coordinates using the measured cell width/height and preserves the leaf’s `cols` and `rows` (`packages/terminal-ui/src/components/splitLayoutGeometry.ts:59-78`).

`SplitPaneView` positions each pane as a percentage of the root tmux grid (`packages/terminal-ui/src/components/split/SplitPaneView.tsx:103-114`). The pane root, pane content, and terminal content are all clipped with `overflow-hidden` (`packages/terminal-ui/src/components/split/SplitPaneView.tsx:103-114,170-189`). Each terminal is explicitly `sizingMode="follow"` (`packages/terminal-ui/src/components/split/SplitPaneView.tsx:174-189`), and `useSplitPaneTerminals` resizes each emulator to the exact layout leaf geometry (`packages/terminal-ui/src/components/split/useSplitPaneTerminals.ts:47-60,98-108`).

There is no terminal-specific `transform: scale()` or font-size adaptation in these split paths. The existing `FitAddon` only measures the current DOM and calls `terminal.resize()` with the proposed columns (`packages/ghostty-terminal/src/terminal.ts:60-77`); it does not shrink the font or scale the surface. The normal size calculation also derives columns/rows from container pixels and cell dimensions (`packages/terminal-ui/src/components/terminalMetrics.ts:16-41`).

Mobile has no automatic font fitting. Font size and line height are user settings with defaults of 13px and 1.2 (`packages/stores/src/ui.ts:85-88,114-117,162-164`). Changing them rebuilds the terminal surface with the new font metrics (`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:293-323`).

## 3. `sizingMode` and resize commands

The actual type has three modes—`'report' | 'follow' | 'local'`—not only report/local (`packages/terminal-ui/src/components/terminal-resize-reporter.ts:4-5`; `packages/terminal-ui/src/components/types.ts:18-23`).

- `report`: `TerminalResizeReporter.report()` measures the container, resizes the local emulator, de-duplicates unchanged dimensions, then calls either `onResize` or `onSync` (`packages/terminal-ui/src/components/terminal-resize-reporter.ts:130-173`). The normal `ResizeObserver`/browser-resize path schedules kind `resize`; post-selection restoration schedules an immediate forced `sync` (`packages/terminal-ui/src/components/useTerminalResize.ts:104-122,131-144`).
- `local`: it performs the same local measurement and emulator resize, but returns before emitting a transport command (`packages/terminal-ui/src/components/terminal-resize-reporter.ts:157-162`). Hidden keep-alive panes use this mode (`packages/panels/src/device-console/terminal-stage.tsx:297-312`).
- `follow`: reporting is rejected before measurement, because tmux layout or remote pane metadata is authoritative (`packages/terminal-ui/src/components/terminal-resize-reporter.ts:61-85`). Split panes use this mode and are resized externally from layout geometry (`packages/terminal-ui/src/components/split/SplitPaneView.tsx:174-189`; `packages/terminal-ui/src/components/split/useSplitPaneTerminals.ts:98-108`).

The frontend store maps `resizePane()` to `terminal-resize` and `syncPaneSize()` to `terminal-sync-size` (`packages/stores/src/tmux.ts:235-245`). Both commands use the same Borsh fields (`packages/shared/src/ws-borsh/schema.ts:226-234`) and the gateway routes both kinds to the same `handleTermResize()` function (`apps/gateway/src/ws/tmux-kind-handlers.ts:174-183`). The gateway then calls `resizeWindow()` for multi-pane windows or `resizePane()` for single-pane windows (`apps/gateway/src/ws/tmux-command-handlers.ts:174-203`). Thus the distinction is currently client intent/protocol provenance, not different gateway behavior. The protocol documentation describes resize as normal viewport reporting and sync as post-selection synchronization (`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md:135-136`; `docs/ws-protocol/2026021403-ws-state-machines.md:183-190`).

## 4. Feasibility of local panning

### Gateway policy and visibility

Current snapshots already carry the accepted tmux geometry: `PaneWire` includes `width`, `height`, `left`, and `top` (`packages/shared/src/ws-borsh/schema.ts:289-302`), and the domain pane exposes `width`/`height` (`packages/shared/src/contracts/tmux.ts:14-31`). Legacy metadata diffs also update width and height (`packages/shared/src/ws-borsh/legacy-pane-fields.ts:81-95`).

However, snapshots do not carry an owner or policy. More importantly, `sendSnapshotToClients()` encodes one identical snapshot payload and sends it to every client (`apps/gateway/src/ws/legacy-feed-broadcaster.ts:234-243`). Adding a per-client `sizeOwner` field to the shared snapshot would require personalized encoding. A dedicated S2C policy message containing accepted geometry, policy state, and optionally `isOwner` is cleaner. Snapshot width/height can remain the geometry fallback.

There is no existing browser-visible/hidden command. `GatewaySession` contains carrier and tmux selection state but no viewport claims (`apps/gateway/src/ws/gateway-session.ts:10-31`). The client’s `visibilitychange` listener only reconnects, clears heartbeat timeout, or pings when the document becomes visible; it sends no message (`packages/ws-client/src/client.ts:577-604`). `TMUX_FOCUS_PANE` is tmux pane selection, not browser visibility (`apps/gateway/src/ws/tmux-kind-handlers.ts:124-127`).

The minimum end-to-end policy needs:

1. Add a C2S viewport-state command, preferably a new Borsh kind rather than changing the fixed `TermResizeSchema`. It should include `deviceId`, `windowId` or `paneId`, `cols`, `rows`, and `visible`. Add it through `kind.ts`, `schema.ts`, `transport-types.ts`, `transport-command-encoder.ts`, `message-builder.ts`, and the gateway dispatch table (`packages/shared/src/ws-borsh/kind.ts:42-50`; `packages/shared/src/ws-borsh/schema.ts:226-234`; `packages/ws-client/src/transport-types.ts:133-157`; `packages/ws-client/src/transport-command-encoder.ts:39-50`).
2. Pass the `GatewaySession` through the resize path. The dispatcher currently declares `handleTermResize()` without a session, drops `_ws` in both resize handlers, and `WebSocketServer.handleTermResize()` also lacks a session (`apps/gateway/src/ws/borsh-dispatcher.ts:46-49`; `apps/gateway/src/ws/tmux-kind-handlers.ts:174-183`; `apps/gateway/src/ws/index.ts:722-728`).
3. Store claims on `GatewaySession`, keyed by device plus window. Window scope is important because multi-pane resize is implemented as `resizeWindow()` (`apps/gateway/src/ws/tmux-command-handlers.ts:184-194`). A claim should contain visibility, geometry, and a stable update timestamp.
4. Define “largest” deterministically. Recommended: maximize `cols * rows`, then `cols`, then `rows`, then session ID. The gateway should resize tmux only when the sender is the winner; when a winner disappears, recompute and apply the next visible claim.
5. Emit hidden on `document.visibilitychange`, visible when the terminal/pane becomes active, and hidden on unmount or route removal. Gateway cleanup must occur in device disconnect and session close paths (`apps/gateway/src/ws/device-connection-registry.ts:245-263`; `apps/gateway/src/ws/index.ts:402-446`). Reconnect failure also clears the device’s client set and should clear claims (`apps/gateway/src/ws/device-connection-registry.ts:360-377`).

### Frontend panning

A dedicated scroll wrapper should receive `overflow:auto` on both axes. It should wrap a PTY-sized surface, while the existing logical terminal viewport remains responsible for scrollback. Do not make the page wrapper or the `Terminal.tsx` measurement container the pan target, because those elements currently participate in page layout and resize measurement (`apps/fe/src/page-wrapper.tsx:74-85`; `packages/terminal-ui/src/components/Terminal.tsx:178-186`).

A concrete medium-size change is:

- Add a dedicated `.xterm-pan-viewport` and content surface in `TerminalDomSurface`; make the pan viewport fixed to the visible container and scrollable, and make the content surface at least `cols * cellWidth` by `rows * cellHeight` (`packages/ghostty-terminal/src/terminal-dom.ts:38-57,159-177`).
- In `CanvasRenderer.resize()`, update the content surface dimensions together with the four canvas CSS dimensions (`packages/ghostty-terminal/src/canvas-renderer.ts:324-383`).
- Extend `Terminal`/`useMobileTouch` to expose the pan viewport and a `panEnabled`/follower-policy flag (`packages/terminal-ui/src/components/Terminal.tsx:44-85`).
- Add a distinct `pan` state or controller to the touch machine. Current touch states only distinguish bypass, scroll, pending, wheel, and selection (`packages/terminal-ui/src/components/touch/types.ts:44-52`). Current single-finger movement always becomes vertical scrollback through `handleViewportGesture()` (`packages/terminal-ui/src/components/touch/gesture-machine.ts:141-183`; `packages/terminal-ui/src/components/touch/scroll-gesture.ts:80-118`), and non-reporting terminal gestures explicitly reject horizontal movement (`packages/ghostty-terminal/src/terminal-input-bridge.ts:291-316`). Pan must therefore be entered by an explicit rule—such as horizontal drag, two-finger pan, or a UI-selected pan mode—so vertical scrollback is not accidentally replaced.
- Keep native pan scrolling separate from the existing custom-scrollbar fallback, which currently searches `.xterm-viewport` and `.xterm-scrollable-element` (`packages/terminal-ui/src/components/touch/scroll-bypass.ts:52-59`).

The history logic should remain authoritative-geometry driven. `usePaneSizeSync` already resizes the local emulator to remote pane dimensions and fetches history after a remote resize (`packages/panels/src/device-console/use-pane-size-sync.ts:91-129`). `writeRestoredHistory()` resizes to remote geometry before writing history (`packages/terminal-ui/src/components/terminal-snapshot.ts:157-191`), and canonical snapshots resize before replaying content (`packages/terminal-ui/src/components/terminal-snapshot.ts:115-133`). For a non-owner client, preserve these operations, but prevent `report`/`sync` from sending the container’s smaller dimensions. Ensure the remote resize also updates the authoritative-size ref used by `convergeSnapshotSize()` (`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:210-225`; `packages/terminal-ui/src/components/hooks/useTerminalHandle.ts:48-51`).

### Existing tests affected

- `ws-borsh-resize.spec.ts:109-181` currently requires local terminal size to equal tmux after browser resize. That remains valid for the owner; add a non-owner assertion around the multi-browser case at `:183-228` that the smaller page sends no resize and remains at the accepted larger geometry.
- `terminal-render-regressions.spec.ts:478-560` (`bug4`) currently expects a remote shrink to make the local emulator exactly `smallCols × smallRows`. Preserve this as a single-owner/external-resize case or split it into owner and follower cases; the follower case should assert large local geometry plus clipped/pannable rendering.
- `ws-borsh-theme-resize.spec.ts:124-144` should retain owner convergence and add policy-state assertions for a non-owner.
- `mobile-terminal-interactions.spec.ts:312-417` must continue asserting scrollback; add an oversized-surface pan test. Long-press coordinate setup at `:467-489` must account for the scroll wrapper.
- `mobile-mouse-reporting.spec.ts:172-284` must continue asserting press/release and wheel semantics; pan mode must not intercept reporting-mode wheel gestures.
- `split-screen-mobile.spec.ts:28-68` should add that mobile stacked layout does not claim a smaller window size when another visible client owns the larger window.
- `mobile-keyboard-avoidance.spec.ts:143-280` should remain green; its resize mode intentionally expects container shrink and resize frames, while lift/follow intentionally expect no resize.

## 5. CSS scaling alternative

A CSS `transform: scale(k)` alternative is possible visually but unsafe without coordinated hit-testing changes. Selection hit-testing divides `(clientX - rect.left)` and `(clientY - rect.top)` by the unscaled cell dimensions (`packages/ghostty-terminal/src/terminal-render-coordinator.ts:190-206`). Mouse input uses the same conversion and reports the screen rectangle dimensions (`packages/ghostty-terminal/src/terminal-input-bridge.ts:239-279`).

Because `getBoundingClientRect()` reflects the transformed rectangle (`packages/ghostty-terminal/src/terminal-dom.ts:238-240`), dividing transformed coordinates by unscaled cell dimensions would introduce a scale-factor error. This is an inference from the current coordinate conversion. A scale implementation would need a centralized inverse-scale conversion used by selection, mouse reporting, links, cursor/IME placement, and screen dimensions. It also still needs a pan/scrollback gesture policy. Consequently, the recommended path is PTY-sized canvas plus local panning; CSS scale is best treated as a separate zoom feature.

## Recommended sequence

- **S:** Add per-session viewport claims, a visibility-state command, a per-client policy response, and a follower mode that suppresses resize reporting while retaining remote geometry/history rebuilds.
- **M:** Add the dedicated two-axis pan viewport, surface-size synchronization, and an explicit touch pan state. Update the listed mobile and regression E2E tests.
- **L:** Consider CSS scaling only after centralizing inverse-transform hit-testing and deciding how scaling interacts with IME, selection, mouse reporting, and pinch zoom.