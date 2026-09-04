# G3 结果：幽灵租户清理 + 中继模式版本门禁读 `peer_cache.version`

## 做了什么

### L2：`relay,node → relay` 不再留下本机幽灵租户

`leave targetRole=relay` 原先只 `clearMeshMembership()`，本机用户被删掉后，`relay_tenants` 里 `root_public_key = 本机用户根公钥` 的那一行还在（幽灵租户），子表靠 cascade 也没人删。

现在：

1. 清库前先取出本机用户 `rootPublicKey`。
2. `MeshMembershipStore.clearMeshMembership({ removeRelayTenantRootPublicKey })` 在**同一事务**里：
   - 清 mesh 成员表；
   - `DELETE relay_tenants WHERE root_public_key = ?`（FK cascade 清 `relay_nodes` / `relay_enrollments` / `relay_key_log`）。
3. 其它 root pk 的租户、`relay_config`、中继 env 键保留。
4. `relay,node → standalone` 仍走 `clearAll()`，行为不变。

**在线 uplink：** `membership-reset` 只拿得到 `quiesceMesh`（`assemble-routes` 里停 mesh + hub，**不停 RelayRuntime**）。范围内改不到接线，幽灵租户上的 uplink 靠 leave 随后的进程重启断开。代码与文档都写了这一点。

### L5：中继模式版本门禁改读 `peer_cache.version`

`inspectHubAuthRecordCompat()` 增加可选 `{ relayMode }`（默认 false，hub-runtime / uplink-server 调用方不用改）：

| 模式 | 版本来源 | 空注册表 |
|---|---|---|
| hub（默认） | `nodes.version` | 不再豁免；未撤销 cert 没有 nodes 行 → fail-closed |
| 中继 | `peer_cache.version`（`getPeer`） | 仅 `set-relays` / `meta-key` / `rename-node` 豁免；`admit-hub` / `retire-hub` / `rotate-root-keep` fail-closed |

细节：

- 对端在 cache 里但 version 缺失 / 无法解析 → fail-closed。
- 中继模式下本机 cert 通常不在 `peer_cache`（`relay.list` 跳过 self）：已有其它 active peer 时跳过未缓存 cert；peer cache 为空且非节点侧记录时，未撤销 cert 一律视为过旧。
- `listActivePeers` 做成 `hub-authorization.ts` 本地 helper（`listPeers()` 去掉 `HUB_META_PEER_ID`）。`getPeer` 已有，**没有改 `user-store.ts`**（该文件已顶 allowlist 960 行）。
- 删掉 `auth-key-log-routes.ts` 里中继模式对 `rotate-root-keep` 的整段 bypass；改为 `inspectHubAuthRecordCompat(..., { relayMode: this.inRelayMode(userId) })`。对端全员 ≥ 1.1.16 时合法 `rotate-root-keep` 仍通过。

文档 `docs/relay/2026090304-relay-role.md` 已更新 §7.3、§10 leave 句、§13 最后一条。

## 改动文件

- `packages/app/src/runtime/membership-reset.ts`
- `packages/app/src/runtime/membership-reset.test.ts`
- `apps/gateway/src/auth/mesh-membership-store.ts`
- `apps/gateway/src/auth/mesh-membership-store.test.ts`
- `apps/gateway/src/hub/hub-authorization.ts`
- `apps/gateway/src/hub/hub-authorization.test.ts`
- `apps/gateway/src/mesh/auth-key-log-routes.ts`
- `apps/gateway/src/mesh/auth-key-log-relay.test.ts`
- `docs/relay/2026090304-relay-role.md`

未改：`user-store.ts`、`relay-tenant-store.ts`、`hub-runtime.ts`、`setup-service.ts`、`relay-routes.ts`。

## 验证

```
cd apps/gateway && bun test src/hub/hub-authorization src/mesh/auth-key-log src/auth/mesh-membership
# 91 pass, 0 fail（3 files, 909 expect）

cd packages/app && bun test src/runtime/membership-reset
# 16 pass, 0 fail（106 expect）

bunx biome check <上述 9 个源文件>
# Checked, no errors
```

Type-check（本任务范围内的文件 0 错）：

- `cd apps/gateway && bunx tsc --noEmit -p .`：本范围文件无 TS 错。仓库里另有并行 agent 的错误：`src/mesh/relay-enrollment-fanout.ts` ×2、`packages/app/src/lib/native-datachannel.ts` ×1。
- `cd packages/app && bunx tsc --noEmit -p .`：同样只见 `relay-enrollment-fanout.ts`（app 引用 gateway）。

`bun scripts/complexity/gate.ts`：本范围文件通过。仓库失败 2 条属于其它 agent（`setup-service.ts:joinHub` 122>120、`commands/hub.ts` 1299>1298）。未给 user-store / 本任务文件加 allowlist。

未跑全仓 `bun run lint`（`biome check .` 会扫到其它 agent 正在改的文件）。

## 未决 / 不确定

- **RelayRuntime 断链：** leave 后立刻重启，没有从 membership-reset 可及的 relay stop hook。若希望不重启也能踢掉幽灵租户 uplink，需要改 `assemble-routes.ts` / `SetupServiceDeps`（超出本任务范围）。
- **首次 `set-relays`（尚未进入中继模式）** 仍走 hub 模式 `nodes.version`。`auth-key-log-relay` 的 boot fixture 会写 `nodes` 行，所以测试仍绿；生产上由 Hub 提交 `set-relays` 时 `nodes` 表是满的。纯 node 机器本地 `nodes` 为空时，现在会 fail-closed（不再用空 `nodes` 表豁免）。这是按 EX4「不再用 `listNodes().length === 0`」收窄后的行为。
- 仓库级 tsc / complexity 的失败项不在本任务文件内，留给对应 agent。
