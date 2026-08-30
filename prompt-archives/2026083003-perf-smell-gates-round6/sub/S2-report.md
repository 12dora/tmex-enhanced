# Exploration S2 Report

Scope: read-only audit of the requested S2 areas. No files or Git state were modified.

## Findings

### 1. HIGH — Local and SSH tmux reconnect paths duplicate the same recovery policy

Files:

- `apps/gateway/src/tmux-client/local-external-connection.ts:618–681` — `reconnectControlClient`, CC16
- `apps/gateway/src/tmux-client/ssh-external-connection.ts:452–508` — equivalent reconnect path
- Current files: 716 and 767 lines respectively

Both paths independently implement stable-window reset, restart counting, stderr-tail capture, restart delay, connection guards, `has-session` probing, session-gone handling, control-client restart, snapshot resync, and active-pane history capture. This is user-visible whenever the tmux control process dies: local and SSH recovery can drift in retry behavior or error reporting.

Fix: extract a shared `reconnectControlChannel` policy, with small callbacks for local-only spawn failures and SSH/local-specific status reporting. Keep `startControlClient`, snapshot, and history operations supplied by the adapters. This preserves the sequential recovery semantics without table-driving protocol logic.

Expected gain: approximately 15–25 fewer total lines; local reconnect CC should fall from 16 to roughly 4–6, with the shared helper remaining under CC15. Recovery behavior becomes consistent across local and SSH connections.

Risk: medium. The local `EAGAIN`/`EMFILE` retry path and distinct fatal notifications must remain adapter-specific.

Tests covering it: `local-external-connection.test.ts`, `ssh-external-connection.test.ts`; together, 66 tests passed with 191 assertions.

### 2. HIGH — Device-folder drag rendering rebuilds the same container model repeatedly

Files:

- `packages/panels/src/device-folders/device-folder-tree.tsx:354–384`
- `packages/panels/src/device-folders/folder-tree-model.ts:101–133, 159–241`
- `DeviceFolderTree`: 233 lines; `resolveDrop`: CC19, intentionally retained

`DeviceFolderTree` memoizes `containers`, but `resolveDrop` and `previewPlaceholder` each call `listContainers` again during the same render. `onDragOver` updates `overId` for every pointer movement, so a drag frame can perform multiple placement clones, sorts, maps, and sets. `NodeItem` also checks implicit-root membership with `layout.placements.some(...)` for every node, making that part O(nodes × placements).

A benchmark using the real model functions with 100 folders, 1,000 placements, and 1,000 implicit nodes measured:

- Two `listContainers` builds: 397.68 ms / 1,000 renders
- One build: 178.20 ms / 1,000 renders
- Repeated `.some` membership: 2,226 ms / 1,000 renders
- Set membership: 32 ms / 1,000 renders

The latter is a synthetic upper bound, but it demonstrates the avoidable quadratic work.

Fix: pass the already memoized `containers` into `resolveDrop` and `previewPlaceholder`, with a default for existing callers and tests. Replace per-node `.some` checks with a memoized `Set` of implicit or placed node IDs. Leave the branch-heavy drop grammar unchanged.

Expected gain: one model construction per render instead of three, plus O(1) implicit-root lookup. Expected line change is neutral, approximately 0 to +2 lines; `resolveDrop` remains CC19 because this is a hot-path cache fix, not complexity concealment.

Risk: low to medium. The main risk is passing a container model built from a different layout; dependency boundaries must remain explicit.

Tests covering it: `device-folder-tree.test.tsx` passed 17 tests; `folder-tree-model.test.ts` and collision tests cover the model semantics.

### 3. MEDIUM — Device reorder optimistic updates duplicate logic and use quadratic membership checks

Files:

- `packages/panels/src/device-management/use-device-management-state.ts:95–110`
- `packages/panels/src/device-tree/sidebar-device-list.tsx:129–146`
- `useDeviceManagementState`: 126 lines
- `SideBarDeviceList`: 267 lines

Both mutation handlers build an ID map, assign new `sortOrder` values, filter remaining devices using `deviceIds.includes(...)`, and reconstruct the optimistic list. The `includes` call makes the remainder pass O(n × m), and the two implementations can diverge over time.

A Bun microbenchmark with 2,000 devices, 1,000 reordered IDs, and 1,000 iterations measured:

- Existing `includes` implementation: 2,724.85 ms
- Set-based implementation: 163.90 ms
- Synthetic improvement: approximately 16.6×

Fix: extract `optimisticallyReorderDevices` or `reorderDeviceQueryData` into a small device-tree utility. It should preserve unknown-ID filtering, stable remainder ordering, and `sortOrder` assignment while using a `Set`; both mutation handlers should retain their existing rollback and invalidation behavior.

Expected gain: roughly 9 fewer implementation lines, resolving the 126-line hook violation. With focused helper tests, the net change should be approximately −1 to +2 lines overall.

Risk: low. The important compatibility points are unknown IDs, ordering of hidden devices, and the exact assigned sort indexes.

Tests covering it: `device-tree-selectors.test.ts`, device-management panel tests, and sidebar/device-tree tests. A direct helper test should be added for unknown IDs and remainder ordering.

### 4. LOW — `createTmuxStore` repeats the same reorder algorithm for windows and panes

File:

- `packages/stores/src/tmux.ts:274–293`
- `packages/stores/src/tmux.ts:354–376`
- `createTmuxStore`: 363 lines; file: 387 lines

The window reorder path and pane reorder path independently build `byId`, filter requested IDs, and append the remaining entities. This is not a major runtime hotspot: a synthetic benchmark over 200 items and 100 IDs measured about 14.3 µs per operation. It is nevertheless duplicated behavior in a large store factory.

Fix: add a generic `reorderById<T extends { id: string }>` helper and use it for both windows and panes. Keep window-specific and pane-specific state updates outside the helper.

Expected gain: approximately 7–12 fewer lines, with no meaningful runtime change. The store factory would remain over 120 lines and should still be allowlisted as a composition root.

Risk: low. The helper must preserve unknown-ID omission and original remainder ordering.

Tests covering it: `packages/stores/src/tmux-reorder.test.ts` passed 7 tests with 11 assertions.

### 5. LOW — Dead `loginRoute` export

File:

- `apps/fe/src/pages/LoginPage.tsx:293–297`
- `LoginPage.tsx`: 297 lines; `LoginForm`: 218 lines

`loginRoute` is declared for a future route-table design but has no importer. `rg` found the declaration only; runtime routing uses `apps/fe/src/main.tsx:241` and imports `LoginPage` through `loginModule`.

Fix: remove the unused four-line export and its obsolete comment.

Expected gain: −4 lines and no runtime change.

Risk: low, unless the planned F4-2 route table is being developed concurrently.

Tests covering it: existing `LoginPage` dynamic-import tests; no test imports `loginRoute`.

## Allowlist recommendations

| Violation | Reason |
|---|---|
| `packages/ghostty-terminal/src/ghostty-wasm.ts` | One FFI/resource-ownership boundary; splitting it risks memory-lifetime bugs. |
| `packages/ghostty-terminal/src/render-state.ts` | Cohesive renderer bridge with intentional dirty-row, palette, and buffer reuse. |
| `packages/ws-client/src/direct/direct-carrier-controller.ts` | One WebRTC/direct-carrier lifecycle state machine with extensive coverage. |
| `packages/shared/src/auth/key-log.ts` verification functions | Sequential security checks for signatures, epochs, forks, and genesis state; table rewrites would obscure ordering. |
| `packages/shared/src/link/websocket-link.ts` queue/pump | Queue, backpressure, close, drain, and open handling form one state machine; extraction was previously reverted with line growth. |
| `packages/panels/src/device-folders/device-folder-tree.tsx` root | DnD context, overlay, actions, and tree composition are already split into child components; the recommended cache fix is independent. |
| `packages/panels/src/device-tree/sidebar-device-list.tsx` root | Intentional orchestration plus per-device selector/memoization boundaries. |
| `packages/terminal-ui/src/components/Terminal.tsx` and `SplitTerminalArea.tsx` | Composition roots coordinating dedicated terminal, resize, clipboard, and split hooks. |
| `packages/stores/src/agent-session-crud-actions.ts` | CRUD lifecycle root containing deduplication, history eviction, selection, patch, and delete semantics. |
| `packages/stores/src/createSiteStore.ts`, `createUIStore.ts` | Store composition functions with already-separated action modules. |
| `apps/fe` settings/auth forms and panels | Feature-level form flows; extracting JSX would mostly move code and increase indirection. |
| `apps/fe` remote-access components, excluding `loginRoute` | Wizard/status components already have step and status subcomponents; no contract duplication was found. |
| `apps/gateway/src/runtime.ts` and `managed-entry.ts` | Application lifecycle/composition roots. |
| `apps/gateway/src/auth/user-key-service.ts` | Cohesive transactional key-log service; splitting risks atomicity and security invariants. |
| `apps/gateway/src/tls/tls-config-store.ts:get` | Sequential fallback and migration behavior should remain explicit. |
| `apps/gateway/src/tmux-client/external-tmux-core.ts:bindCollaboratorHost` | One adapter boundary exposing the core lifecycle to collaborator objects. |
| `packages/app/src/runtime/assemble.ts` | Top-level role/shutdown composition with dedicated lifecycle helpers and tests. |
| `packages/app/src/lib/native-manifest.ts:detectLibcFamily` | Ordered platform fallback chain. |
| `packages/app/src/cli-auth-entry.ts:dispatchAuthCli` | Command grammar dispatch. |
| `packages/app/src/commands/enroll.ts:pollAndAdmit` | Sequential polling, SIGINT, and admission flow. |
| `packages/panels` device-console hooks and settings tab roots | Each coordinates one interaction protocol or feature flow and already has focused helper boundaries. |
| `apps/gateway/src/api/watch.ts` | CRUD and regex-assist sections are logically separate, but splitting would mostly relocate code and add imports; no net-negative refactor found. |

The mesh, hub, tunnel, WebSocket, and agent-tools violations outside S2 were not re-proposed. Previously retained protocol and parser violations were also omitted.

## Duplication and dead-export audit

- Exact normalized 10-line cross-file scan over non-test, non-generated source: 0 matching windows.
- Semantic duplication found in the two device reorder mutation handlers listed above.
- A second semantic duplicate exists inside `packages/stores/src/tmux.ts` for window/pane ordering.
- Remote-access tunnel handling is centralized: one shared contract, one API-client GET/POST pair, one gateway parser, and one serialized action controller. No duplicated 10+ line tunnel-contract implementation was found.
- The only safe internal dead export identified was `loginRoute`. Broader export scans produced public API and test-support false positives, so they were not reported as dead code.

## Verification

- `bun scripts/complexity/gate.ts`: 132 violations, 0 stale allowlist entries.
- Folder-tree tests: 17 passed.
- Tmux reorder tests: 7 passed.
- Local and SSH external-connection tests: 66 passed, 191 assertions.
- `apps/gateway/src/api/watch.test.ts` could not start in this environment because Bun 1.3.14 reports `EADDRINUSE` for `Bun.serve({ port: 0 })`; this is a test-harness/environment limitation, not a reported code failure.