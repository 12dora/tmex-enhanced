# Canonical State Feed Implementation Result

## Outcome

The tmex workstream now owns a single canonical runtime per device session, projects realtime tmux
metadata separately from pane bytes, retains active/hot pane state within explicit bounds, and can
fan the same state feed into WebSocket or host-owned transports. Existing attach clients remain
compatible while canonical-capable hosts can reuse one control/data lane without opening a fallback
WebSocket.

The terminal client keeps the currently rendered generation visible during replay or snapshot
rebase, builds the replacement generation off-screen, and swaps only after the replacement has
rendered. Settings code is deferred until first use, and terminal startup exposes loading, failure,
and retry states instead of leaving an empty surface under weak-network or resource failures.

## Implemented boundaries

- Added canonical inventory, metadata, pane subscription, replay, snapshot, input, resize, and
  recovery semantics behind capability negotiation.
- Moved tmux observation and pane retention to runtime-owned state shared by all consumers.
- Kept metadata observation active for closed panes while pane bytes are retained or forwarded only
  for active/hot subscriptions.
- Added bounded screen checkpoints, replay bytes, hot pane retention, per-consumer pending gaps,
  aggregate terminal batching, and WebSocket backpressure limits.
- Added typed `GatewayTransport` events and commands, a default WebSocket adapter, lazy transport,
  and an externally owned shared transport adapter.
- Added the stable `encodeGatewayTransportCommand(command) -> { kind, payload }` export so native
  hosts can send control commands through an existing local/relay lane.
- Added source-route attribution (`gateway`, `local`, `relay`, or `unknown`) without exposing
  endpoint credentials or identifiers.
- Added bounded terminal generation/rebase handling, cursor-based history pagination, host resource
  preparation, and weak-network retry UI.
- Added the explicit lightweight `@tmex/terminal-ui/terminal-diagnostics` export.
- Added content-safe Gateway and client diagnostics for runtime count, active/hot/cold state,
  retained bytes, replay outcomes, rebases, gaps, drops, queue pressure, backpressure, generation
  recovery, source route, epochs, and cursors. Raw terminal data, titles, paths, process names,
  tokens, and stable identifiers are excluded.

## Verification

- `bun run --filter @tmex/gateway test`: 1031 passed, 0 failed.
- `bun run --filter @tmex/ws-client test`: 33 passed, 0 failed.
- `bun run --filter @tmex/terminal-ui test`: 95 passed, 0 failed.
- `bun run --filter @tmex/stores test`: 57 passed, 0 failed.
- `bun run --filter @tmex/panels test`: 5 passed, 0 failed.
- `bun run --filter @tmex/shared test`: 98 passed, 0 failed.
- `bunx tsc --noEmit -p packages/terminal-ui/tsconfig.json`: passed.
- `bunx vite build` from `apps/fe`: passed; terminal settings sheet and panel are emitted as
  separate lazy chunks.
- Public imports for `@tmex/terminal-ui/terminal-diagnostics` and `@tmex/ws-client` were resolved
  from the frontend workspace.

The workspace-wide frontend wrapper still reaches the repository's pre-existing duplicate React 19
type declarations before Vite starts; direct Vite production compilation passes. The Gateway-wide
TypeScript baseline also still contains unrelated existing errors, including legacy `BufferSource`
typing in `apps/gateway/src/ws/index.ts`; focused tests and changed-package checks introduce no new
failures.

## Safety

All tmux-related verification used unit/integration fakes or repository-local paths. No installed
tmex service, production directory, default tmux socket, or `tmex` session was accessed or changed.
