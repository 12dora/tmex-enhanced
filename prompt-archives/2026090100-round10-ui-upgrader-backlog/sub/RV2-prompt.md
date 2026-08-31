# RV2: Code review — mesh remote node upgrade backend (branch feat/round10-ui-node-upgrade)

You are a code reviewer with read-only access to the worktree at /Users/konata/code/tmex-enhanced-wt-r10. Review the diff at `prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/review-r10-backend.diff` (gateway: new `/api/mesh/upgrade/latest`, `POST|GET /api/mesh/nodes/:id/upgrade`, authorized peer-link forwarding, upgrade-service extraction from update-check/system). Read surrounding code as needed. Design doc: `prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/EX2-result.md`; implementer report: `C2-result.md`. Output your FULL report as your final message.

Review focus:
1. **Security**: all three routes require the local user session; the forwarded request carries only the target-node session cookie; nothing lands in `/api/mesh-internal/*`; no way to trigger upgrade of an arbitrary/revoked node or inject an arbitrary version from the client (POST body is empty; server resolves latest).
2. **Correctness**: error-code mapping (401/403/404/409/502/503) vs the forwarder's behaviors; POST must never auto-retry (double-upgrade risk); GET retry safety; local-node path parity with `/api/system/upgrade` (409 on concurrent, 403 canSelfUpdate); already-latest comparison robustness (unparseable versions must not be treated as latest).
3. **Refactor safety**: `apps/gateway/src/api/system.ts` and `update-check.ts` extraction — is the external behavior of `/api/system/upgrade` and `/api/system/update-check` unchanged?
4. **Resource handling** in `forwardAuthorizedHttp` (stream bodies, abort signals, backoff loop).

Classify Blocker / Should-fix / Nit with file:line and concrete failure scenarios for blockers. No padding.
