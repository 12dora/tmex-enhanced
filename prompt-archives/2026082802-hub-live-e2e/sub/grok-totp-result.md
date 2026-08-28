# TOTP login scenario (single-machine hub-e2e)

Date: 2026-08-28. Branch `chore/merge-hub-tabs`. No git state changes. Did not touch production tmex, the `tmex` tmux session, or `scripts/hub-e2e/split/`.

## What changed

Scenario 9 was added to `scripts/hub-e2e/run.sh` (after 8, before the report). Assertions:

| row | check |
|---|---|
| 9a | `hub user totp <user>` via `cli-auth.js` + `TMEX_PASSWORD`; otpauth URI captured, base32 secret extracted |
| 9b | login without totp → HTTP 401 `TOTP_REQUIRED` (not `TOTP_INVALID`; missing body hits `checkTotp` before decrypt) |
| 9c | login with `--totp 000000` (and derived `k_totp`) → HTTP 401 `TOTP_INVALID` |
| 9d | `--totp-secret <base32>` computes the current 6-digit code; login succeeds; `GET /api/auth/mode` has `"totpEnabled":true` |
| 9e | `hub user passwd` with `TMEX_PASSWORD_OLD` + `TMEX_PASSWORD` (`rotate-root`) |
| 9f | login with the new password and no totp succeeds; `totpEnabled` is false. `PASSWORD` is updated (scenario 9 is last) |

Driver:

- New `scripts/hub-e2e/driver/totp.ts`: `decodeBase32`, `parseOtpauthSecret`, `resolveTotpCode` (`--totp` > `TMEX_TOTP` > `--totp-secret`), `totpLoginField` (reuses shared `totpCode` / `deriveTotpKey`).
- `login.ts` sends `{ totp: { code, k_totp } }` on both self and remote login.
- `driver()` forwards `TMEX_TOTP`; `cli()` forwards `TMEX_PASSWORD_OLD`.
- `lib.ts` and `build-driver.sh` unchanged (totp.ts is pulled into `login.js`).

Docs (`docs/hub/2026082801-hub-docker-e2e.md`): scenario 9 row added; TOTP removed from single-machine “not covered”. 分体拓扑 section untouched.

## Verified

- `bun test scripts/hub-e2e/driver/` — 12 pass (RFC 4648 base32, CLI otpauth round-trip, code precedence, HKDF `k_totp` vector).
- `bash -n scripts/hub-e2e/run.sh`
- `bunx biome check` on `login.ts`, `totp.ts`, `totp.test.ts` — clean
- `scripts/hub-e2e/build-driver.sh` — produces `driver-dist/{login,nodes,terminal,files}.js`; `login.js` includes `totp-secret` / `deriveTotpKey` / `TMEX_TOTP`
- No harness `tsconfig`; skipped `tsc` for driver files

## Full harness

**Not run.** qemu amd64 is 15–25 min; host already has many unrelated compose projects; `tmex-e2e` was not up. Unit tests + bundle cover the new driver logic. To run:

```bash
TMEX_TARBALL=/Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/build/tmex-cli.tgz scripts/hub-e2e/run.sh
```

## Open issues

None in scope. 9b uses `TOTP_REQUIRED` (gateway `auth-routes.ts`); a wrong code is `TOTP_INVALID`.
