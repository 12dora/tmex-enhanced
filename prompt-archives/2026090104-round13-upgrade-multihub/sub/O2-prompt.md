# O2 — Frontend: show the hub set (active/standby) on the Nodes page; handle `HUB_NOT_WRITER`

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it. Also read `/Users/konata/code/tmex-copy-guidelines.md` before writing user-facing copy. Then read `prompt-archives/2026090104-round13-upgrade-multihub/plan-00.md` (§目标 3) and `sub/G2-result.md` (backend API you consume).

## Backend contract (from G2)

- `GET /api/mesh/hubs` → `{ hubs: HubEndpointInfo[], attached: { hubNodeId, publicUrl, mode, writerEpoch, since } | null, writerHubId: string | null, candidates: string[] }` where `HubEndpointInfo = { nodeId, publicUrl, name?, mode: 'active'|'standby', priority, writerEpoch, caFingerprint?, online?, lastSeenAt? }` (types exported from `@tmex/shared` uplink codec — check the exact export path in G1/G2 results; if the FE cannot import from that path cleanly, mirror the type in `packages/api-client/src/auth/types.ts`).
- `GET /api/mesh/nodes` rows now carry `hubMode?: 'active'|'standby'` and `isHub` is true for every hub.
- `GET /api/auth/mode`'s `hubNodeId`/`hubPublicUrl` now point at the **writer** hub.
- Hub management writes on a standby return `409 { code:'HUB_NOT_WRITER', writerHubId, writerPublicUrl, writerEpoch }`.

## Requirements

1. **Data**: add `listHubs()` to `AuthApi` (`packages/api-client/src/auth/auth-api.ts`, with types in `packages/api-client/src/auth/types.ts`), and a small external store/hook in `apps/fe/src/node/mesh-hubs.ts` (same pattern as `mesh-nodes.ts`: `useSyncExternalStore`, refresh on demand + on `NODE_EVENT`/hub presence changes; poll at the same cadence the hub list uses, 30 s) exposing `{ hubs, attached, writerHubId, loading, error, refresh }`.
2. **Nodes page** (`apps/fe/src/pages/settings/nodes/management/`): 
   - In the table, the existing hub badge/marker becomes mode-aware: 「主 hub」 for `hubMode==='active'`, 「备 hub」 for standby (tooltip shows publicUrl, priority, writerEpoch, online). Keep `isSelf` marker as is.
   - A compact "Hub 集群" strip above the table (or inside the card header area — pick what fits the existing layout): one chip per hub (name or short id, mode, online dot), the chip of the hub this entry is **attached to** highlighted with a link icon + tooltip「当前入口挂载于此 hub」, the writer chip marked「写入」. When there is exactly one hub, render nothing extra (no regression for single-hub users).
   - When `attached.mode === 'standby'` or `writerHubId` is null/offline: show a one-line inline notice「主 hub 不可达，正在使用备用 hub；加入/重命名/移除等管理操作暂不可用」and disable the Add / rename / remove / enrollment actions (upgrade actions stay enabled).
3. **Error mapping**: wherever hub API errors are turned into user text (`errors.ts` in management, `use-node-row-actions.ts`, `use-create-enrollment.ts`, enrollment engine), map `HUB_NOT_WRITER` to「该 hub 是备用 hub，不接受管理写入；请通过主 hub {{url}} 操作」(interpolate `writerPublicUrl` when present).
4. **Local machine card** (`apps/fe/src/pages/settings/nodes/local-machine-card.tsx`): if the local role is `hub,node`, show the mode (`主 hub` / `备 hub`) if the local status API exposes it — check `packages/api-client/src/local/types.ts` and the `/api/local/*` status route; if the backend does not expose mode there yet, skip this item and say so in the result (do not modify gateway code).
5. i18n: new keys under `translation.nodes.hubs` (+ the error under `translation.nodes.errors` or wherever hub errors live) in `en_US`, `zh_CN`, `ja_JP`; run `bun run build:i18n` from the repo root.
6. Tests: `mesh-hubs.test.ts` (store), extend `nodes-management.test.tsx` (chips render only for ≥2 hubs, attached/writer marking, standby notice disables actions, `HUB_NOT_WRITER` text), api-client test for `listHubs` if the package has route tests.

## Files you own

- `apps/fe/src/node/mesh-hubs.ts` (+test), `apps/fe/src/node/mesh-nodes.ts` ONLY for reading `hubMode` into `NodeRow` (additive), `apps/fe/src/pages/settings/nodes/management/**` (except `upgrade-batch.ts`/`use-node-upgrade*.ts` which are done), `apps/fe/src/pages/settings/nodes/local-machine-card.tsx`
- `packages/api-client/src/auth/auth-api.ts`, `packages/api-client/src/auth/types.ts` (+ tests)
- locale JSONs: only `translation.nodes.hubs` and the single error key you add

Do NOT touch anything under `apps/gateway/**`, `packages/shared/**` (other than running `build:i18n`), `packages/app/**`.

Baselines: `cd apps/fe && bun test src/` currently ≥ 1168 pass / 0 fail, `bunx tsc --noEmit -p apps/fe` 0; `packages/api-client` tsc has 5 pre-existing errors (do not add more); `packages/stores` tsc 1 pre-existing.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/O2-result.md`. Write it, then exit.
