# G7 结果：`readmit-node` 密钥日志记录

根轮换后历史 `admit-node` 仍停在旧 epoch、旧根签名。中继租户只认当前根 / `root_epoch`，`relay.auth` 因此 `member-epoch_mismatch`，整网无法接入。本任务新增 `readmit-node`：在当前根下重申未吊销成员（证书不变，只换授权签名），并在 enroll / reauth 提交 `set-relays` 之前自动补签。

## 改动

### 记录类型（`packages/shared`）

- `KeyLogType` 追加 `readmit-node`（枚举末尾，旧编码不变）
- 载荷复用 `encodeAdmitNodePayload` / `decodeAdmitNodePayload`
- 签名者 `root` / `passkey`；`MIN_READMIT_NODE_RECORD_VERSION = '1.1.26'`，`allowForce: false`
- `applyReadmitNode`（`readmit-node-record.ts`）：验签与 `admit-node` 相同，但要求已有未吊销且证书字节相同的 cert，然后只替换 authorization。错误：`unknown_node` / `node_revoked` / `certificate_mismatch`

### DB / 落账（`apps/gateway`）

- 迁移 `0045_readmit_node_keylog.sql`：`user_key_log.type` CHECK 追加 `readmit-node`（重建表，同 0042）
- 已注册 `managed-migrations.ts` + `drizzle/meta/_journal.json` idx 45
- schema CHECK 同步
- `persistApplied`：`readmit-node` 更新现有 `node_certs.admit_record_seq` 与 authorization，证书与 Hub `nodes.name` 不动

### 中继

- `relayMemberFromRecord`：`readmit-node` → `op: 'admit'`
- `verifyRelayMemberProof`：`op admit` 接受 `admit-node` 与 `readmit-node`（epoch / 签名规则不变）
- 节点侧 `selfAdmitMemberProof` 回退扫描也认 `readmit-node`

### Node API

- `GET /api/mesh/relay/readmit/prepare` → `{ rootEpoch, entries: [{ nodeId, name, admitSeq, admitRootEpoch, authorization_bytes, certificate_bytes, cert_sig }] }`
  列出未吊销且 admit/readmit 记录 `root_epoch` < 当前 epoch 的证书（含本机）；hub / relay 模式都可用
- `GET /api/mesh/relay/status` 增加 `readmitPending`
- `POST /api/mesh/relay/enroll` 增加 `readmitRequired`
- hub 模式 `readmit-node` 走 writer（与 `admit-node` 相同，非 local-first）；中继模式 local-first + publish
- 空 peer cache 的 bootstrap 豁免扩到 `readmit-node`（未塞进 `RELAY_RECORD_TYPES`）

### CLI

- `tmex relay enroll` / `reauth`：enroll 之后、`set-relays` 之前调 `readmit/prepare`，对每条用根钥重签 `authorization_bytes`，顺序追加 `readmit-node`（`POST /api/auth/keylog?hub=sync`）；任一条失败则中止
- 成功打印 `re-affirmed N member(s) under root epoch E`

### 文档

- `docs/relay/2026090304-relay-role.md` §4 新小节与表格行，§6 CHECK，§12 运维，§13 根轮换后再迁中继必须 readmit

## 文件列表

**shared**

- `packages/shared/src/auth/encoding.ts`
- `packages/shared/src/auth/encoding.test.ts`
- `packages/shared/src/auth/key-log.ts`
- `packages/shared/src/auth/key-log.test.ts`
- `packages/shared/src/auth/readmit-node-record.ts`（新）
- `packages/shared/src/auth/readmit-node-record.test.ts`（新）
- `packages/shared/src/auth/index.ts`

**gateway**

- `apps/gateway/drizzle/0045_readmit_node_keylog.sql`（新）
- `apps/gateway/drizzle/meta/_journal.json`
- `apps/gateway/src/db/managed-migrations.ts`
- `apps/gateway/src/db/schema/users-auth.ts`
- `apps/gateway/src/auth/key-log-store.ts`
- `apps/gateway/src/auth/key-log-store.test.ts`
- `apps/gateway/src/auth/user-key-persistence.ts`
- `apps/gateway/src/auth/user-key-persistence.test.ts`
- `apps/gateway/src/auth/user-key-service.test.ts`
- `apps/gateway/src/auth/schema.migration.test.ts`
- `apps/gateway/src/auth/readmit-node-compat.test.ts`（新）
- `apps/gateway/src/hub/hub-authorization.ts`
- `apps/gateway/src/hub/hub-authorization.test.ts`
- `apps/gateway/src/relay/relay-member.ts`
- `apps/gateway/src/relay/relay-member.test.ts`（新）
- `apps/gateway/src/mesh/relay-key-log-sync.ts`
- `apps/gateway/src/mesh/relay-key-log-sync.test.ts`
- `apps/gateway/src/mesh/relay-member.ts`
- `apps/gateway/src/mesh/relay-readmit.ts`（新）
- `apps/gateway/src/mesh/relay-readmit.test.ts`（新）
- `apps/gateway/src/mesh/relay-routes.ts`
- `apps/gateway/src/mesh/relay-routes.test.ts`
- `apps/gateway/src/mesh/relay-secrets.ts`
- `apps/gateway/src/mesh/auth-key-log-routes.ts`
- `apps/gateway/src/mesh/auth-key-log-plan.test.ts`（新）

**app**

- `packages/app/src/lib/relay-session.ts`
- `packages/app/src/commands/relay.ts`
- `packages/app/src/commands/relay.test.ts`

**docs**

- `docs/relay/2026090304-relay-role.md`

未改 `package.json`（版本由 commander 升到 1.1.26）。未跑 `build:i18n`。无 git 操作。

## 验证

| 命令 | 结果 |
|---|---|
| `cd packages/shared && bun test src/auth/readmit-node-record.test.ts src/auth/key-log.test.ts src/auth/encoding.test.ts src/auth/index.test.ts` | 66 pass / 0 fail |
| `cd apps/gateway && bun test`（readmit 相关 11 个文件） | 90 pass / 0 fail |
| `cd apps/gateway && bun test src/relay src/mesh/relay src/mesh/auth-key-log src/hub` | **498 pass / 0 fail**；2 个 unhandled `LinkError: relay-rst`（`relay-hardening.test.ts` 测间 mux RST，栈在 `mux.ts` / `relay-stream-router.ts`，本任务未改这些文件） |
| `cd packages/app && bun test src/commands/relay.test.ts` | 19 pass / 0 fail |
| `cd packages/shared && bunx tsc --noEmit -p .` | 0 |
| `cd packages/app && bunx tsc --noEmit -p .` | 0 |
| `cd apps/gateway && bunx tsc --noEmit -p .` | 仅既有 `native-datachannel.ts` TS5097 |
| `bun run lint` | biome + complexity gate ok（`relay-routes.ts` 580 行，接近 600） |

## 未完成 / 不确定

- 前端 enroll / reauth 链式签名由并行的 Opus agent 改 `apps/fe`，本任务未动前端。
- `bun test src/relay ...` 的 2 个 unhandled error 是 hardening 测间 mux RST，不是本任务引入的断言失败；若 CI 把 unhandled error 当红，需要另开任务在 `relay-hardening` 里吞掉 RST。
- passkey 承认的节点：CLI 用根钥重签同一份 `authorization_bytes`。若内嵌 authorization 的 `signer` 是 `passkey`，apply 会走 passkey 验签路径，CLI 这条根签名会失败。生产故障是 epoch-1 **根**签的 `admit-node`，CLI 路径覆盖该场景；passkey 承认节点的重申应由网页 passkey 签名者完成。
