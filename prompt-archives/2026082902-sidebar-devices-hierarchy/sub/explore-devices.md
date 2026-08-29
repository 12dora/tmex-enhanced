You are exploring a Bun + React monorepo (tmex). Read-only. Produce a concise but complete code map (file paths + line refs + short explanations) for a follow-up implementation agent. Write it in English.

Scope: the "Devices management" page (`apps/fe/src/pages/DevicesPage.tsx`, `packages/panels/src/device-management/*`, `packages/stores/src/*device*`, `packages/api-client`, and gateway backend routes for devices under `packages/app` / `apps/gateway` or wherever `/api/devices` lives), plus how "runtime nodes" (hub/node mesh, `apps/fe/src/node/node-runtimes.ts`) relate to devices.

Answer these questions precisely:
1. What happens when the user clicks the global "+" (add device) button in the top right of DevicesPage? Trace the event (`packages/panels/src/device-management/events.ts`, `device-management-actions.tsx`, `device-dialog.tsx`). Look for any likely crash source (undefined store, missing provider, missing i18n key, hook order, event emitted before listener mounted, null runtime). Report the most likely root cause(s) with evidence.
2. The device card (`device-card.tsx`) shows a device "kind" label (e.g. "Local device") twice — once in the header and once in a pill. Identify both render sites.
3. Why does every device show as "local device" even for real remote devices? Find how `device.type`/`kind` (local / ssh / remote node) is determined, the DB schema for devices (drizzle schema), and API responses. Distinguish: locally configured SSH devices vs devices belonging to remote mesh nodes.
4. Connect / disconnect: where is the connect action on the card, what store/API does it call (`device-connection.ts`, `global-device-provider.tsx`, `device-connection-control.tsx`), is there a disconnect API, and how does the sidebar's connection control do it?
5. Edit dialog: which fields are shown (`device-basic-fields.tsx`, `device-auth-fields.tsx`, `device-ssh-connection-fields.tsx`), and how does it differ by device type today? What device types exist in shared types (`packages/shared/src/**`)?
6. Grouping/hierarchy: is there ANY existing notion of device groups/folders/tags/order in DB schema, stores, or UI (search `group`, `folder`, `category`, `sortOrder`, `position`)? Report the devices table schema, migration mechanism (where migrations live, how new ones are added, naming), and the API router pattern for devices (file, validation lib, how the fe api-client wraps it) so a new `device_groups` table + CRUD can be added the same way.
7. i18n: where are locale JSONs (`packages/shared/src/i18n/locales/*.json`), how keys are namespaced for device management, and the build command (`bun run build:i18n`). 
8. Test/tsc baseline: run `cd packages/panels && bun test src/ 2>&1 | tail -5` and `bunx tsc --noEmit -p . 2>&1 | tail -3`, same for `packages/stores`, `apps/fe` (use `bun test src/`), and report counts.

Output the map to stdout only; no code changes.
