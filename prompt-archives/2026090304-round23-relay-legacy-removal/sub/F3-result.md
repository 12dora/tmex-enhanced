# F3 结果：改密补 meta-key、移除单条中继、评审整改（A–H）

worktree `/Users/konata/code/tmex-r23-f3`，分支 `feat/round23-f3`（未 commit）。

---

## 一、任务 1：`rotate-root` / `rotate-root-keep` 之后补一条 `meta-key`

`apps/fe/src/auth/account-security-actions.ts`（403 → 528 行）

| 位置 | 内容 |
|---|---|
| `ChangePasswordInput`（:97-107） | 新增 `relayApi?: RelayTenantApi`（测试注入）、`lock?: <T>(run) => Promise<T>` |
| `ChangePasswordResult`（:148-152） | 成功分支多一个 `metaKey?: { ok: true } \| { ok: false; code: string }`；非中继模式不带该字段 |
| `prepareMetaKeyAfterRotate()`（:174-201） | **在 rotate 记录送出去之前**调 `POST /api/mesh/relay/meta-key/prepare {op:'rotate'}`，并按「rotate 之后的头」签好 |
| `submitMetaKeyAfterRotate()`（:204-228） | rotate ack 之后立刻送；没落账就 `rememberPendingMetaKey({id:'rotate-root'})` |
| `runPasswordRotation()`（:234-291） | 锁内主体：取 head → 签 rotate → 预备 meta-key → 送 rotate → 送 meta-key |
| `changePassword()`（:311-341） | 先 `fetchRelayMode(relayApi)` 当场问网关；`keyLogHead()` 从函数顶端移进锁里 |

`apps/fe/src/components/side-panels/account-security-password.ts`
- `submitPasswordChange()` 传 `lock: withKeyLogLock`（`@/node/enrollment-engine`），改密与紧随的 `meta-key` 连成一段，且与 admit / revoke 抢同一个 key log 头。
- 新增 `withMetaKeyNotice()`：换代没落账时把反馈降级成 `notice` 并追加一句 `relay.tenant.metaKey.afterPasswordChange`。

### 签出来的两条记录（测试已逐字段验证）

| | rotate | meta-key |
|---|---|---|
| `seq` | `head.seq + 1` | `head.seq + 2` |
| `prev_hash` | `head.hash` | `computeRecordHash(rotate.bytes, rotate.sig)` |
| `root_epoch` | `E` | `E + 1` |
| 签名者 | **旧**根钥 | **新**根钥（rotate payload 里的新根公钥验得过） |

### 指挥官必须知道的一条（E 的现实边界）

`rotate-root`（全量重置）在**服务端应用记录的那一刻**就 `revokeAllSessions`（`packages/shared/src/auth/key-log.ts:416` → `apps/gateway/src/auth/user-key-persistence.ts:269`），而 `POST /api/auth/keylog` 要 node-session（`apps/gateway/src/mesh/auth-routes.ts:238`）。因此**第二条请求必然 401**，这不是时序问题，任何「同一个 signer session 内背靠背提交」都救不了。

落地方案：那条 `meta-key` 已经**签好且链在 rotate 之后**，401 时原样存进 `relay-meta-key-pending`（sessionStorage），用户用新密码重新登录、打开节点页后自动重发即可落账（本地 head 没动，字节仍然接得上）。测试 `中继模式：meta-key 没送出去时不算成功，欠账留给节点页重试` 固化了这一条。`rotate-root-keep`（常规改密，默认路径）会话保留，当场就落账。

> 如果指挥官希望全量重置也当场落账，唯一可行的顺序是把 `meta-key` 放到 rotate **之前**、用**旧**根钥按当前 epoch 签。安全性等价（新 K_meta 同样只发给当前成员），但与 plan §1.4「其后紧接一条」的字面顺序相反，需要拍板后我再改。

---

## 二、任务 2：移除多中继里的某一条

### 新路由 `POST /api/mesh/relay/remove/prepare`（`apps/gateway/src/mesh/relay-routes.ts:246-283`）

请求（需本机 node-session）：

```json
{ "url": "https://relay-2.example" }
```

`200`：

```json
{ "metaEpoch": 1, "payload": "<b64url set-relays payload>", "payloadHash": "<b64url sha256>" }
```

语义：

- 归一化 `url`（`normalizeRelayUrl` = `canonicalHubUrl`）后从当前列表里摘掉，其余按原顺序重排 `priority = 0..n-1`。
- **世代不变**（`metaEpoch` = 当前 `K_meta` 世代）：剩下的中继继续用同一套密钥，摘一条不是轮换。`K_log` / `K_meta` 按 enroll 的同一套 wrap 逻辑重新封装给**全部未吊销节点**（`listRelayNodeKeys` + `buildSetRelaysPayload`），并 `stashPendingKeys`。
- 错误：`400 INVALID_URL`、`404 RELAY_NOT_FOUND`（不在列表里）、`409 RELAY_LAST`（只剩一条，必须走 `leave/prepare`）、`409 RELAY_NOT_CONFIGURED`（非中继模式）、`409 NO_ADMITTED_NODES`、`409 RELAY_KEY_MISSING`（本机没有 K_log/K_meta）。错误体沿用 `jsonError` 的 `{code}`。

为腾门禁额度，`relay-routes.ts` 的纯入参解析拆到新文件 **`apps/gateway/src/mesh/relay-routes-input.ts`**（80 行；`parseEnrollmentBody` / `parseStoredJson` / `normalizeUrlOrNull` / `readProof` / `readRelayErrorCode`）。`relay-routes.ts` 从 513 → 488 行。

### 客户端与前端

- `packages/api-client/src/relay/tenant-api.ts`：`removePrepare(url)`；新常量 `RELAY_NOT_FOUND` / `RELAY_LAST`。
- `apps/fe/src/node/relay-enroll.ts`：`removeRelay(deps, url, signer)`（与 `leaveRelay` 共用 `prepareAndSign`，`prepare → 取 head → 签 → 提交` 全程一把锁）。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts`：`RelayConfirmIntent` 加 `'remove'`，`RelayConfirmRequest` 加 `url?`，`requestConfirm(intent, url?)`。
- `apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx`：中继数 > 1 时，「中继」菜单为**每条**中继渲染一项「移除 {host}」（`data-testid="nodes-relay-remove-<host>"`）；只有一条时不出现（服务端也会 409）。
- `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx`：`CONFIRM_COPY` 加 `remove` 一档，描述带 `{{url}}`。

---

## 三、评审整改 A–H

### A. 吊销 → K_meta 换代的可靠性（BLOCKER，已全部落地）

1. **模式判定改问网关**：新增 `fetchRelayMode(api)`（`apps/fe/src/node/mesh-relay.ts:76-92`），`rotateMetaKeyAfterRevoke()` 与 `changePassword()` 都用它，不再读 30 秒轮询的 store。测试固化了「store 说 hub、网关说 relay 时照样补一条」。
2. **换代没落账不再报「已移除」**：`RevokeAttempt` 新增 `{ kind: 'meta-pending'; code }`；`reportRevokeAttempt` 对它弹 warning（`relay.tenant.metaKey.revokePending`）而不是 success；`BulkRevokeSummary` 加 `metaPending` 计数并单独提示；`revokeLanded()` 供卸载批处理判定「节点确实移除了」（`use-node-uninstall.ts:290`）。
3. **欠账持久化 + 自动重试**：新文件 `apps/fe/src/node/relay-meta-key-pending.ts`（176 行）——sessionStorage（key `tmex.relay.metaKeyPending`）+ 模块级 store + 订阅；存 `{id, reason, op, createdAt, record}`，`record` 是**已签好的记录字节**（公开数据，payload 里的租户密钥早已按节点 X25519 封装）。有字节就原样重发（不重签，避免把上级顶成 `seq_gap`）；`stale` 时丢字节改为等凭据重签。
   自动重试挂在 `useAutoRetryMetaKey`（`use-relay-actions.ts:234-259`）：**挂上中继**且手上有字节时自动发一次，同一批 id 只试一次；失败后由告警条上的「重试」按钮（`prompt.withSigner`）接手。告警条在 `UplinkSection` 中继分支，`data-testid="nodes-relay-meta-pending"` / `nodes-relay-meta-retry`，只要还欠着就一直挂着。
   **限制**：自动重试只在节点管理页挂载时跑（那是唯一持有 `useRelayActions` 的地方）。
4. **`refreshAll` 加 `relay.refresh()`**（`nodes-management.tsx:132-139`）：hub → 中继迁移后状态条当场翻版式。

### B. 「接入更多设备」侧滑面板（MAJOR，已落地）

`apps/fe/src/components/side-panels/connect-devices/join-token.tsx`
- `useMeshRelay()` → `enrollChannel = relay.relayMode ? defaultRelayEnrollmentApi : hub.hubApi`，同时传给 `useEnrollmentEngine` 与 `useCreateEnrollment`（中继的 `enroll.redeemed` 没有 `entry_sid`，只能靠这条通道轮询回读证书）。
- 加挂 `useRelayAdmitFollowUp({enabled: relay.relayMode, ...})`。为避免设置页与面板同时开着各补一次（第二份抢不到复用窗口里的签名者，只会弹假告警），`use-relay-admit-follow-up.ts` 的去重集合从 `useRef` 改成**模块级** `handledAdmits`，另导出 `resetRelayAdmitFollowUpForTest()`。
- 生成按钮的门从 `hub.online` 改成 `relay.relayMode ? relay.writable : hub.online`，标题文案改用新键 `nodes.uplinkOffline`（中性）。
- `use-create-enrollment.ts`：中继模式下 `hubUrl` 回落到 `relay.ordered[0].url`——否则面板永远停在「缺少 Hub 地址」。

### C. `metaKeyPrepare()` 跑在锁外（MAJOR，已落地）

`apps/fe/src/node/relay-enroll.ts` 重构：
- 抽出 `signAndSubmit()`（锁内主体）与 `submitSignedRecord()`（只提交）；`appendRelayRecord` = `lock(signAndSubmit)`。
- `appendMetaKey()` 与 `prepareAndSign()`（`leaveRelay` / `removeRelay` 共用）把 **prepare 一并放进锁**：两条 admit 补发并行时各拿一次「当前世代 + 1」，后落账的必然 `relay_epoch_regression`。测试 `prepare 与取 head / 签名 / append 同在一把锁里` 断言了 `lock:in → prepare → lock:out` 的顺序。
- 新增 `resendRelayRecord()`（重发存下来的字节）。
- `RelayFlowResult` 失败分支新增 `record?: SignedRelayRecord`：**只在本地 head 没动时**带出来（`hubAck:false`、`classifyKeyLogFailure === 'unconfirmed'`、或请求根本没发出去），`stale` / `rejected` 一律不带。
- `use-relay-admit-follow-up.ts`：拿不到签名者、或 append 失败，都改成记进欠账（`admit:<nodeId>`），成功才销账——不再「请求发出前就标记已处理」。

### D. reauth 打错中继（MAJOR，已落地）

`uplink-section.tsx` 新增导出 `reauthTarget(relays)`（优先挑 `kicked` 的那条，否则挂载中的，否则第一条）与 `kickedRelays(relays)`。告警行按钮改用 `reauthTarget`；菜单在**多条被踢**时逐条渲染「重新输入 {host} 的口令」，只有一条时保持原来的单项。

### E. 见 §一。

### F. 上游错误码被吞（MINOR，已落地）

`apps/gateway/src/mesh/relay-routes.ts` 的 `callRelayEnroll` 原来只读顶层 `payload.code`，而中继（运营者侧）统一回 `{ error: { code, message } }`（`apps/gateway/src/relay/relay-http.ts:35-41`），于是 `RELAY_PASSWORD_INVALID` 一律降级成 `RELAY_ENROLL_FAILED`。新增 `readRelayErrorCode()`（`relay-routes-input.ts`）两种形状都认。HTTP 状态映射保持 `401 → 401 / 其余 → 502`（**故意不透传 404**：那会被前端 `isRelayRoutesMissing()` 误判成「本机没有这族路由」）。i18n 顺带补齐 `RELAY_PASSWORD_REQUIRED` / `RELAY_RATE_LIMITED` / `RELAY_TENANT_KICKED` / `RELAY_TOKEN_INVALID` 四条中继错误码。

### G. `expires_at` → `expiresAt`（MINOR，部分落地，见注）

`packages/api-client/src/relay/tenant-api.ts:117-127`：`RelayEnrollmentCreated.expiresAt: number` 为准；`expires_at?: number` 保留为 `@deprecated` 别名。
**保留别名的原因**：唯一的调用点 `apps/fe/src/node/relay-join.ts:87`（`created.expires_at ?? exp`）由 R2 在主仓并行改写，按指挥官指示我不能动它——直接删字段会让它编译不过。原行为无功能影响（该字段一直是 `undefined`，回落到本地算出的 `exp`，两者相等）。**请 R2 在自己的 pass 里改成 `created.expiresAt ?? exp` 并删掉别名。**

### H. 运营者配额表单的上限（MINOR，已落地）

- `packages/api-client/src/relay/admin-api.ts` 导出 `RELAY_QUOTA_LIMITS = { maxNodes: 4096, maxStreams: 65536, bandwidthBytesPerSec: 10 GiB }`（对齐 `apps/gateway/src/relay/relay-quota.ts:4-6`）。
- `apps/fe/src/pages/settings/relay/relay-forms.ts`：`positiveInteger` → `boundedInteger(raw, limit)`；导出 `BANDWIDTH_KB_LIMIT = 10 GiB / 1024`。
- `quota-fields.tsx`：三条错误文案带 `{{max}}` 参数；三语文案改成「1–{{max}} 的整数」。

---

## 四、任务 3：F1 §五.9 残留契约逐条核对（对着服务端源码）

| 项 | 结论 |
|---|---|
| `/status` 的 `quota` | ✔ 服务端 `quota: client?.quota ?? null`，字段名 `maxNodes/maxStreams/bandwidthBytesPerSec`（`packages/shared/src/relay/codec.ts:66-68`）与 `RelayQuotaView` 一致 |
| `/enroll` 的 `payloadHash` | ✔ `{tenantId, token, passwordEpoch, metaEpoch, payload, payloadHash}` 与 `RelayEnrollResponse` 一致 |
| `/meta-key/prepare` 的 `epoch` | ✔ `{epoch, payload, payloadHash}` 与 `RelayPreparedPayload` 一致 |
| `/enrollments` 的 201 | ✘ 服务端是 `{ok, id, expiresAt, relays}`，api-client 写的是 `expires_at` → 已按 §G 修 |
| 错误体 `{code, reason?}` | ✔ `session-middleware.ts:209` 的 `jsonError` 就是这个形状；`tenant-api.ts` 的 `readError` 两种形状都认 |
| `/enrollments/:id` 的字段名 | ✘ 服务端回 camelCase 的 `nodeId` / `alreadyAdmitted`，而共享的 `HubEnrollmentStatus` 写的是 `node_id`（hub 侧还是 `already_admitted`，`hub-runtime.ts:862`）。前端两个字段谁都没读（node id 从证书里解），**不是活 bug**；已在 `tenant-api.ts` 加 `RelayEnrollmentStatus extends HubEnrollmentStatus { nodeId?; alreadyAdmitted? }` 把契约写实（`HubEnrollmentStatus` 在 `auth/types.ts`，不在本任务范围，没动） |
| F1 §五.7 的 `/api/relay/enroll` proof 形状 | ✔ 已不冲突：B3 现在只发 `proof: {bytes, sig}`，B2 的 `parseEnrollBody`（`relay/relay-routes.ts:56-70`）正是读这个对象 |

---

## 五、i18n（三语同步，`bun run build:i18n` 已跑）

`translation.relay.tenant.*` 新增：

- `actions.removeOne`（`{{host}}`）、`actions.reauthOne`（`{{host}}`）
- `remove.{title,description(带 {{url}}),confirm,done}`
- `metaKey.{pending({{count}}),retry,retryFailed,revokePending({{error}}),revokePendingBulk({{count}}),afterPasswordChange}`
- `errors.{RELAY_NOT_FOUND,RELAY_LAST,RELAY_META_KEY_NEEDS_SIGNER,RELAY_META_KEY_PREPARE_FAILED,RELAY_PASSWORD_REQUIRED,RELAY_RATE_LIMITED,RELAY_TENANT_KICKED,RELAY_TOKEN_INVALID}`

`translation.relay.admin.quota.{invalidNodes,invalidStreams,invalidBandwidth}` 改成带 `{{max}}` 的区间文案。
`translation.nodes.uplinkOffline` 新增（中性的「上级链路未连接」，给侧滑面板的生成按钮用）。

三个 locale JSON 用 `json.load`/`json.dump(indent=2, ensure_ascii=False)` 改的——已先验证过整文件 round-trip 逐字节一致，除新增键外没有任何重排/重排格式。

---

## 六、验证

| 项 | 结果 |
|---|---|
| `cd apps/fe && bun test src/` | **1883 pass / 0 fail**（基线 1864，本任务 +19） |
| `cd packages/api-client && bun test` | **201 pass / 0 fail**（基线 198，+3） |
| `cd apps/gateway && bun test src/mesh/relay-routes*.test.ts` | **12 pass / 0 fail**（基线 9，+3） |
| `cd apps/gateway && bun test src/mesh/relay-*.test.ts`（5 个文件） | 31 pass / 0 fail |
| `cd apps/gateway && bun test src/mesh`（全目录） | 1108 pass / 0 fail |
| `cd packages/shared && bun test` | 632 pass / 0 fail |
| `bunx tsc --noEmit -p apps/fe` | **0 error** |
| `bunx tsc --noEmit -p packages/api-client` | 5 error，全在未改动的 `client.test.ts` / `files-download.test.ts`（= 基线） |
| `bunx tsc --noEmit -p apps/gateway` | **0 error** |
| `bunx biome check`（全部改动文件） | clean |
| `bun run build:i18n` | 通过，core 608 / rest 1505–1510 |
| `bun scripts/complexity/gate.ts` | 只剩 `packages/ws-client/src/client.ts: 839 > 826`（L1c 的存量，非本任务）。本任务文件零违规；`nodes-management.tsx` 595/600（near-limit 提醒，改前 591） |

**`bun run lint` 有一条不是我的错误**：`apps/fe/src/main.tsx` 的 `organizeImports`（`@tmex/ws-client` 与 `@tmex/stores/react` 顺序），来自 HEAD 上的提交 `7dfbf299`，我没碰过该文件（`git diff` 为空）。跑一次 `bunx biome check --write apps/fe/src/main.tsx` 即可清掉。

未跑：Playwright e2e（按规定留给指挥官）；运营者标签目测（指挥官的活，代码已按最终 api-client 类型编译通过）。

---

## 七、留给指挥官

1. **全量重置的 `meta-key` 必然要等重新登录**（§一末尾）。若要当场落账，需拍板改成「rotate 之前、旧根钥签」。
2. **§G 的 `expires_at` 别名请 R2 收尾**（`apps/fe/src/node/relay-join.ts:87`）。
3. **术语冲突仍未解**（F1 §五.1）：`/Users/konata/code/tmex-copy-guidelines.md` 里「中继（Hub）」= hub，本轮 relay 也叫「中继」。本任务新增文案一律按「中继 = relay、Hub = hub」写。
4. **`nodes.enrollment.hubNotConfirmed` / `nodes.enrollment.missingHubUrl` 仍写着 Hub**（F1 §五.5）：中继模式下会显示「Hub 未确认」。我只新增了中性的 `nodes.uplinkOffline`，没有改这两个既有键的三语值（仓库主人在手工改这三个文件）。
5. **`/status` 仍不带「当前节点数」**（F1 §五.6）：加节点表单没法提前拦配额，只能等中继在 redeem 时拒。需要 B2/B3 补字段。
6. **`meta-key` 欠账的自动重试只在节点管理页跑**：用户改完密码不去节点页，那条记录就一直挂着。若要更强，得把重试回路提到宿主级（和 `enrollment-engine` 同档）。
7. `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` 已经 595/600，下一个动它的人得先拆。
