# G4 结果 — TLS upsert / mesh login / hub enroll-redeem / route-input

## 改动文件

| 文件 | 摘要 |
| --- | --- |
| `apps/gateway/src/tls/tls-config-store.ts` | `SECRET_SPECS` + `MERGE_KEYS` / `NULLABLE_KEYS` 表驱动 `upsert`；`onConflictDoUpdate` 用 `values` 解构省略 `id`，保留 `'key' in patch` vs `??` 的 null 语义 |
| `apps/gateway/src/mesh/auth-routes.ts` | `handle` 改为 method+path 路由表；login 拆成 envelope 解析 / binding / delegation / session 签发；校验走 `requiredStrings` |
| `apps/gateway/src/hub/hub-runtime.ts` | `handleRequest` 用 `matchPath` 路由表（先精确 `redeem` 再 `:id`，错 method 仍 405）；enrollment 授权校验抽出；redeem 拆 parse + 事务 + 成功 payload |
| `apps/gateway/src/api/route-input.ts` | **新建**。`requiredStrings` / `requireBodyString` / `decodeB64url` / `requireB64url` / `validationError`；业务错误码仍留在各 route |
| `apps/gateway/src/api/route-input.test.ts` | **新建**。覆盖空串 vs 缺字段、b64url 长度、hub 风格 `{ error }` |

`apps/gateway/src/api/http.ts` 已有 `readJsonObjectBody`，但不在 G4 可改范围，因此新建 `route-input.ts` 而不是扩展 `http.ts`。

## `git diff --stat`

已跟踪文件（`git diff --stat`）：

```
 apps/gateway/src/hub/hub-runtime.ts      | 596 +++++++++++++++----------------
 apps/gateway/src/mesh/auth-routes.ts     | 454 ++++++++++-------------
 apps/gateway/src/tls/tls-config-store.ts | 166 +++------
 3 files changed, 524 insertions(+), 692 deletions(-)
```

未跟踪新文件（`git status` 显示 `??`）：`route-input.ts` 49 行、`route-input.test.ts` 32 行。合计约 **+605 / −692，净 −87**。

## 行数（`wc -l`）

| 文件 | before | after | Δ |
| --- | ---: | ---: | ---: |
| `tls-config-store.ts` | 241 | 185 | −56 |
| `auth-routes.ts` | 985 | 897 | −88 |
| `hub-runtime.ts` | 790 | 766 | −24 |
| `api/route-input.ts` | 0 | 49 | +49 |
| `api/route-input.test.ts` | 0 | 32 | +32 |
| **合计** | **2016** | **1929** | **−87** |

目标净 −80，达成。

## 测试 / tsc / biome

**Before**

- 范围内测试：`tls-config-store` + `auth-routes` + `hub-runtime` → **41 pass / 0 fail**
- `bunx tsc --noEmit -p .`：`error TS` **21**（既有，不在本范围）
- biome：未改文件前未跑

**After**

- 范围内：上述三个 + `route-input.test.ts` → **43 pass / 0 fail**（+2 新测）
- 全量 `cd apps/gateway && bun test`：**2497 pass / 0 fail**（基线提示 2482；差额含本范围 +2 及其它并行 agent 新增用例）
- `bunx tsc --noEmit -p .`：本范围文件 **0 条新错误**。gateway 包内仍是 **21** 条既有 TS 错误。另有 `packages/shared/src/link/fragment-core.ts` 约 20 条，属其它 agent，未动。
- `bunx biome check` 上述 5 个文件：**clean**

## 行为保持

- TLS：`upsert` 加密私钥、`get()` 不回明文；partial 更新 vs `acmeAccountKey: null` / `acmeAccountUrl: null` 只清对应字段（`tls-config-store.test.ts` 原用例）
- Login：错误码、failure counter、二次 rate-limit、本机 `self` vs 真实 nodeId 入口等价（`auth-routes.test.ts` happy path / failure codes / TOTP / passkey）
- Hub：未授权 401；create→redeem 推送 `enroll.redeemed`；幂等 replay / `node_exists` 409；事务边界未改

## Bugs

未发现需要单独修的生产 bug。`issue()` 本身不返回 `{ code }`，空 passkey credential 在签发前 `fail('DELEGATION_BAD_SIGNATURE')`，与原先 `issuePasskeySession` 一致。

## 故意跳过

- **`mesh-routes.ts`**：`handleRtcAuthorize` 有 `typeof … !== 'string'` + `MALFORMED` 检查，但是嵌套 `fp_browser` 对象，不是 hub 的 `missing ${key}` / `invalid b64url`。按规则留给其它 agent。
- **`http.ts`**：已有 JSON body 读取，但不在可改名单；未扩展。
- 未改 CHANGELOG / 版本号 / 构建脚本。
- 未触碰 `emitOsc`、`encodeMouseEvent`、`classifySshError`、control-mode `parse`、`dispatchPaneStreamByte`、`runInit`、`sanitizeBunPath`。
