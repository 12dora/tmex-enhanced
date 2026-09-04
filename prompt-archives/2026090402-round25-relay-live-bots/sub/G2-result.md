# G2 结果 — Hub 密码加入 TOTP / passkey pending / `admission_status`

## 做了什么

### L1a TOTP

- `PublishHubJoinSelfAdmitInput.totpCode?`；TOTP 开启时用本地 `userStore.getById(userId).rootEpoch`（缺省回退 `currentState.rootEpoch`）调用 `deriveTotpKey`，把 `{ code, kTotp }` 传给 `loginWithRootKey()`，请求结束后 `kTotp.fill(0)`。
- 缺码 → 稳定 `JoinError('totp_required')`；Hub 返回 `TOTP_INVALID` → `totp_invalid`。
- `JoinHubInput.totpCode?` 经 `joinHub()` / `POST /api/setup/join` 传到 self-admit；路由校验 6–10 位数字。
- CLI：`tmex hub join <url> --password [--totp <code>]`，`COMMAND_FLAGS` 允许 `--totp`，非交互读 `TMEX_TOTP`；TTY 在 Hub 报告需要时再 prompt。`HubIo.totpCode` 已接通。
- `hub-client.ts` 映射 `TOTP_REQUIRED` / `TOTP_INVALID`。

新逻辑放在 `packages/app/src/commands/hub-join-totp.ts`，`hub.ts` 未再增长（1294 行，allowlist 1298）。

### L1b passkey-only → pending

- `passkeySecondFactor`（含 TOTP+passkey）不再把整次加入打成 `join_failed`。
- enrollment / redeem / 本地 commit 照常完成，跳过 self-admit，结果 `admitPending: true`。
- setup JSON 带该字段；CLI 输出「已加入，等待已登录的浏览器批准」/ `Joined; waiting for approval from a signed-in browser`。
- 节点以 `node` 重启后 uplink 仍会 `unknown-cert`，直到浏览器补 `admit-node`（F3）。

### L3 `GET /api/hub/nodes`

未改 `nodes.status` 约束。派生：

| 条件 | `admission_status` |
|---|---|
| `nodes.status === 'revoked'` 或 cert `revokedLogSeq != null` | `revoked` |
| 有未撤销 `node_certs` | `admitted` |
| 已 redeem、有存储证书、无 live cert | `pending` |

pending 行额外返回 `enrollment_id` / `authorization` / `authorization_sig`（加上原有 `certificate` / `cert_sig`），正好够 `buildAdmitNodeRecord()`。未加 `public_key`（FE `buildAdmitNodeRecord` 不需要）。Hub 节点 DTO 不在 `packages/shared/src/contracts/hub*.ts`，未改 shared。

## 改动文件

- `packages/app/src/lib/hub-password-self-admit.ts` + test
- `packages/app/src/lib/hub-password-join.test.ts`（enrollment 仍不拦 2FA）
- `packages/app/src/lib/hub-client.ts` + test（错误映射）
- `packages/app/src/runtime/setup-service.ts` + test
- `packages/app/src/runtime/setup-routes.ts` + test
- `packages/app/src/commands/hub.ts` + `hub-join-totp.ts` + test
- `packages/app/src/lib/args.ts` + test
- `packages/app/src/cli/help.ts`
- `packages/app/src/i18n/index.ts` + test
- `apps/gateway/src/hub/hub-runtime.ts` + `hub-runtime.test.ts`

未改 `apps/fe`、`node-persistence.ts`、shared contracts。

## 验证

```
cd packages/app && bun test src/lib/hub-password src/runtime/setup src/commands/hub src/lib/args
→ 151 pass / 0 fail

cd packages/app && bun test src/lib/hub-client src/commands/hub-join-totp
→ 25 pass / 0 fail

cd packages/app && bunx tsc --noEmit -p .
→ exit 0

cd apps/gateway && bun test src/hub/hub-runtime
→ 26 pass / 0 fail（含 pending / admitted / revoked）

cd apps/gateway && bunx tsc --noEmit -p .
→ 1 个错误，不在本任务文件：packages/app/src/lib/native-datachannel.ts TS5097（其他 agent）

bunx biome check <本任务 20 个文件>
→ 通过

bun scripts/complexity/gate.ts
→ complexity gate ok
```

## 未决 / 不确定

- FE 的 `HubNodeRow` / 节点表「待批准」按钮属 F3，本任务只提供后端 `admission_status` 与 admit 材料。
- 未加 `public_key`；若 F3 希望避免解析 certificate，可再补。
- gateway 全量 `tsc` 被 `native-datachannel.ts` 拖成 exit 2，与 G2 无关。
