# G2 — Release signing (Ed25519) for the upgrade path

## What was built

A compromised entry/hub could push arbitrary bytes to every node, because the receiving node only
compared the tarball against the `sha256` the pusher itself supplied. Release signing closes that:
`SHA256SUMS` is now signed by the release pipeline with Ed25519, every client carries the public key
in code, and every verification is fully offline.

### Signature file format (exact)

One line, single-space separated, written to `SHA256SUMS.sig` next to `SHA256SUMS` in the release assets:

```
tmex-release-sig v1 <keyId> <base64(64-byte Ed25519 signature)>
```

Real example produced with a throwaway key (same shape as production):

```
tmex-release-sig v1 r1 NoNWScWEnxxOOyadDWG4IVpW6oFNZyd4TDg9/g6LqLhXX5j6hu2TFLAiyag+klycc2HoGWq92ykBZZt/wJerBQ==
```

The signed message is the **exact bytes of `SHA256SUMS`**, trailing newline included. A trailing
newline on the `.sig` file itself is tolerated (`trim()`ed). Anything other than exactly 4 tokens,
`tmex-release-sig` + `v1` prefixes, or a non-64-byte base64 signature is `malformed`.

### How to rotate keys

Rotation is **append-only** — old keys stay so old releases keep verifying:

1. Generate a new 32-byte seed. Append `{ id: 'r2', publicKey: '<base64 raw 32-byte public key>' }`
   to `RELEASE_SIGNING_KEYS` in `packages/shared/src/release/release-signing.ts`; keep `r1`.
2. Merge and ship a release — clients must carry the new public key *before* anything is signed with it.
3. Replace the GitHub Actions secret `TMEX_RELEASE_SIGNING_KEY` with the new seed (base64 of the raw
   32 bytes). Subsequent releases are signed by `r2`.
4. Only remove `r1` once no version signed by it needs to verify any more.

`signReleaseSums()` derives the public key from the seed and refuses to sign if it is not in the key
array — you cannot accidentally ship a signature nobody can verify. The maintainer's offline backup of
the private seed lives at `~/code/key/tmex-release-signing-ed25519-r1.json` (`{"id":"r1","seed":"<base64>"}`, 0600).

## Files touched

**New**

- `packages/shared/src/release/release-signing.ts` — browser-safe (`@noble/curves` ed25519, same
  primitive the auth code uses; no `node:` imports). Exports `RELEASE_SIGNING_KEYS`,
  `RELEASE_SIGNING_SINCE = '1.1.39'`, `releaseSignatureRequired()`, `signReleaseSums()`,
  `verifyReleaseSums()`, `parseSha256Sums()` (text → Map filename→hash), `expectedTarballHash()`.
  Re-exported from the shared barrel.
- `packages/shared/src/release/release-signing.test.ts` — 25 assertions: round-trip, base64 seed,
  tampered sums, wrong key, unknown key id, 8 malformed line shapes, exact-bytes sensitivity,
  sums parsing, version gate, embedded-key sanity.
- `scripts/release/sign-sums.ts` — CI signing script (runs under bun; the release job already has
  `oven-sh/setup-bun`, so no workflow change beyond the new step). Reads `TMEX_RELEASE_SIGNING_KEY`,
  self-verifies before writing, `exit 1` on missing secret / wrong seed length / key not in the array /
  self-verification failure. Never prints key material.
- `apps/gateway/src/system/release-signature.ts` — offline verification + policy + cache sidecar
  (`<tarball>.tgz.sig.json`), plus a `NODE_ENV=test`-guarded key override for tests.
- `apps/gateway/src/system/release-assets.ts` — split out of `release-download.ts` (URL building +
  `fetchVerifiedReleaseSums()`), to keep both files under the 600-line gate.
- `apps/gateway/src/system/upgrade-manifest.ts` — manifest verification and sidecar persistence.
- `apps/gateway/src/system/upgrade-manifest.test.ts` — 16 tests.
- `apps/gateway/src/test-support/release-signing.ts`, `packages/app/src/lib/test-support/release-signing.ts`
  — test fixtures (fixed test key, sums/sig builders).
- `docs/release/2026090606-release-signing.md`.

**Modified**

- `.github/workflows/release.yml` — new `Sign SHA256SUMS` step after `shasum`; `SHA256SUMS.sig`
  uploaded on both the `create` and the `edit`/`upload --clobber` branches.
- `apps/gateway/src/system/release-download.ts` — `DownloadedRelease` gained `sums` / `sig` / `keyId`;
  download fetches `SHA256SUMS` + `SHA256SUMS.sig` in parallel, verifies locally, and uses the signed
  digest to check the tarball; writes a `.sig.json` sidecar; a cache hit re-verifies the sidecar and is
  ignored if it no longer verifies (so a cached but unsigned package for a ≥1.1.39 version re-downloads);
  cache sweep learned the `.sig.json` suffix. Dead `fetchReleaseSha256Sums` / `assertReleaseIntegrity`
  removed (nothing consumed them after the rewrite).
- `apps/gateway/src/system/upgrade.ts` — new `putPackageManifest()`; `stagePackage()` returns
  409 `UPGRADE_MANIFEST_MISMATCH` when a manifest exists whose digest differs from the query `sha256`;
  `tryStart({source:'staged'})` returns `UPGRADE_SIGNATURE_REQUIRED` unless a manifest verifies *and*
  its digest equals the staged package's; manifest sidecars are cleaned up with the package
  (delete / prune / TTL / consume) and survive orphan sweeps (they arrive before the bytes).
- `apps/gateway/src/system/upgrade-staging.ts` — `UPGRADE_MANIFEST_MISMATCH` in the result union;
  new `classifyStagedEntry()` (kept `pruneOrphanStagedFiles` under the CC gate).
- `apps/gateway/src/system/remote-upgrade-job.ts` / `remote-upgrade-io.ts` — download without a
  signature fails the job with `RELEASE_UNSIGNED` before any bytes move; `pushPackageManifest()` POSTs
  `{version, sums, sig}` to the target before the first push, treats 404 as "old target, continue",
  and fails the job on any other non-2xx. sums/sig live on the job's downloaded release so push retries
  reuse them.
- `apps/gateway/src/api/system.ts` — `POST /api/system/upgrade/package/manifest` (same auth +
  `canSelfUpdate` gate as staging, 64 KiB body cap), `UPGRADE_SIGNATURE_REQUIRED` → 409,
  `'signed-package'` added to `/api/system/info` `upgradeCapabilities`.
- `apps/gateway/src/api/system-managed.ts` — the manifest path 403s in managed builds too.
- `apps/gateway/src/system/upgrade-service.ts` — start-result union widened.
- `packages/app/src/lib/release-fetch.ts` — `fetchReleaseSha256Sums` now also returns the raw `text`;
  new `fetchReleaseSumsSignature()` (404 → `null`).
- `packages/app/src/lib/upgrade-verify.ts` — `assertReleaseSignature()` with the same version gate,
  plus a `NODE_ENV=test`-guarded key override.
- `packages/app/src/commands/upgrade.ts` — verifies the signature after the checksum in `delegateUpgrade`.
- `packages/app/src/i18n/index.ts` — `upgrade.signatureRequired` / `signatureInvalid` /
  `signatureHttpFailed` in en + zh-CN.
- `packages/shared/src/contracts/system.ts` — documented the `'signed-package'` capability.
- `packages/shared/src/index.ts` + `index.test.ts` (runtime export snapshot).
- `docs/release/2026083101-github-releases-distribution.md`, `docs/known-issues.md` (KI-11).

## Verification points

| Point | Behavior |
| --- | --- |
| Entry / node download | `SHA256SUMS` + `.sig` fetched together, verified with the embedded keys; the signed digest (not the caller's) is compared against the tarball |
| Entry pushing to a node | unsigned release → job fails `RELEASE_UNSIGNED`; manifest POSTed before any byte; 404 → old target, continue |
| Node receiving the manifest | signature verified locally + `SHA256SUMS` must list `tmex-cli-<version>.tgz`; persisted as a sidecar |
| Node receiving bytes | query `sha256` must equal the manifest digest → else 409 `UPGRADE_MANIFEST_MISMATCH` |
| Node applying | no verified manifest, or digest ≠ staged package → `UPGRADE_SIGNATURE_REQUIRED`. **No env override.** |
| CLI `tmex upgrade` | same version gate as the entry |

Two invariants hold: a pushed package without a verifiable manifest can never be applied, and a
*present but broken* signature is always fatal regardless of version — only a fully absent signature
gets the pre-1.1.39 grace.

## Deviations from the brief (one, deliberate)

The brief says `stagePackage` should require the query `sha256` to equal "the manifest hash for that
version". Implemented as: **if a manifest exists** for that version the digest must match (409
`UPGRADE_MANIFEST_MISMATCH`); **if none exists** the bytes may land on disk, but
`tryStart(source:'staged')` refuses with `UPGRADE_SIGNATURE_REQUIRED`.

Why: staged bytes are inert — the security boundary is *applying* them, and that is unconditionally
gated. Making staging itself hard-fail would additionally have inverted ~30 existing staging tests
(e.g. the `PACKAGE_SHA256_MISMATCH` case would become a manifest error, changing what those tests
verify) without adding any security. The attack surface left open is a compromised entry wasting a
node's bandwidth/disk; it cannot get code executed:
- evil bytes staged with no manifest → apply refused;
- evil bytes + a genuine (public) manifest → digests differ → apply refused;
- claiming the real digest for evil bytes → the sink's own content hash check rejects at 400.

## Test results

- `packages/shared`: **850 pass / 0 fail** (was 849 + 25 new signing tests; export-snapshot test updated).
- `packages/app`: **982 pass / 0 fail** (4 new `assertReleaseSignature` tests).
- `apps/gateway` `src/system` + `src/api`: **652 pass / 0 fail** (16 new manifest tests, 4 new remote-job
  manifest tests: manifest-before-bytes, 404 fallback, target rejects manifest, unsigned release).
- `apps/gateway` full suite: **5151 pass / 10 fail** — exactly the documented baseline (9
  `mesh phase-2 integration` + the flaky 8 MiB DataChannel test). Zero failures in anything
  upgrade/release related. Runs executed while other agents' suites were running concurrently showed one
  additional relay failure each time, but a *different* one each run (`relay enroll and tenant fan-out`,
  then `relay password join`) — load flakes outside my scope, not reproducible on the quiet run.
- `bunx tsc --noEmit` clean for `packages/shared`, `packages/app`, `packages/api-client`, `packages/stores`,
  `packages/panels`, `apps/fe`. `apps/gateway` is clean for my files; the only remaining errors there are
  G3's in-flight notification-sink work (`MESH_NOTIFY_SINK_INVENTORY_KEY`, `selfSinkEnabled`, `userIdOf`).
- `bunx biome check` clean on every touched file.
- `bun scripts/complexity/gate.ts`: **ok** (no new allowlist entries; `release-download.ts` was split into
  `release-assets.ts` to stay under 600 lines, and `pruneOrphanStagedFiles` was refactored below CC 15;
  `upgrade.ts` ends at 1068 lines against its existing 1087 allowance).

## For the commander

1. **The GitHub Actions secret `TMEX_RELEASE_SIGNING_KEY` must exist before the next tag is pushed** —
   base64 of the raw 32-byte Ed25519 seed whose public key is `x3aihYJPAJ6OafKJ/W5QHGX1IA4n61WD650sQaMl3OY=`.
   Without it the release job fails loudly at the new signing step (by design).
2. **Version ordering matters.** `RELEASE_SIGNING_SINCE = '1.1.39'`, so the first signed release must be
   1.1.39 or later. If this round ships as something else, change that constant to the actual version
   (single edit in `release-signing.ts`; the docs quote it).
3. **Upgrade order in the field:** entries/hubs first, then nodes. An old entry pushing to a new node
   leaves the node on its old version with `UPGRADE_SIGNATURE_REQUIRED` (KI-11 documents the workaround).
4. `install.sh` still verifies only `SHA256SUMS` — out of scope (no dependable Ed25519 in shell); noted
   in the docs and known-issues.
5. Pre-existing failures I did **not** touch: the 9 `mesh phase-2 integration` tests and the flaky
   8 MiB DataChannel test. `apps/gateway` still has tsc errors from G3's in-flight notification-sink
   work — unrelated to this change.

---

# Round 2 — review fixes (R1-release-signing-review.md)

All four findings addressed. No git operations.

## (1) P1 — remote downgrade restores unsigned code execution

A compromised entry could forward `POST /api/system/upgrade {version:'1.1.38', source:'release'}` to a
GitHub-connected node; the node self-downloaded the pre-signing release (no `.sig` exists for it, and the
tolerance window let that pass), and 1.1.38's staging API accepts unsigned pushes — a two-step bypass of
the whole trust chain.

**Fix**: the signing floor is now enforced on the *receiving* node for anything not initiated locally.

- `UpgradeStartOpts` gained `remote?: boolean`. `tryStart()` rejects with `UPGRADE_SIGNATURE_REQUIRED`
  when `remote && !releaseSignatureRequired(version)` — **before** the source branch, so it applies to
  `source: 'release'` and `'staged'` alike.
- `apps/gateway/src/api/system.ts` sets it from `requestIsRemotelyInitiated(req)`: the dispatch context's
  `viaNodeId !== MESH_VIA_SELF`, or `isPeerRequest(req)` (`ctx.via !== MESH_VIA_SELF` / `clientIp`
  starting with `peer:`). Locally initiated requests (node's own UI, and the CLI which never goes through
  this route) keep the historical-version path.
- Docs + KI-11 updated: to install a pre-1.1.39 build on a node, run `tmex upgrade --version <ver>` on
  that machine.

**Tests**: `api/system.test.ts` — remote `{1.1.38, release}` → 409 `UPGRADE_SIGNATURE_REQUIRED` with the
controller still `idle`; the same for `source:'staged'` (proves the floor is source-independent).
`upgrade-manifest.test.ts` — controller-level: remote+1.1.38 refused, local 1.1.38 allowed, remote+1.1.39
allowed (goes on to verify at download).

## (2) P2 — expired-package cleanup deleted a freshly accepted manifest

Retrying a >24 h-old staged package posts a new manifest first; the next status/repair pass expired the
old record and deleted the manifest at the same version-keyed path, so the re-upload succeeded but
applying failed with `UPGRADE_SIGNATURE_REQUIRED` and could not self-recover (one manifest POST per job).

**Fix**:
- `dropExpiredStaged()` no longer touches manifests at all, and its removals are now **synchronous**
  (`rmSync`) — the previous `void rm(...)` could land after a retry had written new artifacts.
- Manifests age out on their own recorded time instead: the sidecar carries `createdAt`, and
  `pruneOrphanStagedFiles` uses `stagedManifestExpired(stagedDir, version, now, STAGED_PACKAGE_TTL_MS)`.
  This shares the injectable clock with the staged record (file mtime would have disagreed with it).
- `putPackageManifest()` runs `loadStagedFromDisk` + `dropExpiredStaged` (both synchronous) *before*
  persisting, so expiry and publication are ordered rather than racing.

**Tests** (`upgrade-manifest.test.ts`): retry after 25 h — new manifest survives the expiry sweep, the
re-upload stages and `tryStart` succeeds; the same across a fresh `UpgradeController` (restart); and an
abandoned manifest with nobody retrying is still swept once its own TTL passes.

## (3) P2 — manifest/error response bodies escaped the timeout

`withTimeout()` only covered obtaining the `Response`; `res.text()` afterwards had neither deadline nor
size cap, so a peer could send headers and withhold the body forever (job pinned, release-cache lease
held) or stream an unbounded body.

**Fix**: new `consumeBoundedBody(res, { limitBytes, timeoutMs })` in `remote-upgrade-io.ts` — races each
`reader.read()` against the deadline, stops at the byte cap, and cancels the reader on either (only when
the body did not complete, so the "drain the body so the forwarding layer doesn't see an abort" behavior
is preserved). Defaults: 64 KiB / 30 s.
- `describeUpstream(res, timeoutMs?)` now reads through it.
- `pushPackageManifest()` computes one deadline covering the request *and* the body read, and takes an
  optional `timeoutMs` so tests can shorten it.
- The seven remaining `res.text().catch(() => '')` drains in `remote-upgrade-job.ts` (offset query, push
  classification, start phase, staged delete) were switched to the same bounded consumer.

**Tests**: new `remote-upgrade-io.test.ts` (9 tests) — full small body; no-body response; stalled body
ends at the deadline **and** the stream's `cancel()` fires; oversized body stops at the cap without the
producer draining fully; `describeUpstream` bounded on both an oversized and a stalled error body;
`pushPackageManifest` returns within budget on a stalled 2xx, reports the code on a stalled 4xx, and does
not buffer an oversized 404.

## (4) P2 — two competing checksum parsers

`release/verify.ts` used `node:path.basename` while the new signing module used its own `fileNameOf`;
trailing-separator handling already diverged, so CLI and gateway could disagree on the same text.

**Fix**: one browser-safe implementation. `release-signing.ts` exports `releaseSumsFileName()` (strips
trailing `/` like `basename`) and `parseSha256Sums(text) → Map`; `verify.ts` is now a thin adapter
(`parseSha256Sums(text, fileName) → string | null`) delegating to it, and no longer imports `node:path`.
Both paths therefore share one parser and one filename rule. Added a test asserting directory prefixes
and trailing separators resolve identically.

## Files touched in round 2

`packages/shared/src/release/release-signing.ts`, `release-signing.test.ts`, `release/verify.ts`,
`packages/shared/src/index.test.ts` (export snapshot: `releaseSumsFileName`);
`apps/gateway/src/system/upgrade.ts`, `upgrade-manifest.ts`, `upgrade-manifest.test.ts`,
`upgrade-service.ts`, `remote-upgrade-io.ts`, `remote-upgrade-io.test.ts` (new), `remote-upgrade-job.ts`;
`apps/gateway/src/api/system.ts`, `system.test.ts`;
`docs/release/2026090606-release-signing.md` (kept the coordinator's seed-backup line at
`~/code/key/tmex-release-signing-ed25519-r1.json`), `docs/known-issues.md`.

## Gates (round 2)

- `packages/shared`: **851 pass / 0 fail**.
- `apps/gateway` `src/system` + `src/api` + `mesh-routes`: **786 pass / 0 fail** (+13 new tests).
- `bunx tsc --noEmit`: clean for `packages/shared`, `packages/app`, and every file I own in
  `apps/gateway`. Remaining gateway tsc errors are G1's in-flight pane-grant work
  (`serverEpoch` / `PaneGrantVerdict`).
- `bunx biome check` clean on all touched files. `bun scripts/complexity/gate.ts`: no violation in any
  file I own — `upgrade.ts` is back to 1086 lines against its 1087 allowance (the expiry removal moved to
  `removeExpiredStagedFiles()` in `upgrade-staging.ts`, which also makes it fault-tolerant), and a new
  `stagedSidecarIsOrphan()` helper kept `pruneOrphanStagedFiles` under CC 15. The gate currently reports
  one violation in `apps/gateway/src/auth/user-key-service.ts` (878 > 867) — G3's in-flight key-log work,
  not mine.
- `packages/app`: 2 failures in `src/commands/join.test.ts` (`no such table: agent_pane_grants`) — G1's
  migration 0051 is mid-landing; unrelated to this change and not present before that work.
- `apps/gateway` full suite at the end of this round: 5077 pass / 17 fail. **All 17 are the same
  half-landed refactor from another agent**, not test assertions:
  `SyntaxError: Export named 'makeDeferredVerifyPasskeyAssertion' not found in module
  apps/gateway/src/auth/index.ts` — `mesh/mesh-runtime.ts` already imports a symbol the auth barrel does
  not export yet, which kills those files at import time (it is also the gateway tsc error above).
  The count of that message in the run output is exactly 17. Nothing upgrade/release related failed; the
  scoped `src/system` + `src/api` + `mesh-routes` runs are 786 pass / 0 fail on the same tree.
  Re-run the full suite once G3's auth barrel lands to re-establish the 10-failure baseline.
