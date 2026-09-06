Found three defects:

1. **Medium — Probe expiry can permanently corrupt newly created share URLs.**  
   [share-origins.ts:226](/Users/konata/code/tmex-r30/apps/gateway/src/share/share-origins.ts:226), [share-origins.ts:273](/Users/konata/code/tmex-r30/apps/gateway/src/share/share-origins.ts:273)

   Relay routing prefixes are derived only from probe-approved candidates. When the successful cache expires, `ensure()` starts an asynchronous refresh, but that invocation excludes the relay. A saved default relay origin remains a `custom` candidate with **no prefix**. `ShareService.create()` consequently persists `https://relay/s/<id>` instead of `https://relay/n/<self>/s/<id>`. Successful revalidation does not repair that stored URL.

   The same race affects an explicitly selected relay when its probe expires between listing origins and creating the share.

   **Fix:** Resolve routing prefixes from configured relay metadata independently of probe eligibility. Gate automatic recommendation on probe status, but preserve the required prefix for explicit/default relay origins. Add tests covering expiry between listing and creation, and creation with a saved relay default during refresh.

2. **Medium — Existing relay installations lose working notification deep links after upgrade.**  
   [effective-site-url.ts:81](/Users/konata/code/tmex-r30/apps/gateway/src/mesh/effective-site-url.ts:81)

   Previously, a connected relay node could resolve its effective URL to `https://relay/n/<self>`. Returning `null` now makes `getSiteSettings()` fall back to the stored URL. That value is initialized from the installation’s bind endpoint; relay enrollment does not replace it.

   An existing installation retaining its default loopback URL therefore starts emitting notification links to `http://127.0.0.1:9883/…`. Terminal push, agent notifications, and connection alerts still consume `getSiteSettings().siteUrl`; the new `siteAccessOrigins` field does not help them.

   **Fix:** Preserve site-URL editability while giving notification consumers an explicit access-URL resolver. Honor an explicitly configured URL, with a verified relay `accessUrl` fallback for inherited installation defaults. Add an upgrade regression test with a stored loopback URL and a reachable relay.

3. **Low — Startup priming can cache a failure caused by startup itself.**  
   [assemble.ts:380](/Users/konata/code/tmex-r30/packages/app/src/runtime/assemble.ts:380)

   Priming runs during assembly, before `server.ts` starts the HTTP listener and calls `assembled.start()`. The mesh uplink starts inside that later lifecycle call. If the relay receives the probe before the node becomes reachable—or attachment takes longer than the five-second probe timeout—the probe caches `bad` for two minutes.

   Once attachment succeeds, origins requests still cannot re-probe until that negative cache expires. A deployment whose only public entry is the relay temporarily has no automatic share origin despite being reachable.

   **Fix:** Prime after successful uplink attachment, and invalidate/retry startup failures when attachment becomes ready. Moving the call merely after `mesh.start()` is insufficient because uplink connection proceeds asynchronously.

**Verification:** All 41 focused tests passed. A separate read-only Bun reproduction confirmed finding 1: advancing the probe clock past its TTL changed the saved relay default’s prefix from `/n/node-a` to `null`.

No additional concrete SSRF, redirect-following, ordinary fetch-rejection, sync/async DB mismatch, or older FE/CLI wire-compatibility defect was found. The domain-access host metadata changes, but the enforcement path does not establish a bypass.