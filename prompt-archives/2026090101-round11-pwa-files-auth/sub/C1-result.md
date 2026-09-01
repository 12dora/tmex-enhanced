# C1 result — Gateway complexity-gate extractions

No behaviour change. Allowlist untouched.

## Extractions

| File | Before | After | Move |
|---|---|---|---|
| `mesh/auth-routes.ts` | 925 > 924 | **899** | login-failure limiter → `auth-login-limiter.ts` (`LoginFailureLimiter`) |
| `ws/tmux-kind-handlers.ts` `createTmuxKindHandlers` | 189 > 183 | **150** | resize/viewport kinds → `tmux-viewport-handlers.ts`, spread at end |
| `ws/tmux-command-handlers.ts` `applyViewportPolicy` | CC 20 > 15 | CC ≤ 15 | `collectWindowClaims`, `applyWinnerGeometry`, `notifyClaimants` in `viewport-policy.ts` |
| `ws/index.ts` | 921 > 900 | **890** | session teardown + `dropViewportClaims` → `session-close.ts` (`closeGatewaySession`) |

Public test exports (`AuthRoutes`, `resolveUser`, `requestOrigin`, `rpIdFromOrigin`, handler registration) unchanged.

## Verification

- `bun scripts/complexity/gate.ts`: **no gateway violations** (remaining: frontend `LoginForm` 219 > 218, owned by another agent).
- `cd apps/gateway && bun test`: **3119 pass / 0 fail** (baseline 3115 + 4 helper tests in `viewport-policy.test.ts`).
- `cd apps/gateway && bunx tsc --noEmit -p . 2>&1 | grep -c 'error TS'`: **21** (unchanged; none in owned files except pre-existing `ws/index.test.ts`).
- `bunx biome check` on all touched files: **clean**.
