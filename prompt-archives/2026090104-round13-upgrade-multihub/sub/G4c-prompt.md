# G4c — Debug + fix: 22 MB staged-package push over the relay path fails with NODE_UNREACHABLE (stream reset)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G4-result.md`, `sub/G4b-result.md` (what exists: `remote-upgrade-job.ts`, `release-download.ts`, `forwarder.ts` `rawBody` streaming, target `PUT /api/system/upgrade/package`).

## Field evidence (live three-instance test, production mode, today)

Entry A (`hub,node`, same process is the hub) pushed the real `tmex-cli-1.1.10.tgz` (22,359,746 bytes) to node C (attached to A over WS uplink; no native DataChannel; peer port reachable on 127.0.0.1). Result within 15 s:

```
POST /api/mesh/nodes/<C>/upgrade → 200 {"state":"downloading"}
GET  … +15s → {"state":"idle","error":"push failed: HTTP 503 NODE_UNREACHABLE"}
A server.log:  [mesh][mux] rst send stream=3 reason=relay-rst
               [mesh][mux] rst recv stream=3 reason=relay-rst
C server.log:  (nothing about the PUT; no staging dir created)
```

Download + cache worked (`A/staging/release-cache/tmex-cli-1.1.10.tgz` + `.sha256` present). The push used the **relay** path (A→hub(A, in-memory)→C uplink). `forwardAuthorizedHttp` caught an error during `openAuthorizedAttempt` and returned 503. The 3 MiB in-memory forwarder test from G4/G4b passes, so the failure is size/path specific: suspects — link flow control (1 MiB window, 1 MiB max frame) not being honoured by the raw-body pump on the relay path (`SecureChannelLink` over `relay` stream: the hub's `pumpRelay`/`pumpLink` copying and `WINDOW` credits, `UPLINK_CTL`/stream buffer caps like the 32 MiB unacknowledged-buffer limit that tears the link down, `hub-level relay per-stream limits`), the target reading the request body slower than frames arrive, or `content-length` vs actual length mismatch, or an abort from the detached request's timeout.

## Task

1. Reproduce deterministically in-process: add `apps/gateway/src/mesh/integration/large-push.integration.test.ts` (plain `bun test`) using the existing harness pieces (`multi-hub-harness.ts` shows how to boot hub A + nodes attached over the fake WS factory; `/n/<D>/api/system/info` from C via relay works there) — push a 24 MiB random body through `forwardAuthorizedHttp({ rawBody })` to a target route that counts bytes (or the real `PUT /api/system/upgrade/package` with a fake canSelfUpdate) over (a) the relay path and (b) the ws-secure direct peer path. Assert full delivery and the response status. Make the test fail first with the current code.
2. Find the root cause (add temporary diagnostics if needed, remove them after) and fix it in the owning layer: `packages/shared/src/link/**` (flow control / pump), `apps/gateway/src/hub/uplink-server.ts` relay pump, `apps/gateway/src/mesh/stream-targets.ts` / `forwarder.ts` body pump, or `remote-upgrade-job.ts`. Keep the fix minimal and covered by the new test; do not lower safety caps blindly — if a cap is the cause, justify the new value in the result.
3. Also make the failure diagnosable: when the forwarder falls into `NODE_UNREACHABLE` for a raw-body push, log one line at warn level with the underlying error message and the byte offset reached (`[mesh][forward] raw-body push aborted node=… bytes=… err=…`), and include the underlying reason in the remote-upgrade job error text.

## Files you own

- new `apps/gateway/src/mesh/integration/large-push.integration.test.ts` (+ optional helper file `large-push-harness.ts`; do NOT edit `multi-hub-harness.ts` / `multi-hub.integration.test.ts` — another agent is editing them)
- `apps/gateway/src/mesh/forwarder.ts` (+test), `apps/gateway/src/mesh/stream-targets.ts` (+test), `apps/gateway/src/system/remote-upgrade-job.ts` (+test), `apps/gateway/src/system/upgrade.ts` (+test) if the target-side reader is at fault
- `packages/shared/src/link/**` (+tests) if the link layer is at fault
- `apps/gateway/src/hub/uplink-server.ts` ONLY the relay pump functions (`pumpRelay`/`pumpLink` and friends) + a focused test, if the hub relay is at fault

Do NOT touch `mesh-runtime.ts`, `uplink-pool.ts`, `uplink-client.ts`, `apps/fe/**`, `packages/app/**`.

## Verification

`cd apps/gateway && bun test src/mesh src/system src/hub && bunx tsc --noEmit -p .` (0 fail / 0 tsc), `cd packages/shared && bun test && bunx tsc --noEmit -p .` if touched, biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G4c-result.md` — root cause with file:line, the fix, test evidence (both paths, byte counts, duration), and anything the commander should re-verify live. Write it, then exit.
