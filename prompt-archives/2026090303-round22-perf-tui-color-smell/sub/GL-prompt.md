# TASK GL

Backend standby-cost items R9, R10, R13, R7 from the exploration report
`/Users/konata/code/tmex-r22/prompt-archives/2026090303-round22-perf-tui-color-smell/sub/EX3-standby-cost.md`
(read sections 3, 4, 7 (those rows) and 8 first).

### R9 — RTC data-channel upgrade: add a terminal "give up" state
### R10 — lazy-load `node_datachannel`
### R13 — `[tmux-metrics]` gated by log level instead of `isManagedExternally()`
### R7 — replay trimming: `Array.shift()` → head cursor / ring

Files you own: `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts`, `mesh/peer-dc-upgrade.ts`,
`mesh/rtc/rtc-peer-manager.ts`, `tmux-client/local-external-connection.ts` (metrics lines only),
`system/managed.ts`, `retention/policy-scheduler.ts`, `retention/types.ts`, and their tests.
NOT `mesh/rtc/data-channel-carrier.ts`, `mesh/peer-manager*.ts`, `mesh/mesh-runtime.ts`,
`mesh/stream-*.ts`, `mesh/forwarder.ts`, `retention/replay-store.ts`, `ws/*`.

Result file: `/Users/konata/code/tmex-r22/prompt-archives/2026090303-round22-perf-tui-color-smell/sub/GL-result.md`
