# Canonical State Feed Implementation Prompt

## 2026-07-22

Implement the tmex-owned portion of the canonical terminal state architecture described by the
cross-repository plan at
`../../../../prompt-archives/2026072204-canonical-terminal-stream/plan-00.md`.

Requirements:

- one canonical feed per managed Gateway runtime instead of one terminal stream per consumer;
- stable source identities for sessions, windows, and panes;
- realtime metadata projection for title, current directory, foreground process, layout, activity,
  and lifecycle changes;
- an explicit subscription union for terminal bytes, with active/hot/cold states and bounded screen
  and replay history;
- legacy Gateway and frontend adapters must consume the same projection during migration;
- title and metadata updates must not wait behind a periodic full-list refresh;
- preserve the public tmex behavior and keep the implementation transport-neutral;
- retain compatibility until all consumers have migrated, then remove the legacy execution path
  only after the rollout gate passes.

Safety constraints:

- never touch an installed tmex service or the default tmux socket/session;
- use repository-local temporary instances and dedicated test sockets only;
- do not run destructive workspace cleans;
- keep commits neutral and suitable for the open-source repository.

## 2026-07-22 client adapter and recovery implementation

Complete the tmex-owned portions of cross-repository Tasks 18 and 20:

- extract a typed transport event/command boundary from `GatewayConnection` while preserving the
  existing public WebSocket implementation;
- allow an externally owned shared state stream to feed metadata snapshots/patches, terminal data,
  screen snapshots, and history pages into the existing stores and terminal UI without creating a
  physical WebSocket;
- ensure metadata-only runtimes never create pane subscriptions;
- preserve the visible terminal generation during reconnect/rebase, assemble replacement snapshots
  in a hidden generation, atomically swap only after render, and keep live interleave bounded;
- paginate history by cursor without conflating it with live terminal sequence state;
- expose visible loading/error/retry UI for font, WASM/controller, and terminal-open failures; permit
  a host-provided async resource preparation hook so resource loading does not block the app shell.

Additional weak-network integration requirements received during implementation:

- defer the terminal settings sheet and its settings panel until the first explicit open so the
  terminal route does not synchronously download that non-critical chunk;
- keep the terminal loading/error/retry shell independent from the deferred settings chunk;
- export terminal diagnostics through the explicit lightweight package path
  `@tmex/terminal-ui/terminal-diagnostics` so hosts do not import the full terminal barrel solely
  for startup diagnostics.

## 2026-07-22 bounded state-stream observability follow-up

Complete the tmex-owned observability portion of cross-repository Task 22:

- expose canonical runtime, active/hot/cold retention, cache/replay, gap/rebase, and queue/drop
  health through the existing Gateway activity and terminal-output metrics surfaces;
- report both current values and the exact execution-path bounds that constrain caches and queues,
  reusing exported runtime constants instead of duplicating monitoring-only limits;
- keep metrics content-safe: never include terminal bytes, titles, working directories, process
  names, credentials, tokens, or raw stable identifiers;
- extend terminal diagnostics with source route, epoch/cursor progress, and recovery state while
  preserving the same no-content/no-token boundary.

Additional shared-control-lane contract received during implementation:

- export a stable `encodeGatewayTransportCommand(command) -> { kind, payload }` API from
  `@tmex/ws-client`, reusing the existing command encoder;
- let externally owned state transports forward low-frequency create/close/rename/split/reorder
  commands over their existing control lane without opening a fallback legacy WebSocket;
- cover the public encoder with a minimal wire-contract regression test.
