# grok-harness-combined result

Part 1 (LAN D/H/I) and Part 2 (second-host env) in the split harness. Harness was **not** executed (no docker builds; commander runs it).

## Part 1 — LAN DataChannel (L1–L8)

`scripts/hub-e2e/split/run.sh` now runs the same D/H/I assertions twice via `run_direct_scenarios <kind>`:

| kind | rows | target | when |
|---|---|---|---|
| `lan` | **L1–L8** (REQUIRED, count as FAIL) | node-b (`docker exec tmex-split-node-b`) | immediately after E |
| `hub` | D1–D3 / H1–H3 / I1–I2 (unchanged policy) | hub (`rssh_docker exec tmex-split-hub`) | after LAN |

Helpers: `target_exec` / `target_bash` / `target_restart` / `target_ensure_tmux`, parameterized `dump_rtc_logs` / `rtc_evidence` / `write_mesh_path`.

LAN specifics:

- `direct enable` on node-a **and** node-b; restart node-b; `wait_local_healthy`; recreate `e2e-b` tmux; refresh `PANE_B` from tmux-tree (`DEVICE_B_ID` lives in the volume).
- UDP drop is still node-a `OUTPUT -p udp DROP` (host ICE is UDP; TCP/WSS uplink stays).
- Evidence files are suffixed (`*-lan.json`, `direct-logs-node-b.txt`, …). Hub files keep original names.

Why LAN exists: node-a↔hub DC does not establish here (VPS inbound UDP filter, symmetric NAT, no TURN-over-TCP). L1–L8 exercise interruption + bulk over the docker `lan` that is already connected from C.

## Part 2 — second remote host

All previous hardcodes are env with the old values as defaults (existing invocation unchanged):

| var | default |
|---|---|
| `TMEX_E2E_HUB_HOST` | `ai.jiefakj.com` |
| `TMEX_E2E_HUB_IP` | `43.248.129.233` |
| `TMEX_E2E_HUB_PORT` | `18443` |
| `TMEX_E2E_REMOTE_USER` | `root` |
| `TMEX_E2E_REMOTE_DIR` | `/root/tmex-e2e` |
| `TMEX_E2E_REMOTE_SUDO` | empty; `sudo` when user≠root |
| `TMEX_E2E_TLS_MODE` | `letsencrypt` \| `private-ca` |

`HUB_PUBLIC_URL`, local `extra_hosts`, Caddy site (template `__HUB_HOST__`/`__HUB_PORT__` → `Caddyfile.runtime`), TURN `--external-ip`, `sync_clocks` / `preflight_udp` / `.compose-bind.yml` all follow host/ip/port. Every remote `docker`/`compose` goes through `rssh_docker` / `DOCKER=(sudo docker)`.

`private-ca`: SAN check on `ca/hub.crt` (already `hub.tmex.test` + `entry.tmex.test`); reissue leaf from existing CA if host missing; rsync `ca/`; mount certs + `NODE_EXTRA_CA_CERTS=/ca/ca.crt`; `curl_hub --cacert`; Playwright `--insecure-tls` (F TLS checks weaker).

Example:

```bash
TMEX_E2E_HUB_HOST=hub.tmex.test TMEX_E2E_HUB_IP=118.195.194.170 \
  TMEX_E2E_REMOTE_USER=ubuntu TMEX_E2E_REMOTE_DIR=/home/ubuntu/tmex-e2e \
  TMEX_E2E_TLS_MODE=private-ca \
  RSSH=… RSYNC_SSH=… TMEX_TARBALL=… scripts/hub-e2e/split/run.sh
```

## Verified

- `bash -n` on `run.sh`, `setup-remote.sh`, `setup-local.sh`
- `shellcheck` not installed (`brew list shellcheck` missing) — skipped
- `docker compose config` on both compose files: default env and `HUB_HOST=hub.tmex.test HUB_IP=118.195.194.170 REMOTE_USER=ubuntu REMOTE_DIR=/home/ubuntu/tmex-e2e TLS_MODE=private-ca` (plus TLS_CERT/KEY/CA_CRT as `run.sh` would export). Nested compose defaults work; extra_hosts/aliases/TURN IP interpolate.
- `bunx biome check scripts/hub-e2e/split/browser.ts` — **pre-existing** format/import-order failures on the original file; this change does not add new diagnostics. Did not reformat the whole file.
- No live harness / docker build.

## Open issues

- `TMEX_E2E_TLS_MODE` is interpreted by `run.sh`/`setup-remote.sh`, not by compose YAML. `compose config` with only the five new-host env vars still points caddy at `${REMOTE_DIR}/certs/fullchain.pem` until setup-remote exports `TMEX_E2E_TLS_CERT`.
- Hub D2/H/I still FAIL-with-evidence when WAN UDP is blocked; that is intended.
- Scenario I/L7–L8 still assert REST `/api/files/raw`, not browser bulk DataChannel.
