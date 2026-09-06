1. **P1 — Short writes silently corrupt completed uploads.**  
   **Location:** `packages/transfer/src/node/sink.ts:226`  
   `FileHandle.write()` can write fewer bytes than requested, but the sink advances its cursor and received-byte tally by the entire chunk length. Preallocation masks the missing bytes, and browser uploads have no digest to detect them. In an in-memory filesystem reproduction, writing `[1,2,3,4]` with a two-byte disk write produced `complete: true` and committed `[1,2,0,0]`.  
   **Fix:** Loop until every byte is written, advancing by `bytesWritten`; treat zero progress as an I/O failure. Apply this to both write modes and update hashes/tallies only for bytes actually written.

2. **P1 — Overlapping PUTs can corrupt acknowledged data and mutate a committed file.**  
   **Locations:** `packages/transfer/src/node/sink.ts:219`, `apps/gateway/src/files/transfer-session.ts:185`  
   Only bitmap updates are locked. A PUT overlapping an acknowledged range can overwrite its prefix and then fail with `too_large`, while the bitmap still marks the original range valid. Completing the remaining range then commits corrupted bytes without a digest check. An overlapping writer can also remain open while another PUT triggers commit; its file descriptor continues modifying the renamed file, potentially during rsync. Both cases reproduced in the in-memory harness. `commitOnce` prevents duplicate renames but does not exclude active writers.  
   **Fix:** Reserve active ranges, reject conflicting overlaps, and make acknowledged ranges immutable or verify duplicate content before accepting it. Finalization must exclude active writers and seal the session against further writes.

3. **P1 — Commit deletes the valid destination before knowing replacement can succeed.**  
   **Location:** `packages/transfer/src/node/sink.ts:277`  
   Removing `destPath` before `rename()` introduces a destructive gap. A missing `.part`, cancellation race, or overlapping commit can delete the existing file and then fail. In particular, two receiver commit requests can pass their initial checks; the second can remove the first request’s successfully committed destination before its own rename fails. Repeating commit reproduced destination deletion.  
   **Fix:** Rename directly over the destination on the supported Unix platforms. Serialize finalization per descriptor and make repeated commits idempotent.

4. **P2 — Bitmap persistence failures are acknowledged as successful uploads.**  
   **Location:** `packages/transfer/src/node/sink-state.ts:102`  
   `writeReceivedRanges()` suppresses write failures, and `recordReceivedRange()` returns the unpersisted bitmap as though it succeeded. A transient sidecar failure therefore produces successful PUT responses while a later update loses the earlier range. The browser driver treats all successful PUTs as completion, then fails at commit instead of retrying the missing bytes. This reproduced with a simulated sidecar `ENOSPC`. In-place sidecar replacement also exposes truncated JSON to concurrent status reads.  
   **Fix:** Propagate persistence failures as retryable I/O errors. Publish the bitmap atomically, with data flushed before durable metadata publication when crash recovery is required.

5. **P2 — Download cleanup makes the new resume path fail with 404.**  
   **Locations:** `apps/gateway/src/api/file-transfer-routes.ts:212`, `apps/gateway/src/api/file-http.ts:117`  
   `atEof` describes the requested range, not successful delivery. Both the initial full download and an open-ended resume request set it to true. Cancelling either response deletes the session and temporary file immediately, so the client’s subsequent Range request receives 404. Reading the source to EOF also does not establish that the client received all buffered bytes.  
   **Fix:** Retain resumable download sessions until explicit client cleanup or TTL expiry. Have the client delete the session after successfully receiving and validating the complete body.

6. **P2 — Cancelling an upload does not cancel its active body readers.**  
   **Location:** `apps/gateway/src/files/transfer-session.ts:173`  
   `writeUploadRange()` supplies neither the session abort signal nor a `registerCancel` callback to the sink. DELETE and GC remove the session and unlink its directory, but an active PUT can keep reading and writing its open, unlinked file. A slow sender can retain file descriptors and disk allocations after cancellation; the session-existence check runs only after the body finishes.  
   **Fix:** Connect session cancellation to every active sink write, including writes still opening their files. Cancel readers and close handles before considering cleanup complete. Also cancel the body when `pumpBody()` exits early on overflow or a write failure.

7. **P2 — Omitting length metadata bypasses the upload chunk limit.**  
   **Location:** `apps/gateway/src/api/file-transfer-routes.ts:103`  
   The 8 MiB cap is now enforced only when `length` or `Content-Length` is present. A chunked request omitting both reaches the sink without `maxWriteBytes`, allowing one PUT to consume the entire remaining file allowance. The previous implementation enforced the cap independently of client metadata.  
   **Fix:** Always pass `maxWriteBytes: Math.min(UPLOAD_CHUNK_SIZE, session.size - offset)` through to the sink, regardless of declared length.

8. **P2 — The browser upload deadline does not bound active requests.**  
   **Locations:** `packages/api-client/src/upload-transfer.ts:69`, `packages/transfer/src/push-driver.ts:101`  
   The transport ignores `PushPutOptions.deadlineMs` and uses only the caller’s signal. The driver checks time between attempts but waits indefinitely for status and PUT promises. A stalled response can therefore exceed the six-hour upload deadline and prevent retries or completion of the parallel worker pool.  
   **Fix:** Enforce the remaining deadline with a derived abort signal covering status queries, PUTs, and response-body consumption. Make the transport use that signal and abort remaining workers when the attempt terminates.

9. **P2 — Download connection failures bypass the retry loop.**  
   **Location:** `packages/api-client/src/download-transfer.ts:127`  
   `client.fetch()` executes outside the retry `try/catch`. A connection reset before response headers—or while opening a subsequent Range request—immediately escapes to outer cleanup and deletes the session, even when attempts remain. Only failures encountered while reading an established response are retried.  
   **Fix:** Include request establishment in the attempt’s retry handling, preserving accumulated bytes across retryable network failures and still terminating immediately on user cancellation or permanent HTTP errors.

Meaningful quality issues:

10. **P2 — The local-download optimization is dead code.**  
    **Location:** `apps/gateway/src/files/device-storage.ts:151`  
    `localFileForDownload()` has no callers. `pullFileFromDevice()` still takes every local download through rsync, despite the new helper’s stated purpose. The accompanying `device` addition to the callback context is unused as well.  
    **Fix:** Remove the unused helper and context expansion, or integrate the optimization with explicit handling of source-file changes during resumed downloads.

11. **P2 — Retry policy still has two authoritative definitions.**  
    **Location:** `apps/gateway/src/system/remote-upgrade-job.ts:24`  
    The upgrade job retains copies of `PUSH_RETRY_BACKOFF_MS` and `PUSH_MAX_ATTEMPTS` and explicitly passes them to the driver, which now exports identical constants. Future engine policy changes will therefore leave upgrade behavior on the duplicate values.  
    **Fix:** Import and, if necessary, re-export the engine constants. Keep only the genuinely upgrade-specific legacy limit locally.

**Verdict:** Request changes. The shared sink has reproducible silent-corruption and destination-deletion failures, and the advertised resume behavior is undermined by cleanup and retry handling. Resolve those before enabling parallel ranged transfers.