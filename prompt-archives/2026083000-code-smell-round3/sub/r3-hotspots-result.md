# Last three complexity hotspots (round 3)

Scope: `parseIpv6ToBytes`, `executeDependencyInstall`, `detectPackageManager`. Same-file helpers + tests only. No git.

## Files

- **Unchanged** `apps/gateway/src/agent/tools/ip-address.ts` (parser skipped; see below)
- **Changed** `apps/gateway/src/agent/tools/ip-address.test.ts` (existing cases kept; tables expanded)
- **Changed** `packages/app/src/lib/dep-install.ts` (injectable runner + duplicated install/verify collapsed)
- **Changed** `packages/app/src/lib/dep-install.test.ts` (+16 `executeDependencyInstall` branch tests)
- **Changed** `packages/app/src/lib/linux-distro.ts` (declarative probe list; format wrap on `parseOsRelease` quote-strip `if`)
- **Changed** `packages/app/src/lib/linux-distro.test.ts` (ID vs `idLike` order cases)

## What moved

### `parseIpv6ToBytes` — skipped

Table-driven tests were written first and passed against the current implementation: compressed (`::`, `::1`, `1::`, `2001:db8::`), IPv4-mapped (`::ffff:1.2.3.4`, hex, brackets, zone, uncompressed `0:0:0:0:0:ffff:1.2.3.4`), full 8-group, over-long groups, too many groups, empty groups (`1:::2`, leading/trailing empty, `:::`, `::::`), non-hex, mixed invalid (dotted leftover, extra octet, `::ffff:1.2.3.4:5`, zone on a non-address).

The function is already the grammar in order: strip brackets/zone → expand dotted suffix → one `::` → 8 groups → 16 bytes. Uncompressed vs compressed **must** stay two branches (`missing < 1` would reject a valid 8-group form). Splitting named stages would scatter a security-relevant SSRF path without helping a top-to-bottom read. Left the production function untouched.

### `executeDependencyInstall`

Command runner was not injectable. Added optional `ExecuteDependencyInstallDeps` (`runCommand`, `getuid`, `promptConfirm`, `checkBunVersion`, `checkTmuxVersion`, `platform`) with production defaults. `isSudoAvailable` takes the same runner so the `sudo -n true` probe is recorded with the install spawn.

Tests cover: empty plan (darwin tmux vs linux), sudo vs not (probe / skip / prefix), pipeline (`sh -c`) vs direct argv, interactive confirm vs decline vs non-interactive refuse, verification success vs failure, and that a failed spawn never calls the version check. Order is asserted (sudo probe before install; sudo probe before the non-interactive refuse).

Then collapsed only real duplication:

- `runInstallCommand` — one `|` vs argv choice, one success predicate (`result !== null && result.code === 0`)
- `reportInstallFailed` — the repeated failed+manual pair
- bun vs tmux verify — one `check` then one success/fail

Sudo / confirm / empty-plan branches stay inline: they are distinct safety boundaries, not copies.

### `detectPackageManager`

`LINUX_PACKAGE_MANAGER_PROBES` is `{ manager, matches }[]` in the old if-chain order (apt → dnf → pacman → apk → zypper). Outer loop is still `[distro.id, ...distro.idLike]`, inner loop is the probe list — so a machine with several IDs still picks the first matching **id**, not the first matching manager family. Tests lock that: `fedora`+`idLike: debian` → dnf; `debian`+`idLike: fedora` → apt; `idLike` order among unknowns.

## Metrics (McCabe = 1 + `if`/`&&`/`||`/`?:`/`??`/`for`/`catch`)

| Symbol | Before | After |
|---|---|---|
| `parseIpv6ToBytes` | CC 17 / 50L | skipped (unchanged) |
| `executeDependencyInstall` | CC 19 / 83L | CC 14 / 65L control-flow (6 injectable `??` defaults not counted; with them CC 20) |
| `runInstallCommand` | — | CC 4 / 10L |
| `reportInstallFailed` | — | CC 1 / 4L |
| `detectPackageManager` | CC 15 / 21L | CC 7 / 17L |
| probe `matches` lambdas | — | apt 2 / dnf 3 / pacman 2 / apk 1 / zypper 2 |

## Verification

### `apps/gateway`

- Scoped `ip-address.test.ts`: **56 pass / 0 fail**
- `bun test`: **1733 pass / 1 fail**. The failure is `SshExternalTmuxConnection > heartbeat timeout stops control channel` in `src/tmux-client/ssh-external-connection.test.ts` — another agent’s in-flight file, ignored.
- `bunx tsc --noEmit -p .`: **21 errors** (baseline 20). **None** in scoped files. Extra vs baseline are other agents (`tmux-client/*`, `ws/*`, `telegram/service.ts`, `tmux/ssh-auth.ts`, `system/managed-endpoint.test.ts`).

### `packages/app`

- Scoped (`dep-install` + `linux-distro`): **61 pass / 0 fail**
- `bun test src`: **122 pass / 0 fail** (baseline 102; +20 are the new tests in this scope)
- `bunx tsc --noEmit -p .`: **1 error** (`Cannot find type definition file for 'node'`) — matches baseline, not in scoped files.

### biome

`bunx biome check` on the five changed files: format clean. Two remaining `lint/style/noNonNullAssertion` hits in `dep-install.ts` are **pre-existing** (`TMUX_INSTALL_COMMANDS.brew!` in `planTmuxInstall`, `plan.commands[0]!` in `executeDependencyInstall`). No new `!`. `ip-address.test.ts` and both `linux-distro` files are clean.

## Skipped

**`parseIpv6ToBytes` restructure** — see above. Tests kept.

Did not extract sudo/confirm/empty-plan into helpers (not duplication). Did not change `process.ts`. Did not wrap `TMUX_INSTALL_COMMANDS` / `parseOsRelease` beyond biome format in scoped files.

## Bugs found

None. Current parser quirk pinned, not changed: `1:2:3:4:5:6:7:8%` (empty zone) is accepted because `%` is stripped before parse — same 16 bytes as without a zone. Report only; SSRF classification is unchanged.
