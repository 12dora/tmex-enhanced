# C1 — Gateway: bring 4 complexity-gate violations back under the limits

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11`. Bun-only; use `bun` (`~/.bun/bin/bun` if needed). **Other agents edit frontend files concurrently. Touch only the files listed. Never run git commands.** Write the final report (English, < 250 words) to `/Users/konata/code/tmex-enhanced-wt-r11/prompt-archives/2026090101-round11-pwa-files-auth/sub/C1-result.md` and only exit after writing it.

`bun scripts/complexity/gate.ts` (part of `bun run lint`) fails with these gateway violations (limits are enforced per file/function; read `scripts/complexity/` to see the rules and the allowlist format — do **not** add allowlist entries, fix the code):

```
apps/gateway/src/mesh/auth-routes.ts: 925 lines > 924
apps/gateway/src/ws/tmux-kind-handlers.ts:4 createTmuxKindHandlers: 189 lines > 183
apps/gateway/src/ws/tmux-command-handlers.ts:286 applyViewportPolicy: CC 20 > 15
apps/gateway/src/ws/index.ts: 921 lines > 900
```

Fix by extracting cohesive pieces into new modules/functions with no behaviour change:
- `auth-routes.ts`: move a self-contained block (e.g. the login-failure limiter helpers or passkey option builders) into a sibling module; keep exports used by tests.
- `tmux-kind-handlers.ts`: extract the viewport/resize handler group (or another cohesive group) into `ws/tmux-viewport-handlers.ts` and register it from `createTmuxKindHandlers`.
- `tmux-command-handlers.ts` `applyViewportPolicy`: split into pure helpers (`collectWindowClaims`, `notifyClaimants`, `applyWinnerGeometry` …) in `ws/viewport-policy.ts` (already exists as the pure module) so each function is CC ≤ 15.
- `ws/index.ts`: move the viewport claim plumbing (or another cohesive ≥ 25-line block added recently) into a new module.

Verification (must pass): `bun scripts/complexity/gate.ts` reports **no gateway violations** (frontend violations are being fixed by another agent — ignore them); `cd apps/gateway && bun test` (baseline **3115 pass / 0 fail**); `bunx tsc --noEmit -p . 2>&1 | grep -c 'error TS'` stays **21**; `bunx biome check <touched files>` clean.
