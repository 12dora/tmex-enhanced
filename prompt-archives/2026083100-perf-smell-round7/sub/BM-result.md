# BM 结果：standalone 本机登录门

## 结论

已落地 standalone 可选本机登录：持久化开关默认关；仅在已有用户凭证时允许开启；开启且有凭证后 `authenticateRequest` 走与 node 相同的会话校验；`/api/auth/mode` 在生效时返回 node 同构的 `mode:'mesh'` 载荷。**HTTP 整站门（`localUiGuard` / `assemble.ts`）仍按 standalone 放行**，见下文范围外缺口。

## 探索声明核对

| 声明 | 结果 |
| --- | --- |
| `authenticateRequest` standalone 短路全部鉴权 | **属实**（`session-middleware.ts`）。现改为 `standalone && !localAuthEffective` 才短路。 |
| `/api/auth/mode` standalone 返回 `mode:'none'`，FE 据此藏登录 UI | **属实**。现：未生效仍为 `none`；生效则 `mesh`。 |
| hub/node 已有 passkey / OTP / session / user store | **属实**。第一凭证对齐 CLI/`bootstrapUser`（口令派生 root），不是 mesh enrollment。 |
| `loginEnforced = roles.hub \|\| roles.node` | **属实**。现默认闭包改为 `defaultLoginEnforced()`：`hub \|\| node \|\| readLocalAuthEffective()`，每次 `status()` live 读。 |
| `'self'` 哨兵与真实 `nodeId` 等价 | **属实**（`loginBindingError`）。standalone 生效时 `nodeId` 仍为实例身份，登录 `entry`/`target` 可填 `self` 或真实 id。 |

未强制改动的结论：passkey 注册在门未生效时仍要 session（`userId`）；第一凭证走 `POST /api/auth/local/bootstrap`（口令用户），与 node 的 CLI init 同构。在门生效前开放 passkey 注册，会让公网攻击者把钥匙挂到主人刚建的账号上，故未做。

## 状态机（安全契约）

```
S0  standalone, enabled=false, credentials=false   默认；无登录门
S1  standalone, enabled=false, credentials=true    已有用户，门未开（警告态）
S2  standalone, enabled=true,  credentials=true    生效：会话校验 = node
S3  enabled=true ∧ credentials=false               禁止：API 拒绝进入
```

转移：

| 动作 | 允许 | 拒绝 |
| --- | --- | --- |
| `POST /api/auth/local/bootstrap` {username,password} | 仅 S0 + **loopback** | 非 standalone 404；非 loopback 403 `LOCAL_ONLY`；S1 `CREDENTIALS_EXIST` 409；S2 `LOCAL_AUTH_ENABLED` 409；弱口令/非法用户名 400 |
| `POST /api/auth/local` {enabled:true} | S1 + (loopback **或** 已登录) | 无凭证 `CREDENTIALS_REQUIRED` 409；公网未登录 `LOCAL_ONLY` 403 |
| `POST /api/auth/local` {enabled:false} | loopback **或** 已登录（S2 本机可无 cookie 恢复） | 公网未登录 403 |
| 登录 `/api/auth/challenge` `/login` | 始终公开（与 node 相同） | — |

**loopback**：`clientIp` 缺失 / `local` / `127/8` / `::1` / `localhost` / v4-mapped loopback。`peer:` 与公网/LAN IP 否。缺失视为本机，是为了单测与部分未注入 `requestIP` 的路径；生产 `assemble.ts` 会写入 socket 地址。

**为何不用「enabled 先置位、凭证后补」**：会出现「主人以为已上锁、攻击者抢注第一凭证」窗口。拒绝无凭证 enable，先 bootstrap 再 enable。公网在门关闭时本就可以为所欲为，故 bootstrap 再加 loopback，避免从隧道域名抢注。

hub/node：`POST /api/auth/local*` → 404 `not_standalone`。`mode` 仍为 `mesh`。

## 改动

- `packages/shared/src/contracts/local-auth.ts`：加性契约 `LocalAuthStatus` / 请求体类型
- `apps/gateway/src/db/schema.ts` + drizzle `0031_luxuriant_colossus.sql`（`db:generate`，未手改产物）
- `apps/gateway/src/db/local-auth-settings.ts` / `local-auth-http.ts`：存储、决策、HTTP
- `apps/gateway/src/db/managed-migrations.ts`：补 0026–0030（journal 已有、列表缺失）并加入 0031
- `session-middleware.ts`：`localAuthEffective?: () => boolean`
- `auth-routes.ts`：mode 载荷、`POST /api/auth/local`、bootstrap；`findPrimaryUser` 回退 `listUsers()[0]`（standalone 无 cert/node）
- `tunnel/manager.ts`：默认 `loginEnforcedFn` live 读（未增加 allowlist 行数）

生产 `AuthRoutes` 未注入 store 时默认 `LocalAuthStore(getOrmDb())`，与网关门面同一库。`MeshHttpRuntime` 未改（范围外），测试用 `setLocalAuthStore(MemoryLocalAuthStore)`。

## 给 FE 的契约

`GET /api/auth/mode` **加性**字段（api-client 尚未改，FE 可宽松读）：

```ts
localAuth: {
  supported: boolean;          // 仅 standalone 为 true（可开关本机登录）
  enabled: boolean;            // 持久化开关，默认 false
  effective: boolean;          // supported && enabled && credentialsPresent
  credentialsPresent: boolean; // users 表至少一行
}
```

向导：

- `!localAuth.supported`（hub/node）→「已由节点登录保护」
- `localAuth.effective` → 已保护；`mode === 'mesh'`，登录页与 node 相同（`uid` / `kdfParams` / `rootPublicKey` / `rootEpoch` / `nodeId`）
- standalone 且 `!effective` → `mode === 'none'`（登录 UI 仍藏），用 `localAuth` 提供开启：无凭证先 `POST /api/auth/local/bootstrap`，再 `POST /api/auth/local` `{enabled:true}`，均须本机访问

`POST /api/auth/local` 200：`{ ok:true, localAuth }`  
错误：`{ code }` + 400/403/404/409。

用户名：`^[A-Za-z0-9._-]{1,64}$`；口令 ≥ 8（与 hub setup 一致）。

## 范围外（整站门未闭合）

以下仍 `isStandaloneRoles` 直接放行，**即使 localAuth.effective**：

1. `mesh-http.ts` `localUiGuard` / `guardGatewayWebSocket`
2. `packages/app/src/runtime/assemble.ts`：`isStandaloneRoles || authenticate`
3. `PUBLIC_API` 未列入 `POST /api/auth/local*`（当前 standalone 全放行所以还能打到；接上 guard 后需把 bootstrap/toggle 在未生效时列入公开，生效后 toggle 靠 cookie）

因此本任务保护了 **auth 路由的 requireSession** 与 **显式 `authenticateRequest` 调用方**（注入了 `localAuthEffective` 的）。`AuthRoutes` 自身已注入。未改的 `MeshHttpRuntime.sessionDeps` 仍无该回调 → mesh-http 内 `authenticateRequest` 对 standalone 仍短路。接上整站门时：standalone 不要提前 return，改为调用 `authenticateRequest`（AuthRoutes 的 effective 闭包或同一 store）。

## 风险

- 本机判定依赖 `clientIp`；伪造 Host 无效，但若反代把所有 IP 写成 127.0.0.1 会把公网当成本机。
- `bootstrapUser` 对同名用户会重置 key log（与 CLI 相同）；HTTP bootstrap 在已有任意用户时直接 409。
- drizzle 0031 与并行 agent 的下一序号可能冲突，由 commander 合入。
- 复杂度：`manager.ts` 仍锁 1189 行（删了一行空行以消化新 import）。

## 测试

| 包 | 任务前 | 任务后 |
| --- | --- | --- |
| apps/gateway `bun test` | 2882 / 0 | **2910 / 0** |
| apps/gateway `tsc --noEmit` | 21 | **21**（无新增） |
| packages/shared `bun test` | 392 / 0 | **392 / 0** |
| packages/shared `tsc` | 0 | **0** |
| biome（改动文件） | — | 通过 |

覆盖：session 矩阵（standalone 关 / 开未生效 / 开已生效 / node 不变）、mode 载荷、enable/bootstrap 排序与公网拒绝、已登录远端关闭、`loginEnforcedFn` live 读、migration 建表 round-trip。
