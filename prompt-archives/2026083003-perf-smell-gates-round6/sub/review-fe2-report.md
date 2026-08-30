## Findings

- **should-fix — `packages/stores/src/agent-session-crud-actions.ts:309`**  
  **What breaks:** Eviction runs only during `setActiveSession`. If several first-time history requests are delayed, those sessions have no `messages` entry when eviction runs; their later responses populate every history without another budget check. A reproduction with 20 concurrent delayed histories retained all 20 despite the 8-session budget. Late post-unsubscribe events can similarly schedule a fetch that repopulates an evicted history. The test at `agent-history-budget.test.ts:123` masks this by awaiting every response before activating the next session.  
  **Suggested fix:** Enforce retention after history writeback and busy-to-idle transitions, or track/invalidate inactive in-flight loads. Add a deferred-response test that activates all sessions before releasing any history request.

- **should-fix — `apps/fe/src/auth/session-key-store.ts:155`**  
  **What breaks:** If the dynamically loaded `session-login` chunk fails to download, `ensureNodeLogin` rejects instead of returning `LoginNodeResult`. `use-node-login.ts:56` has no rejection handler and remains pending forever, while `NodeLoginButton.tsx:44` remains disabled in its pending state.  
  **Suggested fix:** Convert import/load failure into `{ ok: false, code: 'NETWORK_ERROR' }` while retaining the `finally` cleanup. Add an injectable-loader test covering concurrent callers and failed chunk loading.

- **nit — `packages/panels/src/agent/messages/tool-call-card.tsx:58`**  
  **What breaks:** In the supplied patch, the 64-KiB cutoff can split a UTF-16 surrogate pair. For example, 65,535 ASCII characters followed by an emoji renders a replacement character at the end of the preview, although copying still returns the intact output.  
  **Suggested fix:** If the cutoff ends after a high surrogate, decrement it by one and add a boundary regression test.

## Verified OK

- Active sessions across every node, running/waiting-confirmation sessions, streamed segments, queued messages, and pending confirmations are pinned.
- A genuinely evicted session invalidates its existing history request and reopens with one full fetch and one subscription.
- Failed session-list requests do not call `forgetSessions`; the successful list endpoint is an authoritative local database listing rather than partial remote fan-out.
- History-size caching uses weak keys, and all production message updates replace the array reference.
- The bounded preview retains the full string for copying and correctly applies the line limit.
- Ordinary `data:image` values and image URLs remain supported; bare base64 guessing is restricted to image-named tools.
- `ToolDetailsBody` recomputes image extraction when streaming tool-call updates replace the `call` object.
- Existing secret-zeroing behavior and same-node login single-flight behavior are preserved.
- LoginPage remains a lazy route, and the narrow keyboard-avoidance module is SSR-safe and cleans up its listeners and animation frames.