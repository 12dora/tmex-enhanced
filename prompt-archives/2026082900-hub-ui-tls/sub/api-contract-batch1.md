# Batch 1 API contract (frontend and backend both implement exactly this)

All JSON. Errors: HTTP 4xx/5xx with body `{ "error": { "code": string, "message": string } }`.

## GET /healthz (extend existing)

Add `startedAt: number` (process start time, `Date.now()` captured at module load). Everything else unchanged.

## GET /api/local/status

Auth: standalone → open; mesh → requires a valid `self` session (401 otherwise).

```json
{
  "role": "standalone" | "node" | "hub,node",
  "nodeEnv": "development" | "test" | "production",
  "hubUrl": string | null,
  "hubPublicUrl": string | null,
  "direct": {
    "supported": boolean,
    "installed": boolean,
    "capable": boolean,
    "version": string | null,
    "platform": string
  },
  "tls": { "mode": "none" }
}
```

`direct.supported` = platform has a pinned native manifest; `installed` = `native/manifest.json` exists; `capable` = runtime actually loaded the addon (`direct_capable`); `version` from manifest. `tls` is a placeholder in batch 1 (always `{mode:'none'}`); batch 2 extends it.

## POST /api/local/direct

Auth: same as status. Body `{ "enable": boolean }`.

Response `200 { "ok": true, "installed": boolean, "capable": boolean }`.
Errors: `409 direct_unsupported` (platform not pinned), `502 direct_download_failed` (message has cause), `500 direct_failed`.

`enable` downloads the addon (60 s timeout) and writes `<installDir>/native/`; `disable` deletes `native/`. The running RTC manager cannot reload the addon, so the response is always `{ "ok": true, "installed": <new state>, "capable": <unchanged runtime state>, "restartRequired": true }`. The frontend offers a "restart now" button that calls the existing `POST /api/settings/restart` (returns `{ success: true, message }`), then uses the restart waiter and reloads local status.

## POST /api/setup/precheck

Registered only in standalone (mesh → `404 not_standalone`). Body `{ "url": string }`.

Server fetches `<url>/healthz` with 5 s timeout using the system trust store.

Response `200 { "reachable": boolean, "isSelf": boolean, "status": number | null, "error": string | null }`.
`isSelf` = the returned `startedAt` equals this process's `startedAt`.

## POST /api/setup/hub

Registered only in standalone. Body:

```json
{ "hubPublicUrl": string, "username": string, "password": string, "directEnable": boolean }
```

Validation: `hubPublicUrl` must parse and be `https:` (or `http://127.0.0.1|localhost` only when `nodeEnv !== 'production'`); `username` 1–64 chars `[A-Za-z0-9._-]`; `password` ≥ 8 chars.

Steps: (1) `bootstrapUserWithSelfAdmit` (user + root key + self-admitted node cert); (2) if `directEnable`, direct enable with 60 s timeout, failure non-fatal; (3) write env keys `TMEX_ROLES=hub,node`, `TMEX_HUB_PUBLIC_URL=<url>`; (4) respond; (5) `process.exit(0)` ~300 ms later.

Response `200`:

```json
{ "ok": true, "fingerprint": string, "direct": "enabled" | "failed" | "skipped", "directError": string | null, "restarting": true }
```

Errors: `409 not_standalone`, `400 invalid_url`, `400 invalid_username`, `400 weak_password`, `409 user_exists`, `500 env_write_failed` (nothing restarted; user record may exist → message says so).
Additional: `409 setup_in_progress` (another become-hub/join is running), `409 setup_committed` (a transition already scheduled restart).

## POST /api/setup/join

Registered only in standalone. Body:

```json
{ "hubUrl": string, "token": string, "name": string, "directEnable": boolean, "insecureLocal"?: boolean }
```

Same semantics as CLI `hub join <hubUrl> --token <token> --name <name>`; `insecureLocal` honoured only when `nodeEnv !== 'production'`. Then direct enable (optional), write `TMEX_ROLES=node`, `TMEX_HUB_URL=<hubUrl>`, respond, exit.

Response `200 { "ok": true, "hubUrl": string, "username": string, "direct": ..., "directError": ..., "restarting": true }`.
Errors: `409 not_standalone`, `400 invalid_url`, `400 invalid_token`, `409 node_revoked`, `409 node_exists`, `502 hub_unreachable`, `400 join_failed` (message from join logic), `500 env_write_failed`.
Additional: `409 setup_in_progress` (another become-hub/join is running), `409 setup_committed` (a transition already scheduled restart).

## Restart handling (frontend)

Before submitting, read `/healthz.startedAt`. After a `restarting: true` response poll `GET /healthz` every 1 s; success when a response arrives whose `startedAt` differs from the recorded one. Timeout 60 s → show "service did not come back; start it manually (`npx tmex-cli restart` or launchd/systemd)". On success navigate to `/login` (mode is now mesh).
