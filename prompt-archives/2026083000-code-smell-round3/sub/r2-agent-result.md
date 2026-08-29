# gateway agent tools + prompt environment (round 2)

Scope: `collectAgentEnvironment`, `read-screen` `execute`, `parseIpv6ToBytes`, `executeRunCommand`, `overlaySnapshotFields`. Same-file helpers only (no new production files). No git.

## Files

- **Changed** `apps/gateway/src/agent/prompts/environment.ts` (50L → 85L)
- **Added** `apps/gateway/src/agent/prompts/environment.test.ts` (4 cases)
- **Changed** `apps/gateway/src/agent/tools/read-screen.ts` (69L → 95L)
- **Changed** `apps/gateway/src/agent/tools/pane-info.ts` (109L → 113L; exported `overlaySnapshotFields` + `SnapshotPaneContext`)
- **Added** `apps/gateway/src/agent/tools/pane-info.test.ts` (3 cases)
- **Changed** `apps/gateway/src/agent/tools/run-command.ts` (384L → 427L)
- **Changed** `apps/gateway/src/agent/tools/run-command.test.ts` (existing cases kept; +auto/posix vs powershell, +disablePaging buffer discard)
- **Changed** `apps/gateway/src/agent/tools/ip-address.test.ts` (existing cases kept; +table of compressed/mapped/over-long/invalid)
- **Changed** `apps/gateway/src/agent/tools/terminal.test.ts` (existing cases kept; +emulator + `historyLines>0` capture path)
- **Unchanged** `apps/gateway/src/agent/tools/ip-address.ts` (parser skipped; see below)

## What moved

### `collectAgentEnvironment`

Clock, device identity, and local-only host facts were one object literal of `??` / ternaries. Now:

- `readHostTimezone()` — `Intl` + UTC fallback
- `collectDeviceIdentity(device)` — name/type/host/user/port/session
- `collectLocalHostFacts(isLocal)` — early-return nulls for non-local; OS/shell/TERM/locale/utf-8 only when `device?.type === 'local'`

`collectAgentEnvironment` is a spread of those three.

### `read-screen` `execute`

Same pattern as `send-input` result formatting. `shouldUseLiveRender` is the emulator-and-zero-history decision. `formatReadScreenResult` owns untrusted wrap, pane-info size/cursor fallbacks, and `capturedAt`. `execute` still does alive/runtime checks, `getPaneInfo`, live render vs `capturePaneText`, `onSuccess`, and `failTool`.

### `executeRunCommand`

Byte truncation stays byte-based (`appendBoundedBytes` vs `OUTPUT_MAX_BYTES`). Named decisions:

- `shouldUsePosix` — `posix` or `auto` with a POSIX exit-code expr
- `resolvePromptRegex` — explicit prompt, else CLI-learned prompt (render still lazy)
- `wrapPosixCommand` — OSC133 + nonce wrapper
- `isMatchingDoneMarker` — `D` + empty-or-matching nonce
- `resolveRunCommandClock` — sleep/now/nonce defaults

`executeRunCommand` still owns TUI reject, tap, paging-disable + buffer reset, send, wait, `untap`.

### `overlaySnapshotFields`

Seven `info ?? snapshot ?? null` fields now go through one `coalesceNullable` (`??` semantics, so `splitPaneCount: 0` still wins). Field list stays in `overlaySnapshotFields`.

## Metrics (McCabe = 1 + `if`/`&&`/`||`/`?:`/`??`/`for`/`catch`; same style as round baseline)

| Symbol | Before | After |
|---|---|---|
| `collectAgentEnvironment` | CC 20 / 25L | CC 1 / 8L |
| `readHostTimezone` | — | CC 3 / 6L |
| `collectDeviceIdentity` | — | CC 7 / 10L |
| `collectLocalHostFacts` | — | CC 6 / 13L |
| `execute` (`read-screen`) | CC 17 / 41L | CC 7 / 36L |
| `shouldUseLiveRender` | — | CC 3 / 6L |
| `formatReadScreenResult` | — | CC 5 / 14L |
| `parseIpv6ToBytes` | CC 17 / 50L | skipped (unchanged) |
| `executeRunCommand` | CC 16 / 92L | CC 8 / 73L |
| `appendBoundedBytes` | — | CC 3 / 11L |
| `shouldUsePosix` | — | CC 3 / 3L |
| `resolvePromptRegex` | — | CC 3 / 8L |
| `overlaySnapshotFields` | CC 15 / 14L | CC 1 / 14L |
| `coalesceNullable` | — | CC 3 / 3L |

## Verification (`apps/gateway`)

- Scoped (environment + pane-info + ip-address + run-command + terminal + system-prompt): **81 pass / 0 fail**
- `bun test`: **1669 pass / 0 fail** (baseline 1559; extra passes are new tests here plus other agents)
- `bunx tsc --noEmit -p .`: **32 errors** (baseline 27). **None** in scoped files. Extra vs baseline are other agents’ in-flight edits (`push/*`, `tmux-client/*`, `ws/*`, `telegram/service.ts`, `tmux/ssh-auth.ts`, `api/device-routes.test.ts`, `system/managed-endpoint.test.ts`, `weixin/ilink/client.test.ts`).
- `bunx biome check` on changed files except `run-command.ts`: **clean**. `run-command.ts` reports 9 pre-existing `lint/suspicious/noControlCharactersInRegex` hits in unchanged `cleanTerminalText` (ANSI strip). No new biome findings in code this agent added.

## Skipped

**`parseIpv6ToBytes` restructure.** It is a linear validation pipeline (strip brackets/zone → expand dotted IPv4 suffix → one `::` expansion → 8 groups → 16 bytes) with security-relevant early rejects for SSRF. Splitting it into named stages would scatter that path without changing a reader’s top-to-bottom scan. Left the implementation untouched.

Extended `ip-address.test.ts` with a table covering compressed forms (`::`, `1::`, `2001:db8:85a3::8a2e:370:7334`), IPv4-mapped (`::ffff:192.168.0.1`, hex equivalent, brackets, zone id), embedded v4, over-long groups (`12345::1`, `1:2:3:4:5:6:7::8`), and invalid input (non-canonical octets, incomplete v4, no colon, empty, `::::`). Existing cases kept.

Did not extract `waitForCommandCompletion` (already out of `executeRunCommand` before this round). Did not create a file per function.

## Bugs found

None. No unrelated fixes.
