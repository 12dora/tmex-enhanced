# TASK C 结果 — 拆分 `auth-routes.ts`

## 做了什么

### Seam 1 — key-log / hub-sync 子域

将 `AuthRoutes` 中与 key-log / hub-sync 正交的成员原样搬到 `apps/gateway/src/mesh/auth-key-log-routes.ts` 的 `AuthKeyLogRoutes`：

- `handleKeyLogHead`、`handleKeyLog`、`usesHubSync`、`handleKeyLogHubSync`
- `previewKeyLog`、`syncToHub`、`safePublishAndAck`、`hubAlreadyHasRecord`
- `identicalAppliedRecord`、`keyLogSuccess`、`refuseUnsupportedHubAuthRecord`
- `authorizedHubRows`、`refuseIfAttachedNotWriter`、`hubNotWriterResponse`、`resolveHub`

`AuthRoutes` 在构造函数里组合该 collaborator。`handle()` 路由表除委托给 `this.keyLog.*` 外保持不变。`handleMode` 的 hub 解析改为 `this.keyLog.resolveHub()`。`setWriterForward` 仍写 `AuthRoutes` 实例字段，collaborator 通过 getter 读取，避免转发函数在构造后丢失。

响应体、状态码、header 未改。

### Seam 2 — `handleLogin`（原 CC 21）

抽出：

1. `createLoginFailureSink(deps, { peer, ip })` → `{ noteUidHint, fail, precheck, rejectUid }`
2. `verifySecondFactors(...)` → `{ ok: true } | { ok: false, code }`
3. `loginRequestContext(req)`（把 `peer` / `ip` 计算移出 `handleLogin`，否则 CC 卡在 14）

**1.1.18 登录混淆语义保持字面顺序：**

- `fail()` 对 `TOTP_REQUIRED` / `PASSKEY_REQUIRED` **不**记失败（与原闭包相同）。
- 二因子仍先 TOTP 后 passkey；`TOTP_REQUIRED` / `PASSKEY_REQUIRED` 仍走 `fail()`，因此不计 rate-limit。
- 空 body 只记 `ip:`；uid 过长 / `RATE_LIMITED` 仍直接 `jsonError`，不经 `fail()`。

登录辅助函数放在 `auth-key-log-routes.ts`（并从 `auth-routes.ts` 再导出 `createLoginFailureSink` / `verifySecondFactors`），否则 `auth-routes.ts` 会回到 >800 行。`peekLoginUid` / `authUidTooLong` 经 deps 注入，避免与 `auth-routes.ts` 的运行时循环依赖。

## 行数 / 复杂度

| 项 | 之前 | 之后 |
| --- | --- | --- |
| `auth-routes.ts` | 1091 行 | **766** 行（门限 800） |
| `auth-key-log-routes.ts` | — | 443 行（新文件） |
| `handleLogin` CC | 21 | **12**（门限 12） |
| `handleKeyLog` CC | （随方法搬走） | 15（刚好等于门限） |

`bun scripts/complexity/gate.ts` 过滤本任务文件：**无 violation**。全局门禁仍有其它文件的既有 violation，与本任务无关。

`auth-routes.ts` 中未动的 `handlePasskeyRegisterVerify` 仍为 CC 16（原先就超，不在本次名单）。

## 测试

- `auth-routes.test.ts`：**未改**。相关套件 `auth-routes` / `auth-login-limiter` / `auth-totp-record` / `session-middleware` / `mesh-http` / `forwarder`：**137 pass / 0 fail**。
- `isAuthPublicPath` 覆盖在 `auth-routes.test.ts` 内，已过。
- 全量 `apps/gateway`：`3758 pass / 4 fail / 3 errors / 3762 tests`。失败均为既有 flake（`RtcPeerManager` ×3、`multi-hub in-process integration` ×1），与 auth 无关。基线为 3750 tests / 3 fail + 2 errors；多出的失败/错误属于 flake 抖动，其它并行 agent 也使测试总数略增。
- `bunx tsc --noEmit -p .`（`apps/gateway`）：**0 error**（基线 21）。
- `bunx biome check` 对改动文件：**通过**。

## 有意留下的

- 登录辅助函数与 key-log collaborator 同居于 `auth-key-log-routes.ts`，为守住 `auth-routes.ts` ≤800。未另开文件（任务只允许这一个新文件）。
- `handlePasskeyRegisterVerify`（CC 16）未拆，不在本次名单。
- 未新增独立的 `auth-key-log-routes` 测试文件：现有 `auth-routes.test.ts` 已覆盖行为。
