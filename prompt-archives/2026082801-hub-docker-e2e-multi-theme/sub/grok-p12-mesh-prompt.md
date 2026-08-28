# Backend task — round 9 (small): fix the 1 finding of review-p11

Worktree `/Users/konata/code/tmex-enhanced-wt-merge` (branch chore/merge-hub-tabs, HEAD c526f41). Read `AGENTS.md` and `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/review-p11.md` (1 finding, P1). Scope: `apps/gateway/src/hub/**`, `apps/gateway/src/mesh/uplink-protocol.ts` (+ tests). No git operations, no TODOs.

Finding: the hub's inbound ctl decoder (`apps/gateway/src/hub/uplink-protocol.ts` ~L185) relaxed `key.log.res` to 1 MiB and skips the generic string/depth limits; the hub also decodes frames BEFORE checking authentication (`uplink-server.ts` ~L382/L525). An unauthenticated client can flood `/hub/uplink` with 1 MiB `{"t":"key.log.res","records":[]}` frames that are queued (holding raw bytes) and WINDOW is returned immediately.

Fix: (1) hub inbound never accepts `key.log.res` (it is a node-bound message) — reject by direction; (2) before `auth.ok`, the hub accepts only `auth.response` (and whatever the handshake needs), enforces the 64 KiB cap and the generic limits, and closes the link on anything else; (3) the 1 MiB allowance exists only on the NODE side for `key.log.res` when a matching pending request id exists; (4) bounded backpressure on the hub ctl processing queue (do not return WINDOW for frames not yet processed beyond a small cap; close on overflow). Tests: pre-auth 1 MiB frame is rejected/closes; pre-auth non-auth message closes; node side still accepts a 1 MiB key.log.res only with a pending id.

Verify: `bun test` in `apps/gateway` 0 fail (baseline 2304), tsc ≤ 21, biome clean. Do NOT run any harness (the commander runs it). Report to `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/grok-p12-mesh-result.md`.
