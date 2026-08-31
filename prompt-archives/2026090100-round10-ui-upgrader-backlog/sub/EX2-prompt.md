# EX2: Remote node upgrade feature exploration (read-only)

You are a read-only code explorer for the tmex monorepo (Bun runtime; gateway in `apps/gateway`, CLI/installer in `packages/app`, shared code in `packages/shared`, frontend in `apps/fe`). Do NOT modify files. Output your FULL report as your final message.

## Goal

We want a new feature: in Settings → Node management (节点管理), each node row's actions get an "Upgrade" button that upgrades THAT node (possibly a remote mesh peer) to the latest released version. Design the full chain based on what exists.

Explore and report:

1. **Existing self-upgrade infra**: `apps/gateway/src/system/upgrade.ts` (UpgradeController — Web-triggered background upgrade of the local install), `apps/gateway/src/api/system-routes.ts` (endpoints, auth), how the FE triggers/tracks it today (search FE for upgrade UI — round9 added a BIOS-style upgrade; where is it surfaced?). Report the API contract, states, and preconditions (serviceMode, install-dir detection via `apps/gateway/src/system/install-info.ts`).
2. **Mesh node inventory & control channel**: `/api/mesh/nodes` shape (`peerAddress/linkSinceAt/endpoints/directFailure` fields added in round9), how hub and nodes communicate (uplink? relay? peer WS?), and crucially: is there ANY existing mechanism for one node to invoke an action/API on another node (e.g. the Files multi-node feature proxies file APIs to other nodes — how does that work? `FilesNodeSection`, files roots API). Identify the transport we can reuse to tell a remote node "start your Web upgrade".
3. **Node management settings UI**: the settings page listing nodes with an actions column (设置-节点管理) — component files, existing actions (e.g. leave/remove?), how it fetches node data, i18n resource locations for its strings.
4. **Version info**: how a node's current version is known to peers (healthz version? node.list metadata?), and how "latest" is determined (GitHub Releases lookup lives where? `packages/app/src/lib/release-fetch.ts`, gateway `stageGithubRelease()`?).

## Deliverable

A concrete implementation design: proposed API endpoint(s) on the local gateway (e.g. POST /api/mesh/nodes/:id/upgrade), how the request reaches the remote node over the existing mesh transport (name exact modules/message types to extend), what the remote node executes (reuse UpgradeController), how progress/errors flow back to the FE, and the FE touch points. Split into a backend work package and a frontend work package with explicit file lists (so two agents can work without overlapping files). Flag risks (e.g. node upgrading itself kills the connection mid-flight; hub vs leaf differences; old-version nodes lacking the endpoint).
