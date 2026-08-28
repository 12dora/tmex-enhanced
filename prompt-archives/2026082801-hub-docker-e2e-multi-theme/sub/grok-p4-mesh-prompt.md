# Backend task (gateway mesh) — round 4: fix the 8 review findings on uplink-client / mesh-runtime / uplink-server

Worktree `/Users/konata/code/tmex-enhanced-wt-merge` (branch chore/merge-hub-tabs, HEAD 44138c7). Read `AGENTS.md`, the review `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/review-p1b.md` (8 findings, all accepted by the commander) and your own reports `sub/grok-p1b-mesh-result.md`, `sub/grok-p3-mesh-result.md`. You own `apps/gateway/**`. No git operations, no TODOs. Nobody else edits the gateway.

Implement all 8, each with a unit test that fails before and passes after:
1. Every key-log sync failure path (push NACK/timeout, applyMany error incl. invalid_signature, head not advancing, stalled) must NOT `finishNodeList()`; bounded retry then `tearDownLink`; `fork` → `failFork()`; after partial apply re-read head so the next connection resumes from the committed prefix.
2. Bind `authenticated` to the connection generation (`authenticatedGeneration === generation` when handling gated frames); clear all connection-level state on `connectWithLink`/reconnect.
3. Strict key-log response correlation: a request sent with an id accepts only a response with the identical id; responses without id are dropped when a request id is outstanding (log once).
4. Per-connection-generation node.list version watermark: reject a list with version lower than the highest accepted in this generation; reset on new generation.
5. Hub presence (`lastNodeList` online) only counts while `uplink.state === 'online'`; on uplink disconnect emit the corresponding offline state/NODE_EVENT so the UI does not show stale `online:true, reach:null`.
6. `resolveUserId`: explicit userId → self cert → exactly one distinct user across `users`/certs; if zero or ambiguous, do NOT start the uplink (log a clear error) instead of returning ''. Also make `hub join` semantics robust: if `node_identity` can carry the user id without a migration (check schema), persist it at redeem time — if that needs `packages/app` or a migration, describe precisely instead of doing it.
7. Hub `uplink-server` key.log.req: rate-limit per node (token bucket, e.g. 10/min burst 20) and rate-limit/aggregate the warn logging (suppressed count).
8. ctl warn logging: `type` only from the protocol enum else 'unknown'; map errors to fixed codes; strip control characters; never log payload fragments.

Verify: `bun test` in `apps/gateway` 0 fail (baseline 2248), tsc ≤ 21, biome clean; then ONE remote harness run: `bash /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-cycle.sh p4` must stay all-PASS (table printed; logs in `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p4/`). Report to `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/grok-p4-mesh-result.md`.
