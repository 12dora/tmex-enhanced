# Task BI 结果：将 TMEX_ROLES 角色模型收敛到 shared 纯模块

## 主张核对

全部成立，已对照源码后再改。

| 主张 | 核对结果 |
|---|---|
| `apps/gateway/src/config.ts` 自管 `TmexRoles` + `parseTmexRoles`，空串/空白 **fail-closed** | 属实。`undefined` → `{hub:false,node:false}`；`''` / `'   '` / 非法值抛 `TMEX_ROLES must be one of standalone \| node \| hub,node`。`config.test.ts` 已锁此语义。 |
| `packages/app/src/lib/roles.ts` 再定义一套类型与 parser，空值 → standalone | 属实。`parseTmexRoles` 在 `undefined \|\| trim()===''` 时先归一成 `'standalone'`。`parseTmexRoleName` 本身对空串仍抛错（`(raw ?? 'standalone').trim()` 后空串不在合法集）。 |
| `mesh-deps.ts` 再定义 `MeshRoles` + `isStandaloneRoles` | 属实。`MeshRoles = TmexRoles`（原从 config 引类型）；`isStandaloneRoles` 与 app 实现逐字相同（`!hub && !node`）。 |
| `assemble.ts` 直接依赖 gateway config 的 parser，其它 app 命令用 `lib/roles` | 属实。`assembleTmex` 用 `parseTmexRoles(process.env.TMEX_ROLES)` 来自 `apps/gateway/src/config`；`isStandaloneRoles` 已从 `lib/roles` 引入。 |

两套 wrapper 对合法值（`standalone` / `node` / `hub,node`，含两侧空白）结果一致；错误文案不同（gateway：`TMEX_ROLES must be…`；app：`role must be…`）。此分叉是有意保留的，不是 bug。

## 改动

### `packages/shared`（纯 TS，无 `node:`）

新增 `src/roles.ts`，从主 barrel 再导出：

- 类型：`TmexRoleName`、`TmexRoles`
- `isTmexRoleName`：合法 token 判定
- `rolesFromName` / `roleNameFromFlags`：名 ↔ 标志
- `isStandaloneRoles`

`index.test.ts` 运行时导出快照补了上述四个函数名。

### gateway

- `config.ts`：`TmexRoles` 改为从 `@tmex/shared` 再导出；`parseTmexRoles` 仍是 env 校验包装——`undefined` 当 standalone，trim 后非法（含空串）抛原来的 `TMEX_ROLES must be…`。
- `mesh-deps.ts`：`MeshRoles` 仍是 `TmexRoles` 别名（消费者不改）；`isStandaloneRoles` 改为从 `@tmex/shared` 再导出。不再从 `../config` 取类型。

未改 `mesh-runtime.ts`（范围外）；它继续从 `config` 取 `TmexRoles` 类型，再导出链仍有效。

### `packages/app`

- `lib/roles.ts`：类型与 `isStandaloneRoles` / `roleNameFromFlags` 从 shared 再导出；`parseTmexRoleName` / `parseTmexRoles` 保留默认归一包装与 `role must be…` 文案。`DEFAULT_PEER_PORT` / `DEFAULT_STUN_SERVERS` 留在 app（不是角色模型）。
- `assemble.ts`：去掉对 gateway `parseTmexRoles` / `TmexRoles` 的依赖；角色解析改走 `lib/roles`。`gatewayConfig` 仍从 gateway config 取 hubUrl/peerPort 等（那些不是角色 parser）。

## 设计决策

1. **shared 只放纯转换，不放 env 语义。** 空值策略是产品层选择（gateway fail-closed vs CLI 归一），不能压进单一 `parseTmexRoles`。shared 提供 `isTmexRoleName` + `rolesFromName`，两边 wrapper 各自决定空值和错误文案。
2. **错误文案不统一。** 现有测试与 CLI 提示依赖原文案；统一会变成行为变化。
3. **`roleNameFromFlags({hub:true,node:false})` 仍回落 `standalone`。** 这是旧实现的缺口（合法名集合里没有纯 hub），测试显式锁住，没有“修好”。
4. **assemble 改用 app wrapper。** 这是 smell 的核心：app 运行时组装不应走 gateway 的 fail-closed parser。生产路径仍会先 import gateway `config`（模块级 `roles: parseTmexRoles(process.env.TMEX_ROLES)`），进程启动时空串依然 fail-closed。唯一差别是 `assembleTmex()` 在 **模块已加载之后** 再读被改成空串的 `process.env.TMEX_ROLES` 时，现在归一成 standalone 而不抛。生产不会在启动后把 `TMEX_ROLES` 改成空串。
5. **app 用相对路径 `packages/shared/src/roles`，不用 `@tmex/shared`。** `packages/app` 的既有约定（`load-env` / `auth` 同款），且 `package.json` 不在本次范围，不能加 workspace 依赖。
6. **`MeshRoles` 别名保留**，避免改 session-middleware / mesh-http / auth-routes（范围外）。

## 风险

- **assemble 调用时空串语义变了**（见上）。影响面限于测试或热改 env；gateway 自身 `config.roles` 仍 fail-closed。
- **`config.ts` 现在 import `@tmex/shared` 主 barrel**，会把 i18n/ws-borsh 等拉进 config 的模块图。gateway 其它文件早已这么做；config 作为更早入口，启动时多加载一次 barrel。若要再收，可改成深路径 `packages/shared/src/roles`（本次未做，保持与 gateway 其它 `@tmex/shared` 引用一致）。
- **`{hub:true,node:false}` 仍不是合法角色**，round-trip 会变成 standalone。未扩大合法集。

## 测试

新增：

- `packages/shared/src/roles.test.ts`：合法 token、非法 token、名↔标志、hub-only 回落、`isStandaloneRoles`。
- `packages/app/src/lib/roles.test.ts`：app wrapper 的 undefined/空/空白归一、合法值、非法值；以及 **跨包一致性**：gateway 拒空串、app 归一、合法值两边相等、非法值两边都抛（文案不同）。
- gateway `config.test.ts` 原有 fail-closed 用例未改，重构后仍过。

| 包 | 基线 | 本次 |
|---|---|---|
| `packages/shared` `bun test` | 387 pass / 0 fail | **392 pass / 0 fail**（+5） |
| `packages/shared` `tsc` | 0 | **0** |
| `apps/gateway` `bun test` | 2854 / 0（任务书）；并行 agent 期间套件在涨 | 第一次 2850/1 fail/1 error（RTC 等 flake，且跑的时候别的 agent 还在改文件）；**完整复跑 2861 pass / 0 fail** |
| `apps/gateway` `tsc` | 21 pre-existing | **21**（`grep error TS`；无一落在本次改动文件） |
| `packages/app` `bun test` | 414 pass / 1 fail（cpu-features stub） | **422 pass / 1 fail**（+8；失败仍是 `cpu-features stub plugin > packaged dist/runtime/server.js…`） |
| `packages/app` `tsc` | 1 pre-existing | **1**（`Cannot find type definition file for 'node'`） |

`bunx biome check`：上述 9 个改动文件通过。
