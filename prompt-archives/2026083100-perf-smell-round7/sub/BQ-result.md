# BQ 结果：生产 standalone 挂上鉴权面

## 结论

生产 standalone 现在会构造 **auth-only 的 `MeshHttpRuntime`**（`authSurfaceOnly`），挂上 BM 的 `AuthRoutes`（含 `/api/auth/mode`、bootstrap/toggle、登录流）、`localUiGuard`、WS 门，**不**构造 peer-manager / uplink / hub runtime / 真实 forwarder。`assembled.mesh` 仍为 `null`；`createMeshRuntime` 在 standalone 下仍不被调用。

`/api/local/status` 与 `/api/local/direct` 在本机登录生效时走同一套 live `authenticate`（BP 缺口 #2）。任务里写的 `apps/gateway/src/mesh/local-routes.ts` **不存在**，实际文件是 `packages/app/src/runtime/local-routes.ts`。

## 探索声明核对

| 声明 | 结果 |
| --- | --- |
| `assemble.ts` 仅 `if (roles.node)` 才建 mesh | **属实**。standalone 仍不调用 `createMeshRuntime`。 |
| 无 mesh 时 `/api/auth/mode` 硬编码 `{mode:'none'}` | **属实**（`meshHttp` 旧 fallback）。已删除，改走 AuthRoutes。 |
| `MeshHttpRuntime` 构造总是拉 Forwarder + MeshRoutes | **属实**。加了 `authSurfaceOnly`：peers/streams 可缺省为 inert（`onNodeEvent` 空订阅，无 timer/socket）；`handleRequest` 跳过 forwarder 与 `/api/mesh`。 |
| 生产 standalone 需要整站门才能让 BM/BP 生效 | **属实**。现已挂上。 |
| `local-routes.ts` standalone 跳过 `authenticate` | **属实**，路径是 `packages/app/src/runtime/local-routes.ts`。现 status/direct 一律走注入的 `authenticate`（未生效时 `authenticateRequest` 仍短路放行）。 |

## 改动

- `apps/gateway/src/mesh/mesh-http.ts`：`peers`/`streams` 可选；`authSurfaceOnly` 装配缝；`nodeId` 公开；可注入 `localAuth` / `localAuthEffective`；auth-only 不转发、不挂 mesh 路由。
- `packages/app/src/runtime/assemble.ts`：standalone 用同一 DB 的 `LocalAuthStore(gateway.db)` 建 auth-only runtime；`meshHttp` / WS 走该 surface；node 路径抽到 `createNodeMesh`（选项与原先一致）。
- `packages/app/src/runtime/local-routes.ts`：`/api/local/status`、`/api/local/direct` 不再因 standalone 跳过鉴权。`/api/local/leave` 的 standalone `not_member` 短路未改。
- 测试：assemble 装配 E2E（bootstrap → enable → login → 关门 → disable 恢复开放）、local-routes 把鉴权交给 `authenticate`、mesh-http auth-only 构造。

未改：`auth-routes.ts`（曾考虑在 `isLocalAuthEffective` 包 try/catch，因文件已 923 行 > 900 撤回）、`mesh-runtime.ts`、`peer-manager`、fe/panels/i18n/db-migrations。

## 设计决策

1. **复用 `MeshHttpRuntime`，不新抽象鉴权栈。** 构造缝是 `authSurfaceOnly` + inert peers/streams，避免为 standalone 再写一套 guard。node/hub 仍传 peers/streams，`authSurfaceOnly` 为 false，`handleRequest` 路径与改前相同。
2. **不把 auth-only runtime 赋给 `assembled.mesh`。** 保留「standalone 不构造 mesh 网络栈」不变量；WS 4401/会话触摸用 `wsAuthFrom` 窄接口接到 `routeWebsocket`。
3. **同一 live store。** 生产 standalone 的 AuthRoutes / localUiGuard / `createRouteAuthenticate` 都读 `LocalAuthStore(gateway.db)` + 同一 `userStore`。测试注入的 `localAuthEffective` 优先，覆盖 TLS 与整站门。
4. **`/api/local/*` 不复制生效判断。** 路由层只信 `authenticate`；未生效短路仍在 `authenticateRequest`。node/hub 响应字节级不变（本来就要会话）。
5. **启动成本。** standalone 不 `mesh.start()`、不 listen peer/uplink。MeshRoutes 只对 inert `onNodeEvent` 订阅；`stop()` 里 `authHttp.stop()` 退订。

## 风险

- 反代把所有 `requestIP` 写成 127.0.0.1 时，bootstrap/toggle 的 loopback 判定仍会把公网当成本机（BM 已标，未改）。
- 生效后本机无 cookie 的 `POST /api/auth/local {enabled:false}` 被 `localUiGuard` 401（BP 已说明：先走公开登录再关）。
- fake gateway DB 上 `userStore.listUsers()` 会抛；`MeshHttpRuntime` / assemble 对 `isLocalAuthEffective` 做了 catch→false，避免单测 500。生产走真实库。
- 复杂度门禁仍报 **`apps/gateway/src/mesh/auth-routes.ts: 923 lines > 900`**（无 fileLines allowlist）。本任务未留下对该文件的改动；此为 BM/BP 合入后的既有超标，需 commander 处理 allowlist 或拆文件。
- `assembleTmex` 实测 CC 14 / 136 行（allowlist 锁 17 / 150），未改 allowlist。

## 测试

| 包 | 任务前（BP） | 任务后 |
| --- | --- | --- |
| apps/gateway `bun test` | 2915 / 0 | **2916 / 0**（+1 authSurfaceOnly） |
| apps/gateway `tsc --noEmit` | 21 | **21**（无新增） |
| packages/app `bun test` | 426 / 0 | **431 / 0**（+2 local-routes，+3 assemble） |
| packages/app `tsc` | 1 | **1**（`Cannot find type definition file for 'node'`，既有） |
| biome（改动文件） | — | 通过 |

覆盖：standalone 未生效时 mode 为 BM 载荷（`mode:'none'` + `localAuth.supported`）、不建 mesh；bootstrap → enable → API/local/WS 关门；口令登录后放行；disable 立即恢复；未登录 WS upgrade `mesh-reject-4401`；`/api/mesh/nodes` 不由 auth-only 处理；node/hub 既有 assemble/mesh-http 测试未改逻辑且全绿。
