# Task D6-1 — documentation: hub/node operations guide and deployment doc rewrite

Context: design `docs/hub/2026082700-hub-node-architecture.md` (v3.2), implementation reports in `prompt-archives/2026082701-hub-multinode-design/sub/*-result.md` (read: `c5-1`, `c5-2`, `c5-3`, `c5-4` for CLI; `b2-2b-fix`, `b2-5`, `b2-6` for HTTP contract; `b2-3`, `b2-4` for startup matrix and env; `b3-1`, `f3-1` for direct connection behaviour; `f4-1`, `f4-3`, `f4-4` for UI flows) and the repo's doc conventions in `AGENTS.md` (docs in `docs/<module>/`, filename `YYYYMMDDNN-short-english-name.md`, Simplified Chinese, Chinese punctuation, technical audience at junior-engineer level, no redundancy). Existing outdated doc: `docs/2026021000-tmex-bootstrap/deployment.md` (JWT/login sections are obsolete).

Deliverables (Chinese):
1. `docs/hub/2026082800-hub-node-operations.md`: 部署矩阵（standalone / node / hub,node 与 env 变量：`TMEX_ROLES`, `TMEX_HUB_URL`, `TMEX_HUB_PUBLIC_URL`, `TMEX_PEER_PORT`, `TMEX_PEER_BIND_HOST`, `TMEX_STUN_SERVERS`, `TMEX_TURN_*`, `TMEX_TRUST_PROXY`, `TMEX_NATIVE_DIR`），首次搭 hub（`init --role hub,node` → `hub user add` → `enroll` → 各机 `hub join`）、Nodes 页 enrollment/admit/revoke、passkey 注册与 TOTP、`direct enable|disable` 与平台支持、Cloudflare Tunnel 场景（`TMEX_TRUST_PROXY`）、hub 离线行为、灾难恢复（`mesh reset-root`、`hub user reset`）、常见排障（4401、`NODE_LOGIN_REQUIRED`、`NODE_UNREACHABLE`、`KEY_LOG_FORK`、`HUB_TIMEOUT`、direct 降级）、安全边界摘要（引用设计 §5 表格，不复制整表）。
2. Rewrite the auth/deployment parts of `docs/2026021000-tmex-bootstrap/deployment.md`: remove JWT/OIDC content, point to the operations doc, keep the still-valid install/service content.
3. Only claim behaviour that the reports show as implemented; mark known limitations from the reports (e.g. v1 offline LAN uses cached addresses only; musl/Windows not supported for direct).

File scope: `docs/**` only. Result: `prompt-archives/2026082701-hub-multinode-design/sub/d6-1-result.md` (list of sections and which report each claim is based on).
