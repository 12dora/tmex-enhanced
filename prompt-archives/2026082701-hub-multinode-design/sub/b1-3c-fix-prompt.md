# Task B1-3c-fix — align apps/gateway/src/auth with the shared-auth security fixes + auth-store review

Context: `apps/gateway/src/auth/**` (reports `sub/b1-3b-result.md`, `sub/b1-3c-result.md`) consumes `@tmex/shared/auth`, which just changed (`sub/b1-3a-fix-result.md`, read its "Changed signatures" and "协调者必须做的" sections — that list is your spec, items 1–8). Additionally a reviewer found issues in the store layer (`sub/b1-3b-review.md`); the coordinator accepted items 1 and 2 (item 3 is already fixed in config.ts).

Do all of the following, each with a regression test:

A. From `b1-3a-fix-result.md` "协调者必须做的":
1. `passkey.ts`: passkey-signed record `sig` = `encodePasskeyAssertion({credential_id, client_data_json, authenticator_data, signature})` with raw bytes (decode the browser's base64url fields). `makeVerifyPasskeyAssertion` decodes that Borsh struct, reconstructs the `AuthenticationResponseJSON` for SimpleWebAuthn, and verifies with `expectedChallenge = base64url(challenge)`. Delete the JSON-string encoding.
2. `user-key-service.ts`: `allowGenesis: true` ONLY inside `bootstrapUser` (local `hub user add` / `mesh reset-root`); `apply`/`applyMany` from remote sources never allow it (test: remote `reset-root` at head 0 is rejected with `reset_not_genesis`).
3. Passkey delegation verification (`makeVerifyDelegationPasskey`) must also call `verifyDelegationTimes(delegation, now)`; expose `now` injection.
4. `createEnrollment` passkey path: `PasskeySigner` carries `credentialId`; adapt `selfSignedNodeCertificate` and any call site.
5. Any hard-coded byte vectors for `Authorization` / admit-node payloads in gateway tests must be regenerated (do not weaken assertions).
6. `clearPeerCache` effect → `UserStore.deleteAllPeers()` (verify already wired; add test).
7. `node_id_reused` surfaces as an `apply` error; add test.
8. Fork check in the persist path compares `computeRecordHash({bytes,sig})`, never `bytes` alone; test: same bytes + different sig at existing seq → `fork`, DB unchanged.

B. From `b1-3b-review.md`:
9. `user-store.ts`: atomic `consumeEnrollmentToken(enrollPublicKey, {nodeId, now}) → EnrollmentTokenRecord | null` — one `UPDATE … WHERE enroll_public_key = ? AND used_at IS NULL AND expires_at > ? RETURNING …`; test two sequential consumes → second null; expired → null. Keep `markEnrollmentUsed` only if still referenced (grep); otherwise delete it.
10. `node-session-store.ts`: `IssueNodeSessionInput` becomes a discriminated union — `{delegationMethod:'root'; credentialId?: null}` | `{delegationMethod:'passkey'; credentialId: Uint8Array}`; `issue` throws on a passkey session without credential; test both.

File scope: `apps/gateway/src/auth/**` only. Acceptance: `cd apps/gateway && bun test src/auth` green; tsc 0 in `src/auth`; biome clean. Result file: `prompt-archives/2026082701-hub-multinode-design/sub/b1-3c-fix-result.md` (item → change → test; changed signatures).
