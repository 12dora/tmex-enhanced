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
- Kept the legacy compatibility snapshot on the exact same canonical metadata revision instead of
  independently mutating a second WebSocket-owned projection.
- Fixed remote resize reconciliation so a matching local resize echo clears its pending guard;
  mismatched remote sizes are retried when the bounded guard expires instead of being discarded
  forever. Remote layout changes continue to use metadata patches and targeted history recovery,
  without restoring full snapshot polling.
- Added bounded terminal generation/rebase handling, cursor-based history pagination, host resource
  preparation, and weak-network retry UI.
- Added the explicit lightweight `@tmex/terminal-ui/terminal-diagnostics` export.
- Added content-safe Gateway and client diagnostics for runtime count, active/hot/cold state,
  retained bytes, replay outcomes, rebases, gaps, drops, queue pressure, backpressure, generation
  recovery, source route, epochs, and cursors. Raw terminal data, titles, paths, process names,
  tokens, and stable identifiers are excluded.

## Verification

- `bun run --filter @tmex/gateway test`: 1032 passed, 0 failed.
- `bun run --filter @tmex/ws-client test`: 33 passed, 0 failed.
- `bun run --filter @tmex/terminal-ui test`: 95 passed, 0 failed.
- `bun run --filter @tmex/stores test`: 57 passed, 0 failed.
- `bun run --filter @tmex/panels test`: 5 passed, 0 failed.
- `bun run --filter @tmex/shared test`: 98 passed, 0 failed.
- `bunx biome check` on every changed source and test file: passed.
- `bun run --filter @tmex/fe build`: passed; terminal settings sheet and panel are emitted as
  separate lazy chunks.
- `terminal-render-regressions.spec.ts --grep bug4 --repeat-each=3`: 3 passed, 0 failed on the
  isolated `tmex-e2e` socket. Before the fix, the same test failed 3/3 with the terminal stuck at
  `112x35` after tmux had moved to `92x27`.
- `theme-propagation.spec.ts --grep "rapid theme toggle.*resize" --repeat-each=3`: 3 passed, 0
  failed.
- Public imports for `@tmex/terminal-ui/terminal-diagnostics` and `@tmex/ws-client` were resolved
  from the frontend workspace.

The full frontend E2E run before this final regression fix completed with 92 passed, 3 skipped, and
9 failed. The remaining failures reproduce the repository's documented baseline in
`docs/testing/2026070800-e2e-known-issues.md`. In particular, the old two-pane
`ws-borsh-theme-resize` case ends at a different viewport size but compares against the starting
pane width, producing the same fixed 33-column mismatch in 3/3 focused repeats; the single-pane
theme/resize pressure gate above is green.

## Safety

All live tmux verification used the repository's isolated `tmex-e2e` socket. No installed tmex
service, production directory, default tmux socket, or production `tmex` session was accessed or
changed. The isolated test server was removed after verification.
