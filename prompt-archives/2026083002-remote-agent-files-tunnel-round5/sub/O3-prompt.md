# Task O3 — Link badge: real reach + latency (frontend)

Read `common-rules.md` in this directory first (ground rules, baselines, fixed contracts).

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-devices-report.md section 6.

## Scope (files you own)
- apps/fe/src/node/mesh-nodes.ts (+ test), apps/fe/src/node/device-node-badges.tsx (+ new test), apps/fe/src/node/direct-diagnostics.ts, apps/fe/src/node/mesh-events.ts (only if the node event payload parsing needs the new fields)
- i18n: only `nodes.reach` and `nodes.badge` sub-objects.

## Context
Backend (agent G2, in parallel) changes `GET /api/mesh/nodes` rows and node-change events to carry `reach: 'lan' | 'wan' | 'relay' | null`, `transport`, and `rttMs` (entry↔node ping RTT, may be null). Contract: `MeshNode` in packages/api-client/src/auth/types.ts. Today the fe `NodeRow`/`mergeNodes` drop `transport`, and the badge shows two labels ("局域网" + "中转 · 延迟未知") that confuse users.

## Requirements
1. Keep `transport` and `rttMs` in `NodeRow` / `mergeNodes` / event handling (update on events).
2. `DeviceNodeBadges`: render ONE badge (keep the click-to-open ICE diagnostics popover):
   - browser direct (WebRTC) active (`diagnostics.path === 'direct'`): label "直连 · {rtt}ms" (WebRTC rtt), tone ok.
   - else by reach: `lan` → "局域网", `wan` → "公网", `relay` → "经 Hub 中转", null → "不可达"; append " · {rttMs}ms" when `rttMs` is a number, else no latency suffix (do NOT show "延迟未知" any more — remove that key). tone ok for lan/wan/direct, muted for relay/none.
   - en: "Direct", "Local network", "Internet", "Via hub", "Unreachable"; ja equivalents concise.
   - Popover keeps the ICE rows and adds rows "到达路径" (reach label) and "承载" (transport: ws-secure → "WebSocket", dc → "WebRTC", relay → "Hub relay").
3. Tests for badge label matrix and for mesh-nodes keeping transport/rttMs across merge/events.

Verify: `cd apps/fe && bun test src/ && bunx tsc --noEmit -p .` + biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O3-result.md
