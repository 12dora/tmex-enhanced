# grok-harness-netem result

Optional `TMEX_E2E_LAN_NETEM` shaping on the split-harness LAN bridge. Harness / docker builds were **not** run.

## Changes

### `scripts/hub-e2e/Dockerfile`
- Added `iproute2` to the apt list (`ip`, `tc`). `iptables` was already present.

### `scripts/hub-e2e/split/run.sh`
- Env `TMEX_E2E_LAN_NETEM` (e.g. `delay 80ms rate 16mbit`). Unset/empty = no shaping (`set -u` via `${…:-}`).
- Before L scenarios, on **node-a and node-b**:
  1. Docker-inspect the container IP on `tmex-split-local_lan`
  2. Match that IP in `ip -4 -o addr` (exact prefix, not regex; strip `ethN@ifM`)
  3. `tc qdisc del … root` (ignore missing) then `tc qdisc add dev <iface> root netem $TMEX_E2E_LAN_NETEM`
- Re-applied after L1’s `docker restart` (qdisc does not survive restart). Apply waits up to 15s for the lan iface to reappear.
- Cleared (`tc qdisc del`) after L returns and in `cleanup_on_exit` (EXIT trap), before WAN D/H/I.
- L2 evidence appends `tc qdisc show` for both nodes. Report header has `- lan netem: …`.
- Missing `ip`/`tc` or iface → log warning and continue L; evidence shows `none`.

### `docs/hub/2026082801-hub-docker-e2e.md` (分体拓扑)
- Env table row, example invocation, NET_ADMIN / `iproute2` note, L-row + L2 qdisc evidence. Notes both-end delay ≈ 2×.

## Verified
- `bash -n scripts/hub-e2e/split/run.sh` — OK
- Dockerfile apt list includes `iproute2` next to `iptables`
- Local awk check of `ip -4 -o addr` matching (`172.28.0.3` → `eth1` / `eth1@if42`)
- `bunx biome check` — no JS/TS in scope; biome processes 0 files (exit 1 “No files were processed”). N/A.
- No package `bun test` / `tsc` — shell + Dockerfile + markdown only
- Did not run the harness or docker builds

## Open issues
- Images built before this change lack `iproute2`; netem needs a rebuild (`TMEX_E2E_SKIP_BUILD=1` is not enough).
- Shaping both ends doubles one-way delay (documented).
- Apply failure does not FAIL L by itself; L2 evidence is the signal.
