# EX1 — Explore: node remote-upgrade backend path (read-only)

You are a read-only code explorer. Do NOT modify files. Output the complete report as your FINAL MESSAGE (you cannot write files in this sandbox).

Repo: tmex monorepo (Bun runtime). Key packages: `apps/gateway` (server), `packages/app` (npm `tmex-cli`: installer/upgrader CLI + runtime bundle), `packages/shared`, `packages/api-client`, `apps/fe` (React).

## Context

The product has a hub/node mesh. From the web UI (Settings → Nodes), a user can click "Upgrade" on a remote node. The hub-side endpoints are roughly `/api/mesh/upgrade/latest`, `POST/GET /api/mesh/nodes/:id/upgrade`, which forward over the peer link to the target node's `/api/system/upgrade` (which invokes the crash-safe upgrader in `packages/app`). Node versions are shown from `peer_cache.inventory_json` / `node.list`.

Two field bugs were reported on a mixed-version mesh (local node 1.1.10, remote hub named `tmex` 1.1.5, other nodes 1.1.6/1.1.5, a docker node 1.0.2):

- **Bug A**: Clicking Upgrade on some nodes (e.g. `docker-node`, running inside a docker container without systemd/launchd) shows "this node does not support in-app upgrade". Find exactly what condition produces that message (which check, where — gateway, upgrader preflight, service manager detection, install layout detection, legacy target version too old, etc.) and whether an in-app upgrade could legitimately work for a docker/no-service-manager install (e.g. upgrade files + let the container restart, or exec-replace the process).
- **Bug B**: Clicking Upgrade on the node `tmex` (the remote hub, table shows 1.1.5) immediately reports "already updated to 1.1.10" although nothing happened. Hypothesis: the request was resolved against the local gateway's own `/api/system/*` instead of the remote, or the version readback reads the wrong node, or the node id mapping (`hub` vs self) goes wrong when the local node is *not* the hub. Trace the whole path and identify the real cause with file:line evidence.

## Also collect (for a planned "Upgrade all" feature)

1. Exact request/response shapes of `/api/mesh/upgrade/latest`, `POST /api/mesh/nodes/:id/upgrade`, `GET /api/mesh/nodes/:id/upgrade` (types, status enum, error codes), and where they live (routes + service files).
2. How a node's current version reaches the UI (`node.list` payload, `peer_cache`, refresh cadence, what triggers a refresh after an upgrade finishes) — is there a stale-version problem after an upgrade completes?
3. How the local node itself (self) is upgraded from the UI (which endpoint), and whether the same flow works when self is not the hub.
4. Concurrency: is there any guard against upgrading several nodes concurrently, and any guard against upgrading the hub while it is relaying other upgrades? What happens to in-flight forwarded upgrade requests when the hub restarts mid-upgrade?
5. Tests that exist for this path (file names) and the current `bun test` baseline command per package.

## Output format

Markdown report with sections: Bug A root cause (with file:line), Bug B root cause (with file:line), API shapes, version propagation, concurrency notes, tests, recommended minimal fixes (bullet list, with files to touch). Be precise; cite file paths and line numbers. Do not speculate without evidence — say "unverified" if unsure.
