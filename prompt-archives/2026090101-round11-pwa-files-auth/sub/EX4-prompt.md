# EX4 — Security review of password login exposed to the public internet

The gateway can be exposed on the public internet (via Cloudflare Tunnel or a direct port) with username/password login enabled. The user wants a **pragmatic** assessment: what is the real exposure, and what (if anything) is worth changing. **Explicitly avoid over-defence** — the user has been burned by suggestions that add friction without meaningful security gain. Rank findings by realistic risk and cost; say clearly when something is fine as-is.

Map the current implementation first (`apps/gateway/src/auth`, `apps/gateway/src/api` auth/session routes, `packages/shared/src/auth`, `apps/fe/src/auth`, `apps/gateway/src/tls`, `apps/gateway/src/tunnel`, `docs/hub`, `docs/onboarding`, `docs/operations`):

1. **Credential storage & verification**: password hashing algorithm and parameters (argon2/bcrypt/scrypt? via Bun.password?), constant-time comparison, where users are created (onboarding), whether a default/empty password state can exist, and whether password login can be enabled while no password is set.
2. **Login endpoint hardening**: rate limiting / lockout / backoff (per IP? per account? global?), whether it works behind Cloudflare Tunnel (X-Forwarded-For / CF-Connecting-IP handling — does the limiter key on the tunnel's IP and therefore lock everyone?), response timing differences between "no such user" and "wrong password", audit logging.
3. **Session mechanics**: session token format (opaque random vs JWT), entropy, storage (cookie flags: `HttpOnly`, `Secure`, `SameSite`; or `localStorage` bearer), lifetime, rotation on login, server-side revocation/logout-all, whether the WS upgrade authenticates with the same session and how (query param `?token=` in URL → appears in logs), and whether the session survives password change.
4. **CSRF / origin checks**: state-changing REST and the WS upgrade — `Origin` validation, SameSite reliance, CORS config (`Access-Control-Allow-Origin: *`?).
5. **Other public-facing surfaces when password login is on**: passkey/WebAuthn (relying-party ID/origin binding when accessed via multiple hostnames), OTP / device enrollment endpoints, mesh peer endpoints (`TMEX_PEER_PORT` 39001 — is it authenticated by node certificates independent of the password?), `/healthz` info disclosure (version), file APIs (path traversal guards, root confinement), upload/download, agent endpoints, `/api/system/upgrade` (who can trigger it), Telegram/WeChat webhooks, static asset serving.
6. **Transport**: HTTP vs HTTPS when not behind the tunnel (`TMEX_BIND_HOST`, self-signed TLS support), HSTS, and whether cookies are marked `Secure` only when TLS is present.
7. **Brute-force realism**: given the hashing cost and any limiter, estimate the practical online guessing rate an attacker gets against a public endpoint, and whether the current password policy (min length? complexity?) makes that matter.

Deliverable:
- A table of findings: `severity (High/Med/Low/Info) | finding | evidence path:line | realistic attack scenario | recommended action (or "leave as-is") | effort (S/M/L)`.
- A short "recommended minimal set" — the 0–4 changes you would actually ship — and a list of things you deliberately recommend NOT doing (with reason), so the commander can resist over-defence.
- Note anything that would interact with a planned feature: automatic cross-node login using the local session (another explorer, EX5, is designing it) — e.g. whether the session token/cookie scoping would allow a token minted for node A to be replayed on node B.
