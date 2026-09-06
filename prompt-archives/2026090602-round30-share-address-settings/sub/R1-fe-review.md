I found three defects.

1. **Medium — Batch confirmation bypasses upgrade locks acquired while the dialog is open.**  
   [use-upgrade-batch.ts:247](/Users/konata/code/tmex-r30/apps/fe/src/pages/settings/nodes/management/use-upgrade-batch.ts:247)

   After awaiting confirmation, the code rechecks only `batchRunning`. Meanwhile, node discovery and restoration can start tracking another active upgrade. Confirming then launches the batch despite `refs.running` or outstanding restoration, potentially restarting a hub while a dependent node is upgrading.

   **Reproduced:** Opened batch confirmation for a hub, introduced a leaf whose restoration reported `downloading`, then confirmed. The controller called `io.start("hub")` while the leaf remained downloading.

   **Fix:** Recheck running and restoration state after confirmation, before persisting or starting the batch. Add a controller test covering restoration during pending confirmation.

2. **Medium — Following the global model default unexpectedly clears the provider override.**  
   [llm-fields.tsx:110](/Users/konata/code/tmex-r30/packages/panels/src/watch/llm-fields.tsx:110)

   The model selector’s empty option returns `{ providerId: null, modelId: null }`, and this handler applies both fields. For a rule explicitly using provider A, choosing “Follow global default” in the **model** field also switches its provider to the global provider B.

   The backend resolves these defaults independently: `{ providerId: A, modelId: null }` means use A with the global default model. Clearing the previous input preserved that behavior.

   **Fix:** Preserve `draft.providerId` when clearing the model; synchronize the provider only when selecting a concrete model. Add a watch-form test asserting that clearing the model preserves the provider in the saved payload.

3. **Medium — Large bulk-revoke dialogs place their action buttons outside the viewport.**  
   [revoke-dialog.tsx:61](/Users/konata/code/tmex-r30/apps/fe/src/pages/settings/nodes/management/revoke-dialog.tsx:61)

   The description interpolates every selected node name. The shared popup is fixed and vertically centered, without a maximum height or scrolling. A large selection with long names makes the dialog taller than the viewport, pushing its reason field and action buttons offscreen. Background scrolling is also locked, preventing pointer/touch users from reaching those controls.

   **Fix:** Bound the dialog height and put the target names in a scrolling region while keeping the footer visible. Add a browser test with many long names and a small viewport; the current copy-only tests cannot detect this.

Targeted Bun tests passed in isolated runs. A combined cross-package run exposed three i18n test-isolation failures in `site-url-candidates.test.tsx`, which assumes translations return raw keys. No browser E2E tests were run.