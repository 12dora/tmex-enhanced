# EX2 — Multi-client terminal viewport coupling

## Current architecture

The gateway uses tmux control mode, not `pipe-pane` streaming.

For a local device, `LocalExternalTmuxConnection` spawns one `tmux -C attach-session -t <session>` process per `DeviceSessionRuntime`【apps/gateway/src/tmux-client/local-external-connection.ts:511-549】. SSH connections use the same control-mode command remotely【apps/gateway/src/tmux-client/ssh-external-connection.ts:400-421】. The control stream is parsed into pane output callbacks【apps/gateway/src/tmux-client/control-mode-subscription.ts:102-109】.

The runtime is shared by browser clients:

- `TmuxRuntimeRegistry` reuses an existing runtime by `deviceId` and increments its reference count【apps/gateway/src/tmux-client/runtime-registry.ts:16-30】.
- A `DeviceConnectionEntry` contains one `runtime`, but multiple `clients` and `canonicalClients`【apps/gateway/src/ws/types.ts:14-24】.
- Browser sessions are added to that shared entry【apps/gateway/src/ws/device-connection-registry.ts:213-243】.
- Each browser has its own `CanonicalFeedSession`, but that session attaches a pane consumer to the same runtime【apps/gateway/src/ws/index.ts:313-345】【apps/gateway/src/ws/canonical-feed-session.ts:215-267】.

Therefore the current topology is:

```text
Browser A ─┐
Browser B ─┼─ WebSocket sessions ─ one DeviceSessionRuntime ─ one tmux control client ─ one pane PTY
Browser C ─┘
```

`capture-pane` is used for screen/history snapshots, not as the live transport【apps/gateway/src/tmux-client/external/session-commands.ts:253-264】【apps/gateway/src/tmux-client/external/control-mode-capture.ts:161-180】. I found no production `pipe-pane` invocation.

The gateway does not configure `window-size` or `aggressive-resize`. Its session setup configures passthrough, extended keys, focus events, and `destroy-unattached`, but not either resize option【apps/gateway/src/tmux-client/external/session-commands.ts:719-742】. It also does not use `refresh-client -C` on attach: attach is simply `tmux -C attach-session`【apps/gateway/src/tmux-client/local-external-connection.ts:545-547】. The only startup `refresh-client` commands are metadata subscriptions【apps/gateway/src/tmux-client/control-mode-subscription.ts:15-18】; `refresh-client -A` is used only for control-stream flow control【apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:192-200】.

## Resize path and coupling

The browser measures its terminal container through `FitAddon` and `ResizeObserver`【packages/terminal-ui/src/components/Terminal.tsx:107-135】. `TerminalResizeReporter.report()` applies the measured size to the local terminal and emits `onResize` or `onSync`【packages/terminal-ui/src/components/terminal-resize-reporter.ts:130-183】.

The store sends:

```text
terminal-resize / terminal-sync-size
  → deviceId, paneId, cols, rows
```

The message builders contain no browser/client identifier【packages/ws-client/src/message-builder.ts:178-205】, and the command union contains no viewport or scroll-position field【packages/ws-client/src/transport-types.ts:148-156】.

The gateway’s legacy handlers ignore the originating WebSocket when dispatching resize【apps/gateway/src/ws/tmux-kind-handlers.ts:174-183】. `handleTermResize()` directly applies the request to the shared device entry【apps/gateway/src/ws/tmux-command-handlers.ts:174-203】:

- Multi-pane windows call `resize-window`.
- Single-pane windows call `runtime.resizePane()`.

`runtime.resizePane()` eventually resolves the pane’s window and issues:

```text
resize-window -t <window> -x <cols> -y <rows>
```

【apps/gateway/src/tmux-client/external/session-commands.ts:536-563】

Thus the size is a single shared tmux window size. There is no smallest-client or largest-client arbitration. If two clients send different sizes, both commands are accepted; the geometry after the later tmux command is the effective size. The existing E2E test confirms that resizing one browser does not cause the other browser to emit an echo resize frame, but it does not make the remote browser independent【apps/fe/tests/ws-borsh-resize.spec.ts:183-221】.

`resize-window` also automatically changes tmux’s `window-size` option to `manual` according to the installed tmux 3.7b manual【/opt/homebrew/Cellar/tmux/3.7b/share/man/man1/tmux.1:3559-3590】. The repository explicitly tests that the gateway does not restore `window-size latest` after resizing【apps/gateway/src/tmux-client/external/session-commands.test.ts:345-363】.

The size coupling continues on the frontend. When a shared tmux snapshot reports a different pane size, `usePaneSizeSync` resizes the local emulator and fetches history to rebuild it【packages/panels/src/device-console/use-pane-size-sync.ts:91-129】. `writeRestoredHistory()` also resizes a local terminal to the remote tmux geometry before replaying history【packages/terminal-ui/src/components/terminal-snapshot.ts:162-190】.

The design document accurately describes the current intent: resize originates from the browser viewport and the gateway synchronizes tmux/client geometry【docs/ws-protocol/2026021403-ws-state-machines.md:173-190】. It is synchronization, not per-client viewport isolation.

## Scroll path

Normal scrollback is client-side.

Every Ghostty terminal controller owns its own WASM terminal handle and local `cols`/`rows` state【packages/ghostty-terminal/src/terminal.ts:88-140】【packages/ghostty-terminal/src/terminal.ts:177-199】. `scrollLines`, `scrollToTop`, and `scrollToBottom` call local WASM viewport functions【packages/ghostty-terminal/src/terminal.ts:417-442】. The render coordinator reads a local scrollbar offset and writes it into the local render snapshot【packages/ghostty-terminal/src/ghostty-terminal/src/terminal-render-coordinator.ts:246-287】.

Touch and wheel gestures eventually call `handleViewportGesture()`【packages/terminal-ui/src/components/touch/scroll-gesture.ts:42-64】【packages/terminal-ui/src/components/touch/gesture-machine.ts:141-182】. In the ordinary non-mouse-reporting path, the gesture calls `host.scrollLines(lines)`, which is local【packages/ghostty-terminal/src/terminal-input-bridge.ts:291-317】.

Older history requests are also local to the browser’s terminal surface. A wheel event may request another history page, but the response is applied to that surface only【packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:123-156】.

There is no gateway `copy-mode` path in the code examined. tmux’s own manual describes copy mode as a mode of a pane【/opt/homebrew/Cellar/tmux/3.7b/share/man/man1/tmux.1:1788-1806】, not an independent copy cursor per attached client. tmux does support a per-client visible offset for an oversized window through `refresh-client -U/-D/-L/-R`【/opt/homebrew/Cellar/tmux/3.7b/share/man/man1/tmux.1:1427-1474】, but that is different from independent pane copy-mode state.

The phone can nevertheless affect the desktop through shared PTY input:

1. If mouse reporting is enabled, wheel/touch gestures become mouse buttons 4/5 or 6/7.
2. If alt-screen is active with `altScroll`, gestures become ArrowUp/ArrowDown key bytes.
3. Those bytes are emitted through the terminal input host【packages/ghostty-terminal/src/terminal-input-bridge.ts:297-317】【packages/ghostty-terminal/src/terminal-input-bridge.ts:329-375】.
4. Terminal input is sent to the shared pane runtime【packages/terminal-ui/src/components/hooks/useTerminalInput.ts:95-101】【apps/gateway/src/tmux-client/device-session-runtime.ts:313-333】.

The mobile gesture state machine intentionally sends single-finger drags as wheel events when reporting is enabled【packages/terminal-ui/src/components/touch/gesture-machine.ts:144-155】. The corresponding E2E contract is explicit【apps/fe/tests/mobile-mouse-reporting.spec.ts:206-246】.

So the likely explanation is:

- ordinary shell scroll: phone scroll should remain local;
- mouse-reporting or alt-scroll: phone sends input to the shared PTY, and the resulting application state/output is visible to both clients.

## What is local versus shared

| State | Current behavior |
|---|---|
| PTY input | Shared. Canonical input is routed to the shared runtime/pane【apps/gateway/src/ws/canonical-feed-session.ts:395-417】. |
| tmux window/pane size | Shared. Every accepted resize changes the same tmux window【apps/gateway/src/ws/tmux-command-handlers.ts:184-203】. |
| Scroll offset | Local Ghostty state in normal mode【packages/ghostty-terminal/src/terminal.ts:417-424】. |
| Mouse/alt-screen mode | Locally held by each emulator, but restored from shared tmux mode metadata and driven by shared PTY output【packages/terminal-ui/src/components/terminal-snapshot.ts:115-133】. |
| Selection | Local to each Ghostty controller; local resize clears it【packages/ghostty-terminal/src/terminal.ts:105-107】【packages/ghostty-terminal/src/terminal.ts:405-414】. |
| `TERM_HISTORY` | Delivered to the requesting browser’s local sink, but replay geometry currently follows shared tmux dimensions【packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts:76-84】. |
| Theme | Site theme is broadcast to all gateway sessions and applied to all connected runtimes【apps/gateway/src/ws/theme-settings-broadcaster.ts:79-95】【apps/gateway/src/ws/theme-settings-broadcaster.ts:127-141】. Browser theme/preset is also persisted and synchronized across same-origin tabs【packages/stores/src/ui.ts:289-303】. |
| Font size/family | Browser-local UI state, persisted in local storage and used when creating each Ghostty controller【packages/stores/src/ui.ts:232-252】【packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:284-315】. |
| Keep-alive terminals | Browser-local. Each frontend keeps recent panes mounted; hidden instances use `local` sizing and do not report resize【packages/panels/src/device-console/terminal-stage.tsx:4-6】【packages/panels/src/device-console/terminal-stage.tsx:297-312】. |

## Design options

### A. One tmux client per browser

Use one control-mode tmux client for every browser and set each control client’s size with `refresh-client -C`. tmux supports `ignore-size` clients【/opt/homebrew/Cellar/tmux/3.7b/share/man/man1/tmux.1:1102-1118】 and `window-size` policies such as `largest`, `smallest`, `manual`, and `latest`【/opt/homebrew/Cellar/tmux/3.7b/share/man/man1/tmux.1:5655-5678】.

This is complexity L. It requires refactoring `DeviceSessionRuntime`, `LocalExternalTmuxConnection`, `SshExternalTmuxConnection`, `DeviceConnectionEntry`, and canonical-session attachment. It still does not provide two truthful PTY sizes: `window-size` selects one shared window geometry, while tmux copy mode is pane-scoped. Shared input would remain possible, but independent viewport behavior would not be complete.

Affected tests include `apps/fe/tests/ws-borsh-resize.spec.ts:109-221`, `apps/fe/tests/ws-borsh-theme-resize.spec.ts:81-141`, and `apps/fe/tests/terminal-render-regressions.spec.ts:478-546`.

### B. Gateway virtual viewport

Keep the shared PTY at a chosen size, preferably the largest active client, while each browser keeps its own Ghostty `cols`/`rows` and scroll offset. Stop applying remote tmux geometry to local terminals in `usePaneSizeSync`, `writeCanonicalSnapshot`, `writeRestoredHistory`, and `convergeSnapshotSize`.

This is complexity M/L. It preserves shared keyboard and mouse input, but full-screen TUI applications receive only one PTY size. A phone emulator parsing output generated for a desktop-sized PTY may wrap, clip, or misinterpret cursor coordinates. This is a fundamental limitation of one shared PTY, not merely an implementation defect.

`terminal-render-regressions.spec.ts` bug4 explicitly expects the opposite behavior—remote resize must resize and rebuild the local screen【apps/fe/tests/terminal-render-regressions.spec.ts:478-546】—so that test must be replaced. `ws-borsh-resize.spec.ts` must distinguish single-client convergence from multi-client local geometry.

### C. Policy-only changes

Keep the current shared geometry, but reject or defer smaller resize reports when another client is present; alternatively accept resize only from the most recently active client. Track sizes by `GatewaySession`, remove them on disconnect, and recompute the policy winner.

This is complexity S/M and keeps input fully shared. It reduces the phone shrinking the desktop, but it does not give each client an independent PTY size. It also does not solve shared mouse-reporting/alt-scroll input unless wheel handling is separately changed.

The main affected functions are `handleTermResize()`【apps/gateway/src/ws/tmux-command-handlers.ts:174-203】, the resize handlers in `tmux-kind-handlers.ts`【apps/gateway/src/ws/tmux-kind-handlers.ts:174-183】, and disconnect cleanup in `device-connection-registry.ts`【apps/gateway/src/ws/device-connection-registry.ts:245-263】. Existing mobile wheel tests should remain valid for a single client, while a new two-browser regression test is needed.

## Recommendation

For a one-day implementation, use **B-lite + C**:

1. Add per-session resize tracking and make the shared tmux PTY follow the largest active client. This prevents a newly opened phone from shrinking an existing desktop.
2. Keep each browser’s Ghostty controller at its own measured local geometry. Change:
   - `packages/panels/src/device-console/use-pane-size-sync.ts:91-129`
   - `packages/terminal-ui/src/components/terminal-snapshot.ts:115-190`
   - `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:210-225`
3. Preserve local Ghostty scroll offsets and prevent wheel/alt-scroll from becoming shared PTY input when another client is attached. Change:
   - `packages/ghostty-terminal/src/terminal-input-bridge.ts:291-317`
   - `packages/terminal-ui/src/components/touch/scroll-gesture.ts:44-64`
   - the terminal input wiring in `packages/terminal-ui/src/components/hooks/useTerminalInput.ts:95-101`
4. Continue routing keyboard input through the existing shared `sendInput` path【packages/gateway/src/tmux-client/device-session-runtime.ts:313-333】.

This gives the requested behavior for shells and line-oriented programs: independent browser viewport/scroll state with shared typing. It cannot guarantee independently laid-out full-screen TUIs while retaining one shared PTY. A fully correct TUI solution would require separate PTYs or a substantially more sophisticated per-client terminal virtualization layer.