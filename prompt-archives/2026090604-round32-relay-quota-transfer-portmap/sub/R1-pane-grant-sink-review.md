1. **P1 — Key-log revocation does not reliably invalidate pane grants**  
   **Location:** `apps/gateway/src/mesh/mesh-runtime.ts:579`

   Grant deletion is attached to a `revoked` node event, but applying `revoke-node` through `UserKeyService.apply/applyMany` does not emit that event. This occurs during peer key-log synchronization, including relay deployments. Existing inbound peer streams also do not recheck certificate revocation, and `verifyPaneGrant` checks only the stored grant. A compromised node with an established link and valid grant can therefore continue issuing pane RPCs after its revocation has been applied, until another operation happens to close the link.

   **Fix:** Delete the node’s grants as part of committing the revocation, covering both single-record and batch application. Close existing links from the same committed effect, and reject grants belonging to currently revoked certificates.

2. **P1 — Replacing a grant leaves earlier grants usable after session deletion**  
   **Location:** `apps/gateway/src/agent/pane-grant/client.ts:197–200`

   `persistSessionGrant` overwrites the only stored reference without revoking the previous grant on Y. Rebinding a session from `%1` to `%2` therefore leaves the `%1` grant active. Deleting the session subsequently revokes only the `%2` grant. A compromised X that retained the earlier token can continue accessing `%1`, renewing it up to its original 30-day cap—even when Y was reachable throughout. Concurrent mint requests can similarly produce multiple grants while retaining only one reference.

   **Fix:** Serialize grant replacement per session, verify that the session binding has not changed before committing, and revoke superseded or discarded grants. Retain failed revocations for retry instead of losing their identifiers.

3. **P1 — Grants survive reuse of a tmux pane identifier**  
   **Location:** `apps/gateway/src/agent/pane-grant/store.ts:142–145`

   The grant identifies a pane solely by `deviceId` and numeric `paneId`. After the target tmux server restarts, pane identifiers such as `%0` can identify newly created panes while the persisted grant remains valid. X can replay its old grant against the replacement pane, gaining access without a new browser authorization. The repository already distinguishes server and pane epochs elsewhere, but this authorization ignores them.

   **Fix:** Bind grants to the actual server/pane generation obtained from the target runtime. Validate that generation before executing each RPC and invalidate grants when the generation changes.

4. **P1 — The notification record’s version gate skips uncached admitted nodes**  
   **Location:** `packages/shared/src/auth/key-log-compat.ts:36–39`

   Adding the compatibility-table entry does not make this record fail closed for unknown node versions. `inspectHubAuthRecordCompat` enables `failClosedUncached` only for `readmit-node`. In relay mode, once any peer is cached, `nodesBlockingMinVersion` skips other admitted, non-revoked nodes missing from `peer_cache`. Consequently, a `notification-sink` record can be committed while an offline older node remains admitted; that node cannot decode the new enum when it reconnects, blocking subsequent key-log synchronization.

   This gate behavior was reproduced using the real compatibility function with an uncached admitted member.

   **Fix:** Make `notification-sink` fail closed for every admitted member whose compatible version is unknown, including uncached relay members. Prefer expressing this policy in the compatibility specification rather than another separate type list.

5. **P1 — Queued notifications still reach a sink after its signed authorization is disabled**  
   **Location:** `apps/gateway/src/mesh/notification-bridge-wiring.ts:59`

   Signed sink membership is checked when selecting enqueue targets, but `deliver` forwards unconditionally. Existing queue lanes are neither removed nor reauthorized when a disabling key-log record arrives. A compromised sink can cause a delivery failure, wait until the sender has applied `enabled:false`, then accept a retry and receive the queued sensitive event. Its inbound `sinkEnabled` check offers no protection because the receiver is compromised. The exposure lasts until the queue’s three-minute expiry.

   **Fix:** Recheck current signed membership immediately before each delivery and retry. On sink removal, discard its queue and abort pending delivery attempts.

6. **P2 — The new sink toggle fails with counter-incrementing passkeys**  
   **Location:** `apps/fe/src/node/notification-sink.ts:75–77`

   The new flow always requests `hubSync:true`. That path previews the record using `makeVerifyPasskeyAssertion`, which updates the stored authenticator counter. After hub acknowledgement, local application verifies the same assertion again; its counter now equals the stored counter, so verification fails. For a node forwarding to a separate hub, the hub may already have committed the record while the originating node reports failure and skips the local notification switch update.

   This is an existing shared verifier defect newly exercised by this feature. Repeated verification with the real verifier and a synthetic counter-incrementing assertion reproduced the failure.

   **Fix:** Make preview verification side-effect-free. Commit counter advancement once, atomically with the accepted key-log record, in the shared authentication implementation.

7. **P2 — A rejected pane rebind has already changed the session**  
   **Location:** `apps/gateway/src/api/agent-session-routes.ts:204–208`

   The session is updated before `ensureSessionGrant` checks authorization for the replacement pane. If the browser lacks a valid Y session, PATCH returns `401 NODE_LOGIN_REQUIRED`, but the new `paneId` and accompanying configuration changes remain committed. The frontend treats the operation as failed and retains its old session state, while the backend now holds a different pane binding with the old, mismatched grant.

   **Fix:** Prepare authorization against a proposed session value before modifying the database. Commit the binding and encrypted grant together, with a concurrency check that the original session has not changed.

**Verdict:** Request changes. The grant lifecycle and notification retry paths leave concrete authorization gaps, and the compatibility gate can block older nodes’ key-log synchronization. These need resolution before the fixes satisfy the stated isolation principle.