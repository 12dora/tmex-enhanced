# R1 result — Relay operator limits (round 32, part 1)

Branch `feat/round32-relay-quota-transfer-portmap`, worktree `/Users/konata/code/tmex-r32`.
Implements plan-00 §第一部分 following EX1's "Recommended insertion points" (option A for max file size).
All deliverables 1–13 are done. No TODOs, no skipped tests.

## What was built

### 1. Storage — migration 0049
- `apps/gateway/drizzle/0049_relay_limits.sql`: `relay_config` gains
  `max_tenants integer` (null = unlimited), `total_bandwidth_bytes_per_sec integer` (null = unlimited),
  `fair_share integer NOT NULL DEFAULT 1`.
- Registered in `apps/gateway/drizzle/meta/_journal.json` (idx 49) **and** appended to
  `apps/gateway/src/db/managed-migrations.ts` `MIGRATIONS` (one line; 0050 untouched).
- Schema: `apps/gateway/src/db/schema/relay.ts` (`fairShare` is `{ mode: 'boolean' }`).
- Test: `apps/gateway/src/db/relay-limits.migration.test.ts` (PRAGMA column assertions + insert/update round-trip),
  modelled on `relay-pack-updated-at.migration.test.ts`.

### 2. `RelayQuota.maxFileBytes`
- `packages/shared/src/relay/codec.ts`: optional `maxFileBytes?: number | null`; the `relay.quota` parser
  reads it with `optUint`, so an explicit `null` and an absent field both normalize to "unlimited"
  (field dropped on encode → frames stay small, old peers unaffected).
- `apps/gateway/src/relay/relay-quota.ts`: `RELAY_QUOTA_MAX_FILE_BYTES = 1 TiB`; `normalizeRelayQuota` /
  `serializeRelayQuota` handle it. Introduced an `INVALID` sentinel so "illegal" and "null = unlimited"
  stay distinguishable for both `bandwidthBytesPerSec` and `maxFileBytes`.
- `RELAY_DEFAULT_QUOTA` gains `maxFileBytes: null`.
- Flows for free through `quota_json` / `default_quota_json`, both admin PATCHes, the `relay.quota` push,
  node-side `applyRelayQuota` → `host.quota` (`mesh/relay-uplink-ctl.ts`, explicit destructure updated),
  `GET /api/mesh/relay/status`, `RelayQuotaView`, and `metrics.tenants[].quota`.

### 3. `relay-limits.ts` + config store + admin API
- New `apps/gateway/src/relay/relay-limits.ts`: `RelayLimits`, `RELAY_DEFAULT_LIMITS`,
  `normalizeRelayLimits` (strict → 400), `defaultRelayLimits`, plus `RelayLimitTotals` / `relayLimitTotals`
  (the metrics projection — kept here so `relay-metrics.ts` did not have to grow).
- `relay-config-store.ts`: `RelayConfigRecord.limits`, read/ensure wiring, new `setLimits()`.
- `relay-http.ts`: new codes `RELAY_QUOTA_TENANTS`, `RELAY_BAD_LIMITS`.
- `relay-admin-routes.ts`: `GET /api/relay/status` → `config.limits`;
  `PATCH /api/relay/config` now takes `{ defaultQuota?, limits? }`, at least one required
  (empty patch → 400 `RELAY_INVALID_BODY`, bad limits → 400 `RELAY_BAD_LIMITS`), and calls
  `uplink.applyLimits()` for a hot rate/fair-share update. `/api/relay/health` untouched.

### 4. Max tenants
`relay-routes.ts` `handleRelayEnroll`, **after** password verification and before `issueTenantToken`:
new root public key + `tenants.count() >= maxTenants` → `409 RELAY_QUOTA_TENANTS`.
Token re-issue for an existing root key and `mode: 'join'` are unaffected (test pins both).

### 5. Global bandwidth + fair share
- New `apps/gateway/src/relay/relay-bandwidth.ts`: `RelayBandwidthLimiter` owns one relay-wide
  `RelayTokenBucket(total)` and a ref-counted `RelayTokenStream` per tenant. `acquire(tenantId)` returns a
  handle whose `take()` routes to the tenant stream when fair-share is on (the bucket's existing round-robin
  `drain()` then gives inter-tenant fairness for free) and to the bucket's default stream when off (single
  FIFO = FCFS). `setLimits()` hot-updates rate and the toggle; `clear()` on `stop()`.
- `relay-stream-router.ts`: `RelayStreamContext` gains required `bandwidthFor(tenantId)`;
  `pumpRelayPair` acquires one handle per relay stream and closes it in both `abortBoth` and `finish`;
  `pumpMetered` awaits `limiter.take()` then `global.take()` then `recordAdmitted` (tenant gate first so an
  over-quota tenant does not hold a slot in the global rotation).
- `relay-uplink-server.ts`: owns the limiter, exposes `bandwidthFor` / `applyLimits`, injects into the ctx.
- Idle tenants cost nothing (empty pending lists never enter the ready queue).

### 6. Metrics
`RelayMetricsTotals = RelayLimitTotals & {…}` → totals gain `bandwidthLimitBytesPerSec`, `maxTenants`,
`fairShare`; fed by a new optional `limits` collector option wired in `relay-runtime.ts`.
`packages/api-client/src/relay/metrics-types.ts` mirrors them (all optional, old relays omit).
`relay-metrics.ts` ended at 594 lines (was 586) — still under the 600 gate.

### 7. Node-side transfer limit
- New `apps/gateway/src/files/transfer-limit.ts`:
  `effectiveTransferMaxBytes(configMax, relayQuota)` = min of both ignoring null/absent, plus a tiny registry
  (`setRelayQuotaProvider` / `currentRelayQuota` / `transferMaxBytesNow`). There is no clean global accessor
  for the uplink pool from `files/`, so the provider is injected in `mesh/relay-wiring.ts` `createRelayRoutes`
  (3 lines) reading `uplink.liveClient()` narrowed to `RelayUplinkClient`. A throwing provider degrades to
  "no relay limit" rather than failing the request.
- Call sites (minimal edits, adapted to T1's concurrent refactor which had already landed):
  - `api/file-transfer-routes.ts` `handleUploadInit`: `size > transferMaxBytesNow(config.transferMaxBytes)`
    → 413 with the existing `too_large` shape plus `maxBytes`.
  - `files/device-storage.ts` `pullFileFromDevice`: both the pre-rsync stat check and the post-rsync size
    check use the effective cap and pass it as `detail`.
  Direct DataChannel bulk transfers validate against the size declared at `init`, so gating `init` covers them.
- Unit test `apps/gateway/src/files/transfer-limit.test.ts`.

### 8. `RELAY_QUOTA_LIMITS.maxNodes` drift
api-client 4096 → **256** (matches `RELAY_CTL_MAX_NODES`), plus `maxFileBytes: 1 TiB` and a new
`RELAY_LIMITS_BOUNDS`. Contract tests added in `admin-api.test.ts` and `relay-forms.test.ts`.

### 9. Frontend
- `quota-fields.tsx`: 4th field 「单文件上限（MB）」 (placeholder 「不限」, one-line hint saying it is a relay
  policy enforced by tenant nodes) — lands in both the default-quota dialog and the tenant editor.
- `relay-forms.ts`: `QuotaDraft.maxFileMb` + errors + `quotaEquals`; new `LimitsDraft` / `limitsToDraft` /
  `parseLimitsDraft` and the `MAX_FILE_MB_LIMIT` / `TOTAL_BANDWIDTH_KB_LIMIT` / `MAX_TENANTS_LIMIT` bounds.
- `relay-format.ts`: `bytesToMb` / `mbToBytes` / `maxFileText`; `quotaSummary` now includes 单文件.
- New `relay-limits-dialog.tsx` (最大租户数 / 总带宽上限（KB/s）/ 租户带宽公平分配 switch + one-line hint),
  opened from a new `RelayAdminMenu` item 「中继限额…」; `use-relay-controller.ts` gains `limits` action,
  `limitsOpen`, `openLimits` / `closeLimits`, `submitLimits`.
- `relay-metrics-tiles.tsx`: new 「租户」 tile (`n / 上限`) and 「放行带宽」 tile (`已用 / 上限`, sub line says
  fair-share vs FCFS); when no limit is set both show the bare current value. The traffic group is now 8 tiles,
  so `TileGroup` takes a `gridClassName` and traffic uses `grid-cols-2 lg:grid-cols-4` (divisors of 8).
- `settings/nodes/relay/relay-quota.ts`: 4th row `maxFile` (limit only, no progress bar) →
  connection-details renders it automatically.
- KB/s unit convention kept everywhere; copy follows `/Users/konata/code/tmex-copy-guidelines.md`
  (terse, no second person, full-width punctuation, 「」 for UI names).

### 10. CLI
- `tmex relay limits [--max-tenants N|none] [--total-bandwidth-kb N|none] [--fair-share on|off]`
  (`runRelayLimits`; with no flags it only reads and prints). `--max-file-mb N|none` on `relay quota`.
- `relay-shared.ts`: `RelayLimits`, `formatLimits`, `limitsFromJson`, `parseMaxFileFlag`,
  `parseMaxTenantsFlag`, `parseTotalBandwidthFlag`, `parseFairShareFlag`; `formatQuota` gains `file=`.
- `lib/args.ts`: `relay.limits` nested name + subcommand + flag allowlists (flags do not leak between
  `relay quota` and `relay limits` — pinned by a test). `cli-auth-entry.ts` handler.
- `cli/help.ts`: both the English and Chinese blocks. CLI i18n strings `relay.limits.current/updated`.

### 11. i18n
zh_CN (source) + en_US + ja_JP, identical key sets, `bun run build:i18n` re-run:
`relay.admin.limits.*` (title/menuItem/description/maxTenants/totalBandwidth/fairShare/fairShareHint/
invalidMaxTenants/invalidBandwidth/saved/failed), `relay.admin.quota.maxFile*`,
`relay.admin.quota.summary` (now includes 单文件), `relay.metrics.tiles.{bandwidth,bandwidthHint,
bandwidthUnlimited,bandwidthFair,bandwidthFcfs,usedOfLimit,tenantsUnlimited}`,
`relay.tenant.errors.{RELAY_QUOTA_TENANTS,RELAY_QUOTA_FILE_SIZE}`, `nodes.machine.details.quotaMaxFile`.

### 12. Docs
- `docs/relay/2026090304-relay-role.md`: §6 storage (new columns + why they are not in `default_quota_json`),
  §7 enroll error codes + admin route table (`config.limits`, the new PATCH contract),
  §8 `relay.quota` frame, §10 CLI table, §11 split into 11.1 per-tenant quota / 11.2 relay-level limits,
  §13 new known boundary about node-enforced `maxFileBytes`.
- `docs/relay/2026090403-relay-metrics.md`: new totals fields, `tenants[].quota.maxFileBytes`, tile layout.
- New `docs/relay/2026090604-relay-limits.md` (Chinese: 背景 / 设计 / 接口 / 验收 / 注意事项), explicitly
  stating that `maxFileBytes` is a relay-published policy enforced by tenant nodes while the bandwidth cap is
  the hard protection, and that port mapping is only covered by the bandwidth cap.

## Deviations from the task text

1. **`totals.tenantCount` not added.** `RelayMetricsTotals.tenants` is already `tenants.count()`;
   a second identical field would be pure duplication. The FE tile uses `totals.tenants / totals.maxTenants`.
2. **`RELAY_QUOTA_FILE_SIZE` error code is not emitted by the server.** Enforcement happens on the node's
   own file API, where the FE already handles `too_large` (413). Introducing a second code would have meant
   changing the `FileErrorCode` contract and the panels' error path, which is outside this scope and worse UX.
   The i18n leaf `relay.tenant.errors.RELAY_QUOTA_FILE_SIZE` exists as instructed, ready if a future round
   surfaces it. The effective limit is returned (`maxBytes` on upload init, `detail` on download).
3. **`bandwidthFor` is a required field of `RelayStreamContext`** (not optional with a noop default) so a
   wiring mistake cannot silently disable the global cap. One test construction was updated.
4. **`relay-limits.ts` also hosts `RelayLimitTotals`** rather than `relay-bandwidth.ts` — the task allowed
   "a new small module"; this keeps `relay-metrics.ts` from importing the limiter implementation.
5. **`useRelayController` was split** into `useOperatorDialogs` + the main hook: adding the limits dialog
   pushed it to 131 lines, over the 120-line gate. Both live in the same file (a source-level test in
   `relay-mgmt-ui.test.tsx` greps that file).

## Tests

Added/extended: `relay-units.test.ts` (maxFileBytes normalize + JSON round-trip; `normalizeRelayLimits`
boundaries; four deterministic `RelayBandwidthLimiter` cases — two tenants split ≈50/50, an idle relay does
not throttle the only active tenant, fair-share off = FCFS, fair-share on lets the smaller take finish first,
unlimited never sleeps + `setLimits` hot update), `relay-admin.test.ts` (maxFileBytes push, limits PATCH →
status + metrics, `RELAY_BAD_LIMITS`, empty patch 400), `relay-routes.test.ts` (409 full relay + re-issue
passes), `relay-membership.integration.test.ts` (global limiter in the forwarding path, asserted on admitted
bytes not wall clock), `relay-limits.migration.test.ts`, `transfer-limit.test.ts`,
`relay-uplink-client.test.ts` (maxFileBytes reaches `client.quota`), `codec.test.ts` (back-compat),
`admin-api.test.ts` (`updateLimits`, `RELAY_QUOTA_LIMITS` contract), `relay-forms.test.ts`,
`relay-format.test.ts`, `relay-mgmt-ui.test.tsx` (menu now two items, limits dialog body),
`relay-metrics-ui.test.tsx` (grid), `relay-ui.test.tsx` (4th quota row),
`relay-shared.test.ts` / `relay-admin.test.ts` / `args-relay.test.ts` in `packages/app`.

Final numbers (all run in this worktree):

| Suite | Result |
|---|---|
| `apps/gateway`: `bun test src/relay src/db src/files` | 392 pass / 0 fail |
| `apps/gateway`: `bun test src/mesh` | 1413 pass / 0 fail (after fixing the 2 quota-shape assertions) |
| `apps/gateway`: `bun test src/api` | included above, 0 fail |
| `apps/fe`: `bun test src/pages/settings` | 1392 pass / 0 fail |
| `apps/fe`: `bun test src/` | 2701 pass / 0 fail |
| `packages/shared`: `bun test src/relay` | 76 pass / 0 fail |
| `packages/api-client`: `bun test src` | 276 pass / 0 fail |
| `packages/app`: `bun test src` | 942 pass / 0 fail |

`bunx tsc --noEmit -p .` is clean for apps/gateway, packages/shared, packages/api-client, packages/app.
`bunx biome check` is clean over every file I touched.
`bun scripts/complexity/gate.ts` reports no violation in my files (no allowlist entries added).

## Things the commander must know / verify

- **Not my failures, seen while running the shared worktree** (other agents' in-flight work):
  - `apps/fe` tsc: `packages/api-client/src/download-transfer.ts(52,18) TS6133 'signal' unused`.
  - `packages/shared` `src/index.test.ts` "运行时导出面与快照一致" fails on a new export `formatEta`.
  - complexity gate: `packages/transfer/src/push-driver.ts runPush CC 17`,
    `packages/api-client/src/download-transfer.ts drainContent CC 22`,
    and 4 over-length components under `apps/fe/src/pages/devices/{transfer,portmap}`.
- **Migration numbering**: I took 0049 in both `MIGRATIONS` and `_journal.json`. Whoever owns 0050 must append
  after mine; the journal is JSON so a merge conflict there needs both entries kept in idx order.
- **`relay-wiring.ts`** got a 3-line addition outside my nominal scope (the quota provider injection) —
  the task explicitly allowed wiring from mesh relay wiring. It is a module-level singleton: if a process ever
  builds two mesh runtimes, the last one wins. Acceptable today (one runtime per process), worth a note.
- **`relay-metrics.ts` is at 594/600 lines** and `relay-uplink-server.ts` at 596/600 — both in the gate's warn
  band. Any further relay work must go into new files.
- **Live verification not performed** (no temp instance was booted): the acceptance items
  「设最大租户数 N 后第 N+1 个 enroll 409」 and 「两租户并发灌流量各占总上限约一半」 are covered by unit +
  in-process integration tests; a multi-process run is still worth doing before release.
