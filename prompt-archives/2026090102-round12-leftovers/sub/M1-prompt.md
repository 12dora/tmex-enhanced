# M1 — Frontend: mesh node list — long fallback poll + event-driven refresh

Worktree: `/Users/konata/code/tmex-enhanced-wt-r12` (branch `feat/round12-leftovers`). Bun-only monorepo. **Other agents edit other files concurrently (K1 in `packages/panels` + `packages/terminal-ui` + `packages/stores`; H1 in `packages/ws-client/**`; G1 in `apps/gateway/**`). Touch only the files in "Scope". Never run git commands.** Comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

Read `prompt-archives/2026090102-round12-leftovers/sub/EX3-result.md` first (audit with `path:line`; re-verify against current code).

## Problem

The resident mesh owner (`apps/fe/src/node/mesh-nodes-resident.tsx` → `apps/fe/src/node/mesh-nodes.ts`) polls `GET /api/mesh/nodes` every 30 s (single poller, skipped while hidden, refreshed on visible when stale — round 11). The mesh WebSocket (`apps/fe/src/node/mesh-events.ts`) already pushes `status/reach/inventory/version/direct_capable/name/transport/rttMs` patches, so the REST list is only needed for: initial membership + public keys, membership changes (admission / revocation — events only patch known rows), `loggedIn`/`isHub`/`peerAddress`/`linkSinceAt`/`endpoints`/`directFailure`, and recovery after a WS gap.

## Required behaviour

1. Fallback poll interval **30 s → 5 min** (constant exported, test-overridable). Keep the existing "skip while hidden, refresh on visible if stale" semantics (stale = older than the interval? No — use a separate **stale threshold of 30 s** for the visibility refresh so coming back to the tab still gives a fresh list quickly).
2. **Immediate refresh** (single-flight, de-duplicated) on:
   - mesh WebSocket (re)connect — after the socket reaches connected state (use the event source's status listener; `mesh-events.ts:343-356` area), because events may have been missed;
   - a mesh event that indicates membership change or a node the store does not know (unknown node id in an event → refresh; admission/revocation events if such kinds exist — check the event kinds in `mesh-events.ts` and the gateway's broadcast in `apps/gateway/src/mesh/mesh-routes.ts:366-389`, read-only);
   - explicit refresh calls already present (settings nodes page, diagnostics popover `device-node-badges.tsx:259-263`) — keep them working; if the settings nodes page does not already refresh on mount, add a call there.
3. Add a tiny throttle so a burst of events causes at most one refresh per ~2 s.
4. No DTO / API changes. No gateway edits.

## Scope

`apps/fe/src/node/{mesh-nodes.ts,mesh-nodes-resident.tsx,mesh-events.ts}` (+ their tests `mesh-nodes.test.ts`, `mesh-events.test.ts`), `apps/fe/src/pages/settings/nodes/**` only to add a refresh-on-mount call if missing. Do **not** edit `apps/fe/src/auth/**`, `packages/**`, `apps/gateway/**`.

## Tests

- two consumers, one poller, interval 5 min (fake timers);
- WS connect → refresh; reconnect after drop → refresh; unknown-node event → refresh; burst of events → one refresh within the throttle window;
- visible after >30 s hidden → refresh; visible after <30 s → no refresh.

## Verification (must pass before reporting)

`cd apps/fe && bun test src/` (pass count not below baseline), `bunx tsc --noEmit -p .` (0 errors), `bunx biome check <touched files>` clean. Do not run Playwright e2e.

## Baselines

`packages/panels` 724 pass / tsc 0; `packages/terminal-ui` 358 pass / tsc 0; `packages/stores` 415 pass / tsc 1 (pre-existing); `packages/ws-client` 286 pass / tsc 0; `apps/fe` (`bun test src/`) 1130 pass / tsc 0.

## Report (final message, < 300 words)

Files changed, the exact refresh triggers and thresholds, test counts before/after, anything unfinished.
