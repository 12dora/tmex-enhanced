# G8 结果 — 修复 R3 readmit-node 审查（backend + shared + CLI）

## 结论

R3 的两个 blocker 与 should-fix 已按最小修复落地：`readmit-node` 版本门禁 fail-closed、root 重编码授权 helper、CLI 顺序改为 **readmit → enroll → set-relays**。文档 §4 / §12 已同步。

## 改动文件

- `apps/gateway/src/hub/hub-authorization.ts`
  - `readmit-node` 不再列入空 cache bootstrap 豁免（它要求已有证书，不存在首节点场景）。
  - `inspectHubAuthRecordCompat` 对 `readmit-node` 打开 `failClosedUncached`：中继模式也不再 `skipUncached`；任何未吊销、非本机、无缓存版本的证书一律阻塞。
- `apps/gateway/src/hub/hub-authorization.test.ts`
  - 空注册表用例：`set-relays` / `meta-key` / `rename-node` 仍放行，`readmit-node` 改为阻塞。
  - 新增「空 peer cache 但有 cert → 阻塞」「一个已缓存 + 一个未缓存 cert → 阻塞」（后者同时确认 `set-relays` 仍跳过未缓存证书；两边都缓存且 ≥ 1.1.26 后 `readmit-node` 放行）。
- `packages/shared/src/auth/readmit-node-record.ts`
  - 新增 `buildRootReadmitAuthorization({ authorizationBytes, rootEpoch, rootKey })`：解码原 `Authorization`，按相同 `uid` / `enroll_pk` / `exp` 重编码为 `signer: 'root'`、`credential_id: null`、当前 `root_epoch`，并用根签名。`applyReadmitNode` 无需改逻辑即可接受（证书字节仍须完全一致）。
- `packages/shared/src/auth/index.ts` — 导出该 helper（F7 已从 `@tmex/shared/auth` 引用）。
- `packages/shared/src/auth/readmit-node-record.test.ts`
  - passkey 承认的成员：直接用根重签原字节 → `bad_authorization_sig`；helper 重编码后 `applyReadmitNode` 成功，证书不变。
  - root 承认的成员经 `rotate-root-keep` 后由新根 helper 重新确认。
  - 篡改 `enroll_pk` 后被拒绝（`bad_cert_sig` / `enroll_pk_mismatch`）。
- `packages/app/src/lib/relay-session.ts` — CLI readmit 循环改用 helper，不再对原 `authorization_bytes` 直接 root 签名。
- `packages/app/src/lib/relay-session.test.ts` — passkey 原授权被重编码为 root 签名。
- `packages/app/src/commands/relay.ts` — `enroll` / `reauth`：先 `GET /api/mesh/relay/readmit/prepare` + 补签，再 proof / 远端 enroll；`readmitRequired > 0` 只作事后校验，中止 `set-relays`。
- `packages/app/src/commands/relay.test.ts` — 顺序断言、passkey+root 两条补签、readmit 失败不调用 enroll、`readmitRequired` 残留中止。
- `packages/app/src/i18n/index.ts` — `relay.enroll.readmitPending`（en / zh-CN）。
- `docs/relay/2026090304-relay-role.md` §4 / §12 — 顺序 **readmit → enroll → set-relays**；空 cache 不再豁免 `readmit-node`；中继模式对未缓存证书 fail-closed。

未改 `apps/fe`（F7 并行）。未跑 `build:i18n`，未 git。

## 验证

```
cd apps/gateway && bun test src/hub/hub-authorization src/mesh/auth-key-log src/auth/readmit-node-compat
# 91 pass, 0 fail

cd apps/gateway && bun test src/hub/hub-authorization src/mesh/relay src/relay src/mesh/auth-key-log
# 283 pass, 0 fail, 2 errors（见下）

cd packages/shared && bun test src/auth
# 158 pass, 0 fail

cd packages/app && bun test src/commands/relay src/lib/relay-session
# 80 pass, 0 fail

cd apps/gateway && bunx tsc --noEmit -p .
# 仅既有 TS5097（packages/app/src/lib/native-datachannel.ts）

cd packages/shared && bunx tsc --noEmit -p .   # 0
cd packages/app && bunx tsc --noEmit -p .      # 0

bunx biome check <scope files>               # 0
bun run lint                                 # complexity gate ok
```

## 遗留 / 不确定

- `bun test src/mesh/relay src/relay` 在 `relay-hardening.test.ts` 测试间隙有 2 个未捕获 `LinkError: relay-rst`（`mux.ts` abort / `relay-stream-router.abortBoth`）。**0 fail**，与 readmit 门禁无关，属既有 mux RST 收尾；本任务未改 mux / hardening。
- 更完整的两阶段令牌换发（`set-relays` 确认后再作废旧 token）R3 已提到，不在本任务范围。本地 prepare 空列表仍是无操作；`readmitRequired` 只作事后闸。
