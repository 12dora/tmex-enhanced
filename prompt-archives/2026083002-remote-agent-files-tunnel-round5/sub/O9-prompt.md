# Task O9 — Fix review findings: Remote access tab (frontend)

Read `common-rules.md`, then `O4-result.md`, `review-fe-2-report.md` (items 2–7) and `review-be-2-report.md` item 4. Contract changes made by the commander in `packages/shared/src/contracts/tunnel.ts`: `TunnelErrorCode` gained `'auth_required'`; `TunnelStatusResponse.configuredTrustProxy` (saved value) sits next to `trustProxy` (effective value); `restartRequired = configured !== effective`. Backend (agent G6, in parallel) also: `check` is an async job ending in `done` + `step:'ok'` or `error`; `create` is rejected while `config.mode !== 'off'`; `tunnelName` must match `^[a-z0-9](?:[a-z0-9_-]{0,62})$`; the actual create job steps are `create` → `route_dns` → `start`; login job steps `login` → `wait_cert` (or `cancelled`).

## Scope (files you own)
apps/fe/src/pages/settings/remote-access/** (+ tests), apps/fe/src/pages/SettingsPage.tsx only if needed; i18n: `settings.remoteAccess` sub-object only, targeted edits (another agent O6 is sweeping wording in the same JSON files — re-read before each edit, never delete keys).

## Fix list
1. Connectivity check: never derive the result from the 202 response. Remember the check job id, poll status, and set the result only when that job reaches `done` (reachable) or `error` (unreachable + message). Keep the pill neutral ("检查中…") meanwhile. Update tests (running → done, running → error).
2. Trust proxy switch binds to `configuredTrustProxy`; `trustProxy` is shown as the effective state; restart prompt when they differ. Copy must carry the existing TLS-settings caveat: enable only when the gateway cannot be reached directly bypassing the proxy (spoofable `X-Forwarded-*`), and advise restricting access to the original listening port — reuse the wording style of the existing `settings.nodes.https.external*` keys.
3. When a named tunnel is configured (`mode === 'named'`), step 3 shows a read-only summary (hostname, tunnel name/id) instead of the create form; the create form only exists while `mode === 'off'`.
4. `remove` in named mode requires an AlertDialog that states: stops the tunnel, deletes local credentials, and deletes the tunnel in Cloudflare. Quick mode keeps the lightweight flow.
5. `JOB_STEPS` / `jobStepKey` include every backend step (`download`, `extract`, `verify`, `login`, `wait_cert`, `cancelled`, `create`, `route_dns`, `start`, `check`, `ok`); the locale `jobStep` object already has most (`create`, `wait_cert`, `login`, `cancelled` were added) — add what is missing in all three locales.
6. `tunnelName` input: client-side validation with the same regex and an inline hint; `auth_required` error mapped to copy: zh「请先为本机启用登录，再开放公网访问。」 en "Enable sign-in on this machine before exposing it publicly." ja「公開する前に、このマシンでサインインを有効にしてください。」 and show it as a persistent notice in the wizard when the status/errors indicate it (the wizard should also pre-empt: if `/api/auth/mode` reports mode `none`, show the notice above step 2 with a link to `?tab=nodes`).

Verify fe tests + tsc + biome. Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O9-result.md
