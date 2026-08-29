# Batch 2/3 API contract — built-in HTTPS (external / self-signed / ACME)

All JSON; errors `{ "error": { "code", "message" } }`. Auth: standalone → open; mesh → valid `self` session.

## Data model (`tls_config`, singleton row id=1)

```
mode            'none' | 'external' | 'selfsigned' | 'acme'
tls_port        integer, default 9443
bind_host       text, default '0.0.0.0'
sans            JSON string[] (self-signed: hostnames/IPs; acme: [domain])
ca_cert_pem     text | null        (self-signed CA, public)
ca_key_enc      text | null        (encrypted PEM, scope 'tls_config' field 'ca_key')
cert_pem        text | null        (leaf + chain, public)
key_enc         text | null        (encrypted PEM, field 'key')
cert_not_before / cert_not_after   integer ms | null
acme_email, acme_domain, acme_challenge ('http-01'|'dns-01'), acme_staging (bool),
acme_cf_token_enc (encrypted), acme_account_key_enc (encrypted), acme_account_url,
acme_status ('idle'|'pending'|'ok'|'error'), acme_last_error, acme_last_attempt_at, acme_next_renew_at
updated_at
```

Private keys are never returned by any API.

## GET /api/tls

```json
{
  "mode": "none|external|selfsigned|acme",
  "trustProxy": boolean,
  "tlsPort": number,
  "bindHost": string,
  "sans": string[],
  "caFingerprint": string | null,            // sha256 hex of CA SPKI, self-signed only
  "certificate": { "subject": string, "sans": string[], "notBefore": number, "notAfter": number, "issuer": string } | null,
  "listener": { "running": boolean, "port": number | null, "error": string | null },
  "acme": { "email": string, "domain": string, "challenge": "http-01|dns-01", "staging": boolean, "status": "idle|pending|ok|error", "lastError": string | null, "lastAttemptAt": number | null, "nextRenewAt": number | null, "hasCloudflareToken": boolean } | null,
  "restartRequired": boolean                 // true after trustProxy change until restart
}
```

## PUT /api/tls

Body is one of:

```json
{ "mode": "none" }
{ "mode": "external", "trustProxy": boolean }
{ "mode": "selfsigned", "sans": string[], "tlsPort": number, "bindHost": string }
{ "mode": "acme", "domain": string, "email": string, "challenge": "http-01|dns-01", "cloudflareToken"?: string, "staging": boolean, "tlsPort": number, "bindHost": string }
```

Behaviour:
- `none`: stop https listener; keep stored material (so switching back is instant).
- `external`: stop https listener; `trustProxy` is persisted by writing `TMEX_TRUST_PROXY=true|false` to the env file (production `app.env`, otherwise `<NODE_ENV>.env.local`) → response `restartRequired: true`.
- `selfsigned`: ensure CA exists (create once, 10 years, EC P-256), issue leaf (398 days) for `sans` (each must be a valid hostname or IP; 1–20 entries), start/restart https listener. Synchronous; response = GET shape.
- `acme`: validate domain (hostname, no wildcard in v1), email; for `dns-01` a `cloudflareToken` is required unless one is already stored (`hasCloudflareToken`); persist config with `acme.status='pending'`, respond immediately (GET shape), run issuance in background; on success store cert, start listener, `status='ok'`, `nextRenewAt = notAfter − 30 d`; on failure `status='error'`, `lastError`. Renewal loop: check every 12 h; renew when `now ≥ nextRenewAt`; on failure retry with backoff (1 h, 2 h, 4 h … max 24 h).

Errors: `400 invalid_sans`, `400 invalid_domain`, `400 invalid_email`, `400 cloudflare_token_required`, `400 invalid_port`, `409 port_in_use` (listener failed to bind; mode still saved, `listener.error` set), `500 tls_failed`.

## POST /api/tls/renew

Self-signed: issue a new leaf now. ACME: trigger issuance/renewal now (async, like PUT). Response = GET shape. `409 not_applicable` for none/external.

## GET /api/tls/ca.crt

Public (no session required — joining nodes fetch it before they have a session; the CA certificate is not secret). Self-signed only: `200 application/x-x509-ca-cert`, body = CA PEM, `Content-Disposition: attachment; filename="tmex-ca.crt"`. Otherwise `404 no_ca`.

## HTTP-01 challenge serving

The plain listener (and https) must answer `GET /.well-known/acme-challenge/<token>` with the key authorization while a challenge is active (in-memory map), `404` otherwise. Must be registered before SPA fallback.

## Env keys

`TMEX_TLS_PORT` / `TMEX_TLS_BIND_HOST` are NOT used; port/host live in `tls_config`. `TMEX_TRUST_PROXY` stays an env key (existing config.ts reads it).

## Join-token v2 (batch 2 B3)

`<128-char base64url>` (v1) or `<128-char base64url>.<64 lowercase hex sha256 of CA SPKI>` (v2). Hub returns `ca_fingerprint` and `ca_cert_pem` in the enrollment-created response and in `GET /api/auth/mode` (`caFingerprint`) when mode=selfsigned. Joining node: if fingerprint present → fetch `GET <hubUrl>/api/tls/ca.crt` with `tls.rejectUnauthorized=false` ONLY for that single request, compute SPKI sha256, must equal the fingerprint, else `join_failed: ca_fingerprint_mismatch`; persist PEM in `peer_cache`-adjacent table `hub_trust` (`hub_url`, `ca_pem`, `fingerprint`); all later hub-client fetches and the uplink WebSocket use `tls: { ca: [pem] }` when the hub URL matches.
