# F4-5 结果 — f4-fix 评审剩余项 + B2-8 前端接线

worktree `/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。
依据：`sub/f4-fix-review.md`（协调者判定）、`sub/b2-6-result.md`（hub=sync 契约）、`sub/b2-8-result.md`（passkey origin 精确过滤）、`sub/f4-4-result.md`（passkey 节点管理已完成）。

`sub/f3-1-fix-result.md` 已存在 → `node-runtimes.ts` / `ws-client` 可动。未碰 `apps/gateway/**`、生产 tmex、名为 `tmex` 的 tmux session；未 `bun install`；未执行任何改状态的 git 命令。

---

## 一、逐条整改（9 项 + 追加的 B2-8）

### 1. 旧格式 pending 的**就地净化**（Blocker）— `node/enrollment.ts`

`listPendingEnrollments()` 从「只在内存里 filter」改成「读到不干净就先删 key 再写公开投影」：

- 秘密判定统一成一条规则：不在 `PUBLIC_FIELDS` 里、且字段名命中 `/sk|secret|token|seed|priv|password|passphrase|credential/i` → **整条丢弃**（`enrollSk` / `joinToken` 都被它覆盖）。
- 干净记录经 `publicProjection()` 只留 7 个公开字段，来路不明的多余字段（哪怕无害）一律不写回。
- 读到的原文 ≠ 公开投影时：**先 `removeItem`**（即便随后的回写抛异常，私钥也已经不在盘上），再写回投影；空集合直接删 key。
- 净化路径**不 `notify()`**：本函数是 `useSyncExternalStore` 的 `getSnapshot`，渲染期同步通知订阅者会炸。

### 2. passkey 选择：没有可信元数据就**不选**（Major）

- `account-security-actions.passkeysForOrigin()`：删掉 `rp_id` 回退；新增 `isPasskeyUsableHere(row, origin)` —— 服务端 `usableHere`（B2-8）优先，缺失才退回 origin 字符串全等。
- `session-key-store.selectPasskeyCredential()` 返回类型由 `string | null` 改成
  `{kind:'bind'} | {kind:'browser'; allowCredentials} | {kind:'none'}`，**彻底删除 `allowCredentials[0]` 回退**：
  - 有元数据 → 只留 origin 全等的；恰好一把 `bind`，多把 `browser`，一把没有 `none`；
  - 无元数据 → 一把时 `bind`（那不是「挑」），多把时 `browser`：把服务端那份列表**原样**交给 WebAuthn。
- `establishSessionFromPasskey()`：`browser` 分支先做一次**探测仪式**（列表原样下发，浏览器/认证器选），拿到 `assertion.id` 再绑定最终 delegation 做正式仪式。协议要求 challenge 覆盖 `credential_id`，这一步换不掉；B2-8 之后后端已按精确 origin 过滤，单候选（常态）仍只有一次仪式。

### 3. `hubAck` 按 B2-6 的码处理，重试**原样重发同一份字节**（Major）

新增在 `node/enrollment.ts`（纯逻辑，页面与测试共用）：

| 导出 | 作用 |
|---|---|
| `classifyKeyLogFailure(code)` | `unconfirmed`（`HUB_TIMEOUT`/`unavailable`/`uplink_down`…）/ `stale`（`KEY_LOG_FORK`/`fork`/`seq_gap`）/ `rejected` |
| `admitDisposition(result)` | 200 且 `hubAck===true` 才 `admitted`；其余 200 与未确认码一律 `unconfirmed` |
| `submitAdmitRecord(api, pendingId, record)` | 发一条**已签好**的记录；`unconfirmed` → 存进模块级 store，其余 → 清掉 |
| `admitPlan(pendingId, canSign)` | `resend` **永远优先于** `sign` |
| `unconfirmedRecord/forgetUnconfirmedRecord/subscribeUnconfirmedRecords/listUnconfirmedRecordIds` | 未确认记录的 store（仅内存） |

NodesPage：
- 未确认记录放**模块级 store**而不是组件 state —— 切走再回来仍能重发同一份字节；`hubUnconfirmedIds` 改为 `useSyncExternalStore`。
- 「重试」按钮：手上有未确认记录时**不要凭据、不取新 head、不重新签名**，直接重发。
- **自动路径同样受管**（原实现的隐患）：轮询每 5 s 会再看到同一张证书，若那时按新 head 重签就会造出另一个 seq —— 现在 `admitPlan()` 强制走 `resend`。
- `stale` → 丢掉暂存记录并提示「密钥日志已变化，请重新确认」，用户下次点按钮走正常重签路径。
- revoke 同样按码分流；`nodes.revoke.hubFailed` 文案改成「hub 未确认，吊销未生效（本地也未写入）」——B2-6 之后旧文案「记录已写入密钥日志」是错的。

### 4. 4401 走**真实宿主接线**（Major）

- `packages/stores/node-connection-manager`：`createConnection?: (nodeId, onClose) => GatewayConnection` —— manager 主动把关闭码回调递给自建工厂，工厂没有忘记它的余地。
- `node-runtimes.ts`：`NodeDirectWiring.createConnection` 同样收 `onClose`；新增 `socketFactory` 测试注入；抽出 `createAppNodeRuntimes(overrides, wiring)`，`appNodeRuntimes` 由它构造 —— **生产与测试用同一份接线**。
- 测试用真 `NodeConnectionManager` + 真 `createNodeConnection` + 真 `createGatewayConnection`，只把 socket 换成假的，由 socket 的 `onclose({code:4401})` 触发；**一次 `notifyClose()` 都没手动调**。日志可见 4401 → `CLOSED`（不重连）、1006 → `RECONNECT_BACKOFF`。

### 5. 密钥所有权（Major）

- `createEnrollmentOnHub`：`try` 从 `createEnrollment()` **产出私钥的那一刻**起，hub 请求失败、编码失败都走同一个 `finally`。
- `changePassword`：旧根钥派生成功即进 `try`，第二次 Argon2（新密码）抛出时旧根私钥照样清零（旧实现那时 `finally` 还没建立）。新增 `deriveRootKey?` 测试注入。
- `establishSessionFromPasskey`：`sk_sess` 生成即进 `try/finally` + `owned` 标志，用户取消仪式 / options 失败 / origin 选不出凭证都立刻清零，只有交给全局 session store 才转移所有权。新增 `generateSessionKeyPair?` 测试注入。
- NodesPage 建 enrollment 失败时调用 `prompt.forget()`，复用窗口里的根钥立刻清零，不等 5 分钟定时器。
- **join 串**：新增 `encodeJoinTokenZeroing()`，自己拼 96 字节、`finally` 清零。
  ⚠️ **共享实现需要改**：`packages/shared/src/auth/enrollment.ts` 的 `encodeJoinToken()` 在内部另建一份含 `enroll_sk` 的 96 字节数组且从不清零，调用方够不着 —— 所以前端不再调它。CLI 侧仍在用，需由 `packages/shared` 负责人在 `finally` 里补 `raw.fill(0)`（本任务范围外）。

### 6. join 命令的 shell 转义（Major）

`isTrustedHubUrl()`：只认 https（回环 `localhost`/`127.0.0.1`/`[::1]` 的 http 例外，与 secure context 判定一致），拒绝带用户名/密码的 URL。`joinCommand()` 先校验再对 **URL 与 token 都** `shellQuote()`；`resolveHubPublicUrl()` 也用它过滤，不可信地址直接渲染 `missingHubUrl`。

### 7. 轮询也上报 `unknown`（Minor）

抽出 `outcomesForCandidates()`，推送与轮询共用；轮询不再 `if (outcome.kind !== 'unknown')` 过滤。

### 8. `disposeNodeQueryClient` 挂在真实 manager 上（Minor）

由 `createAppNodeRuntimes()` 统一提供 `onDispose`，并用真实构造路径测「dispose 后 `nodeQueryClient()` 是全新实例、旧缓存不复活」。

### 9. `mesh-events` 与收紧后的 schema 对齐 + i18n key

- `decodeMeshFrame` 的 `ENROLL_REDEEMED` 分支改调 `wsBorsh.schema.assertEnrollRedeemedFields()`（与 node/hub 同一份边界判定），畸形帧抛出后由外层 catch 变 `null`；额外保留「证书为空」判定。
- 测试重写：定长字段已经**编不出**畸形载荷，新增 `rawEnrollRedeemedFrame()` 手工拼 borsh 字节（真实攻击者也只能这么发），覆盖 certSig 10 字节 / enrollPk 16 字节 / nodeId 非 32-hex / 证书超 2048 / 证书为空。
- 新增 `device.directFallbackToast`（三语），`node-runtimes.ts` 不再用 `defaultValue`；无 runtime 时退到 i18next 单例。

### 10. B2-8 追加项（`packages/api-client/src/auth/**` 本次纳入范围）

- `NoPasskeyForOriginError`（`code='NO_PASSKEY_FOR_ORIGIN'`）；`passkeyLoginOptions()` 对 404 + 该 code 抛它，其余非 200 抛带 code 的普通 Error。
- `PasskeySummary.usableHere?: boolean`。
- 登录页：`establishSessionFromPasskey` 让该错误原样冒泡，`LoginPage` 既有的 `t('auth.errors.'+code)` 分支直接显示「本入口没有可用的 passkey（已注册的凭证属于其它入口地址）」；**不回退到未过滤列表、不取 `[0]`**。
- 账号安全页：`usableHere === false` 的行 `opacity-60` 灰掉并标注「属于其它入口，本入口不可用」，仍可查看与删除。
- i18n 新增 `auth.errors.NO_PASSKEY_FOR_ORIGIN`、`auth.security.passkeyOtherOrigin`（三语，已跑 `bun run build:i18n`）。
- 复核：`registerPasskey()` 早已用 `verified.origin`（不是 `location.origin`），无需改。

---

## 二、验证

| 项 | 基线 | 现在 |
|---|---|---|
| `apps/fe` `bun test src/` | 170 pass / **1 fail** | **206 pass / 0 fail** |
| `apps/fe` tsc | 0 | **0** |
| `packages/stores` `bun test` | 123 / tsc 1 | **123 pass / 0 fail**，tsc **1**（既有 `host-services.test.ts`） |
| `packages/api-client` | — | **85 pass / 0 fail**，tsc **5**（全在既有 `client.test.ts` / `files-download.test.ts`） |
| `packages/shared` | 283 pass | **283 pass / 0 fail**，tsc 0 |
| `packages/panels` 回归 | — | 217 pass / 0 fail |
| biome（`apps/fe/src/{auth,node,pages}`、stores、api-client/auth 共 57 文件） | — | `No fixes applied.` |

仓库范围内 biome 仅剩既有的 `index.css` × 4 与 `main.tsx` 的 `useExhaustiveDependencies`（均非本次引入）。

新增/改写的用例（共 +36）：storage 净化 4、join 命令与 URL 校验 3、`encodeJoinTokenZeroing` 2、hub=sync 分类与重发 9、`selectPasskeyCredential` 7、passkey 会话清零与 404 3、`passkeysForOrigin`/`usableHere` 4、changePassword 所有权 3、轮询 outcome 2、4401 真实接线 3、QueryClient 回收 1、`ENROLL_REDEEMED` 畸形帧 5（合并在一个用例里）、api-client 404 3。

---

## 三、文件清单

| 文件 | 说明 |
|---|---|
| `apps/fe/src/node/enrollment.ts` | 存储净化、未确认记录 store + `classifyKeyLogFailure`/`admitDisposition`/`admitPlan`/`submitAdmitRecord`、`encodeJoinTokenZeroing`、`isTrustedHubUrl`、join 命令转义、私钥 try/finally 前移 |
| `apps/fe/src/node/enrollment-watch.ts` | `outcomesForCandidates()`，轮询不再吞 `unknown` |
| `apps/fe/src/node/mesh-events.ts` | `assertEnrollRedeemedFields` 接线 |
| `apps/fe/src/node/node-runtimes.ts` | `createAppNodeRuntimes()`、`socketFactory` 注入、工厂必收 `onClose`、toast 走正式 i18n key |
| `apps/fe/src/auth/session-key-store.ts` | `PasskeySelection`、无元数据交给浏览器选、`sk_sess` 所有权 |
| `apps/fe/src/auth/account-security-actions.ts` | 删 `rp_id` 回退、`isPasskeyUsableHere`、`changePassword` 所有权 + `deriveRootKey` 注入 |
| `apps/fe/src/pages/NodesPage.tsx` | hubAck/重试逻辑、`prompt.forget()`、`resolveHubPublicUrl` 过滤 |
| `apps/fe/src/pages/AccountSecurityPage.tsx` | `usableHere` 灰显 |
| `packages/stores/src/node-connection-manager.ts` | 自建工厂必收关闭码回调 |
| `packages/api-client/src/auth/{types,auth-api}.ts` | `NoPasskeyForOriginError`、`usableHere` |
| 上述各 `*.test.ts(x)` + `packages/shared/src/i18n/locales/*.json`（+ 重新生成的 `resources.ts`/`types.ts`） | |

---

## 四、遗留 / 需协调

1. **`packages/shared` 的 `encodeJoinToken()` 必须补清零**（见 §1.5）。前端已绕开，CLI 仍暴露。
2. **多凭证 + 无元数据时是两次仪式**（探测 + 正式）。根因是 delegation 的 challenge 覆盖 `credential_id`，浏览器选完才知道选了谁。若要一次仪式，需要后端把 `credential_id` 移出 challenge 预像（协议变更，本次未做）。B2-8 的精确 origin 过滤让这种情况变得罕见（同一 origin 多把凭证才会遇到）。
3. **账号安全页的灰显没有页面级用例**：`AccountSecurityPage` 的 passkey 列表来自 `useEffect` 拉取，静态渲染取不到（仓库没有 DOM 测试环境，也不允许 `bun install`）。灰显判定本身由 `isPasskeyUsableHere` 的单测覆盖。
4. 同理，`useAdmitAction` 是 hook，本次把判定逻辑全部下沉到 `node/enrollment.ts` 的纯函数并在那里做回归，页面只剩 toast 与 busy 状态。
5. `KEY_LOG_FORK` 等 `stale` 码目前按「字节作废、需重签」处理；若后端将来对某个码另有语义，改 `STALE_CODES`/`UNCONFIRMED_CODES` 两个集合即可（只此一处）。
