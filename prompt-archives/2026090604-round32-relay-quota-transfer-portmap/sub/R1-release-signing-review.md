1. **P1 — Remote downgrade restores unsigned code execution**  
   [apps/gateway/src/system/release-signature.ts:75](/Users/konata/code/tmex-r32/apps/gateway/src/system/release-signature.ts:75)

   A compromised entry can send `POST /api/system/upgrade` with `{"version":"1.1.38","source":"release"}`. On a node that can reach GitHub, this downloads and installs the unsigned older release: the receiving controller neither rejects downgrades nor restricts the legacy exception to locally initiated operations. The attacker can then push arbitrary code through 1.1.38’s staging API. I checked the local `v1.1.38` tag: its staged apply path has no manifest requirement.

   **Fix:** Enforce the signing floor on the receiving node for remotely initiated upgrades, including `source: "release"`. Preserve unsigned historical releases only through an explicit trusted local operation. Add a regression test for this two-step downgrade attack.

2. **P2 — Expired-package cleanup deletes a newly accepted manifest**  
   [apps/gateway/src/system/upgrade.ts:550](/Users/konata/code/tmex-r32/apps/gateway/src/system/upgrade.ts:550)

   Suppose a completed staged package remains unapplied for more than 24 hours. Retrying that version first posts a fresh manifest successfully. The subsequent resume-status lookup—or `stagePackage()` repair—expires the old package record and unconditionally deletes the manifest at the same version-based path. The replacement upload can finish successfully, but applying it fails with `UPGRADE_SIGNATURE_REQUIRED`. The sender posts the manifest only once per job, so this attempt cannot recover automatically.

   **Fix:** Serialize expiry cleanup with manifest persistence, and await removal of expired artifacts before publishing the replacement manifest. Cleanup must distinguish the expired package’s manifest from a newly accepted one. Test retrying an expired completed package, including after controller restart.

3. **P2 — Manifest response bodies escape the timeout**  
   [apps/gateway/src/system/remote-upgrade-io.ts:85](/Users/konata/code/tmex-r32/apps/gateway/src/system/remote-upgrade-io.ts:85)

   `withTimeout()` covers only obtaining the `Response`. Once headers arrive, its timer is cleared, and `res.text()` waits without a deadline or size limit. A target or intermediary can return a response head and withhold the body’s completion, leaving the upgrade job permanently running and retaining its release-cache lease. Streaming an oversized body instead consumes unbounded memory. Error responses have the same problem through `describeUpstream()`, which truncates only after reading everything.

   **Fix:** Apply one deadline to the request and bounded body consumption, explicitly cancelling the response reader when the deadline or size limit is reached. Test headers followed by a stalled body and an oversized body.

4. **P2 — Quality: checksum parsing now has two competing implementations**  
   [packages/shared/src/release/release-signing.ts:136](/Users/konata/code/tmex-r32/packages/shared/src/release/release-signing.ts:136)

   The new parser duplicates `release/verify.ts`, while CLI checksum verification still uses the original implementation and gateway verification uses the new one. Their filename handling already differs: `node:path.basename()` ignores trailing separators, while `fileNameOf()` returns an empty name. Consequently, the same checksum text can produce different results between CLI and gateway.

   **Fix:** Extract one browser-safe checksum parser and use it from both verification paths, retaining thin adapters where their return types differ.

Validation: the signing and CLI verification suites passed—**30 tests, zero failures**. Filesystem-writing integration tests were not run under the read-only constraint.

**Verdict:** Request changes. The remotely accessible downgrade path defeats the new trust boundary on GitHub-connected nodes; manifest lifecycle and response handling also need correction.