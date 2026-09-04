# P1 结果 — Relay password join（密封包）

## 结论

第二台机器可用 **中继 URL + 租户编号 + mesh 账户密码** 加入，无需 `r3.` 串。共享密封包协议、中继存储/路由、节点侧 join 服务与 CLI `runRelayPasswordJoin` 已落地。进程内集成：A enroll → 上传 pack → B 密码加入 → 双方看见彼此并共享 K_meta；截断日志 / 错密码 / 根轮换后旧 epoch pack 均拒绝。

迁移 `0043` 追加时 journal 已有 `0041_peer_cache_version`、`0042_rename_node_keylog`，`0043_relay_pack` 为 idx 43（`when: 1789212000000`）。

## 改动文件

### 新增
- `packages/shared/src/relay/relay-pack.ts` + `relay-pack.test.ts`
- `apps/gateway/drizzle/0043_relay_pack.sql`
- `apps/gateway/src/relay/relay-pack-http.ts`（kdf / join / pack / HTTP keylog）
- `apps/gateway/src/mesh/relay-pack-routes.ts` + test（`POST /api/mesh/relay/pack` 转发）
- `apps/gateway/src/auth/user-key-self-admit.ts` + test（admit-node + 换代 meta-key）
- `apps/gateway/src/mesh/relay-member.test.ts`
- `packages/app/src/lib/relay-pack-upload.ts`（enroll/改密直接打各中继 `/pack`；`sealAndUploadRelayPack` 走本机 gateway）
- `packages/app/src/lib/relay-password-join.ts`（`performRelayPasswordJoin`，不依赖 `hub.ts`）
- `packages/app/src/commands/relay-password-join.ts`（`runRelayPasswordJoin`，P2 已从此 import）
- `packages/app/src/commands/relay-password-join.test.ts`
- `apps/gateway/src/relay/integration/relay-password-join.integration.test.ts`

### 修改
- `packages/shared/src/relay/index.ts` 导出 pack API
- `apps/gateway/src/db/schema/relay.ts`：`kdf_params_json` / `sealed_pack`
- `apps/gateway/src/db/managed-migrations.ts`、`drizzle/meta/_journal.json`（仅追加 0043）
- `apps/gateway/src/relay/{types,relay-tenant-store,relay-enroll-limiter,relay-http,relay-routes,relay-runtime,relay-units.test,relay-routes.test}.ts`
- `apps/gateway/src/mesh/relay-member.ts`（`selfAdmitMemberProof`）、`relay-uplink-auth.ts`（member sidecar 回落）
- `packages/app/src/commands/relay.ts`（enroll/reauth 成功后上传 pack，失败 swallow）
- `packages/app/src/lib/hub-user-passwd.ts`（改密成功后、清零新种子前上传 pack）
- `packages/app/src/lib/relay-store.ts`（`persistRelayUplink` 可写 `metaKey`）
- `docs/relay/2026090304-relay-role.md` 新增 §5b

未改 `user-key-service.ts`（已有 `applyMany`）。未改 G2/G3/P2 独占文件。

## 协议要点

- `KEK = HKDF-SHA256(root_seed, salt=utf8("tmex-relay-pack/v1"), info=tenant_id(16B), 32)`
- AES-256-GCM，AAD = salt 前缀 ‖ tenant_id(16) ‖ root_pk(32) ‖ root_epoch(u32 LE)
- 明文 Borsh `{ v:u8=1, log_key, token, head_seq, head_hash, issued_at }`；线格式 `nonce(12)‖ct+tag`，上限 4096 B
- `mode:'join'` 不碰站点口令、不 `issueTenantToken`、不 `enforceTokenReissue`；缺 mode / `'enroll'` 与今日相同
- `rotateRoot` 清空 pack + kdf（fail-closed）
- `sealed_pack` / `kdf_params_json` 不进 admin/status

## 测试

- shared pack：round-trip / AAD mismatch / 错 seed / 超大 blob / kdf wire
- relay-routes：kdf 无鉴权+404、join 成功且 token 不动、错根 401、kicked、pack head_ahead / epoch mismatch
- limiter 按 tenant id 计数
- mesh pack 转发、self-admit 两条记录、member sidecar 扫日志
- CLI：`local_user_exists`、kdf 404 → `join_failed`、缺 `--tenant`
- 集成（新文件，未改既有两个 integration）：四条场景均过

## 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` shared / gateway / app | 0 |
| `bun test` shared | 645 pass |
| `bun test` gateway | 4198 pass / 0 fail / **2 errors**（与任务所述其它 agent inflight 一致，非本任务用例） |
| `bun test` app | 835 pass / 1 skip |
| `biome check` 本任务文件 | 通过 |

基线对照：shared 631→645，gateway ~4162→4198，app 816→835。

## 需要指挥官处理

### 1. 节点侧路由注册（G2 独占 `apps/gateway/src/mesh/relay-routes.ts`）

`route()` table 增加一行，并从 `./relay-pack-routes` 引入 `handleMeshRelayPack`：

```ts
'POST /pack': (r) =>
  handleMeshRelayPack(
    { secrets: this.deps.secrets, fetchImpl: this.deps.fetchImpl, dial: this.deps.dial },
    r
  ),
```

（handler 已由 `RelayRoutes.handle` 的 `requireSession` 包过。）

### 2. CLI 接线（P2 已基本完成）

`cli-auth-entry.ts` 已 `import('./commands/relay-password-join').runRelayPasswordJoin`；`args.ts` 已有 `relay.join` 与 `--tenant/--password/--name/--ca-fingerprint/--no-restart`。本任务导出签名与之对齐，无需再改。

### 3. api-client（P2）

网页后续任务需要：
- 中继：`GET /api/relay/tenants/:id/kdf`、`POST /api/relay/enroll` `{ mode:'join', tenant_id, ... }`、`POST .../pack`、`GET|POST .../keylog`
- 节点：`POST /api/mesh/relay/pack` body 见文档 §5b

### 4. 访问保护放行 kdf

`ACCESS_EXEMPT_PATH_PREFIXES` 已含 `/api/relay/tenants/`（隧道门）。但 `apps/gateway/src/mesh/domain-access-policy.ts` 的 `isServicePath` **没有** `GET /api/relay/tenants/:id/kdf`：中继机若开了域名访问保护，未登录的加入方可能被拦。建议：

```ts
if (verb === 'GET' && /^\/api\/relay\/tenants\/[^/]+\/kdf$/.test(pathname)) return true;
```

`POST /api/relay/enroll` 已在服务路径里。

### 5. schema.migration.test.ts（G3 独占）

该文件已有 0041 列断言。需要补 0043：`relay_tenants.kdf_params_json` TEXT NULL、`sealed_pack` BLOB NULL。

### 6. FE（后续任务）

enroll 对话框 / reauth / 根轮换 / 根签追加后刷新 pack：请求体见 `docs/relay/2026090304-relay-role.md` §5b。材料来自 `GET /api/mesh/relay/join-material` + `GET /api/auth/keylog/head` + 当时持有的根种子。
