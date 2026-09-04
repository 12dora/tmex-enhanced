# EX4：relay-mode 遗留审计报告

审计依据：

- [relay-role 文档 §5b](/Users/konata/code/tmex-r25/docs/relay/2026090304-relay-role.md:185)、§7、§9、§13。
- [round24 执行结果·五、遗留](/Users/konata/code/tmex-r25/prompt-archives/2026090401-round24-relay-local-role/plan-00-result.md:57)。

| 项目 | 当前状态 |
|---|---|
| L1 | 未完成；TOTP 有现成登录底层能力，passkey 不能由纯 CLI/headless 完成 |
| L2 | 未完成；`relay,node → standalone` 清理中继运营状态已完成 |
| L3 | 后端已有部分材料，前端和正式 admission 状态缺失 |
| L4 | `scope=all` 已完成，但 enrollment fan-out 未完成 |
| L5 | 0041 与 `peer_cache.version` 已完成，两个版本门禁仍未接入 |
| L6 | 没有一步完成的原地迁移；通过同一密码重新加入可以重建原 root key，但 node id 会改变 |

## L1：TOTP / passkey 账号无法走 Hub 密码加入

### 当前路径

Hub 密码加入接口本身只验证根钥 proof，不执行用户登录或二次验证：

- [hub-password-enroll.ts:95](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-password-enroll.ts:95) 的 `acceptPasswordEnroll()` 从 proof 解出 `uid`，用用户 `rootPublicKey` 调用 `verifyHubEnrollProof()`，没有 TOTP/passkey 检查。
- [hub-password-join.ts:224](/Users/konata/code/tmex-r25/packages/app/src/lib/hub-password-join.ts:224) 的 `requestEnrollmentByPassword()` 根据密码派生 root key，签名 proof，然后 POST `/api/hub/enrollments/by-password`。
- `/api/setup/join` 只把 `method/password/token/name` 传给 `joinHub()`；[setup-routes.ts:65](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-routes.ts:65) 至 [setup-routes.ts:80](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-routes.ts:80) 没有 TOTP 字段。
- [setup-service.ts:473](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-service.ts:473) 的 `joinHub()` 在密码模式拿到 root key 后，调用 `publishHubJoinSelfAdmit()`；[setup-service.ts:548](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-service.ts:548)。

真正失败点是 G7 自承认：

```ts
if (mode.passkeySecondFactor) {
  throw new JoinError(
    'join_failed',
    'this account requires passkey second-factor; password join cannot publish admit-node'
  );
}
if (mode.totpEnabled) {
  throw new JoinError(
    'join_failed',
    'this account requires TOTP; password join cannot publish admit-node'
  );
}
```

见 [hub-password-self-admit.ts:151](/Users/konata/code/tmex-r25/packages/app/src/lib/hub-password-self-admit.ts:151)。随后 [hub-password-self-admit.ts:201](/Users/konata/code/tmex-r25/packages/app/src/lib/hub-password-self-admit.ts:201) 调用 `loginWithRootKey()`，但没有传 TOTP。

网关登录流程确实强制执行二因子：

- [auth-routes.ts:380](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-routes.ts:380) 调用 `verifySecondFactors()`。
- [auth-routes.ts:565](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-routes.ts:565) 的 `checkTotp()` 要求 `code + k_totp`。
- [auth-routes.ts:591](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-routes.ts:591) 的 `checkPasskeySecondFactor()` 要求 WebAuthn assertion；只有可信本地客户端才可通过 [client-source.ts:45](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/client-source.ts:45) 的 waiver。

`loginWithRootKey()` 已经支持 TOTP 参数：

```ts
totp?: { code: string; kTotp: Uint8Array };
```

见 [hub-client.ts:170](/Users/konata/code/tmex-r25/packages/app/src/lib/hub-client.ts:170)，并在 [hub-client.ts:220](/Users/konata/code/tmex-r25/packages/app/src/lib/hub-client.ts:220) 发送 `code` 与 `k_totp`。

### 最小 TOTP 修改

建议只把 TOTP 接入 G7 登录，不把 TOTP 发送到 `/api/hub/enrollments/by-password`：

1. 在 `PublishHubJoinSelfAdmitInput` 增加 `totpCode?: string`，修改 [hub-password-self-admit.ts:24](/Users/konata/code/tmex-r25/packages/app/src/lib/hub-password-self-admit.ts:24)。
2. 删除 `assertPasswordJoinCanAdmit()` 对 `mode.totpEnabled` 的拒绝，仅保留 passkey 拒绝。
3. TOTP 开启时：
   - 从本地 `userStore.getById(userId)` 取得 `rootEpoch`；
   - 使用 `deriveTotpKey(rootKey.seed, userId, rootEpoch)`。实现见 [totp.ts:12](/Users/konata/code/tmex-r25/packages/shared/src/auth/totp.ts:12)；
   - 调用：
     ```ts
     loginWithRootKey({
       ...,
       totp: { code: totpCode, kTotp }
     })
     ```
   - 请求完成后清零 `kTotp`。
4. `JoinHubInput` 增加 `totpCode?: string`，修改 [setup-service.ts:140](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-service.ts:140) 和 [setup-routes.ts:65](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-routes.ts:65)。
5. CLI `HubIo` 已经有 `totpCode?: string`，见 [hub.ts:66](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:66)，但 [hub.ts:634](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:634) 当前没有传入。应接通该字段。
6. 非交互 CLI 建议使用已有约定的 `TMEX_TOTP`，而不是把验证码暴露在进程参数中。当前 `tmex hub join` 没有 `--totp`，`COMMAND_FLAGS` 也未允许该 flag，见 [args.ts:231](/Users/konata/code/tmex-r25/packages/app/src/lib/args.ts:231)。若确实需要 flag，再增加 `--totp`。
7. `hub-client.ts:251` 的错误映射增加 `TOTP_REQUIRED`、`TOTP_INVALID`，否则当前只会显示泛化的 HTTP 错误。

测试至少增加：

- `hub-password-self-admit.test.ts`：TOTP 正确时登录并追加 `admit-node`；错误或缺失时返回明确错误。
- `setup-routes.test.ts`：`POST /api/setup/join` 的 `totpCode` 能传到 self-admit。
- `hub-password-join.integration.test.ts`：TOTP 账号完整加入并通过 uplink 认证。
- 同时覆盖“同时开启 TOTP + passkey”仍不能纯 CLI 完成。

### Passkey-only 是否可支持

纯 CLI/headless 不可直接支持。

原因是网关要求 WebAuthn assertion，且 [auth-routes.ts:591](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-routes.ts:591) 需要 `clientDataJSON`、origin、credential id 等浏览器产生的数据。`loginWithRootKey()` 没有 passkey assertion 参数。

可行的最小 fallback 是：

1. 密码加入完成 enrollment/redeem 和本地 commit。
2. 不再因 passkey 直接把整个加入判为 `join_failed`。
3. 将节点标记为 pending，并提示“请在已有登录浏览器中确认”。
4. 复用前端已有 admission 流程：
   - [enrollment-engine.ts:726](/Users/konata/code/tmex-r25/apps/fe/src/node/enrollment-engine.ts:726) 调用 `op.prompt.request({ purpose: 'admit', reuse: true })`；
   - [enrollment-engine.ts:757](/Users/konata/code/tmex-r25/apps/fe/src/node/enrollment-engine.ts:757) 获取 redeemed certificate；
   - [enrollment.ts:492](/Users/konata/code/tmex-r25/apps/fe/src/node/enrollment.ts:492) 构造并签名 `admit-node`。

这样 passkey 只在已有浏览器会话中完成。若要求新机器上的 CLI 自己完成 passkey ceremony，则必须增加浏览器 UI/WebAuthn 通道，不能用当前 CLI 实现。

### RELAY 密码加入是否受 2FA 阻塞

不受 Hub 登录二因子阻塞。

`performRelayPasswordJoin()`：

- [relay-password-join.ts:152](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-password-join.ts:152) 直接执行密码派生、下载 pack、回放日志和自承认。
- [relay-password-join-flow.ts:208](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-password-join-flow.ts:208) 通过 `GET /kdf`、派生 root seed、签名 `mode:'join'` 的 relay proof，然后 POST `/api/relay/enroll`。
- [relay-password-join-flow.ts:330](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-password-join-flow.ts:330) 直接用租户 token 向 relay 追加 `admit-node` 和 `meta-key`。

整个流程没有 `/api/auth/login`，也没有 `verifySecondFactors()`。

[relay-password-join.ts:114](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-password-join.ts:114) 的限制是本机不能已有 mesh user 或 `node_identity`；这会返回 `local_user_exists`，不是 2FA 失败。

另外：

- `POST /api/setup/relay-join` 受 standalone 门禁，见 [setup-routes.ts:83](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-routes.ts:83)。
- CLI `tmex relay join` 使用本地 `withAuth()`，但 [with-auth.ts:4](/Users/konata/code/tmex-r25/packages/app/src/commands/with-auth.ts:4) 只是打开本地数据库上下文，不是远程 Hub 登录。

## L2：`leave targetRole=relay` 残留幽灵租户

### 当前行为

[ membership-reset.ts:137](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:137) 当前逻辑：

```ts
if (targetRole === 'relay') {
  store.clearMeshMembership();
  return;
}
store.clearAll();
```

`clearMeshMembership()` 只删除 mesh 成员数据：

- [mesh-membership-store.ts:23](/Users/konata/code/tmex-r25/apps/gateway/src/auth/mesh-membership-store.ts:23) 至少删除 `users`、`userKeyLog`、`nodeIdentity`、`nodes`、`nodeCerts`、`meshHubs`、`meshRelays`。
- `clearRelayOperatorState()` 才删除 `relayTenants`、`relayNodes`、`relayEnrollments`、`relayKeyLog`、`relayConfig`，见 [mesh-membership-store.ts:40](/Users/konata/code/tmex-r25/apps/gateway/src/auth/mesh-membership-store.ts:40)。
- `clearAll()` 两者都删，见 [mesh-membership-store.ts:63](/Users/konata/code/tmex-r25/apps/gateway/src/auth/mesh-membership-store.ts:63)。

中继租户保存根公钥：

```ts
rootPublicKey: blob('root_public_key').notNull()
```

见 [relay.ts:18](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/relay.ts:18)。`relayNodes`、`relayEnrollments`、`relayKeyLog` 都对租户使用 `onDelete: 'cascade'`，见 [relay.ts:36](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/relay.ts:36)、[relay.ts:58](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/relay.ts:58)、[relay.ts:72](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/relay.ts:72)。

因此 `relay,node → relay` 会删掉本机用户/root，但保留所有 relay operator tenants。现有测试明确验证了这个行为：

- [membership-reset.test.ts:356](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.test.ts:356) 期望 `relayTenants` 仍有一行。

### 最小修改

只删除与“即将离开的本地 mesh 用户 root pk”匹配的租户：

1. 在清除 mesh 数据前取得本地 primary user 的 `rootPublicKey`。
2. 扩展 `MeshMembershipStore.clearMeshMembership()`，例如：
   ```ts
   clearMeshMembership(options?: {
     removeRelayTenantRootPublicKey?: Uint8Array;
   })
   ```
3. 在同一个数据库事务中：
   - 清除 mesh membership；
   - 若存在 `removeRelayTenantRootPublicKey`，删除：
     ```ts
     relayTenants.rootPublicKey = rootPublicKey
     ```
4. 不删除其他 root pk 的租户。
5. 由于外键级联，匹配租户的节点、enrollment、keylog 会一起删除。也可以复用 [relay-tenant-store.ts:75](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-tenant-store.ts:75) 的 `getByRootPublicKey()`，但最好不要拆成两个事务。

`clearMembershipForTarget()` 需要接收该 root pk，[membership-reset.ts:137](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:137) 的调用方必须在删除用户前捕获它。

不需要数据库迁移。

测试增加：

- matching local root tenant 被删除；
- foreign tenant 保留；
- matching tenant 的 `relayNodes`、`relayEnrollments`、`relayKeyLog` 级联删除；
- `relay,node → standalone` 仍删除所有 relay operator state。

### `relay,node → standalone` 是否已正确清理

已正确，且不应修改。

[ membership-reset.ts:161](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:161) 只允许 `relay,node → relay`，默认 standalone。standalone 分支调用 `clearAll()`。

现有测试 [membership-reset.test.ts:380](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.test.ts:380) 已验证 `relayConfig` 和 `relayTenants` 都被清空。

## L3：Hub 节点列表没有 pending / unadmitted 状态

### 当前状态模型

Hub 的 `nodes.status` 数据库约束只有：

```ts
check('nodes_status_check', sql`${table.status} in ('enrolled', 'revoked')`)
```

见 [mesh.ts:14](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/mesh.ts:14) 至 [mesh.ts:34](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/mesh.ts:34)。

`upsertEnrolledNode()` 只写 `enrolled`，见 [node-persistence.ts:58](/Users/konata/code/tmex-r25/apps/gateway/src/hub/node-persistence.ts:58)。

Hub REST 节点列表在 [hub-runtime.ts:828](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-runtime.ts:828)：

- 返回原始 `n.status`；
- 从 `node_certs` 或已 redeem enrollment 中返回 certificate/cert_sig；
- 没有判断“certificate 是否已经被 admit-node 应用”。

```ts
status: n.status,
...
...(certificate ? { certificate } : {}),
...(certSig ? { cert_sig: certSig } : {})
```

而 `handleGetEnrollment()` 已经能区分 enrollment 自身的 `pending/redeemed`，见 [hub-runtime.ts:856](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-runtime.ts:856)。问题是这个状态没有投影到 `/api/hub/nodes`。

真正的 uplink admission 判定是 `node_certs`：

```ts
const cert = this.userStore.getCert(nodeId);
if (!cert) {
  this.rejectAuth(link, nodeId, 'cert_not_admitted', 'unknown-cert');
  return;
}
```

见 [uplink-server.ts:1286](/Users/konata/code/tmex-r25/apps/gateway/src/hub/uplink-server.ts:1286)。

`node.list` 也没有 admission 字段。它只按 `nodes.status === 'enrolled'` 投影，见 [uplink-server.ts:1937](/Users/konata/code/tmex-r25/apps/gateway/src/hub/uplink-server.ts:1937)。因此它无法区分“已 enrolled 但还没有 node_certs”。

前端更明显：

- `/api/mesh/nodes` 的 `collectNodes()` 只从有效 `node_certs` 构建节点，见 [mesh-routes.ts:415](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/mesh-routes.ts:415) 和 [mesh-routes.ts:419](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/mesh-routes.ts:419)。
- `mergeNodes()` 只遍历 mesh 节点，并把 Hub 行作为补充字段，见 [mesh-nodes.ts:176](/Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:176)。
- 其注释明确写着“mesh 列表是权威成员集，未 admit / revoked 不出现”，见 [mesh-nodes.ts:172](/Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:172)。
- `HubNodeRow` 当前只有原始 `status`，见 [hub-api.ts:11](/Users/konata/code/tmex-r25/apps/fe/src/node/hub-api.ts:11)。
- 节点表只显示在线/离线，见 [nodes-table.tsx:117](/Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:117)，没有 admit 操作。

### 建议的最小模型

不要扩展数据库 `nodes.status`。它表示 Hub enrollment registry 状态，不应混合 key-log admission。

在 `GET /api/hub/nodes` DTO 增加派生字段：

```ts
admission_status: 'pending' | 'admitted' | 'revoked'
```

建议规则：

- `nodes.status === 'revoked'` 或 cert 已撤销：`revoked`；
- `node_certs` 有未撤销证书：`admitted`；
- enrollment 已 redeem、存在存储的 certificate，但 `node_certs` 没有对应记录：`pending`；
- 没有证书的未 redeem enrollment 不进入节点列表，继续由 enrollment 列表显示。

为支持刷新后的“一键批准”，DTO 还应返回：

- `enrollment_id`；
- `authorization`；
- `authorization_sig`；
- `certificate`；
- `cert_sig`；
- 建议增加 `public_key`，避免前端重新解析 certificate。

这些字段已经是签名材料，不是秘密，但只应通过已认证的 Hub 节点列表返回。现有 `buildAdmitNodeRecord()` 需要 authorization/certificate 全套材料，见 [enrollment.ts:482](/Users/konata/code/tmex-r25/apps/fe/src/node/enrollment.ts:482)。

前端修改：

1. `HubNodeRow` 增加 `admission_status` 和 admission material。
2. `mergeNodes()` 将 Hub-only pending 行并入结果，而不是只遍历 `meshNodes`。
3. pending 行：
   - `online=false`；
   - 禁用升级、移除、远程详情等依赖已 admission 的操作；
   - 显示“待批准”。
4. 增加 `Admit` 按钮，复用：
   - `op.prompt.request({ purpose: 'admit', reuse: true })`；
   - `buildAdmitNodeRecord()`；
   - `submitAdmitRecord()`。
5. Hub admission 不需要 relay 的 `meta-key/prepare op:'admit'`；那是 relay 元数据密钥跟进路径。

i18n 源文件应修改：

- [zh_CN.json:1729](/Users/konata/code/tmex-r25/packages/shared/src/i18n/locales/zh_CN.json:1729)；
- [en_US.json:1729](/Users/konata/code/tmex-r25/packages/shared/src/i18n/locales/en_US.json:1729)；
- `ja_JP.json` 对应节点管理段。

增加类似：

```json
"nodes": {
  "status": {
    "pending": "待批准",
    "admitted": "已接纳",
    "revoked": "已撤销"
  },
  "actions": {
    "admit": "批准加入"
  }
}
```

不要直接修改生成的 `resources.ts`、`types.ts`，应运行 i18n 生成脚本。

测试：

- `hub-runtime.test.ts`：redeemed enrollment 无 `node_certs` 返回 `pending`，有 live cert 返回 `admitted`，撤销返回 `revoked`。
- `mesh-nodes.test.ts`：Hub-only pending 行能并入，已存在 mesh 行不重复。
- `nodes-table` 组件测试：显示 pending 标签和 admit 按钮。
- admission action 测试：浏览器签名并追加 `admit-node` 后列表刷新为 admitted。
- 保留 `unknown-cert` uplink rejection 测试。

## L4：enrollment fan-out 到全部 relay

### 当前代码

这项只有一半已完成。

`GET /api/mesh/relay/join-material` 已支持 `?scope=all`：

```ts
const all = new URL(req.url).searchParams.get('scope') === 'all';
const targets = all
  ? [attached, ...rows.filter((row) => row.url !== attached.url)]
  : [attached];
```

见 [relay-routes.ts:377](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-routes.ts:377)。

但默认仍只返回 attached relay。round24 已完成的只是 `scope=all` 能力，调用方还没有把 enrollment fan-out 接上。

`POST /api/mesh/relay/enrollments` 当前只创建一次：

```ts
const client = this.relayClient();
...
const ack = await client.createEnrollment(...)
```

见 [relay-routes.ts:406](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-routes.ts:406) 和 [relay-routes.ts:434](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-routes.ts:434)。

`RelayUplinkClient.createEnrollment()` 也只有一个 attached uplink，见 [relay-uplink-client.ts:313](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-uplink-client.ts:313)。`RelayEnrollChannel` 是单连接、单发送通道，见 [relay-uplink-auth.ts:95](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-uplink-auth.ts:95)。

前端 `createEnrollmentOnRelay()`：

- 不带 `scope=all` 调 `joinMaterial()`；
- 只调用一次 `channel.createEnrollment()`；
- 然后把所有返回 relay material 放进 r3。

见 [relay-join.ts:45](/Users/konata/code/tmex-r25/apps/fe/src/node/relay-join.ts:45) 至 [relay-join.ts:86](/Users/konata/code/tmex-r25/apps/fe/src/node/relay-join.ts:86)。

因此 token 中可能包含没有对应 enrollment 的 relay，客户端在该 relay redeem 会 404。`redeemAgainstRelays()` 对非传输错误不会继续尝试，见 [relay-join.ts:253](/Users/konata/code/tmex-r25/packages/app/src/commands/relay-join.ts:253)。

### 建议实现

最小方案是新增 relay-side tenant-token HTTP 控制接口，而不是强行同时建立多个 WebSocket uplink：

```http
POST /api/relay/tenants/:tenantId/enrollments
x-tmex-relay-token: <token>
```

body：

```json
{
  "id": "...",
  "enroll_pk": "...",
  "authorization": "...",
  "authorization_sig": "...",
  "exp": 123
}
```

后端拆出共享函数，供现有 `handleRelayEnrollCreate()` 和新 HTTP route 共用：

- 校验 tenant token；
- 校验 enrollment authorization；
- 校验过期时间、配额、限流；
- 写入 `relay_enrollments`；
- 已存在同 `id` 时，仅当 payload 完全一致才按幂等成功处理。

节点侧 `POST /api/mesh/relay/enrollments`：

1. 生成一个 enrollment id；
2. 写本地 `enrollmentTokens`；
3. 对每个 `mesh_relays` 并发发送 create；
4. 每个请求有短 timeout；
5. 用 `Promise.allSettled()` 容忍部分 relay 失败；
6. 至少一个 relay 接受才保留本地 enrollment；
7. 全部失败则 invalidate 本地 enrollment 并返回错误；
8. 返回每个 relay 的 accepted/rejected 结果，例如：
   ```json
   {
     "id": "...",
     "relays": [
       { "url": "...", "tenantId": "...", "accepted": true },
       { "url": "...", "tenantId": "...", "accepted": false, "error": "timeout" }
     ]
   }
   ```

前端必须只把 accepted relay 放进 join token。`relay-pack-upload.ts` 这种明确需要全部 relay 的调用方应显式请求：

```ts
path: '/api/mesh/relay/join-material?scope=all'
```

当前 [relay-pack-upload.ts:164](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-pack-upload.ts:164) 没有带 query。

### r3 token 应编码什么

当前 r3 固定格式是：

```text
enroll_sk 32
root_pk 32
head_hash 32
K_log 32
relay entries:
  url + tenant_id + token
```

见 [join-token.ts:4](/Users/konata/code/tmex-r25/packages/shared/src/relay/join-token.ts:4)、[join-token.ts:116](/Users/konata/code/tmex-r25/packages/shared/src/relay/join-token.ts:116)。

建议：

- token 只编码 fan-out 成功的 relay；
- 每条 relay 继续携带自己的 `url + tenantId + token`；
- 增加共同的 `enrollment_id`，用于诊断、状态关联和幂等。

但是增加字段会改变现有 r3 二进制布局。最佳做法是引入 `r4.`。如果必须保持旧 r3 兼容，则不改 r3 布局，只过滤 accepted relay；redeem 实际上按 `enroll_pk` 查找，当前 [relay-join.ts:131](/Users/konata/code/tmex-r25/packages/app/src/commands/relay-join.ts:131) 并不需要 enrollment id。

测试：

- 两个 relay 都接受；
- 一个 relay timeout、另一个接受；
- 全部拒绝时本地 enrollment 被 invalidate；
- 重复 create 幂等；
- r3/r4 token 只包含 accepted relay；
- 客户端遇到某 relay 404 时不会因为错误 entry 阻断正确 relay；
- `relay-pack-upload` 确实拿到所有 relay material。

不需要迁移；现有 `relay_enrollments.id` 是每个 relay 本地表的主键，同一个 UUID 可以写入多个 relay 数据库。

## L5：relay 模式版本门禁仍读 `nodes`

### 当前代码

`peer_cache.version` 已存在：

- schema：[mesh.ts:54](/Users/konata/code/tmex-r25/apps/gateway/src/db/schema/mesh.ts:54)；
- migration：[0041_peer_cache_version.sql:1](/Users/konata/code/tmex-r25/apps/gateway/drizzle/0041_peer_cache_version.sql:1)；
- `upsertPeer()` 已保存 version，见 [user-store.ts:466](/Users/konata/code/tmex-r25/apps/gateway/src/auth/user-store.ts:466)；
- relay `node.list` 已把 version 写入 peer cache，见 [uplink-peer-persist.ts:11](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/uplink-peer-persist.ts:11)。

但 `inspectHubAuthRecordCompat()` 仍然走 Hub 节点表：

```ts
const node = userStore.getNode(cert.nodeId);
...
version: node?.version ?? null
```

见 [hub-authorization.ts:183](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:183)。

当前空表豁免也是：

```ts
if (isNodeSideRecordType(type) && userStore.listNodes().length === 0) {
  return { ok: true };
}
```

见 [hub-authorization.ts:216](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:216)。

第二个门在 [auth-key-log-routes.ts:464](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-key-log-routes.ts:464)：

```ts
if (isRotateRootKeepRecord(bytes) && this.inRelayMode(userId)) return null;
```

这会在 relay 模式完全绕过 `inspectHubAuthRecordCompat()`。

### 最小修改

1. 把 `inspectHubAuthRecordCompat()` 的版本来源抽象出来：
   - Hub 模式：继续读取 `nodes.version`；
   - relay 模式：读取 `userStore.getPeer(cert.nodeId)?.version`。
2. relay 模式只对 active cert 检查 peer cache。
3. peer 存在但 version 缺失或无法解析时，fail-closed，视为不满足最低版本。
4. 空注册表豁免缩小为：
   ```ts
   relayMode &&
   isNodeSideRecordType(type) &&
   listActivePeers().length === 0
   ```
   不再用 `userStore.listNodes().length === 0`。
5. Hub-auth 记录和 `rotate-root-keep` 不应因为空 relay peer cache 而无条件放行。
6. 接入 relay peer cache 后，删除或缩小 [auth-key-log-routes.ts:475](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-key-log-routes.ts:475) 的 `rotate-root-keep` 特殊 bypass，否则 L5 仍未真正修复。

不需要迁移。

测试：

- relay peer version 为旧版本时阻止记录；
- version 满足要求时放行；
- peer cache 空时，仅 `set-relays`、`meta-key`、`rename-node` 保留 bootstrap 豁免；
- hub-auth 和 rotate-root-keep 仍 fail-closed；
- peer cache version 缺失/非法时阻止；
- Hub 模式原有 `nodes.version` 测试保持通过。

## L6：现场迁移流程审计

### 总体结论

当前流程不能保持原 node id。它会：

- `leave` 删除本地用户、key-log、证书、session、`node_identity`；
- 后续 `relay join` 重新生成 node id；
- 如果使用同一个 mesh 密码，root seed/root public key 可以重建；
- key-log replay 会恢复 passkey 公钥记录和 TOTP 密文状态；
- passkey 私钥仍只存在原浏览器/硬件中，不会被复制到 B；
- 旧 B node id 会留在历史 admission/relay registry 中，除非另行 revoke。

如果只有浏览器持有 raw root key、没有对应 mesh password，当前 CLI 没有 raw root-key 导入路径，无法完成重建。

### (a) B：`POST /api/local/leave`，从 `hub,node` 离开

`POST /api/local/leave` 要求本地 node-session：

```ts
const auth = deps.authenticate(req);
if (!auth.ok) {
  return jsonErr('unauthorized', 'login required', 401);
}
```

见 [local-routes.ts:35](/Users/konata/code/tmex-r25/packages/app/src/runtime/local-routes.ts:35)。

`targetRole` 缺省是 standalone，见 [membership-reset.ts:28](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:28)。而：

```ts
if (targetRole === 'relay' && fromRole !== 'relay,node') {
  throw new SetupError('invalid_target', ...);
}
```

见 [membership-reset.ts:161](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:161)。

所以 `hub,node → relay` 当前直接返回 400，不能一步完成。

B 执行默认 leave 后：

- 本地角色/env 变成 standalone；
- 本地 `clearAll()` 删除 B 自己的用户、key-log、cert、node identity、`mesh_hubs`、`mesh_relays`、relay operator state；
- 代码没有向 A 或其他节点发送远程 leave/revoke；
- 因此其他节点数据库中的 `mesh_hubs` 不会立即删除，只会在后续心跳/过期逻辑中变成不可达或被清理。

A 不会因为 B 离开立即自动晋升。自动晋升默认关闭：

```ts
export function parseHubAutoPromote(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
}
```

见 [config.ts:213](/Users/konata/code/tmex-r25/apps/gateway/src/config.ts:213)。

即使开启 `TMEX_HUB_AUTO_PROMOTE`，还要满足 standby、writer 不可达超过默认 600 秒、优先级最低、quorum 等条件，见 [hub-peer-poller.ts:97](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-peer-poller.ts:97)。

手工晋升有两条路径：

- API：`POST /api/hub/role`，body 至少包含 `operationId` 和 `mode:'active'`，见 [hub-role-routes.ts:108](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-role-routes.ts:108)；
- CLI：`tmex hub promote --yes`，本地直接执行角色 transition，见 [hub.ts:1145](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:1145)。

### (b) B：standalone → pure relay

`POST /api/setup/relay` 只接受 standalone：

```ts
if (!isStandaloneRoles(deps.roles)) {
  return jsonErr('not_standalone', ...);
}
```

见 [setup-routes.ts:83](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-routes.ts:83)。

`becomeRelay()` 也再次要求 standalone，见 [relay-setup-service.ts:115](/Users/konata/code/tmex-r25/packages/app/src/runtime/relay-setup-service.ts:115)。

角色差异：

- `role:'relay'`：不创建 mesh user/root；
- `role:'relay,node'`：调用 `bootstrapRelayNodeUser()`，生成全新 user/root/node identity，见 [relay-setup-service.ts:89](/Users/konata/code/tmex-r25/packages/app/src/runtime/relay-setup-service.ts:89)。

因此 B 应先变成纯 relay，再由 Mac 使用原 root/password 对 B relay 执行 enrollment，最后 B 自己再 `relay join`。直接 setup `relay,node` 会创建新 root，不符合保留原账号的目标。

`tmex init --role relay` 的 role 解析在 [init.ts:196](/Users/konata/code/tmex-r25/packages/app/src/commands/init.ts:196)。非交互模式还强制要求 `--relay-public-url`，见 [init.ts:227](/Users/konata/code/tmex-r25/packages/app/src/commands/init.ts:227)。帮助文本漏列该 flag，见 [help.ts:6](/Users/konata/code/tmex-r25/packages/app/src/cli/help.ts:6)。

在已有安装上重新执行 `init --force` 不应作为普通原地角色切换方案；live machine 应使用 leave 后的 setup route。

### (c) Mac：Hub → relay 迁移

Mac 的 `POST /api/mesh/relay/enroll`：

1. 用现有 root public key 对目标 relay 做 `/api/relay/enroll`；
2. 得到 tenant id/token；
3. 构造新的 `set-relays` payload；
4. 返回给前端签名。

见 [relay-routes.ts:178](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-routes.ts:178) 和 [relay-routes.ts:268](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-routes.ts:268)。

`set-relays` 是 defining record：

```ts
return { localFirst: input.relayMode || defining, publish: input.relayMode || !defining };
```

见 [auth-key-log-routes.ts:141](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-key-log-routes.ts:141)。

因此 Hub 模式下提交 `set-relays?hub=sync`：

- 本地落账；
- 不等待 attached Hub；
- 不推给旧 Hub；
- 应用后 relay wiring 清空本地 Hub 集合并切换 uplink。

现有测试直接验证了旧 Hub 没收到记录，见 [auth-key-log-relay.test.ts:292](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/auth-key-log-relay.test.ts:292)。

应用 relay state 时：

```ts
if (result.kind === 'relay') bound?.hubStore.replaceAll([], Date.now());
```

见 [relay-wiring.ts:55](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-wiring.ts:55)。

因此 Mac 的 `mesh_hubs` 会清空，uplink pool 改用 `mesh_relays`。该路径没有调用 `nodeSessionStore.deleteAllForUser()`，所以本地 node session 不会因为 `set-relays` 自动删除；但旧 Hub 不再是当前上级，旧 session 后续可能成为无效/过期 session。

历史 key-log catch-up 会带 admission sidecar：

```ts
const member = this.host.memberFor(record);
...
...(member ? { member } : {})
```

见 [relay-key-log-sync.ts:161](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-key-log-sync.ts:161)，分页上传在 [relay-key-log-sync.ts:347](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-key-log-sync.ts:347)。

`relayMemberFromRecord()` 会把 `admit-node`、`revoke-node`、根轮换映射为 relay member sidecar，见 [relay-key-log-sync.ts:40](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-key-log-sync.ts:40)。

结论：正常 catch-up 成功时，relay 可以从历史 `admit-node` sidecar 重建成员表，不要求每个旧节点重新在 `relay.auth` 自报一次。只有日志被跳过、sidecar 缺失/非法或 catch-up 未完成时，才可能需要节点自身的 member proof 作为补救。

### (d) 其他节点：leave 后 relay password join

节点必须先 leave，因为 relay password join 明确拒绝已有用户或 node identity，见 [relay-password-join.ts:114](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-password-join.ts:114)。

leave 会删除 `node_identity`，见 [mesh-membership-store.ts:23](/Users/konata/code/tmex-r25/apps/gateway/src/auth/mesh-membership-store.ts:23)。随后 `ensureNodeIdentity()` 没有旧记录时会随机生成新 node id：

```ts
const nodeId = randomBytes(16);
```

见 [node-identity-service.ts:26](/Users/konata/code/tmex-r25/apps/gateway/src/auth/node-identity-service.ts:26)。

所以每个节点都会得到新 node id。

`--name` 会保留：

- CLI 传入 `name`，见 [relay-password-join.ts:48](/Users/konata/code/tmex-r25/packages/app/src/commands/relay-password-join.ts:48)；
- 加入完成时写入 `node_identity.name`，见 [relay-password-join-flow.ts:390](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-password-join-flow.ts:390)。

该流程不需要 Hub，只访问 relay 的 KDF、enroll、pack、keylog 和 tenant token 接口。

注意：`POST /api/setup/relay-join` 只允许 standalone；纯 relay 机器应使用 CLI `tmex relay join`，而不是该 setup route。

### (e) B：pure relay → `relay,node`

CLI 的角色函数明确保留现有 relay 角色：

```ts
return roleNameFromFlags({ hub: false, node: true, relay: roles.relay });
```

见：

- password join：[setup-shared.ts:297](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-shared.ts:297)；
- r3 token join：[relay-join.ts:365](/Users/konata/code/tmex-r25/packages/app/src/commands/relay-join.ts:365)。

所以纯 `relay` 执行 `tmex relay join` 后变为 `relay,node`。

CLI 分发也确认：

```ts
'relay.join': async (p) =>
  runRelayPasswordJoin(p)
```

见 [cli-auth-entry.ts:41](/Users/konata/code/tmex-r25/packages/app/src/cli-auth-entry.ts:41)。

B 重新加入时会生成新的 node id。旧 B 的 Hub node id 不会自动被复用或撤销，应在迁移计划中安排由现存节点追加 revoke，避免 relay registry 留下旧 B 成员。

### (f) CLI 命令、函数和鉴权

通用 flag：`--lang`、`--help`、`--bun-path`，见 [args.ts:184](/Users/konata/code/tmex-r25/packages/app/src/lib/args.ts:184)。

关键命令如下：

```text
tmex init
  --role standalone|node|hub,node|relay|relay,node
  --install-dir
  --host
  --port
  --db-path
  --autostart
  --service-name
  --force
  --no-interactive
  --install-deps
  --skip-dep-check
  --hub-url
  --hub-public-url
  --relay-public-url
  --peer-port
  --stun-servers
  --no-service
```

实现函数：[init.ts:380](/Users/konata/code/tmex-r25/packages/app/src/commands/init.ts:380)。

```text
tmex hub join <https-url>
  --token <t> | --password [<p>]
  --name
  --insecure-local
  --no-restart
  --install-dir
  --service-name
```

实现函数：[hub.ts:573](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:573)。当前没有 `--totp`。

```text
tmex hub leave
  --install-dir
  --no-restart
  --service-name
```

实现函数：[hub.ts:770](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:770)。

它不解析密码。`withAuth()` 只打开本地数据库上下文，见 [with-auth.ts:4](/Users/konata/code/tmex-r25/packages/app/src/commands/with-auth.ts:4)。因此 `TMEX_PASSWORD` 对 `tmex hub leave` 无效。

```text
tmex hub promote
  --yes
  --no-restart
  --no-interactive
  --install-dir
  --service-name
```

实现函数：[hub.ts:1145](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:1145)。`--yes` 用于非交互晋升，不需要 `TMEX_PASSWORD`。

```text
tmex relay join <url>
  --tenant <id>
  --password [<p>]
  --name
  --ca-fingerprint
  --no-restart
  --install-dir
  --service-name
```

实现函数：[relay-password-join.ts:34](/Users/konata/code/tmex-r25/packages/app/src/commands/relay-password-join.ts:34)。密码通过显式 flag 或 `TMEX_PASSWORD` 读取；`resolvePassword()` 见 [password.ts:10](/Users/konata/code/tmex-r25/packages/app/src/lib/password.ts:10)。

```text
tmex relay enroll <url>
  --password
  --username
  --install-dir
  --service-name

tmex relay reauth <url>
  --password
  --username
  --install-dir
  --service-name
```

实现函数：

- [relay.ts:215](/Users/konata/code/tmex-r25/packages/app/src/commands/relay.ts:215)；
- [relay.ts:223](/Users/konata/code/tmex-r25/packages/app/src/commands/relay.ts:223)。

这两个命令与 relay password join 不同，会调用 `openRelayTenantSession()`，因此会进行本地 root login；TOTP 由 [relay-session.ts:124](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-session.ts:124) 处理，passkey CLI 仍被拒绝。

```text
tmex relay leave
  --install-dir
  --service-name
```

实现函数：[relay.ts:231](/Users/konata/code/tmex-r25/packages/app/src/commands/relay.ts:231)。它是签名 `set-relays` 离开租户，不是 `tmex hub leave`；同样先打开 relay tenant session，因此可能需要本地密码/TOTP。

r3 token 逻辑不是独立顶层命令，而是：

```text
tmex hub join <url> --token <r3-token>
```

内部转到：

```ts
runRelayJoin(parsed, urlRaw, token, io)
```

见 [hub.ts:588](/Users/konata/code/tmex-r25/packages/app/src/commands/hub.ts:588) 和 [relay-join.ts:385](/Users/konata/code/tmex-r25/packages/app/src/commands/relay-join.ts:385)。

最终建议的 live 顺序是：

```text
B: tmex hub leave
B: setup role=relay
Mac: relay enroll + set-relays?hub=sync + pack upload
其他节点: tmex hub leave
其他节点: tmex relay join <B-url> --tenant <id> --password
B: tmex relay join <B-url> --tenant <id> --password
A: tmex hub promote --yes（或满足条件后自动晋升）
```

该顺序能重建原 root key 的前提是使用同一个 mesh 密码；不能保持原 node id，也不能自动清除旧 B node 的 admission 记录。