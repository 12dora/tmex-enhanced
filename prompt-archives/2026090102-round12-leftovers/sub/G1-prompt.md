# G1 — Backend: clear the 21 pre-existing `tsc` errors in `apps/gateway`

Worktree: `/Users/konata/code/tmex-enhanced-wt-r12` (branch `feat/round12-leftovers`). Bun-only monorepo (`bun`, never `node`/`npm`). **Other agents edit frontend packages concurrently; touch only the files listed below. Never run git commands.** Comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

## Goal

`cd apps/gateway && bunx tsc --noEmit -p .` currently reports exactly 21 errors, all pre-existing. Bring it to **0** without changing runtime behaviour and without `any`, `@ts-ignore`, `@ts-expect-error`, or loosening `tsconfig`. Fix types properly (narrow, correct generics, correct `Omit`, proper mock typing).

## The 21 errors (current output)

```
src/push/supervisor.test.ts(169,15): TS2339 Property 'onSnapshot' does not exist on type 'never'.
src/push/supervisor.test.ts(170,15): TS2339 Property 'onEvent' does not exist on type 'never'.
src/push/supervisor.test.ts(254,15): TS2339 Property 'onSnapshot' does not exist on type 'never'.
src/push/supervisor.test.ts(255,15): TS2339 Property 'onEvent' does not exist on type 'never'.
src/push/supervisor.test.ts(323,19): TS2339 Property 'onClose' does not exist on type 'never'.
src/system/managed-endpoint.test.ts(103,25): TS2769 No overload matches this call (toEqual with a subset object — the expected type is inferred from the actual; use a typed variable or `toMatchObject`/`expect.objectContaining` only if semantics stay identical).
src/telegram/service.ts(153,34): TS2341 Property 'offset' is private and only accessible within class 'Updates'.
src/telegram/service.ts(214,40): TS2341 (same)
src/tmux-client/control-mode-capture.ts(120,3): TS2741 Property 'historyText' is missing in type … but required in type 'Omit<AtomicPaneCapture, "text">'.  → the return type should be `Omit<AtomicPaneCapture, 'text' | 'historyText'>`; check callers at :184-185 still type-check.
src/tmux-client/local-external-connection.eagain.test.ts(433,33): TS2769 (toEqual(null-typed) with string[] — type the variable properly)
src/tmux-client/local-external-connection.eagain.test.ts(498,33): TS2769 (same)
src/tmux-client/local-external-connection.eagain.test.ts(554,19): TS2345 Argument of type '"unhandledRejection"' is not assignable to parameter of type '"memoryPressure"'.  (bun-types `process.on` overload narrowing — find the correct typing, e.g. cast the event name via NodeJS.Process typing or use `process.listeners` typed helper; do not silence)
src/tmux-client/local-external-connection.test.ts(1652,19): TS2345 (same as above)
src/tmux-client/local-external-connection.test.ts(1945,5): TS2349 This expression is not callable. Type 'never' has no call signatures.
src/tmux-client/ssh-auth-resolvers.ts(326,9): TS2322 Type 'string | undefined' is not assignable to type 'string | BaseAgent<…>'.
src/tmux-client/ssh-connect-config.test.ts(156,40): TS2769 (auth handler array literal not assignable to AuthenticationType[] — type the fixture with the ssh2 types)
src/tmux-client/ssh-connect-config.test.ts(262,40): TS2769 (same)
src/tmux-client/ssh-external-connection.test.ts(1092,7): TS2322 mock returning `undefined` where `null` expected.
src/tmux/ssh-auth.ts(13,3): TS2559 Type 'ProcessEnv' has no properties in common with type 'Partial<Record<"USER" | "LOGNAME" | "SSH_AUTH_SOCK", string | undefined>>'.
src/tmux/ssh-auth.ts(32,3): TS2559 (same)
src/ws/index.test.ts(231,17): TS2345 '"unhandledRejection"' vs '"memoryPressure"' (same family as above)
```

For the `telegram/service.ts` private `offset` access: look at the `Updates` class in `node_modules` (grammy or whichever lib — check `apps/gateway/package.json`) and its public API for reading/setting the update offset; if there is no public accessor, keep the behaviour via the library's documented mechanism (do not make a structural cast to bypass `private`). Read the library source in `node_modules` before deciding.

For the `process.on('unhandledRejection', …)` family: inspect `node_modules/bun-types` / `@types/node` to see which overload set applies and pick the typing that matches (this repo runs tests on Bun).

## Verification (must pass before reporting)

- `cd apps/gateway && bunx tsc --noEmit -p .` → **0 errors**.
- `cd apps/gateway && bun test` → pass count not below **3134** (the pre-existing baseline), 0 fail. Note: never touch the default tmux socket or a tmux session named `tmex`; the test suite already uses `-L` sockets.
- `bunx biome check <each touched file>` clean.

## Report (final message, < 300 words)

Per file: what the root cause was and how it was fixed; final tsc count; test counts before/after; anything you could not fix properly and why.
