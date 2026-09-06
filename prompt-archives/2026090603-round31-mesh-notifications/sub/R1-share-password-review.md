I found six actionable issues.

1. **High / P1 — In-flight login bypasses password rotation and session revocation.**  
   [apps/gateway/src/share/share-password-service.ts:59](/Users/konata/code/tmex-r31/apps/gateway/src/share/share-password-service.ts:59)

   `loginAccess()` reads the old hash and awaits verification. Rotation can finish, delete every token, and broadcast revocation during that await. The login then resumes and issues a fresh, valid token using the old password. I reproduced this with the real service and an in-memory database: rotation succeeded, followed by a successful old-password login whose token passed verification.

   **Fix:** Before issuing a token, atomically verify that the password hash/version is unchanged and the share remains active and unexpired. Coordinate this with rotation; merely wrapping rotation’s writes in a transaction does not fix the pending verifier. Add a deferred-verification regression test.

2. **Medium / P2 — Reopening the dialog restores password inclusion and cached plaintext.**  
   [packages/panels/src/share/use-share-link-password.ts:44](/Users/konata/code/tmex-r31/packages/panels/src/share/use-share-link-password.ts:44)

   `idle(key)` only changes the returned projection; it never clears stored state. Closing changes the key temporarily, but reopening the same share restores the original key and resurrects `include: true` and its fetched password. This can unexpectedly produce another password-bearing link, or an invalid link after rotation. A controlled execution of the actual hook confirmed that reopening restored both values without another fetch.

   **Fix:** Persist resets on identity/open transitions and invalidate pending requests with a generation counter. Test close/reopen, A→B→A, and responses arriving after closure.

3. **Medium / P2 — Plaintext password responses lack cache protection.**  
   [apps/gateway/src/share/share-routes.ts:140](/Users/konata/code/tmex-r31/apps/gateway/src/share/share-routes.ts:140)

   The new GET returns plaintext through `json()`, which sets only `Content-Type`. Neither the client nor the forwarding path supplies `no-store`. This permits credential responses to be retained by HTTP caches; session authentication and later password rotation do not purge those copies.

   **Fix:** Return `Cache-Control: private, no-store`, following the existing TOTP-record endpoint’s approach. Assert that the header survives both direct and `/n/:id` responses.

4. **Medium / P2 — Subsequent password fragments are neither consumed nor removed.**  
   [apps/fe/src/pages/SharePage.tsx:25](/Users/konata/code/tmex-r31/apps/fe/src/pages/SharePage.tsx:25)

   Password extraction and fragment removal run only on mount. If a recipient already has the share open and follows an updated password link through same-document fragment navigation, the component remains mounted: the form retains its previous value and the new plaintext fragment remains in the address bar. Client-side navigation between share identities can similarly retain the first password.

   **Fix:** Consume incoming fragments when the navigation/share identity changes, update or remount the corresponding password form, and strip each consumed fragment while preserving `history.state`. Add an existing-tab navigation test; the new e2e case only opens a fresh context.

5. **Medium / P2 — Copy-with-password loses the clipboard user gesture.**  
   [apps/fe/src/pages/settings/share/share-password-dialogs.tsx:63](/Users/konata/code/tmex-r31/apps/fe/src/pages/settings/share/share-password-dialogs.tsx:63)

   The action awaits the password request before attempting clipboard access. Safari rejects clipboard writes outside the initiating gesture; the asynchronous `execCommand` fallback cannot reliably recover it. Consequently, the new menu action fails on Safari despite succeeding with the unconditional clipboard mock. This restriction is documented by [WebKit](https://webkit.org/blog/10855/async-clipboard-api/).

   **Fix:** Initiate `clipboard.write()` synchronously with a promise-backed `ClipboardItem`, or fetch first and present an explicit Copy button. Cover delayed retrieval and gesture enforcement.

6. **Medium / P2 — New dialog tests fail depending on other tests’ i18n initialization.**  
   [apps/fe/src/pages/settings/share/share-password-dialogs.test.tsx:161](/Users/konata/code/tmex-r31/apps/fe/src/pages/settings/share/share-password-dialogs.test.tsx:161)

   Assertions here and at lines 186 and 199 expect untranslated keys. Once another test initializes `react-i18next`, these components render translated text instead. I reproduced all three failures in the combined run; this file passes all 12 tests when run alone.

   **Fix:** Render under an explicitly configured, isolated `I18nextProvider` and assert its expected translations. Avoid depending on an uninitialized global singleton.

Validation: the first selected group passed **64/64** tests; the second passed **85/88**, with the three failures above. Browser e2e specs were inspected but not executed. I found no additional confirmed authorization bypass, IV-reuse defect, or migration-registration error. No repository files were changed.