# TASK E — `packages/app`: assembly root + TLS/ACME complexity

Files you own: `packages/app/src/runtime/assemble.ts`, `packages/app/src/tls/tls-service.ts`.
New files you may create: `packages/app/src/runtime/assemble-routes.ts`, `packages/app/src/tls/acme-dns-patch.ts`.

## 1. `assembleTmex` (assemble.ts:672-844, CC 21, 173 lines; limits 15 / 120)
Extract, keeping call order and side-effect order identical:
- `buildLocalRouteDeps(...)` <- :736-781 (the `routeDeps` object) into `assemble-routes.ts`
- `buildHttpAndWs(...)` <- :783-796 (`createHttpDispatch` array + `routeWebsocket`)
- `wireTlsLifecycle(...)` <- :797-822 (`invalidateTlsCaches` / `refreshMeshTls` / `buildTlsLifecycle` / `setHealthzTlsProvider`)
- `createAssembledLifecycle(...)` <- :825-843 (`start` / `stop` / `setProcessShutdown` / `isRestartRequested`)

## 2. `resolveAcmeDnsPatch` (tls-service.ts:678-757, CC 33)
Extract three pure functions into `acme-dns-patch.ts`: `resolveRequestedProvider(input, current)` (:690-694), `resolveIncomingCredentials(input, legacyToken)` (:707-725), `resolveStoredFallback(input, current, requestedProvider, usedNewFields)` (:740-756).
**HARD CONSTRAINT**: the throw order of the error codes `dns_provider_required` / `dns_credentials_required` / `cloudflare_token_required` must stay literally unchanged — this is the round-19 DNSPod dns-01 compatibility semantic.

## 3. `doRunAcme` (tls-service.ts:478-569, CC 16)
Extract `tryReuseValidCert(row, secrets, reason, epoch, tuple): Promise<boolean>` <- :491-513; on a hit it returns early exactly as today.

## Acceptance
- `packages/app/src/runtime/assemble.test.ts` (1843 lines) and `packages/app/src/tls/tls-service.test.ts` pass with no test edits (re-export if a test imports an internal).
- `assembleTmex` <= 120 lines and CC <= 15; `resolveAcmeDnsPatch` CC <= 12; `doRunAcme` CC <= 12. Verify with `bun scripts/complexity/gate.ts --report` from the repo root.
- `cd packages/app && bun test`: 687 pass, only the known cpu-features failure.
