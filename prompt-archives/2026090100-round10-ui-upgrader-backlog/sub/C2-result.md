# C2 结果：远程节点升级 — Gateway 后端

## 端点

全部要求本地 session（`requireSession`）。不走 `/api/mesh-internal/*`，不改 uplink / peer-manager / Hub 协议。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/mesh/upgrade/latest` | 解析 GitHub latest，且必须存在 `tmex-cli-<v>.tgz`。返回 `{ latestVersion, changelog, publishedAt }`，**不含**入口节点 `hasUpdate` / `currentVersion`。失败 → `RELEASE_UNAVAILABLE` 502 |
| POST | `/api/mesh/nodes/:nodeId/upgrade` | 空 body。Gateway 自己解析 latest。本机直接调 `upgradeController.start`；远程先 `GET /api/system/info`，再 `POST /api/system/upgrade { version }`（POST 不重试） |
| GET | `/api/mesh/nodes/:nodeId/upgrade` | 本机：`upgradeController.status()`；远程：转发 `GET /api/system/upgrade`（GET 按现有 forwarder 可重试） |

`:nodeId` 为本机 id 或 `self` 时走本机路径。

### 错误码与 HTTP

| code | HTTP | 何时 |
|---|---|---|
| `NODE_LOGIN_REQUIRED` | 401 | 远程无 `tmex_s_<nodeId>` session |
| `NODE_UNREACHABLE` | 503 | PeerLink / stream 打不开 |
| `UPGRADE_NOT_ALLOWED` | 403 | 目标 `canSelfUpdate===false` 或目标 403 |
| `UPGRADE_IN_PROGRESS` | 409 | 本机 `start()` 失败或目标 409（附带目标 status 字段） |
| `UPGRADE_ALREADY_LATEST` | 409 | 目标 `baseVersion` 已 ≥ latest（无法解析的版本不当作已最新） |
| `UPGRADE_UNSUPPORTED` | 404 | 目标 404（含旧节点没有 upgrade/info） |
| `RELEASE_UNAVAILABLE` | 502 | GitHub 失败或缺少 tarball |
| `NOT_FOUND` | 404 | 未登记或已撤销（设计未列此码） |

成功 POST/GET upgrade 返回目标 `UpgradeStatus`。

## 改动文件

- `packages/shared/src/contracts/system.ts` — `MeshUpgradeErrorCode` / `MeshUpgradeLatest` / `MeshUpgradeError`（仅类型）
- `apps/gateway/src/system/update-check.ts` — 抽出 `fetchLatestGithubRelease`、`requireLatestUpgradeRelease`
- `apps/gateway/src/system/upgrade-service.ts` **新** — latest / start / status 与错误映射
- `apps/gateway/src/api/system.ts` — 本机 start/status 复用 `startLocalUpgradeAttempt` / `readLocalUpgradeStatus`（对外 `/api/system/upgrade` 响应形状不变）
- `apps/gateway/src/mesh/forwarder.ts` — `forwardAuthorizedHttp`（带目标 session；GET 可重试，POST 不重试；复用 `adaptResponse`）
- `apps/gateway/src/mesh/mesh-routes.ts` — 三条路由 + 节点登记校验
- `apps/gateway/src/mesh/mesh-http.ts` — 注入 `forwarder.forwardAuthorizedHttp`
- 测试：`update-check.test.ts`、`upgrade-service.test.ts` **新**、`mesh-routes.test.ts`、`forwarder.test.ts`、`system.test.ts`（既有用例仍覆盖本机 400）

未改：`upgrade.ts` 控制器行为、FE、i18n、uplink、`/api/mesh-internal/*`。

## 验证数字

| | 前 | 后 |
|---|---|---|
| `bunx tsc --noEmit -p .` 输出行数 | 50 | 50 |
| `error TS` 条数 | 21 | 21 |
| `bun test src/mesh src/system src/api` | **992 pass / 0 fail**（84 files） | **1025 pass / 0 fail**（85 files） |
| `bunx biome check`（全部改动文件） | — | clean |

基线 tsc 的 `wc -l=50` 对应 21 条 `error TS`（用户说的 ~21）。未增加。

## 相对设计的偏差

1. **HTTP 状态**：设计只给了稳定 `code`。`UPGRADE_ALREADY_LATEST` 用 409（与 `UPGRADE_IN_PROGRESS` 靠 `code` 区分）。
2. **未登记/已撤销** 返回 `NOT_FOUND` 404，不在设计码表里。
3. **远程先 GET `/api/system/info`**（设计为可选）：用 `baseVersion` 做 already-latest，并用 `canSelfUpdate===false` 短路，避免对托管节点发破坏性 POST。info 非 200 走同一套 404/403/409/401/503 映射。
4. **无法解析的当前版本不当作已最新**（`unknown` / `1.2.3_dev`），避免 `compareVersions` 对非法输入返回 0。
5. **`self` 当作本机 nodeId**，与 `/n/self/` 一致。
6. **升级后 `/healthz` 确认版本** 属于 FE 轮询，后端未做。
7. **`requireLatestUpgradeRelease` 比 `checkForUpdate` 更严**：没有 tarball 时 mesh latest 直接 `RELEASE_UNAVAILABLE`；本机 update-check 仍可回报 `latestVersion` 且 `hasUpdate=false`。
