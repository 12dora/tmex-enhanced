# S1 — Gateway: proxy-aware client IP for login rate limiting and bootstrap loopback check; mesh SSO regression tests

## Context

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo; run everything with `bun` (if `bun` is not on PATH, `source ~/.zshrc` or use `~/.bun/bin/bun`). **Other agents are editing other files in this worktree in parallel (frontend under `apps/fe`, `packages/panels`, `packages/stores`, `packages/ui`; gateway WS/tmux/mesh-forwarder code may be edited by another backend agent). Only touch the files listed under "Scope". Never run any git command.** The commander commits. Code comments only where non-obvious, in Simplified Chinese like the surrounding code. Write your final report to `/Users/konata/code/tmex-enhanced-wt-r11/prompt-archives/2026090101-round11-pwa-files-auth/sub/S1-result.md` (English, < 500 words) **and only exit after that file is written**.

A security review found two deployment-related issues in the public-facing login surface. Both are small; do **not** add anything beyond what is specified (no lockouts, no complexity rules, no origin checks, no HSTS).

## Task 1 — Login rate limiter must key on the real client IP when the proxy is trusted

Facts (verify by reading):
- Login failure limiter: `apps/gateway/src/mesh/mesh-deps.ts:8-19` (10 failures / 60 s per IP bucket and per UID bucket, in memory) and its use in `apps/gateway/src/mesh/auth-routes.ts` (~lines 272-326 challenge/login, ~800-822 `recordFailure`/`isLimited`).
- `clientIp` currently comes from `Bun.Server.requestIP()` (see `packages/app/src/runtime/assemble.ts:141-152` and how the ip reaches `AuthRoutes`). Behind Cloudflare Tunnel / a reverse proxy every remote visitor shares the tunnel agent's IP, so one attacker (or one mistyping user) throttles everybody, while a distributed attacker is not slowed by the IP bucket at all.
- `TMEX_TRUST_PROXY` already exists: `apps/gateway/src/config.ts:211` (`trustProxy`), threaded into `apps/gateway/src/mesh/mesh-http.ts:56/125`, `apps/gateway/src/mesh/session-middleware.ts:31,224-245` (HTTPS origin detection only honours forwarded headers when `trustProxy` is set and the request is direct, `via === MESH_VIA_SELF`), `apps/gateway/src/mesh/mesh-deps.ts:204,239`. The tunnel manager (`apps/gateway/src/tunnel/manager.ts`) can flip it via host env.

Change:
1. Add a single helper (e.g. `resolveClientIp({ socketIp, headers, trustProxy })` in a new small module under `apps/gateway/src/mesh/` or `apps/gateway/src/auth/`) that returns the socket IP unless `trustProxy` is true, in which case it prefers `CF-Connecting-IP`, then the **first** entry of `X-Forwarded-For` (trim, ignore empty), then `X-Real-IP`, falling back to the socket IP. Validate the result is a plausible IPv4/IPv6 literal (reject garbage → fall back to socket IP). Never honour these headers when `trustProxy` is false.
2. Use it wherever the login limiter computes its IP bucket (challenge + login + any other `recordFailure` site). Keep the UID bucket unchanged. Do not change the limits.
3. Unit tests for the helper (trusted/untrusted, each header, malformed values, IPv6) and one test in the existing auth-routes test file showing that with `trustProxy` two different `CF-Connecting-IP` values get separate buckets while with `trustProxy=false` the header is ignored.

## Task 2 — First-run bootstrap must not treat a proxied remote request as loopback

Facts (verify): `apps/gateway/src/mesh/auth-routes.ts:107-131` and `apps/gateway/src/api/local-auth-http.ts:102-121` decide "is this request local (loopback)?" from the socket IP to allow `/api/auth/local/bootstrap` (first account creation) and other pre-session local paths; `apps/gateway/src/tunnel/access-guard.ts:126-153` is related. A fresh (not yet bootstrapped) instance exposed through a tunnel that connects to `127.0.0.1` would treat the tunnel's request as loopback.

Change:
1. Reuse the helper from Task 1: when `trustProxy` is true, the loopback decision must use the resolved client IP (so a request that carries a proxy client-IP header is **not** loopback). When `trustProxy` is false, keep today's behaviour exactly (socket IP), **but** additionally treat a request as non-loopback if it carries `CF-Connecting-IP` (a header only Cloudflare sets — a direct localhost caller never sends it). Do not block anything else; do not add a new setting.
2. Tests: with a fake loopback socket IP, (a) no proxy headers → loopback (bootstrap allowed); (b) `CF-Connecting-IP: 203.0.113.5` → not loopback regardless of `trustProxy`; (c) `trustProxy=true` + `X-Forwarded-For: 203.0.113.5` → not loopback; (d) `trustProxy=false` + `X-Forwarded-For` only → loopback (unchanged behaviour).

## Task 3 — Regression tests for cross-node session isolation (test-only)

In `apps/gateway/src/mesh/integration/mesh.integration.test.ts` (two in-process nodes harness already exists around lines 846-900 with forged-credential cases), add, if not already covered (check first — do not duplicate):
- one user delegation + session key logs in to node A and then to node B; B returns only `tmex_s_<B>` (via `x-tmex-set-session`) and never a session for A;
- a `Login` signed for target A (its `target`/`target_pk`/challenge) is rejected by B;
- A's session id presented as B's cookie is rejected by B;
- a login whose delegation TTL is not exactly `DELEGATION_TTL_MS` is rejected (`DELEGATION_INVALID_TTL`).
Keep them fast and in the existing style.

## Scope (files you may edit)

- `apps/gateway/src/mesh/auth-routes.ts`, `apps/gateway/src/mesh/mesh-deps.ts`, `apps/gateway/src/mesh/session-middleware.ts` (only if the IP helper must be shared with it), `apps/gateway/src/api/local-auth-http.ts`, `apps/gateway/src/tunnel/access-guard.ts` (only if needed), a new helper module + its test, the corresponding existing `*.test.ts` files, `apps/gateway/src/mesh/integration/mesh.integration.test.ts`, and `packages/app/src/runtime/assemble.ts` only if the socket IP / headers are not already reachable where the decision is made.
- Do **not** touch `apps/gateway/src/ws/**`, `apps/gateway/src/tmux*/**`, `apps/gateway/src/mesh/forwarder.ts`, `apps/gateway/src/mesh/stream-targets.ts`, or anything under `apps/fe`/`packages/*` other than as listed.
- Add a short doc `docs/operations/2026090101-public-login-hardening.md` (Simplified Chinese, concise, technical audience) describing: the client-IP resolution rule, that `TMEX_TRUST_PROXY` must be on behind Cloudflare Tunnel / reverse proxies, and the bootstrap loopback rule.

## Verification (must pass before writing the report)

- `cd apps/gateway && bun test` — baseline 3080 pass / 0 fail (≈145 s); your tests add to it. If the full run is too slow to iterate, run the touched files first, then the full suite once at the end.
- `cd apps/gateway && bunx tsc --noEmit -p . 2>&1 | grep -c 'error TS'` — baseline **21** pre-existing errors (in push/supervisor.test.ts, telegram/service.ts, tmux-client/*, tmux/ssh-auth.ts, ws/index.test.ts, system/managed-endpoint.test.ts); must not increase.
- `cd packages/app && bunx tsc --noEmit -p .` if you touched it.
- `bunx biome check <each file you touched>` clean (never `--write` on files you did not touch).

## Report (`S1-result.md`)

Files changed, the helper's exact precedence rule, test counts before/after, tsc error count, anything you could not finish and why.
