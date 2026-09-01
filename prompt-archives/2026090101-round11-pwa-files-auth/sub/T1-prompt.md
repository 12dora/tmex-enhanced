# T1 — Backend + protocol: per-client viewport claims, "largest visible client" size policy

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo; use `bun` (if not on PATH: `~/.bun/bin/bun` or `source ~/.zshrc`). **Other agents edit other files concurrently (frontend packages, `apps/gateway/src/mesh/auth-routes.ts`, `api/local-auth-http.ts`). Touch only the files in "Scope". Never run git commands.** Code comments only where non-obvious, in Simplified Chinese like the surrounding code. Write the final report (English, < 500 words) to `/Users/konata/code/tmex-enhanced-wt-r11/prompt-archives/2026090101-round11-pwa-files-auth/sub/T1-result.md` and **only exit after that file is written**.

Read the contract first: `prompt-archives/2026090101-round11-pwa-files-auth/sub/T-contract.md`. You implement the protocol and gateway side; frontend agents implement the store/UI side against the exact names below.

## Facts (verify by reading)

- Borsh kinds/schemas: `packages/shared/src/ws-borsh/kind.ts` (~42-50), `schema.ts` (`TermResizeSchema` ~226-234, `PaneWire` ~289-302), decoder/encoder tables in the same dir and their tests; docs `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`.
- ws-client transport: `packages/ws-client/src/transport-types.ts` (~133-157 command union), `transport-command-encoder.ts` (~39-50), `message-builder.ts` (~178-205 resize builders), the S2C decoder (find where `PaneWire`/tmux snapshot events are decoded into typed events consumed by `packages/stores/src/tmux-event-router.ts`).
- Gateway: dispatcher `apps/gateway/src/ws/borsh-dispatcher.ts` (~46-49, `handleTermResize` without session), `tmux-kind-handlers.ts` (~174-183 drops `_ws`), `tmux-command-handlers.ts` (`handleTermResize` ~174-203 → `resizeWindow` for multi-pane / `runtime.resizePane` for single-pane), `index.ts` (`WebSocketServer.handleTermResize` ~722-728; session close ~402-446), `gateway-session.ts` (~10-31), `device-connection-registry.ts` (clients per device entry ~213-263; reconnect-failure cleanup ~360-377), `types.ts` (`DeviceConnectionEntry`), `legacy-feed-broadcaster.ts` (`sendSnapshotToClients` ~234-243 — one payload for all clients; do NOT personalise snapshots).

## Deliverables

1. **Shared protocol** (`packages/shared/src/ws-borsh`): add C2S kind `TERM_VIEWPORT` with schema `{ deviceId: string, paneId: string, cols: u16, rows: u16, visible: bool }` and S2C kind `TERM_VIEWPORT_POLICY` with `{ deviceId: string, windowId: string, paneId: string, owner: bool, cols: u16, rows: u16 }`. Register both in kind tables, encoders/decoders, and tests (round-trip). Append both to the spec doc's message table (concise, Chinese, same style).
2. **ws-client** (`packages/ws-client/src`): command type `{ kind: 'terminal-viewport'; deviceId; paneId; cols; rows; visible }` in the command union + encoder; builder `buildTermViewportMessage({ deviceId, paneId, cols, rows, visible })` next to the resize builders in `message-builder.ts`; S2C decoded event type exported as `TerminalViewportPolicyEvent = { kind: 'terminal-viewport-policy'; deviceId; windowId; paneId; owner: boolean; cols; rows }` delivered through the same typed-event path the tmux snapshot/events use (so `packages/stores/src/tmux-event-router.ts` can `case 'terminal-viewport-policy'`). Do **not** edit `packages/stores` or anything under `apps/fe`, `packages/panels`, `packages/terminal-ui`, `packages/ghostty-terminal` — a frontend agent wires the store using these exact names. Unit tests for builder/encoder/decoder.
3. **Gateway**:
   - Thread the `GatewaySession` into the resize path (dispatcher → kind handlers → `handleTermResize`), add a `TERM_VIEWPORT` handler.
   - Add a small pure module `apps/gateway/src/ws/viewport-policy.ts`: claim storage per session keyed `"deviceId/windowId"` → `{ paneId, cols, rows, visible, at }`; `resolveWinner(claims: Iterable<{sessionId, claim}>)` with the deterministic order from the contract; unit-test it thoroughly (largest wins, hidden excluded, ties, removal, no-visible → null).
   - Integrate: `terminal-resize`/`terminal-sync-size` = visible claim; `TERM_VIEWPORT` updates visibility/geometry; after any claim change for a (device, window): compute winner; apply tmux resize via the existing path only when the winner's geometry differs from the last applied geometry for that window (track last applied per entry/window); send `TERM_VIEWPORT_POLICY` to every session holding a claim on that window whenever winner/geometry changes, and to a session right after its first claim on a window. Drop claims on session close, device detach, reconnect-failure cleanup, and recompute/apply for affected windows. Pane→window resolution: reuse whatever `handleTermResize` uses today (snapshot lookup); if the pane is unknown, ignore the claim.
   - Single-client behaviour must remain identical (existing `ws/*.test.ts` resize tests must pass unchanged, except where they need the session argument).
   - Tests: two fake sessions on one device entry — (a) larger visible + smaller visible → only the larger resize reaches tmux, both get policy (owner true/false); (b) larger goes hidden → smaller's geometry applied, policies flip; (c) larger disconnects → same; (d) smaller-only → applied as today; (e) legacy client that only sends resize is a visible claimant.
4. Doc: `docs/terminal/2026090101-viewport-policy.md` (Chinese, concise: background, rule, protocol, edge cases).

## Scope

`packages/shared/src/ws-borsh/**`, `packages/ws-client/src/**` (transport/encoder/decoder/builder + tests only), `apps/gateway/src/ws/**`, `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`, `docs/terminal/2026090101-viewport-policy.md`. Nothing else.

## Verification (must pass before writing the report)

- `cd packages/shared && bun test` (baseline 392 pass) and `bunx tsc --noEmit -p .`.
- `cd packages/ws-client && bun test` (baseline 283 pass) and `bunx tsc --noEmit -p .`.
- `cd apps/gateway && bun test` (baseline 3080 pass / 0 fail, ~145 s) and `bunx tsc --noEmit -p . 2>&1 | grep -c 'error TS'` must stay **21** (pre-existing errors in push/supervisor.test.ts, telegram/service.ts, tmux-client/*, tmux/ssh-auth.ts, ws/index.test.ts, system/managed-endpoint.test.ts).
- `cd packages/stores && bunx tsc --noEmit -p .` must still pass (you did not edit it, but the event union change must not break it — if it does because of an exhaustive switch, tell the commander in the report instead of editing stores).
- `bunx biome check <each file you touched>` clean (never `--write` on files you did not touch).

## Report (`T1-result.md`)

Exact exported names (kinds, types, builder, event), files changed, gateway integration points, test counts before/after, tsc counts, anything unfinished.
