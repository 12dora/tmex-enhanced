# F3 result — transfer dialog: node-named send buttons + virtual `/` root

Worktree `/Users/konata/code/tmex-r32`. No git operations.

## 1. What was built

### 1.1 Send buttons name the destination node

- New pure module `apps/fe/src/pages/devices/transfer/pane-roots.ts` exports
  `sendLabel(options, destNodeId, fallbackKey) → { key, node }`:
  the destination pane's node is looked up in the shared `DialogNodeOption[]`; when it resolves
  the key is `devices.transfer.sendTo` with `node = <name>`, otherwise the old
  `devices.transfer.sendToRight` / `.sendToLeft` is returned with `node: null`.
  A node id that is no longer in the list also falls back.
- `transfer-dialog.tsx` computes each side's label from the **other** pane's `nodeId`
  (`labelOf(sendLabel(options, right.nodeId, 'devices.transfer.sendToRight'))` and the mirror).
  `TransferPane`'s `sendLabel` prop stays a plain string, so the pane is unchanged structurally.
- `transfer-pane.tsx`: the button's text is wrapped in `<span className="min-w-0 truncate">`
  (the Button is `inline-flex … whitespace-nowrap w-full`, so `min-w-0` is required for the
  flex child to shrink) and `title` now falls back to the label when the button is not blocked,
  so a truncated long node name is still readable on hover.
- i18n: new `devices.transfer.sendTo` in the three source locales
  (zh_CN `发送到 {{node}}`, en_US `Send to {{node}}`, ja_JP `{{node}} へ送信`).
  `sendToRight` / `sendToLeft` kept (still the fallback wording). `bun run build:i18n` was run
  from the repo root. `devices.*` is in the rest bundle, so nothing lands on the first screen.

### 1.2 Virtual filesystem root `fs-root`

**Contract** — `packages/shared/src/contracts/files.ts`:
```ts
export const VIRTUAL_FS_ROOT_ID = 'fs-root';
```
Re-exported through `packages/shared/src/index.ts` (`export * from './contracts/files'`);
`packages/shared/src/index.test.ts`'s runtime-export snapshot updated.

**Gateway — one upstream** — new `apps/gateway/src/files/file-root.ts`:
```ts
resolveFileRoot(rootId): { ok: true; root: FileRootRecord } | { ok: false; code: FileErrorCode }
hasEnabledFileRoots(): boolean
```
- a normal id → the DB row (`root_not_found` / `root_disabled` exactly as before);
- `fs-root` → **only** when `hasEnabledFileRoots()` is false: a synthetic `FileRootRecord`
  `{ id: 'fs-root', deviceId: <local device>, path: '/', name n/a, enabled: true, sortOrder: 0,
  createdAt: <device.createdAt> }`, where the device is the first `type === 'local'` row from
  `getAllDevices()` (the seeded local device, `db/devices.ts:ensureDefaultLocalDeviceSeeded`);
- `fs-root` with at least one enabled root → `root_not_found` (indistinguishable from a bogus id,
  so the whitelist model is intact the moment an operator configures a root);
- `fs-root` with no local device at all → `device_not_found`.

I returned a `FileRootRecord` (the DB shape) rather than a `FileRootDto`, because all three
consumers below take the record; the DTO's `deviceName` / `deviceType` / `name` are only built by
`file-root-routes.ts`, which does not see the virtual root at all.

Every rootId resolution now goes through it — verified by grepping `getFileRootById`, which is
left with exactly two callers (`db/file-roots.ts` internal + `api/file-root-routes.ts` config CRUD):

| site | file |
|---|---|
| `resolveContext` (feeds `withNormalizedRsync` → list / stat / content / raw / upload-init / `pushFileToDevice` / `pullFileFromDevice`) | `apps/gateway/src/files/device-storage.ts` |
| `resolveDestContext` (grant creation + receiver session open, i.e. `destRootId`) | `apps/gateway/src/transfer/dest.ts` |
| `enumerateTree` (source expansion) | `apps/gateway/src/transfer/enumerate.ts` |

So `POST /api/transfer/grants`, `POST /api/transfer/jobs` (source `items[].rootId` and
`destRootId`), the mesh receiver, upload init/commit and both download paths all accept `fs-root`
under the same single condition. No route-level allow-listing was needed anywhere.

**Path safety is untouched.** `checkAndNormalize(device, '/', p)` still runs (lexical containment
in `/` is trivially true; the local-device `realpathSync` branch still executes and still rejects a
path that cannot be resolved), and the grant boundary is still the *granted directory*, not the
root: `DestContext.realDestDir` is the realpath of `destPath`, and `dest-local.ts`'s per-segment
`lstat` walk (symlink ⇒ `outside_roots`) and `dest-remote.ts`'s remote walk are unchanged.
`joinPosix` / `withinBase` already handle a `/` base correctly.

**`GET /api/files/roots` is unchanged** — the virtual root is never listed, so the Files page keeps
its explicit-configuration model.

### 1.3 Frontend synthesizes the `/` option

`pane-roots.ts` also exports `VIRTUAL_FS_ROOT` (a `FileRootDto` with `id: 'fs-root'`, `path: '/'`,
`name: '/'`, `enabled: true`) and:
```ts
paneRoots(roots: readonly FileRootDto[] | undefined): FileRootDto[]
```
- `undefined` (query not settled) → `[]` — deliberately **not** synthesized, otherwise the pane's
  existing "auto-select `roots[0]` once" effect would latch onto the virtual root before the real
  list arrives and never re-select;
- an empty / all-disabled list → `[VIRTUAL_FS_ROOT]`;
- otherwise the enabled rows only (previous behaviour).

`use-transfer-pane.ts` now builds `roots` with `paneRoots(rootsQuery.data?.roots)`; the existing
auto-select effect therefore picks `/` by default, and 「未配置文件目录」 (`devices.transfer.rootEmpty`)
is only reached when the roots query failed.

`packages/api-client` needed no change — none of its file helpers validate rootIds
(`file-urls.ts`, `file-resources.ts`, `upload-transfer.ts`, `download-transfer.ts` pass the id through).

## 2. Files touched

New:
- `apps/gateway/src/files/file-root.ts`, `apps/gateway/src/files/file-root.test.ts`
- `apps/fe/src/pages/devices/transfer/pane-roots.ts`, `pane-roots.test.ts`, `transfer-pane.test.tsx`

Modified:
- `packages/shared/src/contracts/files.ts`, `packages/shared/src/index.test.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` (+ regenerated i18n output)
- `apps/gateway/src/files/device-storage.ts`, `apps/gateway/src/transfer/{dest.ts,enumerate.ts}`
- `apps/gateway/src/transfer/{transfer.test.ts,receiver.test.ts}`
- `apps/fe/src/pages/devices/transfer/{transfer-dialog.tsx,transfer-pane.tsx,use-transfer-pane.ts}`

## 3. Tests added

**Gateway `src/files/file-root.test.ts` (7)** — virtual root resolves to the local device's `/`;
an enabled root makes `fs-root` return `root_not_found` (same as a bogus id); a *disabled*-only
config still allows it; no local device → `device_not_found`; a real id still returns its row;
`listDirectory('fs-root', <tmpdir>)` lists a directory outside any root; and the same call returns
`root_not_found` once a root is configured.

**Gateway `src/transfer/receiver.test.ts` (+3)** — a grant with `destRootId: 'fs-root'` opens a
session and a file actually lands on disk under the granted dir; a symlinked component inside the
granted dir is still refused (`outside_roots`, nothing written outside); once an enabled root
exists, `openSession` on a `fs-root` grant fails with `root_not_found`.

**Gateway `src/transfer/transfer.test.ts` (+3)** — `POST /api/transfer/grants` and
`POST /api/transfer/jobs` both accept `fs-root` end-to-end (job snapshot carries
`destRootId: 'fs-root'`); source expansion via `fs-root` enumerates a path outside any root;
configuring an enabled root makes the grant route return `400 {code:'root_not_found'}`.

**FE `pane-roots.test.ts` (6)** — `paneRoots(undefined) === []`, empty/all-disabled → the virtual
root, enabled rows win; the three `sendLabel` branches.

**FE `transfer-pane.test.tsx` (4)** — SSR render of `TransferPane`: the send button contains
「发送到 mesh-node-b」, a `truncate` class and a `title` with the full label; zh/en/ja interpolation
checked against the real generated resources via a standalone i18next instance; SSR render of
`PaneRootSelect` with `paneRoots([])` shows `<span class="truncate">/</span>` and never the
`rootEmpty` copy, and the trigger is not disabled.

> Note on the FE render test: `apps/fe/src/pages/FilePage.test.tsx` calls
> `mock.module('react-i18next', …)` and `mock.module('@tanstack/react-query', …)`, which are
> process-wide for a whole `bun test src/` run. The assertions were therefore restricted to output
> that goes through neither (`sendLabel` is a prop; `PaneRootSelect` is rendered from props), and
> the i18n copy is verified against a self-built i18next instance instead of `useTranslation`.
> A first draft that seeded a `QueryClient` cache and used `I18nextProvider` passed in isolation
> and failed in the full run; that trap is documented in the test's header comment.
> `file-root.test.ts` also clears `devices` / `file_roots` in `beforeEach` (not just `afterEach`) —
> the gateway's shared in-memory DB otherwise leaks another file's rows into the
> "zero enabled roots" precondition.

## 4. Gates

| gate | result |
|---|---|
| `bunx tsc --noEmit -p apps/gateway` | 0 errors |
| `bunx tsc --noEmit -p apps/fe` | 0 errors |
| `bunx tsc --noEmit -p packages/shared` | 0 errors |
| `bunx tsc --noEmit -p packages/api-client` | 0 errors |
| gateway `bun test src/files src/api src/transfer` | **585 pass / 0 fail** (was 572 before my changes) |
| gateway `bun test src/mesh/integration/transfer.integration.test.ts` | 11 pass / 0 fail |
| gateway `bun test` (full) | **5085 pass / 11 fail** — the 10 documented baseline failures (9 `mesh phase-2 integration` + the flaky 8 MiB DataChannel re-dial) plus one relay flake (`relay password join > a rejected admit append leaves no local user`), which passes in isolation (`bun test src/relay` → 177/0). T4 documented the same contention flakiness for relay. Nothing in `src/files` / `src/transfer` fails. |
| fe `bun test src/pages/devices` | 137 pass / 0 fail |
| fe `bun test src/` | **2853 pass / 0 fail** (baseline 2843) |
| `packages/shared` `bun test` | 826 pass / 0 fail (locale consistency green) |
| `bunx biome check` over `apps/fe/src/pages/devices/transfer/`, `apps/gateway/src/files/`, `apps/gateway/src/transfer/`, the two shared files | clean |
| `bun scripts/complexity/gate.ts` | ok, no allowlist entries added |

## 5. For the commander

1. **Security widening, by design.** With zero enabled file roots, any authenticated user of a node
   can now list/read/transfer anywhere the gateway process can reach, via `fs-root`. This is what
   the task asked for and it is gated strictly on "operator configured nothing"
   (`hasEnabledFileRoots()` false); the first enabled root revokes it instantly. Note the node
   already exposed unrestricted *directory* browsing through `GET /api/files/browse?deviceId=`
   (whitelist-exempt by design), so the new surface is file **content** + transfer, not navigation.
   If that is not wanted, the single choke point to gate further is `virtualFsRoot()` in
   `apps/gateway/src/files/file-root.ts`.
2. `bun run build:i18n` was run after adding `devices.transfer.sendTo`; re-run once at the end of
   the round since several agents touched the locale JSONs.
3. `packages/shared/src/index.test.ts`'s export snapshot now contains `VIRTUAL_FS_ROOT_ID` — anyone
   else editing that list must keep it.
4. The virtual root binds to the **local** device only. An SSH-only node (no `type === 'local'`
   device) returns `device_not_found` for `fs-root`; the pane will show that as a load failure.
   That matches the current seeding model (every fresh DB gets one local device).
5. Not run: e2e and any live instance.
