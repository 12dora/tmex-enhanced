# RV1 — Code review: Nodes page "Upgrade all" + disabled states (frontend)

You are a strict but pragmatic code reviewer. Read-only. Output the full review as your FINAL MESSAGE.

Repo: `/Users/konata/code/tmex-enhanced-wt-r13` (Bun monorepo, React FE in `apps/fe`). The diff under review is in `/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/RV1-diff.patch` (commit `0e5614a7`). Spec the author followed: `sub/O1-prompt.md`; author's report: `sub/O1-result.md`.

Context you need: `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts` is a per-node upgrade state machine (POST → poll → version readback). The new `upgrade-batch.ts` orders nodes (non-hub → remote hub → self), runs the first group with concurrency 3, suppresses per-node toasts, shows one summary toast. Rows come from `apps/fe/src/node/mesh-nodes.ts` (`NodeRow`).

Review for: correctness bugs (races between the batch and manual per-row clicks, abort/unmount handling, stale closures over `rows`/`latest`, progress counting, hub/self ordering when self is also the hub, `alreadyLatest` counted as success, failure of the hub group blocking self, i18n plural keys for en), React pitfalls, and copy consistency across the three locales. Classify each finding as **blocker / should-fix / nit** with file:line and a concrete failing scenario. Do not pad; if something is fine, say so briefly. Do not propose large refactors.
