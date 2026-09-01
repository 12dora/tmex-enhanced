# G4 — Backend: remote upgrade via entry-pushed package ("staged package")

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly.

## Background / field evidence

Remote node upgrade today (`apps/gateway/src/system/upgrade-service.ts`): the entry gateway receives `POST /api/mesh/nodes/:id/upgrade`, forwards `GET /api/system/info` to the target over the peer link (`AuthorizedUpgradeForward.forwardAuthorizedHttp` → `apps/gateway/src/mesh/forwarder.ts` `forwardAuthorizedHttp`, JSON bodies only via `buildJsonStreamBody`), checks the version, then forwards `POST /api/system/upgrade {version}`. The **target** then downloads `tmex-cli-<v>.tgz` + `SHA256SUMS` from GitHub Releases itself (`apps/gateway/src/system/upgrade.ts` `UpgradeController`: `downloading` → verify sha256 → extract → `executing` spawns `package/bin/tmex.js upgrade --apply-current-package --version <v> [--no-service]` detached).

Production finding (read-only probe today): the hub node sits on a VPS that **cannot reach GitHub**; its controller ended in `{state:'idle', error:'The socket connection was closed unexpectedly…'}` — the remote upgrade can never succeed there, while the entry (user's Mac) downloads fine. Fix: **the entry downloads and verifies the tarball, pushes it to the target over the peer link, and the target upgrades from the staged file.** Old targets (without the capability) keep the current path.

## Requirements

### Target side (`apps/gateway/src/system/upgrade.ts`, `apps/gateway/src/api/system.ts`, `packages/shared/src/contracts/system.ts`)

1. `GET /api/system/info` gains `upgradeCapabilities: string[]` containing `'staged-package'` (add to the shared `SystemInfo` contract type; keep every existing field).
2. New route `PUT /api/system/upgrade/package?version=<semver>&sha256=<64 hex>` with a raw tarball body (content-type `application/octet-stream`). Auth/permission identical to `POST /api/system/upgrade` (look at how that route is guarded; in mesh mode the request arrives through the forwarded http stream with the node session already verified). Behaviour: refuse if an upgrade is in progress (`409 UPGRADE_IN_PROGRESS`), refuse if `canSelfUpdate` is false (`403`), validate params (`400`), stream the body to `<stageRoot>/staged/tmex-cli-<version>.tgz.part` with a hard cap (256 MiB → `413`), compute sha256 while streaming, on mismatch delete and return `400 { code: 'PACKAGE_SHA256_MISMATCH' }`, on success atomically rename to `.tgz` and remember `{ version, sha256, path, bytes, stagedAt }` (in-memory map on the controller + a small JSON sidecar so a quick restart doesn't lose it; expire staged files older than 24 h and always keep at most 2). Response `200 { version, sha256, bytes }`. Use the same stage root the controller already uses for downloads (find it in `upgrade.ts`; keep permissions/cleanup consistent with the existing crash-safe layout).
3. `POST /api/system/upgrade` body accepts optional `source?: 'release' | 'staged'` (default `'release'`) and, for `staged`, optional `sha256`. With `staged`: the controller skips the download, verifies the staged file's sha256 (must equal the provided `sha256` if given and the remembered one), extracts it and continues exactly as today (`executing`, spawn). Missing/invalid staged package → `409 { code: 'PACKAGE_NOT_STAGED' }`. Status reporting (`UpgradeStatus`) unchanged.

### Entry side (`apps/gateway/src/system/upgrade-service.ts`, new `apps/gateway/src/system/remote-upgrade-job.ts`, new `apps/gateway/src/system/release-download.ts`, `apps/gateway/src/mesh/forwarder.ts`)

4. Factor the existing "download release tarball + fetch SHA256SUMS + verify" logic out of `upgrade.ts` into `release-download.ts` so both the local controller and the entry job use one implementation. Add an on-disk cache `<stageRoot>/release-cache/tmex-cli-<v>.tgz` (+ `.sha256`) and an in-memory promise cache keyed by version so concurrent jobs download once; verify cached files' sha256 before reuse.
5. `startRemoteMeshUpgrade`: after the existing `/api/system/info` check, if `info.upgradeCapabilities` (array) includes `'staged-package'`, **do not** block the HTTP request: create a `RemoteUpgradeJob` for that nodeId (one per node; a second start while a job is active → `409 UPGRADE_IN_PROGRESS`) and immediately return `200 { state: 'downloading', targetVersion, error: null, startedAt }`. The job: download+verify (cache) → `PUT` the tarball to the target via the forwarder as a **raw streamed body** with `content-type: application/octet-stream` and `content-length` → `POST /api/system/upgrade { version, source: 'staged', sha256 }` → on 2xx the job is finished ("handed off"); on any failure the job ends with an error message that says which step failed (download / push / start) and includes the upstream code/text.
6. `handleMeshNodeUpgradeStatus`: if a job exists for the node: running → `{ state: 'downloading', targetVersion, error: null, startedAt }`; failed (kept until the next start or 10 min) → `{ state: 'idle', targetVersion: null, error: <message>, startedAt }`; handed off → delete the job and fall through to the existing forwarding of `GET /api/system/upgrade`. (The frontend state machine already treats `idle`+`error` as a definitive failure and keeps polling through `downloading`, so no FE change is needed.)
7. Forwarder: extend `forwardAuthorizedHttp`'s `input` with optional `rawBody?: ReadableStream<Uint8Array>`, `headers?: Record<string,string>` (raw body wins over `body`; non-idempotent → single attempt as today). Keep the JSON path byte-for-byte compatible. Check `openHttpStream` and the link stream flow control (1 MiB window, 1 MiB max frame) actually handle a ~20–30 MB streamed request body; add a test with a multi-MiB body through the in-memory link if the existing test helpers allow it.
8. Targets without the capability (older versions) keep today's behaviour unchanged (POST forwarded, target downloads itself).

### Tests

TDD. Extend `apps/gateway/src/system/upgrade.test.ts`, `upgrade-service.test.ts`, `apps/gateway/src/api/system.test.ts`, `apps/gateway/src/mesh/mesh-routes.test.ts` (the remote upgrade cases live around lines 1002–1479), `forwarder.test.ts`. Cover: PUT happy path + sha mismatch + size cap + in-progress; POST staged happy/not-staged; entry job success (download once for two nodes), download failure, push failure, hand-off then status forwarding; legacy target path unchanged; forwarder raw body.

### Files you own

- `apps/gateway/src/system/upgrade.ts`, `upgrade.test.ts`, `upgrade-service.ts`, `upgrade-service.test.ts`, new `remote-upgrade-job.ts` (+test), new `release-download.ts` (+test), `update-check.ts` only if needed
- `apps/gateway/src/api/system.ts`, `system.test.ts`
- `apps/gateway/src/mesh/forwarder.ts`, `forwarder.test.ts`, and the remote-upgrade cases inside `apps/gateway/src/mesh/mesh-routes.test.ts` (do not restructure that file; other agents edit `mesh-routes.ts` itself — you must NOT edit `mesh-routes.ts`; the `AuthorizedUpgradeForward` input type is passed through untouched there, so adding optional fields needs no change)
- `packages/shared/src/contracts/system.ts` (+ its test if any)

Do NOT touch `apps/gateway/src/mesh/mesh-runtime.ts`, `uplink-*.ts`, `apps/gateway/src/hub/**`, `packages/app/**`, `apps/fe/**`.

## Verification

`cd apps/gateway && bun test && bunx tsc --noEmit -p .` (baseline 3134 pass / 0 fail, tsc 0 — note other agents are adding tests concurrently, so the total will be higher; what matters is 0 failures and no tsc errors in your files), `cd packages/shared && bun test && bunx tsc --noEmit -p .`, biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G4-result.md` — what changed, new endpoints/contract fields, how a commander can live-test with two temporary instances (which env vars, how to fake the release download — e.g. an env override for the release base URL if you add one; if you add such an override, name it and default it to today's GitHub URL), test counts. Write it, then exit.
