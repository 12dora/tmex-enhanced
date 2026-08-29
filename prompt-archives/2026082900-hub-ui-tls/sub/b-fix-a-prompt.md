# Task B-fix-A — Backend review fixes: CA response hardening, trust-key canonicalization, direct promotion backup, setup env safety, CLI join errors

Read: prompt-archives/2026082900-hub-ui-tls/sub/review-backend2.md (all findings accepted; you own the ones listed below), b3-result.md, b1-fix-result.md, api-contract-batch2.md.

Task B-fix-B runs in parallel and owns `packages/app/src/tls/**`, `packages/app/src/runtime/tls-routes.ts`, `packages/app/src/runtime/server.ts`, `apps/gateway/src/tls/**`. Do NOT touch those. You may read `packages/app/src/tls/cert-authority.ts` (`spkiFingerprint`, `parseCertificate`) but not edit it — put any new PEM helpers in `packages/app/src/lib/pem.ts`.

A shared env lock already exists: `packages/app/src/lib/env-mutation.ts` `withEnvLock(fn)` — use it around every read-modify-write of the env file in setup-service (B-fix-B uses it in tls-service).

Implement:
1. **Blocker — CA response hardening** (`packages/app/src/commands/hub.ts` join CA fetch + new `packages/app/src/lib/pem.ts`): bound the response to 64 KiB; parse the body with a strict single-PEM-certificate grammar (exactly one `-----BEGIN CERTIFICATE-----…-----END CERTIFICATE-----` block, base64 body, only whitespace outside it); parse it with `@peculiar/x509` and require CA basic constraints (`cA=true`) and keyUsage `keyCertSign`; compute the SPKI fingerprint on the canonical re-serialized PEM of that one certificate and compare; persist only the canonical PEM to `hub_trust`. Tests in `join.test.ts`: `real CA || attacker CA` concatenation → rejected; trailing garbage → rejected; oversized → rejected; non-CA leaf → rejected.
2. **Trust-key canonicalization**: new `packages/shared/src/auth/hub-url.ts` `canonicalHubUrl(raw): string` (lowercase scheme/host, strip default port 443/80, strip trailing slashes, keep non-root path, reject credentials/query/fragment; throws on invalid) with tests. Use it in: `assertHubJoinUrl` output (`hub-client.ts`), `HubTrustStore` keys (`apps/gateway/src/auth/hub-trust-store.ts` — normalize on put/get/delete), `createHubFetcher` lookup (`hub-client.ts`), uplink `tlsCa` lookup in `apps/gateway/src/mesh/mesh-runtime.ts`, and the env value written by `runHubJoin` / setup join. Fail closed: when a `hub_trust` row exists for the canonical URL, always pin; when the stored env `TMEX_HUB_URL` canonicalizes to a key with no row, log once at startup (`[uplink] no pinned CA for hub=…; using system trust`).
3. **Direct promotion with backup** (`packages/app/src/commands/direct.ts`): rename existing `native/` → `native.bak-<pid>`, rename staging → `native/`, on failure restore the backup, on success delete the backup. Test: promotion failure keeps the old addon.
4. **Symlinked env target** (`packages/app/src/runtime/setup-service.ts` + `packages/app/src/lib/env-file.ts`): export a `resolveEnvWriteTarget(path)` from env-file.ts (the same symlink resolution `writeEnvFile` already uses) and use it in the join staged-file promotion so the rename lands on the real target and the symlink is preserved. Tests: existing absolute/relative symlink; dangling link falls back to the link path.
5. **Env lock + fresh merge**: wrap setup env writes in `withEnvLock`; immediately before promoting the staged join env, re-read the current env and merge unrelated keys (so a concurrent `TMEX_TRUST_PROXY` write is not lost). Test with a concurrent writer.
6. **CLI join error classification** (`hub.ts:427` area): preserve the underlying cause for pinned `/api/auth/mode` failures — distinguish network failure, TLS verification failure (advise checking the pinned CA/hostname), and v1 token against a self-signed hub (advise generating a v2 token from the hub).
7. Tests as listed; keep everything else green.

## Scope
- packages/app/src/commands/{hub.ts,join.test.ts,direct.ts,direct.test.ts}
- packages/app/src/lib/{hub-client.ts,hub-client.test.ts,env-file.ts,env-file.test.ts,pem.ts,pem.test.ts}
- packages/app/src/runtime/{setup-service.ts,setup-service.test.ts}
- packages/shared/src/auth/{hub-url.ts,hub-url.test.ts}
- apps/gateway/src/auth/{hub-trust-store.ts,hub-trust-store.test.ts}, apps/gateway/src/mesh/mesh-runtime.ts (+ its tests if needed)

## Baselines (HEAD)
packages/app 334/0 tsc 1; apps/gateway 2450/0 tsc 21; packages/shared 337/0 tsc 0.

## Result
`prompt-archives/2026082900-hub-ui-tls/sub/b-fix-a-result.md`.
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
