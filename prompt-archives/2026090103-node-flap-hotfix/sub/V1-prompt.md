# V1 — ws-client: do not send TERM_VIEWPORT to gateways older than 1.1.7

Worktree: `/Users/konata/code/tmex-enhanced-wt-vp` (branch `fix/viewport-compat`, based on main = v1.1.9). Bun-only monorepo. No other agent edits this worktree. Never run git commands. Comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

## Problem (production, confirmed)

The multi-client viewport protocol (round 11, v1.1.7) makes the browser send `KIND_TERM_VIEWPORT` (0x0308 = 776) on every pane select / visibility change (`packages/ws-client/src/transport-command-encoder.ts:53` via `buildTermViewportMessage`, `packages/ws-client/src/message-builder.ts:208-222`). Remote mesh nodes that still run ≤ 1.1.6 do not know that kind and answer every frame with an ERROR envelope `ERROR_UNKNOWN_KIND` / `Unknown kind: 776` (`apps/gateway/src/ws/borsh-dispatcher.ts:137`, same in v1.1.6), which the client surfaces as `transport-error` → `console.error('[tmux] gateway transport error: Error: Unknown kind: 776')` (`packages/ws-client/src/transport-message-decoder.ts:180-183`, `packages/stores/src/tmux-event-router.ts:283`). Harmless but noisy (one error per remote pane switch), and the frames are wasted.

## Required behaviour

1. The client learns the gateway version from `HELLO_S2C.serverVersion` (`packages/shared/src/ws-borsh/schema.ts` `HelloS2CSchema`; the client already keeps `serverCapabilities` from the hello in `packages/ws-client/src/client.ts:168,360`). Add `serverVersion` to what the client keeps and expose a derived flag (e.g. `supportsTermViewport`): true when `serverVersion` parses as semver ≥ `1.1.7`; **also true when it does not parse** (dev builds like `0.0.0-dev`/`dev`/empty must be treated as new — check what `getDisplayVersion()` in `apps/gateway/src/ws/index.ts:512` returns in development / test envs and make the tests cover it). Check `packages/shared/src` for an existing semver compare helper before writing one (e.g. used by the upgrade flow in `packages/app/src` or `apps/gateway/src/update`); reuse it if it lives in a browser-safe module, otherwise add a tiny `compareSemver` to `packages/shared/src` (browser-safe, no Node imports) with tests.
2. When the flag is false, the transport silently drops `TERM_VIEWPORT` commands instead of sending them (find the right layer: `packages/ws-client/src/websocket-transport.ts` / `transport-command-encoder.ts` — the drop must happen per connection, after hello, and must not throw or emit `transport-error`). Everything else is unchanged; the direct (WebRTC) carrier path, if it has its own hello, must use the same flag source — verify in `packages/ws-client/src/direct/**` and `carrier-switch.ts` whether TERM_VIEWPORT can be sent over a carrier that negotiated separately.
3. Reset the flag on reconnect (a node may have been upgraded meanwhile) — it is re-derived from the next hello.

## Tests

`packages/ws-client` unit tests (existing patterns in `client.test.ts` / `websocket-transport*.test.ts`): serverVersion `1.1.6` → TERM_VIEWPORT not sent, other kinds still sent, no transport-error; `1.1.7`, `1.1.9`, `1.2.0`, `2.0.0` → sent; unparsable/empty → sent; after reconnect with a newer hello → sent again. Semver helper tests if you add one.

## Verification (must pass before reporting)

`cd packages/ws-client && bun test` (baseline **295 pass**), `bunx tsc --noEmit -p .` (0); `cd packages/shared && bun test` if touched (baseline 398) + tsc; `bunx biome check <touched files>` clean; `bun scripts/complexity/gate.ts` ok. Do not run Playwright.

## Report (< 250 words)

Files changed, where the gate lives, how dev/unparsable versions behave, test counts before/after.
