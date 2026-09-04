# G4 结果：enrollment fan-out 到全部已配置中继

## 做了什么

中继侧把 `relay.enroll.create` 的写入抽成共享函数，并新增租户令牌 HTTP 创建接口；节点侧 `POST /api/mesh/relay/enrollments` 对 `mesh_relays` 全表并发扇出；CLI 密封包拉全表材料，redeem 遇到「这台没有这条 enrollment」时换下一台。

### 中继侧

- 新文件 `apps/gateway/src/relay/relay-enroll-create.ts`：`applyRelayEnrollCreate` 供 uplink 与 HTTP 共用。
  - 验 authorization（当前根公钥 / `root_epoch` / `exp` 上限）
  - 未使用配额 32（`ENROLLMENT_QUOTA`）、16 条 / 60 s（`ENROLLMENT_RATE_LIMITED`）
  - 同 `id` 同 payload 幂等成功；同 `id` 不同 payload（或 `enroll_pk` 撞车）→ `RELAY_ENROLLMENT_CONFLICT`
- `POST /api/relay/tenants/:tenantId/enrollments`（`x-tmex-relay-token`），201 `{ ok: true }`
- `isServicePath` 覆盖该集合路径（`ACCESS_EXEMPT_PATH_PREFIXES` 已含 `/api/relay/tenants/`，origin 守卫无需再改）

### 节点侧

- `POST /api/mesh/relay/enrollments` 对每一行 `mesh_relays` 并发 HTTP POST（`resolveRelayDialUrl` 回环改写），每台 5 s 超时，`Promise.allSettled`
- attached 那台 HTTP 超时/不可达且 uplink 在线时，退回 `relay.enroll.create`
- 至少一台接受 → 保留本地 `enrollment_tokens`，201：
  `{ ok, id, expiresAt, relays: [{ url, tenantId, token, accepted: true } | { url, tenantId, accepted: false, error }] }`
  拒绝的不回 `token`（令牌来自 join-material 同一套 `collectJoinMaterialRelays`）
- 全部失败 → 作废本地 enrollment，502 `RELAY_ENROLL_FANOUT_FAILED`（body 带 `relays`）

### CLI

- `sealAndUploadRelayPack` 请求 `/api/mesh/relay/join-material?scope=all`
- `redeemAgainstRelays`：`RELAY_ENROLLMENT_UNKNOWN` / `RELAY_NOT_FOUND` / lookup 404 换下一台；CA 指纹不符仍直接失败

### 文档

`docs/relay/2026090304-relay-role.md`：§5 join-material 段、§7.1 路由表、§7.2 `POST /enrollments`、§13「多中继」条。

## 改动文件

新增：

- `apps/gateway/src/relay/relay-enroll-create.ts`
- `apps/gateway/src/relay/relay-enroll-create.test.ts`
- `apps/gateway/src/mesh/relay-enrollment-fanout.ts`
- `packages/app/src/lib/relay-pack-upload.test.ts`

修改：

- `apps/gateway/src/relay/relay-http.ts`
- `apps/gateway/src/relay/relay-uplink-handlers.ts`
- `apps/gateway/src/relay/relay-public-routes.ts`
- `apps/gateway/src/mesh/relay-routes.ts`
- `apps/gateway/src/mesh/relay-routes.test.ts`
- `apps/gateway/src/mesh/domain-access-policy.ts`（`isServicePath` 集合路径；实现项 1 要求）
- `apps/gateway/src/mesh/domain-access-policy.test.ts`
- `packages/app/src/lib/relay-pack-upload.ts`
- `packages/app/src/commands/relay-join.ts`
- `packages/app/src/commands/relay-join.test.ts`
- `docs/relay/2026090304-relay-role.md`

未碰：`apps/fe`、`hub-runtime.ts`、`hub-authorization.ts`、`auth-key-log-routes.ts`、`membership-reset.ts`、messaging/events。

## 如何验证

```text
cd apps/gateway && bun test src/relay/relay-enroll-create.test.ts \
  src/mesh/relay-routes.test.ts src/mesh/domain-access-policy.test.ts \
  src/relay/relay-routes.test.ts
# 81 pass, 0 fail

cd packages/app && bun test src/lib/relay-pack-upload src/commands/relay-join
# 23 pass, 0 fail

cd packages/app && bunx tsc --noEmit -p .
# 0 errors

cd /Users/konata/code/tmex-r25 && bunx biome check <G4 文件>
# 14 files, clean

cd /Users/konata/code/tmex-r25 && bun run lint
# biome check . ok；complexity gate ok（relay-routes.ts 555 / 600，near-limit 提醒）
```

覆盖：HTTP create 接受 / 幂等 / 冲突 / 坏令牌 / 配额 / 限流；节点 fan-out 两台都接受、一台 timeout 一台接受、全部拒绝 → 本地作废 + 502；pack-upload 打 `?scope=all`；CLI 第一台 404 `RELAY_ENROLLMENT_UNKNOWN` 继续第二台。

## 未决 / 不确定

1. **进程内集成测试**（`src/relay/integration/*.integration.test.ts`）当前 15 fail，全部卡在 enroll 后提交 `set-relays`：`409 KEYLOG_TYPE_UNSUPPORTED_BY_NODES`（`nodes.version` 为空）。失败点在 key-log 版本门，不是本任务的 enrollment HTTP/fan-out。G4 单测与 hardening 的 enroll.create 配额/限流仍绿。这与并行任务 L5（`inspectHubAuthRecordCompat` 改读 `peer_cache.version`）重叠；G4 **没有**改 `hub-authorization.ts` / `auth-key-log-routes.ts`。
2. **gateway `tsc --noEmit`** 现报 1 条，不在 G4 文件里：`packages/app/src/lib/native-datachannel.ts:135` TS5097（`.ts` 扩展名 import）。`packages/app` 自身 tsc 为 0。基线 gateway 0；该错误来自并行改动。
3. 默认 `GET /join-material` 仍只返回 attached 那一台；全表用 `?scope=all`。加节点向导应改读 `POST /enrollments` 的 `relays`（F3）。
