# GET /healthz `env: development` on a production install

Date: 2026-08-28. Branch `chore/merge-hub-tabs`. No git state changes. Did not touch production tmex, the `tmex` tmux session, or `packages/app` / `scripts/` source.

## Root cause

`GET /healthz` in `apps/gateway/src/api/system-routes.ts` reported `process.env.NODE_ENV`. `bun build` statically replaces that identifier with the **build-time** `NODE_ENV` string.

`packages/app/scripts/build-runtime.ts` does not `--define process.env.NODE_ENV="production"` (unlike managed compile in `apps/gateway/scripts/build-managed.ts`). The packaged `server.js` therefore contained:

```js
env: "development",
```

`loadEnv()` was not the bug: it already reads `env.NODE_ENV` on the process.env object, so production still logged `[env] production: 使用 app.env 注入变量…` while healthz lied. `config.isProd` also survived (it uses `process.env[key]`).

## Before / after (temp instance, port 19984, not the launchd install)

| entry | NODE_ENV=production | healthz `env` |
|---|---|---|
| source `apps/gateway/src/index.ts` (before) | production | `"production"` |
| built `packages/app/dist/runtime/server.js` (before) | production | `"development"` |
| source (after) | production | `"production"` |
| rebuilt runtime (after) | production | `"production"` |

Rebuilt bundle now has `env: readNodeEnv()` instead of a string literal.

## What changed

- `packages/shared/src/env/load-env.ts`: added `readNodeEnv()` — `resolveEnvName(env.NODE_ENV)` on an env object so bun cannot inline it.
- `apps/gateway/src/api/system-routes.ts`: healthz `env` uses `readNodeEnv()`.
- Tests: `readNodeEnv` cases in `load-env.test.ts`; `system-routes.healthz.test.ts` asserts the live handler and that `Bun.build` of `system-routes.ts` does not bake `env: "development"|"test"|"production"`.

Did not change `build-runtime.ts` (out of scope). The source-side read is correct for any build-time NODE_ENV.

## Verified

- `packages/shared`: `bun test` 332 pass; `bunx tsc --noEmit -p .` 0 errors
- `apps/gateway`: `bun test` 2311 pass; `bunx tsc --noEmit -p .` 21 errors (baseline)
- `bunx biome check` on the four changed files — clean
- Live curl of source + rebuilt runtime as above

## Open issues

`apps/gateway/src/system/managed.ts` still uses `process.env.NODE_ENV !== 'test'` (would also inline if compiled). Out of this healthz/env scope.
