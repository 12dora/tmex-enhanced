Found three defects.

1. **[P1] Cache eviction can delete packages still required by running upgrades** — [release-download.ts:122](/Users/konata/code/tmex-r30/apps/gateway/src/system/release-download.ts:122)

   A remote job downloads version A, then waits for the target’s staged-offset response or backs off between upload attempts. After the latest-release cache expires, another node’s upgrade resolves version B and sweeps with `keepVersions: [B]`, deleting A’s tarball. `remote-upgrade-job.ts:481` subsequently reopens A’s path; `fileReadableStream()` calls `statSync()` and fails with `ENOENT`. Retries reuse that missing path without downloading again.

   An already-open stream may finish successfully, but a subsequent resume attempt fails. The detached startup sweep can also overlap newly accepted upgrade requests because runtime creation does not await it.

   **Fix:** Acquire a per-version lease before downloading or reading the cache, retain it through all push attempts—or local extraction—and release it in `finally`. Serialize eviction against lease acquisition and preserve leased versions regardless of `keepVersions`. Await startup cleanup before accepting upgrade requests.

2. **[P2] A stale directory snapshot can delete a completed package even when its version is retained** — [release-download.ts:124](/Users/konata/code/tmex-r30/apps/gateway/src/system/release-download.ts:124)

   `ctx.present` captures the directory once. Suppose enumeration occurs after a downloader renames `.part` to `.tgz`, but before it writes `.sha256`. While the sweep awaits deletion of an earlier entry, the downloader writes the sidecar, resolves its consumers, and leaves the in-flight map. When the sweep reaches this tarball, the old snapshot says its sidecar is missing and the current in-flight check returns false. It deletes the successfully completed package despite `keepVersions` containing that version.

   This can occur during another same-version upgrade’s cleanup; a different release is unnecessary.

   **Fix:** Revalidate orphan status against the current filesystem under synchronization shared with download publication and eviction. Add a regression test that pauses cleanup after enumeration, completes the download, then verifies both files survive.

3. **[P2] The verification memo accepts changed contents as checksum-verified** — [release-download.ts:445](/Users/konata/code/tmex-r30/apps/gateway/src/system/release-download.ts:445)

   The new test demonstrates the failure directly: verify a file, overwrite it with different equal-length bytes, restore its mtime, and call `downloadVerifiedRelease()` again. The function returns the original checksum without detecting the changed contents.

   Downstream, remote uploads send those bytes with the old checksum and fail the receiver’s integrity check; retries keep using the same corrupt package. Local release upgrades pass the returned path directly to extraction. Previously, rehashing detected the mismatch and entered the download path. The test currently requires the regression to persist.

   **Fix:** Rehash reused files unless their immutability is enforced. If retaining metadata-based memoization, include file identity and change metadata (`dev`, `ino`, `ctime`) and check stability across hashing. Replace the existing test assertion with mismatch detection and redownload expectations.

The 60-second latest-release delay is explicitly documented cache behavior, so I have not treated that alone as a defect. The new sweep does not directly touch detached-applier packages in `staging/staged` or CLI transactions in `staging/<txn>`; existing transaction-pruning behavior predates this diff.

Review was static; filesystem-writing tests were not run in the read-only sandbox.