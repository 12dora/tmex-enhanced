# grok-harness-direct result

Split harness now asserts a real DataChannel (`transport=dc`), mid-stream UDP interruption without SEQ gaps, and 8 MiB file read over the mesh link with REST fallback. Harness was **not** executed (credentials stay with the commander; no docker builds).

## What changed

- `nodes.ts`: `MeshNode.transport`; new `wait-transport --name --transport {dc|relay|ws-secure}` (works for hub id or `node-b`).
- `terminal.ts`: `--capture-seq --expect-count N` captures the entry WS stream (what the browser would see), optional `--input-file` / `--ready-file`.
- `files.ts`: `raw` / `sha256` fetch `/api/files/raw` as bytes and print sha256 + `x-tmex-*` headers. Bulk DC is **browser-only** (`BulkClient` label `bulk:<id>`); REST has no bulk-via-dc header.
- `split/run.sh`:
  - D1 `direct_capable`; D2 `wait-transport dc` **FAIL** (not SKIP) if stuck on relay, with `[mesh][rtc]` excerpts in `out/direct-logs-*.txt` and the evidence column; D3 marker after dc; `out/direct-path.json` includes `transport`.
  - H1–H3: SEQ_1..400 producer, UDP drop on node-a mid-stream, relay ≤30s, contiguous SEQ on the driver WS, undrop then dc ≤90s.
  - I1–I2: 8 MiB random file on remote hub, sha256 via entry `/n/<hubId>/api/files/raw`; repeat under UDP drop.
  - UDP drop: iptables → nft → runtime `apt-get install iptables` → `docker network disconnect/connect` nat-a (last also bounces uplink). `undrop` on EXIT.
- `docker-compose.local.yml`: `cap_add: [NET_ADMIN]` on node-a/node-b.
- Docs 分体拓扑: scenario table D/H/I, NET_ADMIN / STUN / bulk-browser-only notes.
- Pure helpers + tests: `seq.ts` (gap detection), `mesh-row.ts`, `hash.ts`.

## Verified

- `bash -n scripts/hub-e2e/split/run.sh`
- `bun test scripts/hub-e2e/driver/` — 29 pass (existing totp + new helpers)
- `bunx biome check` on changed TS — clean
- `scripts/hub-e2e/build-driver.sh` regenerated `driver-dist/{nodes,terminal,files,login}.js`
- No app-package `tsc` project applies; scripts are Bun CLI. Did not run the live harness or docker build.

## Open issues

- Image still has no iptables/nft in the Dockerfile apt list (out of scope). H prefers iptables; if apt-get in the container fails, network bounce may drop SEQ and fail H2.
- Scenario I asserts REST correctness + fallback, not the browser bulk DataChannel path.
- Live D2/H/I still need reachable STUN and the concurrent gateway `transport` / `[mesh][rtc]` contract.
