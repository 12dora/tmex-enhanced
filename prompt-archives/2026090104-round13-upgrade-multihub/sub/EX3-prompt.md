# EX3 — Explore: hub/mesh architecture for multi-hub support (read-only)

You are a read-only code explorer and architecture analyst. Do NOT modify files. Output the complete report as your FINAL MESSAGE (you cannot write files in this sandbox).

Repo: tmex monorepo (Bun runtime). Gateway in `apps/gateway`; mesh/hub code lives under `apps/gateway/src/mesh/**`, `apps/gateway/src/hub/**` (or similar — locate it), shared link/auth types in `packages/shared/src/**` (look for `link`, `mesh`, `hub`, `uplink`, `peer`). Design docs: `docs/hub/2026082700-hub-node-architecture.md` (v3.2), `docs/hub/2026082800-hub-node-operations.md`. Read the design doc first.

## Goal

Today a mesh has exactly ONE hub: nodes keep an uplink to it; the hub owns the user directory, user key log, node registry/certs, enrollment tokens, and relays traffic (`/n/:nodeId/...`) between nodes and browsers. The user wants: **within one mesh (same network), allow more than one hub**, so that clients/nodes can attach to the nearest hub (lowest latency) and there is redundancy when one hub goes down. Data must stay synchronized between nodes/hubs.

## Please produce an architecture-analysis report covering

1. **Current hub state inventory**: every DB table / in-memory structure the hub owns (name, schema file/migration, writer, reader), and for each: is it append-only (log), last-writer-wins safe, or does it require a single authority (e.g. monotonic counters, unique enrollment token redeem, node cert issuance, revocation)? Cite files.
2. **Current topology & protocol**: how a node discovers/connects to the hub (uplink URL from join string / env), the uplink handshake, `peer_cache`/inventory gossip, how `node.list` is assembled, how relays route `/n/:id`, how browsers pick where to connect (RTC direct / relay), and how LAN "upgrade" to direct connection works. Identify every place that assumes "exactly one hub" (config keys, `role` values like `hub,node`, `hubId`, `isHub`, single uplink, join-string format, trust anchors / CA fingerprint `hub_trust`).
3. **Trust model constraints**: the design doc says the hub is NOT a trust root and "compromise of any point only affects that point". Explain what the user key log / node certs / key.log catch-up mechanism is and how a second hub could participate without becoming a new trust root (e.g. both hubs replicate the same signed logs; nodes verify signatures themselves).
4. **Design options for multi-hub** (at least 3, from simplest to full), e.g.:
   - (a) Active/standby: secondary hub is a plain node that mirrors hub state (append-only logs replicate over the existing peer link), nodes hold an ordered list of hub URLs and fail over; only one hub accepts writes at a time (leader by fixed priority or lease).
   - (b) Multi-primary with append-only replicated logs + deterministic conflict rules (unique-token redeem must be single-authority → route to owner hub; everything else CRDT-ish/LWW).
   - (c) Full consensus (raft) — probably out of scope; say why.
   For each: what changes in schema, protocol messages, join string, CLI (`hub join` / `enroll`), FE (nodes page shows hub role per node, "promote to hub"), how nodes pick the lowest-latency hub (probe RTT to all hub URLs, sticky choice, periodic re-probe), how browsers pick, and how relays work when browser is on hub A and target node is uplinked to hub B (hub-to-hub forwarding).
5. **Recommendation**: the option you'd pick for a first shippable increment that a single engineer team can build in ~1–2 days with parallel agents, with a concrete file/module-level task breakdown (backend modules, shared types, CLI, FE, tests incl. the docker harness `scripts/hub-e2e/`), and the list of hard risks (split-brain, duplicate node ids, key log divergence, revocation propagation, upgrade of mixed versions).
6. Existing tests for mesh (unit/integration under gateway, docker harness) and how a second hub could be added to the docker compose topology.

Be concrete with file:line citations. Mark anything unverified. Length: as long as needed, but structured with headings and tables.
