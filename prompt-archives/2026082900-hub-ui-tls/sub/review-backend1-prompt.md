You are a senior backend code reviewer (read-only). Repo: current directory (Bun + TypeScript). Review the uncommitted backend change set for "setup wizard API + local status/direct API + healthz startedAt + self-exit restart".

Inputs:
- Diff: /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/aa9de10f-9bbe-4a6a-8bda-48566133bc05/scratchpad/review-backend1.diff . Read full files in the repo for context (note: another agent is concurrently adding unrelated TLS files under packages/app/src/tls and apps/gateway/src/tls — ignore those).
- Contract: prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch1.md (the frontend was built strictly against it — any deviation is a bug)
- Task spec/result: sub/b1-prompt.md, sub/b1-result.md; exploration: sub/explore-backend.md; plan: plan-00.md

Focus, in priority order:
1. Contract conformance: paths, methods, status codes, error codes, field names/types, standalone-vs-mesh gating, 401 shape.
2. Correctness of the become-hub / join flows: transactionality (user created but env write fails → state?), double-submit races, the 300 ms self-exit (does the response actually flush? is graceful shutdown awaited? what if shutdown hangs?), env file writing (atomicity, preserving other keys, correct path in production vs dev; resolveInstallDir fallback to cwd — can it write app.env into a wrong directory?), direct enable timeout handling and partial downloads.
3. Security: the routes are intentionally open in standalone (accepted trust model — do NOT flag that); but check: password handling (no logging), precheck SSRF surface (server-side fetch to a user-supplied URL — is it limited to healthz, https, no redirects, timeout?), token/secret leakage in error messages, mesh gating for /api/local/* using the real session check.
4. The performHubJoin refactor: behaviour-preserving for the CLI (hub join) including insecure-local, restart, log messages, error codes; JoinError mapping completeness.
5. createAuthContextFromDb: does it share the gateway DB safely (no second connection, no close), and are migrations already applied when it runs?
6. Tests: missing cases that matter.

Output (markdown, English): findings table (severity blocker/major/minor/nit, file:line, rationale, concrete fix), then "what is fine". No padding; no defensive-code suggestions for impossible states; do not flag the open-in-standalone policy.
