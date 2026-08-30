# Task O2b — Graphical directory picker + per-device files modal (frontend)

Read `common-rules.md` in this directory first (ground rules, baselines, fixed contracts).

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-devices-report.md section 1 (add-directory form, FilesSettingsTab `deviceGroups` prop, file-root-form-*).

## Scope (files you own)
- packages/panels/src/settings/file-root-form-modal.tsx, file-root-form-sections.tsx, use-file-root-form.ts, files-tab.tsx (settings one), file-root-query.ts, NEW `directory-picker-modal.tsx`, NEW `device-files-modal.tsx`, packages/panels/src/settings/index.ts (exports) + tests
- packages/ui/src/** only if a needed primitive is missing (prefer existing Dialog/Button/ScrollArea/Input)
- i18n: only the `settings.files` sub-object.

## Requirements
1. Directory picker: a "浏览…" (en "Browse…") icon-button (FolderOpen icon) to the right of the path input in the file-root form, enabled once a device is selected. It opens `DirectoryPickerModal` which uses `browseDirectory({ deviceId, path, hidden }, runtime.apiClient)` (`GET /api/files/browse` — backend built in parallel by agent G3; contract in packages/shared/src/contracts/files.ts: `{ path, parent, entries: [{ name, path, hidden, symlink }], truncated }`; errors are the standard file API errors). UI: breadcrumb of the current path (each segment clickable), an "up" button, an editable path field (Enter navigates), a list of sub-directories (folder icon; symlink dirs with a small link glyph; hidden ones dimmed), a "显示隐藏目录" checkbox, an empty state "没有子目录", loading skeleton, error line with retry, a footer showing the current path and buttons 取消 / 选择此目录. Selecting fills the path input. Open at the current input value if it is absolute, else at the device default (empty `path`). Keyboard: arrows/Enter to navigate, double-click enters a directory. Styling consistent with existing modals (Dialog from @tmex/ui).
2. `FilesSettingsTab` single-device mode: add optional props `lockedDeviceId?: string` (device selector hidden/read-only, new roots always use that device, list shows only that device's roots) and `title?: string`. Keep the existing default behaviour.
3. `DeviceFilesModal` (`packages/panels/src/settings/device-files-modal.tsx`): `export function DeviceFilesModal({ device, nodeId, open, onOpenChange }: { device: DeviceDto; nodeId: string; open: boolean; onOpenChange: (open: boolean) => void })` — a Dialog titled "{device.name} · 目录" hosting `FilesSettingsTab` with `lockedDeviceId={device.id}` using the current runtime (the card lives inside the node's runtime scope already; verify with `useRuntime()`). Another agent (O2a) adds the menu item on the device card that opens this modal — export exactly this signature and name.
4. Tests: picker renders entries/hidden toggle/navigation/select (mock `browseDirectory`), form button opens picker and fills the input, single-device mode hides the device selector and forces deviceId.

Verify: panels tests + tsc + biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O2b-result.md
