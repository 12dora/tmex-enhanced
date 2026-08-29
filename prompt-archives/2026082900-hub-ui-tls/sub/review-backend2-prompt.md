You are a senior backend/security code reviewer (read-only). Repo: current directory (Bun + TypeScript). Review the uncommitted change set for "built-in HTTPS (self-signed private CA + ACME) and join-token CA pinning" plus the setup-API review fixes.

Inputs:
- Diff: /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/aa9de10f-9bbe-4a6a-8bda-48566133bc05/scratchpad/review-backend2.diff (packages/app tls/runtime/commands/lib, apps/gateway, packages/shared auth, apps/fe/src/node, docs). Read full files in the repo for context.
- Contracts: prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch2.md (TLS + join v2), api-contract-batch1.md
- Task results: sub/b2-result.md, b2b-result.md, b3-result.md, b1-fix-result.md; prior review sub/review-backend1.md (already addressed — verify the fixes rather than re-raising)
- Plan: plan-00.md (verified facts: Bun.serve tls cannot hot-reload; Bun fetch/WebSocket accept tls.ca)

Focus, in priority order:
1. Security of the trust model: CA/leaf generation parameters (key usage, basic constraints, SAN classification, validity), private material encryption at rest and never leaving the process via API/logs; the single `rejectUnauthorized:false` fetch of `/api/tls/ca.crt` during join — is the fingerprint check binding (SPKI sha256 over the right DER), is the pin then applied to every later hub request in that join and to the uplink; can a MITM downgrade to v1 token or strip the pin; `hub_trust` keyed by URL — normalization pitfalls; ACME account key / Cloudflare token handling; http-01 responder path traversal / token validation; anything that lets an unauthenticated mesh caller change TLS config.
2. Correctness: HTTPS listener lifecycle (stop/recreate on cert change, bind failure → port_in_use, shutdown order), renewal scheduler timing/backoff and error state transitions, acme-client usage (order/authorization/finalize flow, staging vs production directory, CSR key), Cloudflare zone lookup and record cleanup, `mode=external` env write + restartRequired, migrations 0021/0022 consistency (schema, journal, managed list order).
3. Setup-API fixes: transition lock semantics, staged env rename, direct abort + staging-dir atomic swap (leftover cleanup, `rename` over existing dir on macOS/Linux).
4. CLI parity: `enroll` prints v2 tokens on a self-signed hub; `hub join` handles v1/v2; error messages actionable.
5. Tests: what matters and is missing (live ACME is intentionally not tested).

Output (markdown, English): findings table (severity blocker/major/minor/nit, file:line, rationale, concrete fix), then "what is fine". No padding; no defensive code for impossible states; do not flag the accepted open-in-standalone policy.
