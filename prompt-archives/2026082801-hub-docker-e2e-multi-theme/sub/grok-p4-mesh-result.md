# grok-p4-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`，只改 `apps/gateway/**`，无 git 操作。未改 `packages/app`。

评审 `review-p1b.md` 的 8 条 finding 全部落地，每条都有先红后绿的单测。

## 改动摘要

| # | 处理 |
|---|---|
| 1 | push NACK/timeout、`applyMany` 错误（含 `invalid_signature`）、head 不前进、stalled、incomplete **都不** `finishNodeList`；有界重试后 `tearDownLink`；`fork` → `failFork()`；partial apply 后立刻重读 head，下次 `key.log.req` 从已提交前缀继续 |
| 2 | `authenticatedGeneration === generation` 才处理受保护帧；`connectWithLink` / teardown 清掉 pending、list epoch、watermark、auth 门闩 |
| 3 | 带 id 发出的 `key.log.req` 只接受相同 id 的 `key.log.res`；无 id 的迟到响应当有 outstanding request 时丢弃，日志打一次 `missing id` |
| 4 | 每个连接代次维护最高已接受 `node.list.version`，更低版本直接拒绝；新代次把 watermark 重置为 `-∞`（兼容 hub 重启后 version 归零） |
| 5 | `listHubOnline` 仅在 `uplink.state === 'online'` 时计入 `lastNodeList`；断线时对无真实 reach 的节点发 `offline` NODE_EVENT。`lastNodeList` 本身保留，避免误清缓存 |
| 6 | `resolveUserId`：explicit → self cert → users/certs 并集恰好一个 user；node-only 在空/歧义时 **不启动** uplink 并 `console.error`。hub 角色在空库时仍启动本地 uplink（`attachLocalNode`），catch-up 因 `userId===''` 跳过。`node_identity` **没有** user_id 列，join 持久化见下，未做 |
| 7 | hub `key.log.req` 按 nodeId token bucket（10/min，burst 20）；warn 10s 窗口聚合 `suppressed=N` |
| 8 | ctl warn 的 `type` 只允许协议枚举否则 `unknown`；错误映射成固定码（`unknown_type` / `decode_error` / `handler_error` / …）；剥控制字符；不打 payload |

## Finding 6：`hub join` 持久化 userId（未做，需要迁移 + `packages/app`）

当前 `node_identity`（`apps/gateway/drizzle/0019_hub_auth.sql` / `apps/gateway/src/db/schema.ts`）列为：

`id, node_id, hub_url, private_key, x25519_private_key, certificate_json, cert_sig`

没有 `user_id`，不能在不改 schema 的情况下写入。精确后续：

1. **迁移**：`ALTER TABLE node_identity ADD COLUMN user_id text`（可空，兼容已有行）。
2. **gateway**：`NodeIdentityRecord` / `SaveNodeIdentityInput` / `NodeIdentityStore.load|save` 增加 `userId`。
3. **`packages/app/src/commands/hub.ts` `commitVerifiedJoin`**：在 `genesisUid` 校验通过后 `identityStore.save({ ...loaded, userId: genesisUid, hubUrl })`。redeem 当时已经有 `input.redeemed.user.id === genesisUid`。
4. **`packages/app/src/runtime/assemble.ts`**：`assembleTmex` 创建 mesh 时把 `userId: (await identityStore.load())?.userId` 传给 `createMeshRuntime`。

在此之前 gateway 回退：单用户 join 后 `users` 表只有一行，`resolveUserId` 仍能唯一解析。多用户库且无 self cert / 无 explicit userId 时拒绝上线，避免再取 `listCerts()[0]`。

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `push NACK does not finish node.list and tears down after retries` | #1 push |
| `applyMany invalid_signature does not finish…` | #1 apply 错误 |
| `applyMany fork calls failFork…` | #1 fork |
| `stalled key-log head does not finish…` | #1 stalled |
| `partial apply re-reads head so the next request resumes…` | #1 提交前缀 |
| `connectWithLink replacement does not inherit authenticated…` | #2 |
| `key.log.res without id is dropped…` | #3 |
| `rejects a lower node.list version on the same connection generation` | #4 |
| `resets node.list version watermark on a new connection generation` | #4 |
| `hub presence is ignored after uplink disconnects…` | #5 |
| `does not start uplink when users/certs are empty or ambiguous` | #6 node-only |
| `hub role still starts local uplink when no user has been created yet` | #6 hub 空库 |
| `rate-limits key.log.req per node with a token bucket` | #7 |
| `aggregates key.log.req warn logs with a suppressed count` | #7 |
| `ctl warn maps illegal type to unknown…` | #8 |

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2263 pass / 0 fail**（基线 2248 + 本轮 15） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 21） |
| `bunx biome check`（改动文件） | 通过 |

## Harness（remote-cycle tag `p4`）

`scripts/hub-e2e/out/report.md`（远程 2026-08-28T07:16:47Z）：

| scenario | result |
|---|---|
| 1a–1c | PASS |
| 2a–2c | PASS |
| 3a–3g | PASS |
| 4a / **4b** / **4c** / 4d | PASS |
| 5 | PASS |
| **6a** / **6b** / 6c | PASS |
| 7a–7b | PASS |
| **8** | PASS |

无回归。日志在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/741cc3a1-5392-48be-8081-06f3803bdeb4/scratchpad/remote-out-p4/`。

中间有一次 3c FAIL：hub 空库时拒绝启动 uplink，本地 `attachLocalNode` 没挂上。已改为 hub 空库仍启动本地 uplink（catch-up 跳过），与 `hub user add` 在进程启动之后的现有流程兼容。
