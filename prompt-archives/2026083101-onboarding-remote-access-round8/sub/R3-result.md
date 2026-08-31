# Findings

1. **BLOCKER — stale external state can bypass the last-protection acknowledgement.**  
   [manager.ts:514](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/manager.ts:514) treats an externally managed tunnel as stopped when `lastExternal.running` is false. That value can be the initial placeholder, a stale cached result, or an error fallback from [external-detect.ts:847](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/external-detect.ts:847). Consequently, `remove_access` or `set_access_enforce(false)` can proceed without `acknowledgeExposure` while the external tunnel is actually running. This is especially reachable after the fire-and-forget startup warmup at [manager.ts:263](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/manager.ts:263).  
   **Fix:** before waiving acknowledgement for an externally managed tunnel, perform a truly fresh, bounded detection. Treat timeout, probing, or detection failure as “possibly running” and require acknowledgement; never infer safety from stale `running:false`.

2. **SHOULD-FIX — `force` does not guarantee a post-invalidation scan.**  
   [external-detect.ts:843](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/external-detect.ts:843) clears only the cache. If an older background refresh exists, [refresh():865](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/external-detect.ts:865) returns it, so `detect({force:true})` joins a scan started before invalidation. That older scan can then repopulate the cache and allow `adopt_external` to accept an obsolete hostname. A failed force refresh also resolves to stale data at lines 873–878, allowing `sync_access` at [manager.ts:1081](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/manager.ts:1081) to use a stale hostname.  
   **Fix:** add an invalidation epoch. A force request must start or await a scan from the current epoch, only the latest epoch may commit, and force failures must propagate instead of silently returning stale data.

3. **SHOULD-FIX — failed refreshes renew the success timestamp.**  
   [external-detect.ts:873](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/external-detect.ts:873) writes the stale or empty fallback back with `at: now()`. A failed background refresh therefore makes arbitrarily old data appear fresh for another 30 seconds and removes `probing`. A fast first-call failure similarly caches `{detected:false}` without `probing` for 30 seconds.  
   **Fix:** retain the last successful timestamp on failure. Do not cache the initial empty failure as a successful result; track attempt/error/backoff separately.

4. **SHOULD-FIX — the 1.5-second first-call cap does not cover synchronous detection work.**  
   `detectUncached()` invokes `defaultListProcesses()` before reaching its first suspension point, and that implementation uses `Bun.spawnSync` at [external-detect.ts:88](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/external-detect.ts:88). Default file and directory operations are also synchronous. The timer in [detect():854](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/external-detect.ts:854) cannot run while those operations block the event loop. The supposedly fire-and-forget startup warmup can block for the same reason.  
   **Fix:** use asynchronous process/filesystem APIs with explicit deadlines, or run the blocking scan outside the gateway event loop.

5. **SHOULD-FIX — Bun timeouts after a partial page are not recognized as truncation.**  
   [requestEnvelope():491](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/access-client.ts:491) wraps the original `TimeoutError` in `TunnelError`. `isAbortLike()` then sees `name === "TunnelError"` and only tests `/aborted|timeout/i`; Bun 1.3.14 reports `"The operation timed out."`, which does not match `timeout`. Thus [listApps():191](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/access-client.ts:191) throws after partial progress instead of returning `truncated`.  
   **Fix:** preserve the timeout cause/code when wrapping, or explicitly recognize `signal.reason`, `TimeoutError`, and `"timed out"`.

6. **SHOULD-FIX — incomplete app lists are consumed as complete by mutation paths.**  
   The 50-page exit at [access-client.ts:190](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/access-client.ts:190) does not set `truncated`. Even when the flag is set, [upsertBypassApps():322](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/access-client.ts:322) and [jobSyncAccess():1084](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/manager.ts:1084) ignore it. They can create duplicate bypass applications, report a false “no matching application,” or persist an incomplete `bypassAppIds` set.  
   **Fix:** make completeness explicit, preferably `{items, truncated}`. Negative decisions and creation/synchronization mutations must reject incomplete results. Mark the 50-page cap as truncated.

7. **SHOULD-FIX — the 3-second timeout makes non-idempotent mutations ambiguous.**  
   The same timeout is applied to POST operations such as application creation at [access-client.ts:110](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/access-client.ts:110) and policy creation at [access-client.ts:251](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/tunnel/access-client.ts:251). Cloudflare may commit the request before the client times out. Because `jobConfigureAccess` persists IDs only after all steps finish, retrying can create duplicate applications or policies.  
   **Fix:** use a separate mutation budget and reconcile timed-out POSTs by deterministic domain/name before retrying. Persist recoverable remote IDs after each confirmed step.

8. **SHOULD-FIX — TLS status invalidation can cache an intermediate mutation state.**  
   [tls-service.ts:264](/Users/konata/code/tmex-enhanced-wt-r8/packages/app/src/tls/tls-service.ts:264) invalidates before the asynchronous store mutation. Likewise, [applyListener():591](/Users/konata/code/tmex-enhanced-wt-r8/packages/app/src/tls/tls-service.ts:591) invalidates before changing listener state. A concurrent `status()` started after that invalidation can cache the new database row with the old listener state under the current generation. No post-mutation invalidation removes it, so even the mutation response may return that intermediate projection for ten seconds.  
   **Fix:** track an active mutation epoch and refuse to cache while a mutation is active, then invalidate again after the store/listener transition completes.

9. **SHOULD-FIX — several auth-mode dependencies mutate without invalidating the cache.**  
   The cache includes primary-user fields, TLS fingerprint, and hub metadata, but only route-local key-log success and setter calls invalidate it. Specific uncovered paths include:

   - Background key-log catch-up at [mesh-runtime.ts:402](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/mesh/mesh-runtime.ts:402), which changes user/root/TOTP/cert data through [user-key-persistence.ts:124](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/auth/user-key-persistence.ts:124).
   - Hub metadata updates at [uplink-client.ts:555](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/mesh/uplink-client.ts:555) and [uplink-server.ts:1092](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/hub/uplink-server.ts:1092).
   - TLS mode, renewal, certificate, and CA mutations routed through [tls-service.ts:264](/Users/konata/code/tmex-enhanced-wt-r8/packages/app/src/tls/tls-service.ts:264). The provider is installed only once at [assemble.ts:433](/Users/konata/code/tmex-enhanced-wt-r8/packages/app/src/runtime/assemble.ts:433), so subsequent TLS changes do not call `setTlsInfo()`.

   These are normally bounded by the five-second TTL, but violate the stated immediate-invalidation behavior and can expose obsolete login parameters or hub/TLS information.  
   **Fix:** connect cache invalidation to the underlying user/key-log, hub-metadata, and TLS mutation events rather than only HTTP response paths.

10. **SHOULD-FIX — auth-mode invalidation state is module-global, not instance-local.**  
    [auth-mode-cache.ts:21](/Users/konata/code/tmex-enhanced-wt-r8/apps/gateway/src/mesh/auth-mode-cache.ts:21) stores `generation` at module scope. Mutating one `AuthRoutes` instance invalidates every other instance in the process, causing avoidable cache misses and cross-test interference; concurrent tests that assert one TLS derivation can fail because another instance changed unrelated state.  
    **Fix:** make generation and invalidation instance-owned by `AuthModeCache`/`AuthRoutes`, and pass that instance’s invalidation callback to its mutation sources.

No defect was found in the `Promise.all` conversion: both operations are read-only, all input rejections are observed, and the existing `direct_failed` mapping remains intact.