# R2 result — relay limits review fixes (round 32)

Fixes for findings 1, 2, 4, 5, 6 of `sub/R1-relay-review.md`.
Finding 3 was skipped as instructed (diff-split artifact; the enforcement calls live in
`file-transfer-routes.ts` / `device-storage.ts`, owned by another agent — untouched).

## 1 — Aborted streams leave global token requests queued (P1)

**`apps/gateway/src/relay/relay-quota.ts`** — `RelayTokenBucket` grew a per-take cancellation identity:

- `PendingTake` now carries `owner: TakeOwner` (`{ closed: boolean }`). A stream's own state is its
  own owner, so `stream.take()` / `bucket.take()` behave exactly as before.
- `RelayTokenStream.createHandle(): RelayTokenHandle` derives an independently closable handle on the
  same logical stream. `handle.close()` removes and rejects **only that handle's** pending takes
  (`dropTakes(state, owner)`, sweeping both `state.pending` and the bypass FIFO, and un-queueing the
  state when it goes empty). `takeFor()` rejects when either the stream or the owner is closed.
- `RelayTokenBucket.cancelAll(reason?)` rejects every queue; `resolveAll` / `rejectAll` now iterate a
  `states: Set<TokenStreamState>` that includes the bucket's own default stream, so nothing can be missed.
- `RelayTokenBucket.pendingCount` getter (leak assertion surface).

**`apps/gateway/src/relay/relay-bandwidth.ts`** — rewritten around those handles:

- `acquire()` returns a handle backed by one child on the tenant stream (fair-share on) and one on a
  dedicated shared FCFS stream (fair-share off). `close()` closes both children, then releases the tenant
  ref. `take()` on a closed handle rejects.
- The bucket's default stream is no longer used at all for fair-share-off traffic (a real `fcfs` stream
  replaces it), so it can be cancelled like every other queue.
- `clear()` closes every tenant stream **and** the FCFS stream, then `bucket.cancelAll()` as a backstop,
  then re-creates a fresh FCFS stream so the limiter stays usable.
- New `pendingCount` / `tenantCount` getters.

**`apps/gateway/src/relay/relay-uplink-server.ts`** — `stop()` now calls `bucket.cancelAll()` on each
per-tenant bucket before dropping the map (one added line, file 596 → 597). Previously those buckets were
dropped with pumps still awaiting `take()`, which never settled.

Regression tests (`relay-units.test.ts`):
- `100 open/send/abort cycles leave nothing queued in either mode` — both fair-share modes; asserts all
  100 takes rejected, `pendingCount === 0`, `tenantCount === 0`, and that a closed handle's `take()` rejects.
- `a cancelled tenant stops taking tokens ahead of live traffic` — three cancelled tenants, then a live
  tenant gets ≥ 4/5 of the full rate over 5 virtual seconds (would be ~1/4 if the ghosts stayed in rotation).
- `closing a derived handle cancels only its own takes` — bucket level.

## 2 — Small frames bypass tenant-level fairness (P1)

- `RelayTokenBucket` takes a 4th ctor arg `options: { bypassSmallFrames?: boolean }` (default `true`).
- The relay-wide bucket in `RelayBandwidthLimiter` is constructed with `bypassSmallFrames: false`, so every
  byte — small frames included — is scheduled by the per-tenant round robin. The per-tenant buckets
  (`relay-uplink-server.ts` `bucketFor`) keep the bypass, so interactive traffic still wins inside a
  tenant's own allocation.

**Additional root cause found while writing the regression test.** Disabling the bypass alone made things
*worse* (67:1), not better: `drain()` used to hand out partial grants (`min(tokens, remaining, 4 KiB)`).
When a frame length equals the rotation quantum, the party that receives the leftover residue can never
assemble a whole chunk before the next refill goes wholesale to its opponent, and the rotation locks
one-sided. `drain()` now only ever grants a **whole chunk** (`min(rate, remaining, 4 KiB)`) and sleeps
until the bucket holds one; the chunk is capped by `rate` so it is always reachable. `drain()` was split
into `drain` / `dropStale` / `grant`, and `nextTake()` now returns `{ take, fromBypass }`.
All eight pre-existing token-bucket / limiter tests still pass unchanged.

Regression test: `fair share counts small frames per tenant, not per stream` — 8 streams of tenant A vs
1 stream of tenant B, all 4 KiB frames, fair share on, deterministic injected clock/sleep. Measured ratio
0.895 (was 8.18:1 before the fix, 0.0148 with the bypass disabled but partial grants left in).

## 4 — Form round-trips silently rewrite untouched values (P2)

`apps/fe/src/pages/settings/relay/relay-forms.ts`:

- `QuotaDraft` gains an optional `origin: QuotaOrigin` (`bandwidthKb`/`bandwidthBytes`,
  `maxFileMb`/`maxFileBytes`) and `LimitsDraft` an optional `origin: LimitsOrigin`, filled in by
  `quotaToDraft` / `limitsToDraft` with the **exact byte values** plus the text they rendered to.
- `parseQuotaDraft` / `parseLimitsDraft` use `keptOrConverted()`: if a field's text is unchanged from what
  was rendered, the original byte value is returned verbatim; only genuinely edited text goes through
  `kbToBytes` / `mbToBytes`.
- `origin` is optional, so object-literal drafts in tests and any future call sites keep the old
  convert-always behaviour. Dialogs patch drafts with `{...prev, ...patch}`, so origin survives editing.

Tests (`relay-forms.test.ts`, new describe `往返保真`): 512 B/s stays 512 while `maxNodes` is edited;
a 1024-byte file cap stays 1024 while `maxStreams` is edited; edited fields still convert
(`2` → 2048, `3` → 3 MiB); the relay-level total bandwidth behaves the same; `tenantToDraft` preserves
exact values too. Two existing `toEqual` assertions on whole `LimitsDraft` objects were extended with the
new `origin` key.

## 5 — Stale tenant cap after async password verification (P2)

`apps/gateway/src/relay/relay-routes.ts` `handleRelayEnroll` re-reads `deps.configStore.ensure(deps.now())`
for `limits.maxTenants` **after** `checkEnrollPassword()`, immediately before the synchronous
count/check/create sequence. `passwordHash` / `passwordEpoch` intentionally keep using the pre-await read —
they must correspond to the password that was actually verified.

Test (`relay-routes.test.ts`): `a tenant cap lowered during the password check is honoured` spies on
`configStore.ensure`, passes through to the real implementation, and lowers the cap to 1 right after the
first read. It asserts the first read still saw `maxTenants === null` and that `ensure` was called more
than once, so a 409 can only come from the re-read. Verified to **fail** (`seen.length` 1, status 200)
when the fix is reverted.

## 6 — CLI flags supplied without a value (P2)

`packages/app/src/lib/args.ts` — new `requireFlagValue(flags, key)`: returns `undefined` only when the key
is absent (`Object.hasOwn`); a bare `--flag` (parsed as boolean `true`) or an empty/whitespace value throws
`t('errors.validate.emptyField', { field: '--<flag>' })`.

`packages/app/src/commands/relay-admin.ts` — `readQuotaFlags` and `readLimitsFlags` use it for all seven
value-taking flags (`--max-nodes`, `--max-streams`, `--bandwidth`, `--max-file-mb`, `--max-tenants`,
`--total-bandwidth-kb`, `--fair-share`); `asString` import dropped. Both readers run before `adminCall`,
so the throw happens before any request.

**No new i18n key was added** — the existing `errors.validate.emptyField` leaf renders as
`--max-tenants cannot be empty.` / `--max-tenants 不能为空。`, which reads correctly as a usage error.
This avoids touching a locale file owned by other agents. If the commander prefers a dedicated message,
say so and I will add `cli.error.flagNeedsValue` to `packages/app/src/i18n/index.ts` (that file is CLI-local,
en + zh only — not the shared locale JSONs).

Tests: `packages/app/src/lib/args.test.ts` (`requireFlagValue` unit tests incl. `--max-tenants --fair-share off`)
and `packages/app/src/commands/relay-admin.test.ts` (two tests asserting `relay limits` / `relay quota` reject
bare and empty flags with `calls.length === 0`, i.e. before any network call).

## Docs

- `docs/relay/2026090604-relay-limits.md`: 「总带宽与公平分配」 now documents the disabled bypass lane on the
  relay-wide bucket, the per-stream cancellable handles and what `clear()` cancels, and the whole-chunk
  granting rule with the measured numbers; new 「最大租户数的读取时机」 subsection; acceptance list and
  注意事项 extended (form fidelity, `requireFlagValue`).
- `docs/relay/2026090304-relay-role.md`: one table cell for `fairShare` corrected (all bytes incl. small
  frames rotate; fair-share-off uses a shared FCFS stream, not the bucket default stream).

## Files touched

```
apps/gateway/src/relay/relay-quota.ts
apps/gateway/src/relay/relay-bandwidth.ts
apps/gateway/src/relay/relay-uplink-server.ts        (1 line in stop())
apps/gateway/src/relay/relay-routes.ts               (1 statement + comment)
apps/gateway/src/relay/relay-units.test.ts
apps/gateway/src/relay/relay-routes.test.ts
apps/fe/src/pages/settings/relay/relay-forms.ts
apps/fe/src/pages/settings/relay/relay-forms.test.ts
packages/app/src/lib/args.ts
packages/app/src/lib/args.test.ts
packages/app/src/commands/relay-admin.ts
packages/app/src/commands/relay-admin.test.ts
docs/relay/2026090604-relay-limits.md
docs/relay/2026090304-relay-role.md
```

No transfer / portmap / files / locale file was touched. No git operations performed.

## Gates

| Gate | Result |
|---|---|
| `apps/gateway` `bun test src/relay` | 177 pass / 0 fail (16 files) |
| `apps/gateway` `bun test src/mesh src/db src/files src/api` | 2076 pass / 0 fail (174 files) |
| `apps/fe` `bun test src/pages/settings/relay src/pages/settings/nodes/relay` | 217 pass / 0 fail |
| `apps/fe` `bun test src/` | 2801 pass / 0 fail |
| `packages/app` `bun test src` | 946 pass / 0 fail |
| `bunx tsc --noEmit -p apps/gateway` | 0 errors |
| `bunx tsc --noEmit -p apps/fe` | 0 errors |
| `bunx tsc --noEmit -p packages/app` | 0 errors |
| `bun scripts/complexity/gate.ts` | ok, no allowlist entries added |
| `bunx biome check <touched files>` | clean |

`relay-uplink-server.ts` 596 → **597** lines and `relay-metrics.ts` stays **594** — both still under 600.
`relay-quota.ts` is 391 lines, `relay-bandwidth.ts` 135, `relay-forms.ts` 290.

## Notes for the commander

- Mid-run I transiently saw other agents' in-flight `tsc` errors in
  `apps/gateway/src/portmap/{accept-tcp-stream,listener,pump.test}.ts` (`PumpSocket.endWrite`,
  `SocketHandler<…,"uint8array">`) and `apps/fe/src/pages/devices/portmap/portmap-actions.test.ts`
  (`listenNodeId` not in `DeletePortMappingParams`). **All of them were gone by the final run** — every
  package now typechecks at 0. Flagged only so you know they existed at some point during the round.
- The whole-chunk granting change in `drain()` is a behaviour change to the **per-tenant** bucket too
  (same class). It never grants more than the rate allows and all pre-existing bucket tests pass, but it
  does shift timing slightly: a take now waits for a whole chunk rather than dribbling in. This was
  unavoidable — partial grants are what broke round-robin fairness at the quantum frame size.
- Live verification (multi-process) was still not performed; everything above is unit + in-process
  integration with an injected clock.
