# uplink connect diagnostics — result

## What changed

`apps/gateway/src/mesh/uplink-client.ts` no longer swallows `connectOnce` failures.

- **Connect failures** log  
  `[uplink] connect failed hub=<host:port> attempt=<n> reason=<code> next_retry_ms=<delay>`  
  at most once per 30s per reason. Hub is `URL.host` only (no path/query/token).
- **Stable reason codes:** `tls`, `dns`, `refused`, `timeout`, `http_<status>` (incl. 4401/403), `auth_rejected`, `protocol`, else `unknown`.
- **State:** `[uplink] online hub=… after_ms=…` and `[uplink] offline reason=…` (same 30s rate limit).
- **Timeout:** `UPLINK_CONNECT_TIMEOUT_MS` default **20000**; wraps WS open **and** auth handshake in `connectOnce`. Optional env override of the same name. Hung TLS/handshake becomes `reason=timeout` and retries.
- **`lastConnectError`:** `{ reason, at }` on the client. `GET /api/mesh/nodes` and `/api/auth/mode` have no existing uplink-state field (`uplinkState` / self-row hub online are peer presence, not this), so HTTP was left alone.

`docs/hub/2026082800-hub-node-operations.md` 常见排障: two rows for silent uplink / `reason=timeout`.

## How verified

- `cd apps/gateway && bun test src/mesh/uplink-client.test.ts` → **41 pass, 0 fail**
- Non-rtc mesh tests (`src/mesh/**/*.test.ts` excluding `rtc/` and `integration/`) → **216 pass, 0 fail**
- `bunx biome check` on the two TS files → clean
- `bunx tsc --noEmit -p .`: **0 errors in `uplink-client.ts`**

## Open issues

- Full `bun test src/mesh` also ran RTC files other agents are editing concurrently (carrier overflow / RtcPeerManager timeouts). Out of this task’s scope.
- Gateway `tsc` total is ~27 vs documented baseline 21; extra errors are in unrelated files (`peer-manager.test.ts`, rtc, tmux, …), not uplink-client.
