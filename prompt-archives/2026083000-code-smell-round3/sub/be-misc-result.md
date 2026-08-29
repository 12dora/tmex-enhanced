# gateway files NDJSON stream + CLI doctor fix registry

Scope: `apps/gateway/src/api/files.ts` + `transfer-progress-stream.ts` + tests; `packages/app/src/commands/doctor.ts` + `doctor-fixes.ts` + `doctor.test.ts`. No git. Nothing else in the repo.

Tests were written against the current implementation first (upload/download NDJSON routes: 12/12 green before extract; doctor orchestration tests green against the pre-registry loop with injected checks/executors), then the helpers were extracted.

## Files

- **Added** `apps/gateway/src/api/transfer-progress-stream.ts` (123L)
- **Added** `apps/gateway/src/api/transfer-progress-stream.test.ts` (4 tests)
- **Changed** `apps/gateway/src/api/files.ts` (517L → 418L)
- **Changed** `apps/gateway/src/api/files.test.ts` (1 → 12 cases; characterization of commit/prepare NDJSON)
- **Added** `packages/app/src/commands/doctor-fixes.ts` (71L)
- **Added** `packages/app/src/commands/doctor.test.ts` (12 tests)
- **Changed** `packages/app/src/commands/doctor.ts` (100L → 132L; injection seam + thinner `runDoctor`)

## What moved

### 10. NDJSON transfer-stream lifecycle

`createNdjsonProgressStream({ start, cancel })` owns encoding (`JSON.stringify` + newline), try/catch `emit`, and try/catch `close`. `ndjsonProgressResponse` wraps the stream with the existing NDJSON headers.

Callers keep distinct cleanup:
- `streamUploadCommit`: `removeUploadSession` in `finally` and in `cancel`
- `streamDownloadPrepare`: download `AbortController` created after body parse; `cancel` only calls `abort?.abort()`

`files.ts` still validates the upload session (`not_found` / incomplete / `committing = true`) then delegates. Invalid JSON / missing `rootId`/`path` for prepare still emit `{ type: 'error', code: 'invalid' }` inside the prepare caller, not a shared error helper.

### 12. CLI doctor repair dispatch

`DOCTOR_FIXERS` (`createDoctorFixers`) holds per-dep `createPlan`, `requiredVersion`, and `classifyIssue`. `executeDoctorFixer` builds the `DepInstallPlan` and runs the injected executor with the same `no-interactive` → `{ nonInteractive, autoConfirm }` mapping.

`runDoctor` keeps check collection order (`platform → dependencies → install → service → health`), skip logging for unknown fixable ids, recursive rerun with `fix: false`, and `process.exitCode = 1` on any `fail`. Optional `RunDoctorDeps` injects checks/executors/fixers for tests; CLI call site is unchanged.

Classification is explicit per fixer: bun always `'missing'`; tmux still uses `message.includes('version')` so observable issue labels are unchanged (see bug below).

## Metrics

CC from lizard (same 1 + `if`/`&&`/`||`/`?:`/`for`/`catch` style as the round baseline). Length is lizard `length` (function span) unless noted as file `wc -l`.

| Symbol | Before | After |
|---|---|---|
| `files.ts` | 517L | 418L |
| `handleUploadCommit` | 44L | 7L |
| `handleDownloadPrepare` | 63L | 3L |
| `createNdjsonProgressStream` | — | CC 1 / 26L |
| `streamUploadCommit` | — | CC 1 / 24L |
| `streamDownloadPrepare` | — | CC 7 / 39L |
| `runDoctor` | CC 21 / 78L | CC 9 / 23L |
| `repairFixableFailures` | — | CC 3 / 18L |
| `doctor.ts` | 100L | 132L |
| `doctor-fixes.ts` | — | 71L |

Targets met: `runDoctor` CC ≤ 9, `files.ts` ≤ 430.

## Verification

### `apps/gateway`

- Scoped: `files.test.ts` + `transfer-progress-stream.test.ts` → **16 pass / 0 fail**
- `bun test`: **1559 pass / 0 fail** (baseline 1472; extra passes include this scope and other agents)
- `bunx tsc --noEmit -p .`: **27 errors**, same as baseline; **none in scoped files**
- `bunx biome check` on the 4 scoped files: **clean**

### `packages/app`

- Scoped: `doctor.test.ts` → **12 pass / 0 fail**
- `bun test`: **102 pass / 0 fail** (baseline 90; +12 doctor tests)
- `bunx tsc --noEmit -p .`: **1 error**, same as baseline (`Cannot find type definition file for 'node'`; not in scoped files)
- `bunx biome check` on the 3 scoped files: **clean**

## Skipped

- Did not generalize upload vs download cleanup or error ownership.
- Did not extract `streamTempFile` / one-shot `handleDownload` (binary streams, not NDJSON).
- Did not change `doctor-checks.ts` (out of scope); classification cannot use a structured reason field without touching that file.
- Did not run Playwright e2e (`apps/fe/tests`).

## Bugs found

**tmux `--fix` issue type is locale-dependent.** `classifyIssue` (and the previous inline code) uses `check.message.includes('version')`. English `doctor.tmux.versionLow` contains `"version"` → `version-too-low`. Chinese `tmux 版本过低：…` does not contain the English substring → classified as `missing`. Locked by a characterization test; not fixed (behavior-preserving).
