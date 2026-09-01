# RV4 — Follow-up review of the fix rounds (hub allowlist/fencing, node-side failover fixes, WebSocketLink backpressure, staged-upgrade hardening)

You are a strict but pragmatic code reviewer with a security mindset. Read-only. Output the full review as your FINAL MESSAGE.

Repo: `/Users/konata/code/tmex-enhanced-wt-r13`. Diff under review: `sub/RV4-diff.patch` = commits `e6dd6b26` (G4b staged-upgrade hardening), `1dfb36d9` (G2b node-side fixes), `1c4eb655` (G3b allowlist + persisted fencing + standby key-log gate), `086c610b` (G2c diagnostics / early TLS fingerprint / standby auto-authorize), `4ced91b6` + `1437377b` (WebSocketLink server backpressure pacing). Your previous reviews and their outcomes: `sub/RV2-result.md` → `sub/G4b-result.md`; `sub/RV3-result.md` → `sub/G2b-result.md`, `sub/G3b-result.md`, `sub/G2c-result.md`. Link-layer root cause: `sub/G4c-result.md` (Bun `backpressureLimit` 1 MiB closes the socket) and the follow-up fix (proactive pause needs its own poll because Bun only fires `drain` after a `-1` send).

Focus:
1. Verify each RV2/RV3 blocker is actually closed (not just claimed): authorization of hub advertisements (any remaining path where an unauthorised node's data reaches `mesh_hubs`, `pickWriterHub`, fencing, CA bootstrap, `node.list.hubs[]`); persisted fencing at construction; `isWriter()` on every write surface incl. ctl paths; standby `key.log.append` identical-replay rule (hash comparison, seq handling); node-side `POST /api/auth/keylog` gate and its offline behaviour; staged PUT/POST mutex + atomic move; auth gating in open mode.
2. WebSocketLink server pacing: correctness of the pause/poll/drain interplay (double resume, timer leaks on close, `serverQueued` drift when `bufferedAmount` is absent, behaviour when a single frame > 1 MiB, interaction with `MAX_LINK_UNACKED`), and whether the same problem exists on other server-socket adapters (peer server `ws-secure`, mesh `/mesh/ws`, gateway sessions) that G4c did not touch.
3. Per-candidate transport: can a standby ever attach to itself while the active is reachable; can an active hub end up dialling another hub over WS (unexpected)? `attached` refresh, `syncProbe` after list, single-flight token.
4. New diagnostics: any secrets/URLs with credentials in logs? Log volume under flapping.
5. Anything in these diffs that would break a mixed-version mesh (1.1.10 hub/nodes + 1.1.11).

Classify as **blocker / should-fix / nit** with file:line and a concrete failing scenario; be concise; say briefly what is fine.
