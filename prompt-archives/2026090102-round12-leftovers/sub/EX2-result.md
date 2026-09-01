# EX2 — Gateway per-pane upstream output subscription

## 1. Current behaviour

The gateway creates one `tmux -C attach-session` control client per external connection; reconnects create a new subscription and process. [`local-external-connection.ts:511-550`](apps/gateway/src/tmux-client/local-external-connection.ts:511-550) The lifecycle currently sends only two format subscriptions, both for metadata. [`control-mode-lifecycle.ts:77-84`](apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:77-84)

The control-mode parser dispatches every `%output` and `%extended-output` to `PaneParserRegistry`; the registry creates one parser per pane and parses titles, bells, OSC notifications, prompt markers, clipboard data, and terminal bytes. [`control-mode-subscription.ts:20-42`](apps/gateway/src/tmux-client/control-mode-subscription.ts:20-42) [`control-mode-subscription.ts:102-118`](apps/gateway/src/tmux-client/control-mode-subscription.ts:102-118) [`notifications.ts:49-84`](apps/gateway/src/tmux-client/control-mode/notifications.ts:49-84) [`pane-registry.ts:22-54`](apps/gateway/src/tmux-client/control-mode/pane-registry.ts:22-54)

The output then enters `RuntimeEventBridge`: it is ingested into `PaneRetention` and broadcast to runtime listeners. [`runtime/event-bridge.ts:49-59`](apps/gateway/src/tmux-client/runtime/event-bridge.ts:49-59)

Legacy browser observation is tracked separately in `LegacyFeedBroadcaster`. It unions each client’s selected pane and subscribed panes, maintains a per-client set plus device/pane reference counts, and releases them on disconnect. [`legacy-feed-broadcaster.ts:45-103`](apps/gateway/src/ws/legacy-feed-broadcaster.ts:45-103) This set only gates later WebSocket delivery; parsing and upstream receipt have already happened. [`legacy-feed-broadcaster.ts:219-234`](apps/gateway/src/ws/legacy-feed-broadcaster.ts:219-234)

Canonical consumers attach a `PaneRetention` lease. [`canonical-feed-session.ts:217-240`](apps/gateway/src/ws/canonical-feed-session.ts:217-240) Retained segments are then batched by `CanonicalPaneStream`. [`pane-stream.ts:100-126`](apps/gateway/src/ws/canonical/pane-stream.ts:100-126) However, `isPaneTerminalRetained()` means any mode other than `cold`, including grace and implicit hot retention; it is not an exact active-observer set. [`replay-store.ts:124-133`](apps/gateway/src/tmux-client/retention/replay-store.ts:124-133) Therefore the browser observer set is not visible to the tmux-client layer today.

## 2. tmux capabilities

| Capability | Version | Relevant behaviour |
|---|---:|---|
| `refresh-client -f no-output` | 3.0 | Client-wide; suppresses all `%output`, so it cannot implement selective pane retention. [`tmux 3.2 CHANGES:485-508`](https://github.com/tmux/tmux/blob/3.2/CHANGES#L485-L508) [`tmux Control Mode:271-279`](https://github.com/tmux/tmux/wiki/Control-Mode#special-commands) |
| `refresh-client -A pane:state` | 3.2 | Per-pane `on`, `off`, `pause`, or `continue`. [`tmux 3.2 CHANGES:0-12`](https://github.com/tmux/tmux/blob/3.2/CHANGES#L0-L12) [`tmux Control Mode:283-301`](https://github.com/tmux/tmux/wiki/Control-Mode#flow-control) |
| `pause-after=N` | 3.2 | Automatically pauses a pane when its control-client output is too far behind. [`tmux 3.2 CHANGES:109-112`](https://github.com/tmux/tmux/blob/3.2/CHANGES#L109-L112) |
| `%pause` / `%continue` | 3.2 | Notifications associated with automatic/manual flow control. [`tmux 3.2 control.c:335-360`](https://github.com/tmux/tmux/blob/3.2/control.c#L335-L360) |
| `%extended-output` | 3.2 | Replaces `%output` when `pause-after` is enabled and includes output age. [`tmux 3.2 control.c:569-598`](https://github.com/tmux/tmux/blob/3.2/control.c#L569-L598) |

The project assumes tmux ≥3.0, including SSH connections, and accepts unknown version strings. [`packages/shared/src/tmux-version.ts:6-25`](packages/shared/src/tmux-version.ts:6-25) [`local-external-connection.ts:479-493`](apps/gateway/src/tmux-client/local-external-connection.ts:479-493) [`ssh-external-connection.ts:362-386`](apps/gateway/src/tmux-client/ssh-external-connection.ts:362-386) Any `-A` implementation therefore needs a separate ≥3.2 capability gate.

`-A pane:off` suppresses future output for that pane: tmux marks the control pane off, skips output generation, and advances the control-client offsets. [`tmux 3.2 control.c:326-334`](https://github.com/tmux/tmux/blob/3.2/control.c#L326-L334) [`tmux 3.2 control.c:437-486`](https://github.com/tmux/tmux/blob/3.2/control.c#L437-L486) It is not retroactive: already queued blocks may drain because `control_set_pane_off()` does not discard them, unlike pause handling. [`tmux 3.2 control.c:248-259`](https://github.com/tmux/tmux/blob/3.2/control.c#L248-L259) [`tmux 3.2 control.c:349-360`](https://github.com/tmux/tmux/blob/3.2/control.c#L349-L360)

The flag is per control client, not a pane/session setting. Turning it back on resets that client’s offsets to the pane’s current offsets, so missed raw bytes are not replayed. [`tmux 3.2 control.c:313-323`](https://github.com/tmux/tmux/blob/3.2/control.c#L313-L323) tmux’s documented recovery mechanism is `capture-pane`; this project already has on-demand text and history capture paths. [`session-commands.ts:253-264`](apps/gateway/src/tmux-client/external/session-commands.ts:253-264) [`session-commands.ts:292-318`](apps/gateway/src/tmux-client/external/session-commands.ts:292-318)

## 3. Non-browser consumers

- Agent headless Ghostty is a real live consumer. The documented architecture requires `%output` for OSC 133 prompt markers, and `PaneEmulator` attaches an active retention lease and live marker subscription. [`2026061303-run-command-headless-ghostty.md:9-10`](docs/agent/2026061303-run-command-headless-ghostty.md:9-10) [`pane-emulator.ts:66-90`](apps/gateway/src/tmux-client/pane-emulator.ts:66-90) `run_command` depends on those bytes and markers for completion, exit status, and output collection. [`2026061303-run-command-headless-ghostty.md:27-31`](docs/agent/2026061303-run-command-headless-ghostty.md:27-31)

- Push notifications are another non-browser consumer. `PushSupervisor` subscribes to runtime events, and its handlers deliver bell and OSC notification events. [`push/supervisor.ts:250-270`](apps/gateway/src/push/supervisor.ts:250-270) [`push/tmux-push-events.ts:59-90`](apps/gateway/src/push/tmux-push-events.ts:59-90) Those events originate from the pane byte parser and are emitted by the tmux core. [`control-mode-lifecycle.ts:170-180`](apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:170-180) [`external-tmux-core.ts:683-705`](apps/gateway/src/tmux-client/external-tmux-core.ts:683-705) A pane requiring bell/OSC notifications must therefore remain upstream-on unless this detection is redesigned.

- Watch rules do not consume live pane output. They acquire a runtime but periodically call `capturePaneText()`, then evaluate the captured screen. [`watch/runtime-pool.ts:4-12`](apps/gateway/src/watch/runtime-pool.ts:4-12) [`watch/service.ts:219-253`](apps/gateway/src/watch/service.ts:219-253) They do not block `-A off`.

- History readers and screen checkpoints are on-demand capture consumers, not passive `%output` consumers. [`pane-history-reader.ts:48-87`](apps/gateway/src/tmux-client/pane-history-reader.ts:48-87) [`runtime/canonical-screen-capture.ts:50-74`](apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts:50-74) Gateway retention itself drops bytes while a pane is `cold`. [`replay-store.ts:91-99`](apps/gateway/src/tmux-client/retention/replay-store.ts:91-99)

## 4. Reconnect and reconciliation

A replacement control process creates a fresh parser, command queue, and tmux control client. [`local-external-connection.ts:511-563`](apps/gateway/src/tmux-client/local-external-connection.ts:511-563) On exit, the subscription is disposed and reconnection begins. [`local-external-connection.ts:612-623`](apps/gateway/src/tmux-client/local-external-connection.ts:612-623) tmux initializes a new client’s pane map empty; newly created pane records have zero flags, meaning default-on. [`tmux 3.2 control.c:227-245`](https://github.com/tmux/tmux/blob/3.2/control.c#L227-L245) [`tmux 3.2 control.c:721-729`](https://github.com/tmux/tmux/blob/3.2/control.c#L721-L729)

Client shutdown destroys the control client and its flags, so a stale `off` or `pause` does not persist in tmux. [`connection-cleanup.ts:22-30`](apps/gateway/src/tmux-client/external/connection-cleanup.ts:22-30) The desired set must nevertheless be reapplied after every attach and reconciled after pane-structure snapshots. [`control-mode-lifecycle.ts:188-205`](apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:188-205) [`runtime/event-bridge.ts:82-115`](apps/gateway/src/tmux-client/runtime/event-bridge.ts:82-115)

## 5. Options

**A — `-A off` for zero-demand panes.** Best bandwidth/CPU savings. Requires a runtime-owned demand coordinator combining legacy refcounts, canonical active/hot leases, agent emulator leases, and push-event demand. On first demand: send `on`, then perform a capture/screen rebase because tmux does not replay missed bytes. The parser also needs reset/reinitialization because its per-pane state persists across the gap. [`pane-registry.ts:22-52`](apps/gateway/src/tmux-client/control-mode/pane-registry.ts:22-52)

**B — `pause-after`.** Lower implementation risk for normal overload, but it does not eliminate steady-state output from unobserved panes. Current code does not enable it and automatically continues on `%pause`. [`control-mode-lifecycle.ts:192-200`](apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts:192-200) tmux discards paused pane blocks, so correctness still requires capture/rebase and does not preserve raw OSC/byte events. [`tmux 3.2 control.c:404-435`](https://github.com/tmux/tmux/blob/3.2/control.c#L404-L435)

**C — do nothing.** Safest semantics. The repository cannot quantify a “typical” unobserved fraction: metrics are aggregate byte counters with only legacy/canonical booleans, not pane IDs. [`terminal-output-metrics.ts:108-133`](apps/gateway/src/ws/terminal-output-metrics.ts:108-133) A hypothetical 10 MiB background build plus 1 MiB observed output is 91.0% removable; four such background panes plus 1 MiB observed is 97.6%. These are scenarios, not repository measurements.

## 6. Recommendation, scope, and tests

Recommend **A, conservatively gated**, with B as an independent overload safeguard. If push notifications are enabled broadly and require every pane’s bell/OSC events, A may provide little benefit until that consumer is made explicit or decoupled.

Estimated full safe change: roughly **8–12 files and 650–1,000 lines**, including a demand coordinator, lifecycle command surface, version gating, runtime/legacy/canonical/agent/push registration, parser/rebase handling, and tests. The minimal browser-only version would be about 250–400 lines but would be unsafe for agents and push notifications.

Integration tests should extend `local-external-connection.integration.test.ts`: create two panes, use `-A off` on one, assert its live bytes stop while `capturePaneText()` still sees accumulated content, then turn it on and verify capture/rebase before delivery. Also test reconnect reapplication, new-pane reconciliation, agent prompt markers, and push bell/OSC behaviour. All tests must use unique `tmux -L <socket>` names and non-`tmex` sessions; the existing test already follows this isolation pattern. [`local-external-connection.integration.test.ts:15-41`](apps/gateway/src/tmux-client/local-external-connection.integration.test.ts:15-41)