# Canonical State Feed Implementation Plan

## Context

The current Gateway execution path creates independent attach streams for consumers. That makes
terminal state ownership consumer-dependent, duplicates reads and snapshots, delays metadata behind
coarse refreshes, and makes reconnect recovery depend on recreating UI sessions. The Gateway must
instead own a single canonical state projection that multiple transports can consume.

The complete cross-repository protocol and rollout plan lives at
`../../../../prompt-archives/2026072204-canonical-terminal-stream/plan-00.md`. This file scopes the
tmex implementation work so it can be executed and reviewed independently.

## Phase 1: legacy weak-network guardrails

1. Audit the advertised Gateway frame limit and credit accounting for terminal, snapshot, and
   resource frames.
2. Bound legacy snapshot payloads below the negotiated maximum frame size.
3. Keep credits isolated per traffic kind so a large resource or snapshot cannot consume terminal
   progress.
4. Verify with a repository-local Gateway and an isolated test socket under constrained bandwidth.

## Phase 2: canonical wire and identities

1. Add versioned canonical feed messages for inventory snapshots, metadata deltas, screen snapshots,
   terminal deltas, subscribe/unsubscribe, resize, input, replay acknowledgement, and rebase.
2. Define stable session/window/pane source identities and explicit source lifecycle events.
3. Keep the existing outer Gateway WebSocket envelope version during capability negotiation; expose
   the new feed behind `canonical-state-v1` until migration is complete.
4. Add protocol regression tests for encoding, unknown message handling, frame bounds, and identity
   stability.

## Phase 3: realtime metadata projection

1. Build one runtime-owned metadata projection for all managed sessions, windows, and panes.
2. Emit title, current directory, foreground process, layout, activity, create, update, and remove
   deltas as changes occur.
3. Use polling only where the underlying multiplexer has no event, and diff at the source before
   emission.
4. Replace periodic full-list title propagation with immediate deltas while preserving bounded
   reconciliation as a correctness fallback.

## Phase 4: one canonical feed session

1. Introduce one `CanonicalFeedSession` per managed Gateway runtime.
2. Maintain a union of consumer pane subscriptions; adding a consumer must not create another
   multiplexer read loop.
3. Route input and resize commands through the canonical session with explicit pane/surface identity.
4. Fan out immutable deltas to consumers and isolate slow-consumer queues from source ingestion.
5. Add invariants proving one upstream read loop, correct subscription refcounts, and no terminal
   bytes for cold panes.

## Phase 5: bounded active/hot/cold state

1. Keep active panes subscribed and retain recently closed panes in a time-, count-, byte-, and
   runtime-bounded hot set.
2. Store bounded screen state plus sequence-addressed live replay for active and hot panes. Use a
   separate pane/history epoch plus line cursor for paginated scrollback so tmux history movement
   cannot be mistaken for live replay.
3. Evict deterministically to cold state; cold panes retain metadata but no terminal byte flow.
4. Reopen from replay when coverage exists and from a fresh snapshot otherwise.
5. Expose metrics for hot-set size, bytes, evictions, replay hit rate, rebase count, and queue drops.

## Phase 6: adapters and client store boundary

1. Make the existing Gateway attach protocol an adapter over the canonical projection during the
   compatibility window.
2. Migrate tmex frontend stores to consume canonical inventory, metadata, snapshot, and delta events
   without starting independent attach readers.
3. Keep terminal rendering state separate from metadata lists and recent-item identity/order.
4. Verify multiple consumers see identical source sequences and metadata while only opened panes
   receive terminal bytes.

## Phase 7: recovery and rollout

1. Implement epoch/sequence replay and snapshot rebase semantics across reconnects.
2. Ensure a transport reconnect does not recreate the canonical source session.
3. Roll out behind capability negotiation, collect boundedness and recovery evidence, then make the
   canonical adapter the default.
4. Remove the legacy independent attach execution path only after old clients are outside the
   supported compatibility window.

## Verification gates

- Rust and TypeScript protocol/unit tests pass with Bun and Cargo.
- Repository-local integration tests use a dedicated tmux socket and never access the default
  `tmex` session.
- One managed runtime has exactly one canonical source read loop with two or more consumers.
- Metadata updates are visible without opening the pane terminal and are not delayed by full-list
  refresh cadence.
- Unopened cold panes send zero terminal bytes while remaining present in metadata inventory.
- Hot-set memory and history remain within configured limits under churn.
- Disconnect/reconnect resumes or rebases automatically without a page refresh.
- Weak-network tests continue making terminal and control progress when snapshot/resource traffic is
  present.
