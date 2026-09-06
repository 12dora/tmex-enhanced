1. **P1 — Aborted streams leave global token requests queued.**  
   Location: [apps/gateway/src/relay/relay-bandwidth.ts:57](/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-bandwidth.ts:57)

   `close()` only releases a tenant reference. With another handle alive, the aborted handle’s pending requests remain in the shared stream. With `fairShare: false`, requests use the bucket’s default stream, which neither `close()` nor `clear()` cancels.

   The router immediately releases the aborted stream’s concurrency reservation, allowing repeated open/send/abort cycles to accumulate pending requests, suspended pumps, and retained payloads beyond `maxStreams`. Cancelled traffic also consumes bandwidth ahead of live traffic. A Bun reproduction retained all 100 cancelled requests; with fairness disabled, all remained pending after `clear()`.

   **Fix:** Give each queued request a handle-specific cancellation identity. Closing a handle must remove and reject its requests in either scheduling mode; `clear()` must cancel every queue. Reject subsequent `take()` calls on closed handles.

2. **P1 — Small frames bypass tenant-level fairness.**  
   Location: [apps/gateway/src/relay/relay-bandwidth.ts:56](/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-bandwidth.ts:56)

   Sharing one `RelayTokenStream` per tenant only groups large requests. `RelayTokenBucket.takeFor()` sends requests of at most 4 KiB into a bucket-wide bypass FIFO, outside the per-stream round-robin scheduler. A tenant can therefore obtain more bandwidth by opening more streams carrying small frames.

   With fairness enabled, a deterministic Bun reproduction using eight streams for tenant A and one for tenant B, all sending 4 KiB frames, measured an **8.18:1** bandwidth ratio.

   **Fix:** Make the global bucket schedule all traffic by tenant, including small frames. Keep interactive priority within each tenant’s allocation, or disable bypass scheduling specifically for the global bucket.

3. **P2 — The supplied diff does not connect file-limit enforcement to transfers.**  
   Location: [apps/gateway/src/files/transfer-limit.ts:33](/Users/konata/code/tmex-r32/apps/gateway/src/files/transfer-limit.ts:33)

   The diff defines `transferMaxBytesNow()` and registers its provider, but adds no production callers. The committed upload-init and download paths still check only `config.transferMaxBytes`. Consequently, a relay can advertise a 1 MiB file cap while an unmodified node accepts larger transfers permitted by its local configuration.

   The working directory contains separate uncommitted changes adding enforcement calls, but those changes are absent from `relay.diff`.

   **Fix:** Include the upload-init and download-size enforcement changes in the reviewed patch, applying the effective limit before transfer and during final size validation.

4. **P2 — Saving the forms silently changes existing limits.**  
   Locations: [apps/fe/src/pages/settings/relay/relay-forms.ts:55](/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/relay/relay-forms.ts:55), [relay-forms.ts:135](/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/relay/relay-forms.ts:135)

   Draft creation rounds byte values into whole MB or KB/s, and submission converts those rounded values back into bytes. Valid API values—and fractional bandwidth values accepted by the CLI—therefore change even when the operator edits an unrelated field.

   Verified examples: **512 B/s becomes 1,024 B/s**, and a **1,024-byte file cap becomes 1,048,576 bytes** after an unchanged form round trip.

   **Fix:** Preserve exact byte values for untouched fields, or support lossless decimal-unit input and conversion. Do not use rounded display formatters to initialize editable values.

5. **P2 — Enrollment uses a stale tenant cap after asynchronous password verification.**  
   Location: [apps/gateway/src/relay/relay-routes.ts:169](/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-routes.ts:169)

   `config` is loaded before awaiting `checkEnrollPassword()`. If an operator lowers or enables `maxTenants` during that await, pending enrollments continue using the previous cap. An enrollment started while unlimited can create another tenant after the relay becomes full. A controlled reproduction returned 200 and increased the tenant count to two after the active cap became one.

   **Fix:** Read the current tenant cap after password verification, immediately before the synchronous count/check/create sequence.

6. **P2 — Missing CLI flag values are silently ignored.**  
   Location: [packages/app/src/commands/relay-admin.ts:343](/Users/konata/code/tmex-r32/packages/app/src/commands/relay-admin.ts:343)

   Bare flags become boolean `true`, which `asString()` discards; empty strings are also skipped. Thus `relay limits --max-tenants` succeeds as a read operation. `relay limits --max-tenants --fair-share off` applies only the fairness change and reports success, leaving the requested tenant cap unset. The new `--max-file-mb` handling has the same issue when combined with another valid quota flag.

   **Fix:** Distinguish absent flags from supplied flags with missing or empty values. Reject malformed supplied values before fetching status or performing any mutation.

**Verdict:** Request changes. The cancellation leak and fairness bypass undermine the global limiter’s resource-control guarantees. The 83 focused existing tests pass, but the targeted reproductions above expose uncovered failures.