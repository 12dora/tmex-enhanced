# BP 结果：standalone 本机登录整站门

## 结论

已把 BM 的 live `localAuthEffective` 接到 `MeshHttpRuntime` 的 `sessionDeps` 与 `assemble.ts` 的 `authenticateRequest`。`localUiGuard` / `guardGatewayWebSocket` 不再无条件因 standalone 放行；生效时 API / WS 与 node 同构要求会话，未生效时行为不变。TLS 授权同样走 live 会话校验。

**生产 standalone 仍不构造 mesh**（`assemble.ts` `if (roles.node)`），因此 `MeshHttpRuntime` 门只覆盖「已构造 runtime 的路径」（单测 `bootMesh({hub:false,node:false})`、以及将来若为 standalone 挂上 mesh）。生产 standalone 的 gateway REST / SPA / 默认 `/ws` 仍不经过 `localUiGuard`。见下文范围外。

## 探索声明核对

| 声明 | 结果 |
| --- | --- |
| `mesh-http.ts` `localUiGuard` / `guardGatewayWebSocket` 对 standalone 无条件 `return null` | **属实**。已改为走 `authenticateRequest`（注入 AuthRoutes 同一 store 的 live 闭包）。 |
| `assemble.ts` `isStandaloneRoles \|\| authenticate`（TLS） | **属实**。已改为只看 `authenticate`；standalone 未生效时 `authenticateRequest` 仍短路为 ok。 |
| `PUBLIC_API` 未列入 `POST /api/auth/local*` | **属实**。抽出 `isAuthPublicPath`：登录流始终公开；`/api/auth/local` 与 `/bootstrap` 仅 **standalone 且未生效** 时公开；生效后 toggle 需 cookie。 |
| 生产 standalone 会走到 `MeshHttpRuntime` | **不属实**。`assembleTmex` 仅 `roles.node` 才 `createMeshRuntime`；无 mesh 时 `/api/auth/mode` 仍硬编码 `{mode:'none'}`。BM 的 AuthRoutes 在生产 standalone 并未挂载。 |

未改动的结论：node/hub 的 `localUiGuard` 对 `/api/auth/local` 仍 401（未列入公开面），有会话后才进 handler 的 404 `not_standalone`——与改前字节级一致。

## 改动

- `auth-routes.ts`：`AUTH_LOGIN_PUBLIC_PATHS` / `AUTH_LOCAL_PRESESSION_PATHS` / `isAuthPublicPath`；`AuthRoutes.isLocalAuthEffective()` 复用 BM 的 store 闭包（`setLocalAuthStore` live）。
- `mesh-http.ts`：`sessionDeps.localAuthEffective → this.auth.isLocalAuthEffective()`（不另存一份状态、不在启动时缓存）。去掉 standalone 提前 return；`healthz` 也改走 `authenticateRequest`（开放短路仍 ok → 完整 body；生效且未登录 → 与 node 相同的 `{status:'ok'}`）。
- `session-middleware.ts`：`isStandaloneOpenAuth`——开放短路是 `{ok:true,sid:null,userId:null}`，WS 不能当成 4401。
- `assemble.ts`：TLS `authorize` 只信 `authenticate`；`createRouteAuthenticate` 注入 `opts.localAuthEffective ?? readLocalAuthEffective`（与默认 `LocalAuthStore` 同一库表）。

## 设计决策

1. **同一 store，不复制状态。** Mesh 门读 `AuthRoutes` 的 store；assemble 生产路径读 `readLocalAuthEffective()`（默认 `LocalAuthStore` + users 表）。测试用 `setLocalAuthStore(MemoryLocalAuthStore)` 或 `assembleTmex({ localAuthEffective })` 注入，避免全局 ORM 污染。
2. **公开面按「是否生效」分支，而不是无条件加入 `PUBLIC_API`。** 否则 node 上未登录 `POST /api/auth/local` 会从 401 变成 handler 的 404，破坏回归。
3. **生效后 toggle 在门上要会话。** 与任务「生效后 toggle 靠 cookie」一致。BM 的「S2 本机无 cookie 关闭」会被门 401；登录端点仍公开，先登录再关。开启当下那一请求在 handler 翻转之前已过门，不会卡住自己。
4. **关闭立即恢复开放。** 每次请求 live 读，无启动缓存。

## 范围外（整站门仍未盖住的生产面）

若要真正锁住生产 standalone，需要改这些（均不在本次文件集）：

| 缺口 | 原因 |
| --- | --- |
| `assemble.ts` `if (roles.node)` 不建 mesh | 生产 standalone 没有 `localUiGuard` / AuthRoutes / 登录 API；`/api/auth/mode` 仍 `{mode:'none'}`。把 mesh 建起来会动 `mesh-runtime.ts` 且打破「standalone 不构造 mesh」测试。 |
| `local-routes.ts` standalone 跳过 `authenticate` | `/api/local/status`、`/api/local/direct` 在生效后仍开放。 |
| `MeshRoutes.sessionDeps` 无 `localAuthEffective` | 未认证的 `/api/mesh/*` 已被 `localUiGuard` 拦住；有 cookie 时 mesh 路由仍会 standalone 短路成 `userId:null`。生产 standalone 不建 mesh，实际打不到。 |
| `mesh-runtime.ts` hub `authenticate` | 未注入回调；hub 不是 standalone。 |

## 风险

- 生产 standalone + `loginEnforced=true`（tunnel 已 live 读）时，**UI/gateway API/默认 WS 仍可能开放**，直到为 standalone 挂上 mesh 或在 assemble 无 mesh 分支自行设门。这是本次范围无法闭合的安全缺口，与任务要消掉的「以为上锁、站点仍开」同类。
- 生效后本机无 cookie 的 `POST /api/auth/local {enabled:false}` 在 `localUiGuard` 得到 401（不再落到 BM 的 loopback 恢复）。可通过公开登录流拿 cookie 再关。
- `readLocalAuthEffective` 与测试里的 `MemoryLocalAuthStore` 不是同一份；assemble 测试用注入回调，生产用 DB。

## 测试

| 包 | 任务前 | 任务后 |
| --- | --- | --- |
| apps/gateway `bun test` | 2910 / 0 | **2915 / 0** |
| apps/gateway `tsc --noEmit` | 21 | **21**（无新增；错误不在本次文件） |
| packages/app `bun test` | 423 / 0 | **426 / 0** |
| packages/app `tsc` | 1 | **1** |
| biome（改动文件） | — | 通过 |

覆盖矩阵：`{standalone 关, standalone 生效, node} × {UI /api 与 /login, REST, WS, auth/local, 登录流}`；运行时开/关 live 读；node `localAuthEffective=false` 仍要会话；assemble TLS 开/关/node 回归。`assembleTmex` 行数 150 → 148（未改 allowlist）。
