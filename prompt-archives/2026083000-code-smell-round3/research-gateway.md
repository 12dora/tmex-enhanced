Archive note: the workspace is read-only, so I could not write `plan-00.md` or `plan-00-result.md`. No source files were changed and tests were not run.

### 1. Table-drive snapshot field splitting

files: [`apps/gateway/src/tmux-client/snapshot-format.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/snapshot-format.ts)

metric: `splitSnapshotFields`: CC25 / file 197L / function 48L.

**Why it hurts.** Field counts 2, 4, 8, and 9 duplicate nearly identical slicing logic. Adding a format or changing a flexible field position requires another branch and risks delimiter-boundary regressions.

**Concrete refactor.** Add a `SNAPSHOT_FIELD_LAYOUTS` map keyed by field count, containing prefix/suffix counts, and implement `splitFlexibleSnapshotFields(parts, layout)`. Preserve the current early return and unsupported-count behavior.

**Risk:** low. **Existing coverage:** [`snapshot-format.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/snapshot-format.test.ts), including pipe-containing titles and paths.

**Expected effect.** `splitSnapshotFields` CC25→~5, 48L→~18L; file ~197L→~170L.

### 2. Separate watch trigger state machines

files: [`apps/gateway/src/watch/evaluator.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/evaluator.ts); new `apps/gateway/src/watch/evaluator-triggers.ts`

metric: `evaluateWatchRule`: CC24 / file 157L / function 85L.

**Why it hurts.** Match and unchanged rules have different state machines, but share one function. Changes to cooldown, reset, capture-group, or unchanged timing logic can accidentally affect match behavior.

**Concrete refactor.** Move `evaluateMatchTrigger`, `evaluateUnchangedTrigger`, and the unchanged-state reset helper to `evaluator-triggers.ts`. Keep regex compilation and last-match selection in `evaluator.ts`; preserve missing-group, `reset`/`ignore`, once, repeat, and cooldown semantics exactly.

**Risk:** low. **Existing coverage:** [`evaluator.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/evaluator.test.ts) is broad and directly exercises both modes.

**Expected effect.** Entry function CC24→~5, 85L→~20L; helpers max CC~10; `evaluator.ts` ~65L plus helper ~90L.

### 3. Extract metadata reconcile planning

files: [`apps/gateway/src/tmux-client/metadata-projection.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/metadata-projection.ts); new `apps/gateway/src/tmux-client/metadata/reconcile-plan.ts`

metric: `reconcile`: CC25 / file 326L / function 74L.

**Why it hurts.** One method combines desired-state comparison, tombstone/base-revision rules, custom-name preservation, field revision checks, and mutation ordering. A new metadata field can easily violate stale-patch behavior.

**Concrete refactor.** Add `buildMetadataReconcilePlan(records, removedAt, desired, baseRevision, nextRevision)`, returning ordered creates, updates, field changes, and removals. Keep `patchBuffer` mutation and revision commits in `reconcile`; execute the plan in the existing order.

**Risk:** medium. **Existing coverage:** [`metadata-projection.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/metadata-projection.test.ts), including tombstones, stale output, subtree removal, and custom fields.

**Expected effect.** `reconcile` CC25→~7, 74L→~20L; main file ~326L→~255L; helper ~70L.

### 4. Split canonical screen capture acquisition from checkpoint assembly

files: [`apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts); new `apps/gateway/src/tmux-client/runtime/canonical-screen-checkpoint.ts`

metric: `captureInternal`: CC27 / file 148L / function 100L.

**Why it hurts.** Barrier capture, fallback capture, alternate-screen history rules, byte budgeting, UTF-8 truncation, identity validation, and checkpoint construction are interleaved. Small changes can break epoch consistency or history cursors.

**Concrete refactor.** Extract `captureFrame(host, paneId, historyLines)` for barrier/fallback acquisition. Extract pure `buildCanonicalCheckpoint(input)` for prefix, cursor, history inclusion, truncation, mode bits, and cursor creation. Keep in-flight deduplication and checkpoint storage in the class.

**Risk:** medium. **Existing coverage:** [`canonical-screen-capture.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/runtime/canonical-screen-capture.test.ts), including fallback, alternate screen, truncation, and epoch changes.

**Expected effect.** `captureInternal` CC27→~9, 100L→~35L; current file ~70L; new helper ~80L.

### 5. Extract approval-response reconciliation

files: [`apps/gateway/src/agent/supervisor.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.ts); new `apps/gateway/src/agent/approval-response-reconciler.ts`

metric: `appendApprovalResponsesIfReady`: CC22 / file 682L / function 94L.

**Why it hurts.** The method reconstructs AI SDK message state, matches approval IDs and tool-call IDs, handles pending/cancelled/approved/denied states, and persists the continuation message. This is correctness-critical recovery logic.

**Concrete refactor.** Move message inspection to `inspectApprovalMessages` and response construction to `buildApprovalResponsePlan`. The supervisor should only load confirmations, append the resulting tool message, broadcast it, and return readiness. Preserve the precedence of existing approval responses, resolved tool calls, pending confirmations, and cancelled confirmations.

**Risk:** medium. **Existing coverage:** [`supervisor.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.test.ts), [`run.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.test.ts).

**Expected effect.** Method CC22→~7, 94L→~12L; supervisor ~682L→~590L; helper ~90L.

### 6. Separate history-window calculation and row packing

files: [`apps/gateway/src/tmux-client/pane-history-reader.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/pane-history-reader.ts); new `apps/gateway/src/tmux-client/pane-history-pagination.ts`

metric: `readPage`: CC19 / file 320L / function 120L.

**Why it hurts.** Cursor validation, history eviction detection, capture coordinates, anchor verification, byte packing, oversized-row truncation, and session mutation all occur in one async method.

**Concrete refactor.** Extract `computeHistoryCaptureWindow` and pure `selectHistoryRows`. Keep remote capture, anchor hashing, cursor/session updates, and error mapping in `readPage`. Preserve reverse-row selection, newline byte accounting, one-row truncation, and all existing error codes.

**Risk:** medium. **Existing coverage:** [`pane-history-reader.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/pane-history-reader.test.ts).

**Expected effect.** `readPage` CC19→~7, 120L→~50L; reader ~320L→~245L; helper ~75L.

### 7. Parameterize active/hot retention admission

files: [`apps/gateway/src/tmux-client/retention/subscription-coordinator.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/retention/subscription-coordinator.ts); new `apps/gateway/src/tmux-client/retention/subscription-admission.ts`

metric: `apply`: CC18 / file 180L / function 112L.

**Why it hurts.** Active and hot requests duplicate validation, rejection construction, quota checks, cloning, and prospective-set updates. The two loops can silently diverge.

**Concrete refactor.** Add `acceptSubscriptionRequests({ mode, requests, occupied, limit, lookupPane, validate })`. Call it once for active and once for hot, retaining active-first ordering, separate quotas, duplicate filtering, rejection order, and cloned request values.

**Risk:** medium. **Existing coverage:** [`subscription-coordinator.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/retention/subscription-coordinator.test.ts) covers generation and active/hot deduplication, but not invalid epochs, quota rejection, or closed consumers.

**Expected effect.** `apply` CC18→~8, 112L→~60L; file ~180L→~125L; helper ~55L.

### 8. Consolidate throttled legacy event delivery

files: [`apps/gateway/src/ws/legacy-feed-broadcaster.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/legacy-feed-broadcaster.ts); new `apps/gateway/src/ws/throttled-event-broadcast.ts`

metric: `broadcastTmuxEvent`: CC24 / file 358L / function 70L.

**Why it hurts.** Bell and notification delivery duplicate the same client iteration, throttle filtering, send, and delivery metric logic. Fixes can update one event type but not the other.

**Concrete refactor.** Add `broadcastThrottledEvent(clients, payload, shouldDeliver, send, record)`. Keep event-specific pane/source extraction and throttle predicates in `LegacyFeedBroadcaster`; keep unthrottled event handling unchanged.

**Risk:** medium. **Existing coverage:** [`ws/index.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.test.ts), including bell/notification throttling and empty notifications.

**Expected effect.** `broadcastTmuxEvent` CC24→~9, 70L→~35L; broadcaster ~358L→~310L; helper ~35L.

### 9. Isolate WebSocket inbound frame decoding

files: [`apps/gateway/src/ws/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts); new `apps/gateway/src/ws/inbound-frame-decoder.ts`

metric: `handleMessage`: CC15 / file 719L / function 53L.

**Why it hurts.** Envelope decoding and chunk decoding duplicate protocol-error conversion while mixing frame validation, reassembly, and dispatch. Wire-level error behavior is easy to change accidentally.

**Concrete refactor.** Add `decodeInboundFrame` returning `ignore`, `error`, or `{ kind, seq, payload }`. Move magic checks, envelope decoding, chunk reassembly, and error metadata into the decoder. Leave `handleMessage` responsible only for sending protocol errors or invoking `handleBorshMessage`; do not change HELLO or handler dispatch.

**Risk:** medium-high. **Existing coverage:** [`ws/index.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.test.ts), including malformed envelopes, malformed chunks, and chunk routing.

**Expected effect.** `handleMessage` CC15→~4, 53L→~20L; `index.ts` ~719L→~665L; helper ~70L.

### 10. Share NDJSON transfer-stream lifecycle

files: [`apps/gateway/src/api/files.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/files.ts); new `apps/gateway/src/api/transfer-progress-stream.ts`

metric: file 517L; `handleUploadCommit` 44L and `handleDownloadPrepare` 63L, neither listed as CC≥12.

**Why it hurts.** Upload commit and download prepare independently implement safe NDJSON enqueueing, controller closing, cancellation, and progress delivery. Their cleanup and abort semantics are already different, making copied lifecycle code risky.

**Concrete refactor.** Add `createNdjsonProgressStream({ start, cancel })` owning only encoding, safe `emit`, and safe `close`. Keep upload session removal and download `AbortController` behavior in the caller callbacks; do not generalize cleanup or error ownership.

**Risk:** high. **Existing coverage:** [`api/files.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/files.test.ts) only tests upload-init validation; [`files/transfer-session.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/files/transfer-session.test.ts) and `rsync.test.ts` cover lower layers. **No direct streaming-route coverage.**

**Expected effect.** `files.ts` ~517L→~410L; upload commit ~44L→~25L; download prepare ~63L→~35L; helper ~50L.

### 11. Separate `send_input` payload and result formatting

files: [`apps/gateway/src/agent/tools/send-input.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/tools/send-input.ts); new `apps/gateway/src/agent/tools/send-input-payload.ts`

metric: `execute`: CC26 / file 160L / function 83L.

**Why it hurts.** One function handles input encoding, control-character policy, emulator tapping, alternate-screen output, line-mode deltas, fallback capture, settling, and failure conversion.

**Concrete refactor.** Extract `buildSendInputPayload` and pure `formatEmulatorResult`/`formatFallbackResult`. Keep runtime I/O, tap/un-tap, `onSuccess`, `onBytes`, and error handling in `execute`. Preserve text/combo/legacy-key order and warning behavior.

**Risk:** medium-high. **Existing coverage:** [`agent/tools/terminal.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/tools/terminal.test.ts), [`agent/run.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.test.ts), [`agent/supervisor.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.test.ts). Coverage is partial for raw control characters, alternate-screen output, fallback capture, and failures.

**Expected effect.** `execute` CC26→~9, 83L→~30L; file ~160L→~105L; helper ~55L. Keep the 130L `createSendInputTool` schema intact.

### 12. Make CLI doctor repair dispatch declarative

files: [`packages/app/src/commands/doctor.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/commands/doctor.ts); new `packages/app/src/commands/doctor-fixes.ts`

metric: `runDoctor`: CC21 / file 100L / function 78L.

**Why it hurts.** Diagnosis, rendering, repair selection, dependency-plan construction, execution, and recursive rerun are mixed together. Repair behavior depends on repeated `bun`/`tmux` conditionals and a localized message substring.

**Concrete refactor.** Add a `DOCTOR_FIXERS` registry with per-dependency plan creation, required version, issue classification, and execution. `runDoctor` should retain check ordering, skip logging, recursive rerun with `fix=false`, and exit-code behavior.

**Risk:** high. **Existing coverage:** no direct doctor tests; [`lib/dep-install.test.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/lib/dep-install.test.ts) covers planning helpers only. **No coverage for `runDoctor` orchestration.**

**Expected effect.** `runDoctor` CC21→~8, 78L→~45L; `doctor.ts` ~100L→~65L; new helper ~45L.

## Not worth doing

- `apps/gateway/src/tmux-client/ssh-external-connection.ts` + `local-external-connection.ts`: reconnect/lifecycle merge was explicitly rejected in the previous phase; transport-specific failure semantics remain distinct.
- `apps/gateway/src/tmux-client/external/session-commands.ts`: a cohesive command facade with small methods and direct tests; further splitting would mostly relocate wrappers.
- `apps/gateway/src/tmux-client/external-tmux-core.ts`: `bindCollaboratorHost` is a deliberate CC1 adapter seam; extraction reduces file size without reducing complexity.
- `apps/gateway/src/ws/canonical-feed-session.ts`: already decomposed into frame sizing, sending, streaming, and subscription collaborators; remaining dispatch is flat.
- `apps/gateway/src/ws/tmux-kind-handlers.ts`: the 183L CC1 factory is a readable protocol registry.
- `apps/gateway/src/ws/error-classify.ts`: CC32 is an ordered classifier whose precedence matters; previous phase deliberately retained it.
- `apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts`: CC52 is a flat protocol dispatcher; splitting cases would obscure wire behavior.
- `apps/gateway/src/tmux-client/control-mode/metadata.ts`: CC26 reflects explicit protocol parsing cases and has focused tests.
- `apps/gateway/src/api/messaging-routes.ts`: provider-specific semantics differ; prior table/HTML-shell extraction produced no useful reduction or increased lines.
- `apps/gateway/src/api/agent.ts`: message and queue handlers share validation, but `steer` is intentionally accepted only by queue; the savings are small and no high-CC function is involved.
- `packages/app/src/lib/bun.ts`: the CC18 parser is cohesive, pure, and well tested.
- `packages/app/src/lib/service.ts`: systemd/launchd branches are platform behavior boundaries; registry extraction would move rather than reduce risk.
- `packages/app/src/lib/dep-install.ts`: sudo, shell-pipeline, interactive, and verification branches are meaningful safety boundaries with no direct execution coverage.
- `packages/app/src/commands/init.ts`: interactive/noninteractive setup and installation side effects are explicit; splitting would relocate orchestration without adequate tests.