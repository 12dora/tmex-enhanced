1. **P2 — Explicit `:443` is erased before relay discovery.**  
   **Locations:** `packages/app/src/commands/relay.ts:181`; `packages/app/src/lib/relay-password-join.ts:174`.  
   Both paths normalize the URL before checking whether its port was explicit. Normalization removes `:443`, so `relay enroll`, `reauth`, and password join can silently select another port. Reproduced with `https://relay.example.com:443` resolving to `https://relay.example.com:2053`. This can enroll against a different relay despite the user explicitly selecting 443.  
   **Fix:** determine explicit-port intent from the original input before normalization, and preserve it through discovery. Normalize the selected URL afterward.

2. **P2 — Hairpin probing attributes local health to the wrong public port.**  
   **Location:** `apps/gateway/src/mesh/relay-resolve-route.ts:39–40`.  
   Every candidate sharing the configured relay’s hostname is redirected to the same loopback gateway, regardless of port. With public URL `https://relay.example.com:13443`, probing the portless hostname immediately “discovers” 443 because loopback responds. Enrollment then uses the existing exact host-and-port comparison, does not apply the loopback shortcut, and attempts the wrong public endpoint. Explicit alternate ports also receive false health confirmations.  
   **Fix:** retain exact authority matching for candidate dial rewrites. For a portless self-address, select and confirm the canonical configured public URL explicitly; never attribute its loopback response to another candidate port.

3. **P2 — Relay setup discovery can select a service that is not a relay.**  
   **Location:** `apps/fe/src/pages/settings/nodes/setup/join-relay-form.tsx:83–84`.  
   The relay form uses `precheckProbe`, whose backend probes `/healthz` with the Hub health predicate. If 443 is blocked, a Hub or standalone node on `:2053` can win before the actual relay on `:8443`. The form writes `:2053` into the URL. Submission now treats that port as explicit, skips relay discovery, and fails against the wrong service.  
   **Fix:** add a validated service kind to setup precheck and use `/api/relay/health` with `ok === true` for relay discovery.

4. **P2 — Hub submission can race or bypass blur discovery.**  
   **Location:** `apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx:85–88`.  
   Discovery runs on blur, but submission immediately uses the current `values.hubUrl`. Fill credentials first, enter a portless Hub address last, then press Enter or submit before probing finishes: joining attempts 443 even when the Hub is available on a suggested port. The setup backend calls `performHubJoin` directly and has no fallback discovery.  
   **Fix:** resolve or await discovery inside submission and pass the returned URL directly to `submitJoinHub`. Do not depend on the asynchronous state update from blur.

5. **P2 — Custom port display can diverge from the submitted configuration.**  
   **Location:** `apps/fe/src/pages/settings/nodes/setup/port-picker.tsx:51–54,79`.  
   The custom input uses `defaultValue`. Editing the main URL from `:9443` to `:8443` while Custom remains selected leaves the port field displaying `9443`, although submission uses `8443`. Clearing the field or entering `65536` silently retains the previous valid URL, so setup can persist a port different from the displayed choice.  
   **Fix:** use a controlled port draft synchronized with URL changes, and propagate invalid or empty custom values into form validation so submission cannot silently retain an earlier port.

6. **P2 — HTTPS card substitutes the internal listener port for the public port.**  
   **Location:** `packages/app/src/runtime/tls-routes.ts:51–52`.  
   With configured public URL `https://box.example.com:13443` and NAT forwarding to the built-in listener on 9443, the new code reports `https://box.example.com:9443`. The HTTPS card displays and copies this externally unreachable address, discarding the configured public port.  
   **Fix:** preserve the canonical configured public URL when available. Derive an address from the listener port only when no external address is known.

**Verdict:** Request changes. The diff contains concrete endpoint-selection and setup-state bugs that can redirect enrollment, prevent valid high-port joins, or publish an incorrect connection address.