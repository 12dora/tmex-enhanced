# G8 Implementation Plan — Cloudflare Access + JWT + external tunnel

**Goal:** Optional Cloudflare Access management, origin JWT enforcement, exposure acknowledgement (replacing `auth_required`), and discovery/adoption of an already-running system cloudflared.

**Architecture:** New `apps/gateway/src/tunnel/access-*.ts` modules. Credentials encrypted like TLS secrets. Guard runs on requests that carry `cf-connecting-ip`. Hook: one call in `mesh-http.handleRequest` plus assemble fetch (standalone never hits mesh). Schema/migration 0029 already scaffolded by commander.

**Tech stack:** Bun, drizzle/sqlite, Web Crypto RS256 (no jose), Cloudflare v4 API.

Commander-scaffolded (keep shape): `tunnel_config.externally_managed` / `exposure_acknowledged_at`, table `tunnel_access`, journal `0029_tunnel_access`. Need snapshot + stores + logic.
