# P2 结果 — Hub password join + 本机 setup API + CLI

方案一已落地：机器用 **Hub URL + mesh 账户密码** 加入（不输入加入码）。客户端 `GET /api/auth/mode` → 派生根钥 → 本地 `createEnrollment` → `tmex/hub-enroll/v1` proof → `POST /api/hub/enrollments/by-password`（无 node-session）→ 用返回的 `key_log_head_hash` / CA 指纹编码普通加入码 → 既有 `performHubJoin()`。

## 行为要点

1. **Proof**：`packages/shared/src/auth/hub-enroll-proof.ts`，域 `tmex/hub-enroll/v1` = `domain ‖ hub_host ‖ uid ‖ root_public_key ‖ enroll_pk ‖ ts(u64)`，±5 分钟。Hub 按 proof 内 uid 取当前根公钥验签，再走 `verifyEnrollmentAuthorization`。
2. **创建路径**：`apps/gateway/src/hub/hub-password-enroll.ts` 的 `createEnrollmentFromAuth` 与 token 路径共用 persist / replication。`hub-runtime.ts` 只加 dispatch（`/api/hub/enrollments/by-password` 在 `/:id` **之前**），`handleCreateEnrollment` 改为委托。成功 201 比 token 路径多 `key_log_head_hash`、`root_public_key`。`enrollSk` 不经过 Hub。
3. **限流**：`hub-enroll-limiter.ts` 滑动窗口；失败键 `fail:${ip}:${uid}`（10 / 60s）；成功键 `ok:${uid}`（5 / 1h）。不记录 proof / 密码。
4. **Writer / standby**：by-password 走 `requireWriterOrForward(req)`（无 uid，与 redeem 相同）；standby 无活 writer 时 409 `HUB_NOT_WRITER`。
5. **Setup**：`POST /api/setup/join` 增加 `method: 'token' | 'password'`（默认 token）；`password` 与 `token` 互斥，都空 → 400。密码路径先 `requestEnrollmentByPassword` 再 `performHubJoin`。
6. **Relay join setup**：新 `POST /api/setup/relay-join`，调用 P1 的 `performRelayPasswordJoin`（见下方合同偏差）。
7. **CLI**：`tmex hub join <url> --password [<p>]`（与 `--token` 互斥；无值时隐藏输入；尊重 `TMEX_PASSWORD`）；`tmex relay join <url> --tenant <id> [--password] [--name] [--ca-fingerprint] [--no-restart]` → `runRelayPasswordJoin(parsed)`。

## 改动文件

**新增**

- `packages/shared/src/auth/hub-enroll-proof.ts` + `.test.ts`
- `apps/gateway/src/hub/hub-password-enroll.ts` + `.test.ts`
- `apps/gateway/src/hub/hub-enroll-limiter.ts` + `.test.ts`
- `packages/app/src/lib/hub-password-join.ts` + `.test.ts`
- `packages/app/src/runtime/relay-join-routes.ts` + `.test.ts`

**修改**

- `packages/shared/src/auth/index.ts`（仅末尾 append export）
- `apps/gateway/src/hub/hub-runtime.ts`（import + by-password dispatch；`userStore` / `now` / `config` / `tlsInfo` / `publishEnrollmentToken` / `verifyEnrollmentAuthorization` 对 Host 结构可见；`handleCreateEnrollment` 委托）
- `apps/gateway/src/hub/hub-runtime.test.ts`、`writer-forward.test.ts`
- `packages/app/src/commands/hub.ts`、`commands/join.test.ts`
- `packages/app/src/lib/args.ts`、`args.test.ts`、`args-relay.test.ts`
- `packages/app/src/lib/auth-spawn.ts`（`AUTH_COMMANDS` 加 `relay.join`）
- `packages/app/src/cli-auth-entry.ts`、`cli/help.ts`、`i18n/index.test.ts`
- `packages/app/src/runtime/setup-routes.ts` + test、`setup-service.ts`、`setup-shared.ts`（`parseJoinHubCredentials`）
- `packages/api-client/src/local/types.ts`、`setup-api.ts` + test
- `docs/hub/2026082700-hub-node-architecture.md`（「密码加入」小节）
- `packages/app/CHANGELOG.md`（1.1.24 `### New` / `### 新增` 各一条，未复制 header）

**未改（范围内判定不需要）**

- `hub-tokens.test.ts`（仍走同一 `createEnrollmentToken`）
- `packages/app/src/i18n/index.ts`（`cli.help` 来自 `cli/help.ts`，无新 key）

## 测试

- `hub-enroll-proof.test.ts`：签名 round-trip、host/uid/pk/根钥/签名失败、时间窗、畸形字节
- `hub-password-enroll.test.ts`：happy（无 session、带回 head hash / CA）、错密码 401、ts_skew 400、失败限流 429、成功上限 429、standby 409
- `hub-enroll-limiter.test.ts`：ip+uid 滑动窗口、成功按 uid 封顶、key 驱逐
- `hub-runtime.test.ts`：by-password 无 session 不是 401
- `writer-forward.test.ts`：路由列表含 `/api/hub/enrollments/by-password`
- `hub-password-join.test.ts`：换加入码、互斥、错密码 JoinError
- `setup-routes.test.ts`：password join、互斥、都空 400、relay-join happy
- `relay-join-routes.test.ts`：转发给 `performRelayPasswordJoin`
- `args.test.ts` / `args-relay.test.ts`：`--password`、relay join 为第十二个 auth 子命令
- `join.test.ts`：CLI `--token`/`--password` 互斥与缺省
- `setup-api.test.ts`：password method 透传、`relayJoin()`

## 验证

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit -p packages/shared` | 0 |
| `bunx tsc --noEmit -p apps/gateway` | 2 处，均非本任务：`relay-pack-http.ts`（P1）、`native-datachannel.ts`（预存） |
| `bunx tsc --noEmit -p packages/app` | 同上 `relay-pack-http.ts` + P1 `relay-password-join.test.ts` fetch 强转；本任务文件 0 |
| `bunx tsc --noEmit -p packages/api-client` | 3（`client.test.ts`×2 + `files-download.test.ts`×1；基线 5，未新增） |
| `packages/shared` `bun test` | **645 pass**（基线 631） |
| `apps/gateway` `bun test` | **4198 pass / 0 fail / 2 errors**（基线 ~4162 + 2 已知 in-flight） |
| `packages/app` `bun test` | **835 pass / 1 skip / 0 fail**（基线 816） |
| `packages/api-client` `bun test` | **206 pass**（基线 204） |
| `bunx biome check`（本任务文件） | 通过 |
| complexity gate（本任务文件） | 通过；仓库另有 7 条越限，全是 P1/fe，见下 |

## 需要指挥官处理

1. **超范围但必要**：`packages/app/src/lib/auth-spawn.ts` 把 `relay.join` 列入 `AUTH_COMMANDS`，否则 Node CLI 不会 spawn Bun，`args-relay.test.ts` 也会挂。
2. **P1 合同偏差**：`performRelayPasswordJoin` 实际签名是 `input: { relayUrl, tenantId, password, name?, caFingerprint? }`（无 `nodeEnv`），返回 `{ userId, relayUrl, tenantId }`（无 `username`）。`runRelayPasswordJoin(parsed, io?)` 自己从 positionals 取 URL。setup 路由已按实际签名接线，响应 `username` 填 `joined.userId`。若产品要显示用户名，需 P1 补返回值或本机再查。
3. **密码加入首次 HTTPS**：`requestEnrollmentByPassword` 先打未登录的 `/api/auth/mode`，此时还没有加入码里的 CA pin。公网证书走系统信任；自签需调用方注入 `fetcher`（setup 的 `deps.fetch` / CLI `io.fetcher`）。`insecureLocal` 只放行 loopback HTTP，不关 TLS pin。
4. **hub-runtime.ts 可见性**：Host 结构需要，将 `userStore` / `now` / `config` / `tlsInfo` / `publishEnrollmentToken` / `verifyEnrollmentAuthorization` 从 private 放宽。未加 allowlist。`handleRequest` CC 正好 15（多一条 `??`）。
5. **complexity 越限（非本任务）**：`relay-password-join.ts`（CC 25 / 175 行）、`relay-pack.ts:kdfParamsFromWire`、`relay-pack-http.ts:applyRelayKeyLogAppend`、`relay-runtime.ts:routePublic`、`relay-pack-routes.ts:handleMeshRelayPack`、`enrollment-section.tsx` 行数。指挥官收 P1/fe 时处理。
6. **`packages/app/src/i18n/index.ts` 未改**：CLI 帮助在 `cli/help.ts`；密码/互斥错误沿用既有英文 `throw new Error(...)`，与现有 hub join 一致。
