# RV2 — Code review: gateway tsc cleanup (21 → 0)

You are a senior reviewer. Read-only sandbox; output the complete review as your final message (Markdown, English, < 600 words). Cite `path:line`. Rank findings **blocker / should-fix / nit** with a concrete failure scenario each; skip style and theoretical hardening.

The diff is in `DIFF_PATH` (git diff main..HEAD limited to `apps/gateway`). Its stated intent: fix 21 pre-existing TypeScript errors **without changing runtime behaviour** (no `any`, no `@ts-ignore`, no tsconfig changes). Verify that claim file by file. Pay special attention to the four non-test files:

1. `src/telegram/service.ts` — `bot.updates.offset` (private in gramio) replaced by a `pollOffset` tracked via `bot.onResponse('getUpdates', …)` = last `update_id + 1`. Compare against gramio's own logic in `apps/gateway/node_modules/gramio/dist/index.js` (search `offset`), including the `dropPendingUpdates` path (`offset: -1`), and check when `updateTelegramBot(..., { lastUpdateId })` is now written vs before (it now writes unconditionally right after `start()`; confirm nothing reads `lastUpdateId` to seed the poll offset — grep the gateway).
2. `src/tmux-client/ssh-auth-resolvers.ts` — new `throw` when the agent socket is `undefined`; determine whether that branch was reachable before and what happened then (was `agent: undefined` passed to ssh2?). Is the error message consistent with the existing `resolveSshAgentSocket('agent')` error and i18n conventions in this file?
3. `src/tmux-client/control-mode-capture.ts` — `Omit` widening; confirm callers.
4. `src/tmux/ssh-auth.ts` — `EnvLike | NodeJS.ProcessEnv`; confirm no call site passed a plain object that now fails.

For the test files, confirm the tests still assert what they asserted before (e.g. the `process.off('unhandledRejection')` EventEmitter view really unregisters the same listener; `Promise.withResolvers()` replacement keeps the release timing; the boxed `{ listener }` in `push/supervisor.test.ts` still exercises the same code paths and the removed `as any` mocks did not hide assertions).
