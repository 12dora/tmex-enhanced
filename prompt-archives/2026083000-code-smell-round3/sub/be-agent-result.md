# gateway agent runtime: approval-response reconciler + send_input payload

Scope: `apps/gateway/src/agent/supervisor.ts` (`appendApprovalResponsesIfReady` only), new `apps/gateway/src/agent/approval-response-reconciler.ts`, `apps/gateway/src/agent/tools/send-input.ts`, new `apps/gateway/src/agent/tools/send-input-payload.ts`, plus matching tests. No git. Nothing else in the repo.

## Files

- **Changed** `apps/gateway/src/agent/supervisor.ts` (682L → 616L)
- **Added** `apps/gateway/src/agent/approval-response-reconciler.ts` (173L)
- **Added** `apps/gateway/src/agent/approval-response-reconciler.test.ts` (10 cases)
- **Changed** `apps/gateway/src/agent/tools/send-input.ts` (160L → 131L)
- **Added** `apps/gateway/src/agent/tools/send-input-payload.ts` (161L)
- **Added** `apps/gateway/src/agent/tools/send-input-payload.test.ts` (7 cases)
- **Changed** `apps/gateway/src/agent/tools/terminal.test.ts` (existing cases kept; 3 cases added: ignored/allowed `rawControlChars`, alternate-screen `send_input`)

## What moved

### Approval-response reconciliation

`inspectApprovalMessages` reconstructs the last-assistant tool-approval-request list and the subsequent tool-message sets (`respondedApprovalIds`, `resolvedToolCallIds`). Non-tool messages, non-array content, and non-string ids are skipped exactly as before.

`buildApprovalResponsePlan` applies precedence: existing `tool-approval-response` → resolved `tool-result` (confirmation `toolCallId` else request `toolCallId`) → pending / missing confirmation (`not-ready`, no partial parts) → cancelled (`execution-denied` tool-result) → approved/denied (`tool-approval-response`; denied `reason` only when present).

`appendApprovalResponsesIfReady` now only: inspect messages, load confirmations by approval id, append the planned tool message, broadcast, return readiness.

### send_input payload / result formatting

`buildSendInputPayload` owns text → combos → legacy keys → (optional) `rawControlChars` concatenation and the control-chars warning. `formatEmulatorResult` / `formatFallbackResult` own alternate-screen vs delta wrapping, 15-line fallback tail, pane-info fallbacks, and optional `warnings`.

`execute` still owns alive/runtime checks, emulator tap/un-tap + `onBytes` buffering, `sendInput` / settle / capture I/O, `onSuccess`, and `failTool`. `createSendInputTool` schema/refine is unchanged.

## Metrics (lizard)

| Symbol | Before | After |
|---|---|---|
| `appendApprovalResponsesIfReady` | CC 22 / 94L | CC 4 / 24L |
| `inspectApprovalMessages` | — | CC 4 / 22L |
| `buildApprovalResponsePlan` | — | CC 9 / 21L |
| `execute` | CC 26 / 83L | CC 8 / 64L |
| `buildSendInputPayload` | — | CC 10 / 16L |
| `formatEmulatorResult` | — | CC 10 / 35L |
| `formatFallbackResult` | — | CC 5 / 11L |
| `supervisor.ts` | 682L | 616L |
| `send-input.ts` | 160L | 131L |
| `createSendInputTool` (schema kept) | 130L CC1 | 111L (schema+execute wrapper) |

Targets met: `appendApprovalResponsesIfReady` CC ≤ 8, `execute` CC ≤ 10. `execute` stayed ~64L (not ~30L) because tap/I/O/error handling remain in the method by spec; the schema in `createSendInputTool` also keeps `send-input.ts` near 130L.

## Verification (`apps/gateway`)

- Scoped: reconciler + payload + `terminal.test.ts` + `supervisor.test.ts` → **63 pass / 0 fail**
- `bun test`: **1559 pass / 0 fail** (baseline 1472; extra passes are new tests here plus other agents)
- `bunx tsc --noEmit -p .`: **30 errors** (baseline 27). **None** in scoped files. Extra vs baseline are other agents’ in-flight edits (`push/*`, `tmux-client/*`, `ws/*`, `telegram/service.ts`, `system/managed-endpoint.test.ts`, `tmux/ssh-auth.ts`).
- `bunx biome check` on the seven scoped files: **clean**

## Skipped

- Did not extract tap buffering or fallback I/O out of `execute` (task: keep runtime I/O / tap / `onSuccess` / `onBytes` / errors there).
- Did not split `createSendInputTool` schema (explicitly keep intact).
- Did not add new `supervisor.test.ts` cases; crash-recovery remains covered there plus the new pure-function tests.

## Bugs found

None. No unrelated fixes.
