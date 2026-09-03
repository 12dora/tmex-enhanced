# F1 结果：租户侧中继 UI（节点页）+ api-client tenant + i18n

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`），未 commit。

写这份报告时 **B3 的节点侧路由已落到工作区**（`apps/gateway/src/mesh/relay-routes.ts` 等），所以下面的契约不再是猜测，
而是按 B3 的实际实现逐字段对齐过的；仍有两处需要指挥官拍板的差异，见 §五。

## 一、改动文件

新增：

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/api-client/src/relay/tenant-api.ts` | 280 | `RelayTenantApi`：`/api/mesh/relay/*` 全族端点 + 类型 + 错误码判定 |
| `packages/api-client/src/relay/tenant-api.test.ts` | 197 | 24 个用例（路径、请求体、错误码、缺字段兜底） |
| `apps/fe/src/node/mesh-relay.ts` | 236 | 中继链路 store（30 s 轮询 + NODE_EVENT 补拉，与 `mesh-hubs.ts` 同骨架） |
| `apps/fe/src/node/mesh-relay.test.ts` | 118 | 6 个用例 |
| `apps/fe/src/node/relay-enroll.ts` | 187 | 接入 / 离开 / `meta-key` 流程（含根钥签 proof、写锁注入） |
| `apps/fe/src/node/relay-enroll.test.ts` | 253 | 9 个用例（记录类型、锁、proof 验签、密码错不发请求、错误码透传） |
| `apps/fe/src/node/relay-join.ts` | 99 | 中继模式的加入码：join 串 v3 + 中继上建 enrollment |
| `apps/fe/src/node/relay-join.test.ts` | 108 | 2 个用例（r3 字段与密钥对拍、空中继列表报错） |
| `apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx` | 200 | 上级链路区块（hub / 中继二选一）+「中继」菜单 + `uplinkBlockedHint` |
| `apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx` | 110 | 中继链路条（chip、悬浮详情、meta 世代、可见节点数、配额） |
| `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx` | 205 | 接入表单对话框 + 离开 / 轮换的确认框 |
| `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts` | 179 | 三个动作的状态机与错误文案查表 |
| `apps/fe/src/pages/settings/nodes/relay/use-relay-admit-follow-up.ts` | 88 | admit 成功后补发 `meta-key {op:'admit'}` |
| `apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx` | 118 | 7 个用例（chip 文案、表单校验、错误查表、静态渲染） |

修改：

- `packages/api-client/src/index.ts`：加 1 行 `export * from './relay/tenant-api';`（改前重读过，F2 的 admin-api 行未动）。
- `apps/fe/src/auth/key-log-actions.ts`：新增 `buildSetRelaysRecord` / `buildMetaKeyRecord`（各是 `buildSignedRecord` 的薄封装，签名者仍是根钥或 passkey）。
- `apps/fe/src/node/hub-api.ts`：新增 `RelayEnrollmentApi extends HubApi`（只改 `path()` → `/api/mesh/relay/*`，`listNodes` / `rename` 直接报错）与 `defaultRelayEnrollmentApi`。这样引擎的证书轮询在中继模式下**零改动**可用（`enrollment-engine.ts` 一行未动，它的 fileLines 门禁只剩 1 行余量）。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`：接 `useMeshRelay({owner:true})`、`useRelayActions`、`useRelayAdmitFollowUp`；`HubStrip` + 两条 hub 提示整体换成 `<UplinkSection>`；`writable` / `blockedHint` 按上级形态分档；enrollment 通道按模式二选一；挂两个中继对话框。（592 行，函数 CC/行数仍在 allowlist 内。）
- `apps/fe/src/pages/settings/nodes/management/types.ts`：`NodeActionDeps` 加可选 `blockedHint`。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`：抽出 `rowBlockedHint()`，不可写时优先用调用方给的原因（顺带把 `NodeRowView` 的 CC 降了 1）。
- `apps/fe/src/pages/settings/nodes/management/enrollment-section.tsx`：`hubOnline` / `hubWritable` 两个 prop 换成 `writable` / `blockedHint`（函数行数 -4，仍在 allowlist 内）。
- `apps/fe/src/pages/settings/nodes/management/use-create-enrollment.ts`：内部自读 `useMeshRelay()`，中继模式走 `createEnrollmentOnRelay`；hub 模式一字未变。**「接入更多设备」侧滑面板因此也自动支持中继模式的加入码**。
- `apps/fe/src/pages/settings/nodes/management/use-node-row-actions.ts`：吊销成功后在同一段写锁里补一条 `meta-key {op:'rotate', exclude:[nodeId]}`（行内吊销、批量吊销、远程卸载三条路径共用）。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`：`beforeEach` 加 `resetMeshRelayStateForTest()`（store 是宿主级单例，跨测试文件会串味）。
- locale JSON ×3：只在 `"relay": {` 后**插入**一个 `"tenant"` 子对象，其余一字未动、未重排（便于与手工修改三方合并）；随后跑了 `bun run build:i18n`（`resources.ts` / `types.ts` / `locales/generated/*` 是它的产物）。

## 二、i18n（`relay.tenant.*`，zh_CN / en_US / ja_JP 同步）

- `strip.{title,online,offline,attached,detail,rtt,kicked,lastError,meta,nodes,quota,empty}`
- `notAttached`
- `reauth.{notice,action}`
- `actions.{menu,enroll,migrate,add,reauth,rotate,leave}`
- `dialog.{enrollTitle,migrateTitle,addTitle,reauthTitle,url,urlHint,password,passwordHint,rootPassword,rootPasswordHint,migrateNotice,submit,submitReauth,done}`
- `leave.{title,description,confirm,done}`
- `metaKey.{rotateTitle,rotateDescription,rotateConfirm,done,needsRotate,admitFailed,rotateFailed}`
- `errors.*`：`ROOT_PASSWORD_INVALID`、`RELAY_PASSWORD_INVALID`、`RELAY_NOT_CONFIGURED`、`RELAY_QUOTA_NODES`、`RELAY_UNCONFIRMED`、`RELAY_OFFLINE`、`RELAY_UNREACHABLE`、`RELAY_BAD_RESPONSE`、`RELAY_ENROLL_FAILED`、`RELAY_REJECTED`、`RELAY_KEY_MISSING`、`NO_ADMITTED_NODES`、`UNKNOWN_NODE`、`DUPLICATE_ENROLL_PK`、`INVALID_URL`、`BAD_PROOF`、`MALFORMED`

查表顺序：`relay.tenant.errors.<code>` → `auth.errors.<code>` → 原样显示 code（`relayErrorText()`）。

术语说明：本轮把 relay 角色译作「中继」，与 F2 的 `relay.admin.*` 一致；但 `/Users/konata/code/tmex-copy-guidelines.md` 里「中继（Hub）」指的是 hub。**两者冲突，需要指挥官统一**（见 §五）。

## 三、每个对话框的步骤与端点

### 1. 接入中继（`enroll` / `migrate` / `add` / `reauth` 四种来意共用一张表单）

表单：中继地址（`reauth` 时锁定）、中继口令（可空）、**当前密码（必填）**。
提交前本地校验：地址须是可信 https（回环允许 http）+ 密码非空。

1. `deriveRootKey(当前密码, mode.kdfParams)` → 与 `/api/auth/mode` 的 `rootPublicKey` 对拍，不一致直接 `ROOT_PASSWORD_INVALID`，**一个请求都不发**（否则中继会拿一把假根公钥开新租户）。
2. `POST /api/mesh/relay/enroll/proof-material {url}` → `{url, relayHost, ts, maxSkewMs, rootPublicKey, rootEpoch}`。
3. 本地 `signRelayEnrollProof(rootKey, {relayHost, ts})`（Ed25519 over Borsh，**通行密钥签不了，对话框里写明了这一条**）。
4. `POST /api/mesh/relay/enroll {url, password, proof:{bytes,sig}}` → `{tenantId, token, passwordEpoch, metaEpoch, payload, payloadHash}`。
5. 用**同一把根钥**把 `payload` 包成 `set-relays` 记录 → `POST /api/auth/keylog?hub=sync`（整段在 `withKeyLogLock` 里）。
6. 成功后 toast + `refreshAll()`（节点列表 / hub 集合 / 中继状态一起重拉，状态条随下一拍 `GET /api/mesh/relay/status` 翻成中继模式）。根钥 seed 在 `finally` 清零。

### 2. 重新输入口令（reauth）

与上一条完全同一条流程，只是地址预填且锁定；入口有两处：状态条上的告警行按钮、「中继」菜单项。触发条件是 `reauthRequired` 或任一条 `relays[].kicked`。

### 3. 离开中继

`AlertDialog` 危险确认 → `prompt.withSigner`（根密码或通行密钥，不进 5 分钟复用窗口）→ `POST /api/mesh/relay/leave/prepare {}` → 签 `set-relays`（空列表）→ `POST /api/auth/keylog?hub=sync`。

### 4. 轮换元数据密钥

`AlertDialog` 确认 → `prompt.withSigner` → `POST /api/mesh/relay/meta-key/prepare {op:'rotate'}` → 签 `meta-key` → 提交。
它同时是 admit / revoke 补发失败后的**唯一恢复路径**（文案里直接指了这条路）。

### 5. 加节点（中继模式）

`GET /api/mesh/relay/join-material` → `POST /api/mesh/relay/enrollments`（同 hub 的报文）→ 本地用
`encodeRelayJoinToken` 拼 `r3.` 串 → 展示 `tmex hub join <relayUrl> --token r3...`（地址取 `join-material.relays[0]`）。
证书回读走 `GET /api/mesh/relay/enrollments/:id`（`RelayEnrollmentApi` 顶替 `HubApi` 塞进引擎，推送路径 `/mesh/ws` 的 `ENROLL_REDEEMED` 不变）。
admit 成功后由 `useRelayAdmitFollowUp` 用复用窗口里的同一把签名者补一条 `meta-key {op:'admit', node_id}`；窗口里没有签名者（用户手动确认后窗口被清等）时不硬签，改提示走「轮换元数据密钥」。

### 6. 吊销（中继模式）

`revoke-node` append 成功后，**同一段写锁内**接 `POST /api/mesh/relay/meta-key/prepare {op:'rotate', exclude:[nodeId]}` → 签 `meta-key` → 提交；失败只 warning，不回滚吊销（记录已落库），文案指向「轮换元数据密钥」。

## 四、hub 专属 UI 在中继模式下的处置

- 多 hub 状态条 → 换成中继链路条（每条中继：在线点、主机名、告警图标、挂载图标；悬浮详情含地址 / 优先级 / 状态 / 延迟 / 被踢 / 最近错误），再加「元数据密钥第 N 代」「经中继可见 N 个节点」「配额」三格。
- 「主 Hub 不可达」「备 Hub 拒写」两条提示只在 hub 分支渲染；中继分支换成「令牌失效 + 重新输入口令」与「未连上中继」。
- 主备切换按钮只对 `row.isHub` 的行渲染，中继模式下没有 hub 行；`writerPublicUrl` / `HUB_NOT_WRITER` 指路文案在中继模式下不可能触发。
- 可写判定：中继模式 = 「至少挂上一条中继」，否则沿用 `hub.online && !writesBlocked`；不可写时的提示文案统一走 `uplinkBlockedHint()`。
- 节点重命名走 hub 控制面，中继模式下 `hubApi` 为 `null`，详情框里的改名照旧禁用（plan §1.9：中继模式下名字由节点自持）。

## 五、需要指挥官处理

1. **术语冲突**：文案规范里「中继（Hub）」= hub，本轮 relay 角色也叫「中继」。F1/F2 已统一按「中继 = relay、Hub = hub」写；请确认，并顺带更新 `tmex-copy-guidelines.md` 那一行，否则后续 agent 会再翻一次。
2. **「移除多中继里的某一条」做不了**：B3 的 `POST /api/mesh/relay/leave/prepare` 忽略请求体，只产出空列表的 `set-relays`。我据此**去掉了**「移除该中继」菜单项（api-client 也不再带 `url` 参数）。要支持的话需要 B3 让 `leave/prepare` 接受 `{url}` 并保留其余中继，前端再加回一项即可（约 15 行）。
3. **`rotate-root` / `rotate-root-keep` 之后没有补 `meta-key`**：这条路径在 `apps/fe/src/auth/account-security-actions.ts`（不在 F1 范围）。plan §1.4 要求根轮换后紧接一条 `meta-key` 换代，否则改密后被吊销过的节点仍能解出元数据。建议派给一个能改 `apps/fe/src/auth/**` 的 agent：在 `account-security-actions.ts` 的 rotate 成功分支后调用 `appendMetaKey({...}, {op:'rotate'}, signer)`（`@/node/relay-enroll` 已导出，锁传 `withKeyLogLock`）。
4. **侧滑面板「接入更多设备」**（`apps/fe/src/components/side-panels/connect-devices/join-token.tsx`，不在 F1 范围）：加入码创建已经自动适配中继（共用 `useCreateEnrollment`），但它注册引擎时传的 `hubApi` 仍是 `hub.hubApi`（中继模式为 `null`），且没有 admit 后的 `meta-key` 补发。设置页开着时这两件事由设置页的槽位兜住；只开面板时，中继模式下证书只能靠 `/mesh/ws` 推送到达，且新节点要靠「轮换元数据密钥」才能拿到 `K_meta`。修法：面板里 `hubApi` 改成 `relay.relayMode ? defaultRelayEnrollmentApi : hub.hubApi`，并调一次 `useRelayAdmitFollowUp`（约 8 行）。
5. **`nodes.enrollment.hubNotConfirmed` / `missingHubUrl` 文案里写着 Hub**，中继模式下会显示「Hub 未确认」。改成中性的「上级未确认」需要动既有 key 的三语值——因为仓库主人正在手工改这三个文件，我没有动。
6. **配额**：B3 在 `/status` 里下发了 `quota`，我把它显示在链路条上（`配额 N 节点｜M 流`）。节点数超配额的拒绝发生在**新节点 redeem 时**（中继侧），浏览器这边只在 `createEnrollment` 被拒时才可能看到 `RELAY_QUOTA_NODES`（文案已备）。若要在加节点表单里提前拦，需要 B2/B3 把「当前节点数」也放进 `/status`。
7. **与 B4 §四.3 / §四.5 的两处冲突已按「B3 是权威服务端」修好**：`POST /api/mesh/relay/enroll` 的 `proof` 是对象
   `{bytes, sig}`（不是裸签名串），`proof-material` 读 `relayHost`、enroll 响应读 `tenantId`（全 camelCase）。
   `packages/api-client/src/relay/tenant-api.ts` 与它的测试都已是这一版，CLI 侧无需再兼容下划线形态。
   注意 B4 §四.4 指出的 **B3 → B2 之间**的 `/api/relay/enroll` proof 形状仍然打架（B3 发 `proof` + `proof_bytes`，
   B2 读 `{bytes, sig}` 对象）：不修的话浏览器这条接入流程会稳定停在 502 `RELAY_ENROLL_FAILED`，与前端无关。
8. **r3 join 串在加入方那边还差一条中继路由**（B4 §四.2）：`applyAdmitNode` 要求加入方先知道租户 uid，
   而 r3 串里没有。F1 生成的加入命令与 CLI 走的是同一条路径，因此这个洞同样卡前端加节点流程，
   需要 B2 补 `GET /api/relay/tenants/:tenantId/enrollments/:enrollPk`。
9. **`sub/B3-result.md` 到本任务结束时仍未出现**：上面所有路由形状是**逐行对着 B3 已落地的源码**
   （`apps/gateway/src/mesh/relay-routes.ts`、`relay-secrets.ts`、`session-middleware.ts` 的 `jsonError`）对齐的，
   不是照 plan 猜的。B3 的结果文档到位后请按它的「exact JSON」再核一遍这几处：
   `/status` 的 `quota`、`/enroll` 的 `payloadHash`、`/meta-key/prepare` 的 `epoch`、
   `/enrollments` 的 201 `{ok,id,expires_at,relays}`、错误体一律 `{code, reason?}`（**不是** `{error:{code,message}}`，
   这一点与 F2 的运营者侧不同形，`tenant-api.ts` 里两种都认）。
10. `packages/api-client` 的 `bunx tsc --noEmit` 有 **3 个既有报错**（`client.test.ts:41,47`、`files-download.test.ts:11`，都在未改动的文件里，与本任务无关）；`bun run lint` 剩下的 17 个错误全部在 B3 的 `apps/gateway/src/mesh/relay-*.ts` 与 `mesh-routes.ts`；复杂度门禁剩下的 11 条违规也全部是 gateway 侧（`relay-uplink-client.ts` 743 > 600、`mesh-runtime.ts` 等）。本任务文件零违规。

## 六、验证

| 项 | 结果 |
|---|---|
| `cd apps/fe && bun test src/` | **1864 pass / 0 fail**（基线 1783；本任务新增 24 个用例，其余为并行 agent） |
| `cd packages/api-client && bun test` | **198 pass / 0 fail**（含本任务 24 个） |
| `cd packages/shared && bun test` | 632 pass / 0 fail（i18n 重建后回归） |
| `bunx tsc --noEmit -p apps/fe` | 0 error |
| `bunx tsc --noEmit -p packages/api-client` | 3 个既有 error（见 §五.7），本任务未新增 |
| `bunx biome check`（本任务全部文件） | clean |
| `bun scripts/complexity/gate.ts` | 本任务文件零违规（`nodes-management.tsx` 592/600，near limit 提醒） |
| `bun run build:i18n` | 通过，core 608 / rest 1482–1487 |

未跑：Playwright e2e（按规定留给指挥官）。开发实例截图核对换行也未做（无可用中继实例），建议在 B5 集成实测时顺带目测中继状态条与接入对话框。
