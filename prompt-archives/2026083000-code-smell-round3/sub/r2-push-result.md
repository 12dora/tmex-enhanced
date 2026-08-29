# r2-push — gateway push alerts, bell context, weixin ilink

Scope: `bell-context.ts`, `connection-alerts.ts`, `supervisor.ts`, `weixin/ilink/client.ts` and their existing tests. No git. No new files (helpers stayed next to the callers).

None of the four functions were skipped. Each had a real decision/fallback table or a mixed retry loop; flattening would not have helped a reader.

## Files

**Changed (production)**
- `apps/gateway/src/tmux/bell-context.ts` (92L → 111L)
- `apps/gateway/src/push/connection-alerts.ts` (327L → 333L)
- `apps/gateway/src/push/supervisor.ts` (447L → 476L)
- `apps/gateway/src/weixin/ilink/client.ts` (387L → 437L)

**Changed (tests, cases extended, none deleted)**
- `apps/gateway/src/tmux/bell-context.test.ts` (+4 cases)
- `apps/gateway/src/push/connection-alerts.test.ts` (+1 case)
- `apps/gateway/src/push/supervisor.test.ts` (+7 cases; existing listener capture switched to a box so `let listener` no longer collapses to `never`)
- `apps/gateway/src/weixin/ilink/client.test.ts` (+5 cases)

## What moved

### `resolvePaneContext`
Fallback cascade extracted in-file: `nonEmptyString`, `pickByIdOrActiveOrFirst`, `locateWindowAndPane`, `buildPaneUrl`. Pane-id match still wins over window-id; missing snapshot still returns only raw ids.

### `maybeEmitEvent`
`classifyBridgeEvent` is the source/errorType/sessionClosed table (`device_tmux_missing` vs `device_disconnect` vs drop). `maybeEmitEvent` only throttles, reads settings, emits, then records the window. `sweepExpiredThrottleKeys` is shared with `shouldSendTelegram`. Telegram still records throttle *before* send; the bridge still records only after a successful emit (those paths were not merged).

### `handleTmuxEvent`
Generation/runtime guard is `liveEntry` (also used by `handleClose` / `handleSnapshot`). OSC payload parse is `parseOscNotification` + `oscNotificationSource`. Dispatch stays two branches (bell vs notification); a handler map for two types would not help. **`osc99` is still coerced to `osc9`** — same as before (see Bugs).

### `WeixinClient.start`
Guards stay in `start`. Poll outcome is `PollOutcome` (`aborted` / `expired` / `retry` / `ok`). Network throw and non-zero `ret` both yield `retry` but keep distinct `error` values for `onError`. Session-expired still calls `onSessionExpired` then throws `WeixinSessionExpiredError` (not merged into retry). Per-request `AbortSignal.timeout` vs stop-signal, backoff, `finally` cleanup, token cache, and empty-buf skip are unchanged.

## Metrics

McCabe = 1 + `if` / `for` / `while` / `&&` / `||` / `?:` / `??` / `catch` (same style as the round baseline; `?.` not counted). Length is function span.

| Symbol | Before | After |
|---|---|---|
| `resolvePaneContext` | CC 23 / 58L | CC 5 / 25L |
| `locateWindowAndPane` | — | CC 4 / 16L |
| `pickByIdOrActiveOrFirst` | — | CC 4 / 10L |
| `maybeEmitEvent` | CC 17 / 59L | CC 8 / 38L |
| `classifyBridgeEvent` | — | CC 5 / 19L |
| `handleTmuxEvent` | CC 16 / 56L | CC 6 / 50L |
| `parseOscNotification` | — | CC 7 / 9L |
| `start` | CC 24 / 91L | CC 10 / 44L |
| `pollUpdates` | — | CC 3 / 29L |
| `deliverInboundMessages` | — | CC 6 / 20L |
| `decideGetUpdatesResp` | — | CC 5 / 12L |

## Verification (`apps/gateway`)

- Scoped: bell-context + connection-alerts + supervisor + ilink client → **66 pass / 0 fail**
- `bun test`: **1669 pass / 0 fail** (baseline 1559; extra passes include this scope and other agents)
- `bunx tsc --noEmit -p .`: **20 errors**, under baseline 27; **none in scoped files**
- `bunx biome check` on the 8 scoped files: **clean**

Test fixtures gained `disabledNotificationChannels: []` because `SiteSettings` now requires it (type lives outside this scope).

## Skipped

- No new files. Helpers stay in the same module.
- Did not merge iLink session-expired with retry; did not merge telegram vs bridge throttle timing.
- Did not extract `toBadgeKey` / `login` (out of scope).
- Did not run Playwright e2e (`apps/fe/tests`).
- Did not add `osc99` to the push allow-list (would change behaviour).

## Bugs found

**Push supervisor remaps OSC 99 notifications to `osc9`.** `NotificationSource` and the pane-stream parser include `osc99` (iTerm2 / Ghostty / Claude Code). `legacy-feed-broadcaster.ts` accepts `osc99`. `handleTmuxEvent` only keeps `osc9` / `osc777` / `osc1337` and defaults everything else — including `osc99` — to `osc9`. Locked by a characterization test (`notification source osc99 is forwarded as osc9`). Not fixed (behaviour-preserving).
