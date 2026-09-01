# H1 — Frontend lib: gateway WS heartbeat — slow down while the page is hidden

Worktree: `/Users/konata/code/tmex-enhanced-wt-r12` (branch `feat/round12-leftovers`). Bun-only monorepo. **Other agents edit other files concurrently (K1 in `packages/panels` + `packages/terminal-ui` + `packages/stores`; M1 in `apps/fe/src/node/**`; G1 in `apps/gateway/**`). Touch only the files in "Scope". Never run git commands.** Comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

Context (from `prompt-archives/2026090102-round12-leftovers/sub/EX1-result.md` §1, last paragraphs): the ws-client heartbeat is a fixed 5 s PING interval with a 10 s PONG timeout (`packages/ws-client/src/client.ts:62-70`, `packages/ws-client/src/heartbeat-controller.ts:20-47`); the visibility handler (`client.ts:577-604`) only acts when the page becomes visible (reconnect/check). The gateway WS has no socket idle timeout (`apps/gateway/src/ws/index.ts` PING→PONG only), so lengthening the interval is safe server-side; external proxies (Cloudflare Tunnel ≈ 100 s idle) are the practical bound.

## Required behaviour

1. While `document.visibilityState === 'hidden'`, the heartbeat interval becomes **30 s** with a **60 s** PONG timeout; while visible, the current 5 s / 10 s. Constants exported and overridable via the existing client options (add `hiddenHeartbeatIntervalMs` / `hiddenHeartbeatTimeoutMs` next to the current ones, defaults as above).
2. Transition hidden → visible: keep the existing behaviour (immediate connectivity check / PING) and switch back to the fast cadence at once. Transition visible → hidden: switch to the slow cadence without sending an extra PING; an in-flight PONG wait keeps its current deadline.
3. `HeartbeatController` gets a way to change cadence at runtime (restart or mutable interval — pick the smaller change consistent with the existing controller tests).
4. Non-browser environments (no `document`) keep the fast cadence.
5. No change to the wire protocol or to the gateway.

## Scope

`packages/ws-client/src/{heartbeat-controller.ts,client.ts}` and their tests (`heartbeat-controller.test.ts`, `client*.test.ts`), plus the options type file if it lives elsewhere in `packages/ws-client/src`. Do **not** edit `apps/**` or other packages.

## Tests

- hidden → interval 30 s / timeout 60 s (fake timers); visible → 5 s / 10 s; hidden→visible triggers immediate check and fast cadence; visible→hidden does not send an extra PING; missing `document` → fast cadence; timeout while hidden still triggers the existing reconnect path.

## Verification (must pass before reporting)

`cd packages/ws-client && bun test` (pass count not below baseline), `bunx tsc --noEmit -p .` (baseline), `bunx biome check <touched files>` clean.

## Baselines

`packages/panels` 724 pass / tsc 0; `packages/terminal-ui` 358 pass / tsc 0; `packages/stores` 415 pass / tsc 1 (pre-existing); `packages/ws-client` 286 pass / tsc 0; `apps/fe` (`bun test src/`) 1130 pass / tsc 0.

## Report (final message, < 250 words)

Files changed, the cadence rules, how cadence switching is implemented, test counts before/after, anything unfinished.
