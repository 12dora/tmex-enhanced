# r3-ssh — split `ssh-external-connection.ts`

Scope: `apps/gateway/src/tmux-client/ssh-external-connection.ts`, new siblings, and new sibling tests. No git. Pure move-and-re-export; `SshExternalTmuxConnection` is still exported from the original module path. Existing `ssh-external-connection.test.ts` cases kept (file not edited). Did not touch `local-external-connection.ts`, `external-tmux-core.ts`, or `external/*`.

## Seams

Connect-config / auth strategy were already extracted (`ssh-connect-config.ts`, `ssh-auth-resolvers.ts`). Remaining real seams:

| Group | Why it is / is not a seam |
|---|---|
| Sentinel shell queue + isolated exec | Cohesive SSH command I/O; few inbound refs (class delegates) |
| Client ready/error/close + `/bin/sh -s` exec | Transport bring-up, shared by command + control readers |
| Control reader + reconnect/backoff | Control-channel lifecycle after attach |
| `openControlChannel` / `handleControlChannelClose` / `connect()` | Stayed — one coherent attach/teardown state machine on `this` |
| Teardown | `disposeTransport` is 5L; not worth a module |

## Files

**Added**

- `ssh-shell-session.ts` (339L) — multiplexed `/bin/sh -s` queue, isolated history exec, window-style recipe
- `ssh-client-connect.ts` (69L) — `establishSshClientConnection`, `execSshShellChannel`
- `ssh-control-channel.ts` (131L) — `openSshReaderChannel`, `reconnectSshControlClient`
- `ssh-shell-session.test.ts` (317L)
- `ssh-control-channel.test.ts` (248L)

**Changed**

- `ssh-external-connection.ts` (770L → **403L**) — class is the orchestrator; original path still exports `SshExternalTmuxConnection`
- `ssh-external-connection.test.ts` — **unchanged**

## What moved

### `ssh-shell-session.ts`

`PendingShellCommand`, `COMMAND_SENTINEL`, `createSshShellSession`, `attachSshShellStream` (was the stream wiring inside `openCommandChannel`), `closeSshShellSession` (command half of `disposeTransport`), `runShell` / `runShellAllowFailure` / `enqueueShellCommand` / `executeShellCommand` / `flushCommandBuffer` / `rejectPendingCommand`, `runTmuxIsolated` / `executeIsolatedShellCommand`, `configureSshWindowStyle`.

Bodies unchanged. The two `/bin/sh -s` `exec` callbacks are now `execSshShellChannel` (identical options, error, resolve).

### `ssh-client-connect.ts`

`connectSshClient` Promise wiring → `establishSshClientConnection(client, authConfig, hooks)`. Class still resolves auth, assigns `this.sshClient`, and supplies `updateDeviceRuntimeStatus` / `onError` / `shutdownInternal`.

### `ssh-control-channel.ts`

`openReaderChannel` → `openSshReaderChannel` (default stderr path is `onUnboundStderr`; the class still gates it with `!manualDisconnect` then `callbacks.onError`). `reconnectControlClient` → `reconnectSshControlClient(ctx)` with live getters so `connected` / `manualDisconnect` / restart count are read after the backoff `await`, same as before.

### Left in the entry class

`connect` / `disconnect` / `sendInput*`, core hooks, `openCommandChannel` bootstrap+version check, `openControlChannel`, `handleControlChannelClose`.

## Metrics

McCabe = 1 + `if` / `for` / `while` / `&&` / `||` / `?:` / `??` / `catch`. Length is function span. Implementation CC is unchanged except reconnect’s two `!connected || manualDisconnect` tests became `!ctx.isLifecycleActive()` (predicate still `connected && !manualDisconnect` at the call site).

| Symbol | Before | After |
|---|---|---|
| `ssh-external-connection.ts` | 770L | **403L** |
| `reconnectControlClient` | CC 13 / 57L | class CC 1 / 20L; `reconnectSshControlClient` CC 11 / 58L |
| `executeIsolatedShellCommand` | 71L (unnamed by lizard) | 71L, same body |
| `flushCommandBuffer` | 38L | 38L |
| `executeShellCommand` | 30L | 34L (session param) |
| `connectSshClient` | 57L | class 27L; `establishSshClientConnection` 48L |
| `openReaderChannel` | 49L | `openSshReaderChannel` 39L |
| `configureWindowStyle` | 51L | class CC 1 / 11L; `configureSshWindowStyle` 59L |
| `openControlChannel` | 43L | 49L (stayed; calls `openSshReaderChannel`) |
| `handleControlChannelClose` | 12L | 12L (stayed) |

Totals: 770L → 942L across four production files (+172 of imports / wrappers / types). Entry is under 450.

## Verification (`apps/gateway`)

- Scoped: `ssh-external-connection.test.ts` + `ssh-shell-session.test.ts` + `ssh-control-channel.test.ts` → **49 pass / 0 fail**
- `bun test`: **1734 pass / 0 fail** (baseline 1669; extras are this slice’s new cases plus other agents in the same worktree)
- `bunx tsc --noEmit -p .`: **20 errors**, same count as baseline. **None** in new production files. One pre-existing error remains in untouched `ssh-external-connection.test.ts:1091` (overrides callback may return `undefined`). Other errors are outside this scope (`telegram/service.ts`, `local-external-connection*.test.ts`, `ssh-auth-resolvers.ts`, `ws/*`, …).
- `bunx biome check` on the six scoped files: **clean**

## Skipped

- **`openControlChannel` / `handleControlChannelClose`.** Attach identity (`this.controlChannel === handle`), subscription, stderr tail, and close→reconnect are one state machine. A host bag would relocate `this.` without a seam.
- **Bootstrap / tmux-version check in `openCommandChannel`.** Mixed with `updateDeviceRuntimeStatus` + throw; still connection orchestration.
- **SSH/local sharing.** Explicitly rejected in a previous phase; out of scope.
- Did not reformat regions that were not moved. Did not run Playwright e2e (`apps/fe/tests`).

## Bugs found (not fixed)

Pre-existing, unchanged:

1. `executeIsolatedShellCommand` initializes `exitCode = 0` and only overwrites it on `exit`. A `close` without `exit` resolves as success.
2. Isolated-exec teardown and control-channel `write` swallow errors with empty `catch {}`.
3. `flushCommandBuffer` uses `Number.parseInt(exitCodeRaw, 10) || 0`, so a parsed `0` is fine but a NaN exit also becomes `0`.

No unrelated fixes.
