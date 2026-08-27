# F4-4 结果 — passkey 也能做节点管理（enroll / admit / revoke）

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。
对齐依据：设计 §2「node 注册与节点证书」步骤 1/3 与「用户密钥」、`sub/b1-3a-fix-result.md`（共享 `createEnrollment(PasskeySigner)`）、`sub/b2-5-result.md`（`/api/auth/mode` 下发 `rootPublicKey`/`rootEpoch`；hub 接受 passkey 的 `authorization_sig`）、`sub/f4-3-review.md` Major 4（enrollment 硬编码 `RootKey`）。

结论：持久记录的签名者从「只能是根钥」放开成「根钥或 passkey」，入口统一收敛到一个凭据对话框。`sk_sess` 仍然一条记录都签不了。

---

## 一、改了什么

### 1. `apps/fe/src/auth/credential-prompt.tsx`（新）——唯一的凭据入口

| 导出 | 作用 |
|---|---|
| `useCredentialPrompt(config)` | 返回 `{request, withSigner, forget, dialog, passkeys}`；`dialog` 挂在页面里，没有待确认请求时为 `null` |
| `request({purpose, reuse})` | 取一个 `RecordSigner` 并**放进 5 分钟复用窗口**（窗口负责清零根钥 seed）；`reuse` 为真且窗口里还有签名者就不打扰用户；取消返回 `null` |
| `withSigner(fn, {purpose})` | 作用域式：**不**进窗口，根钥路径直接复用 `withRootSigner`（回调返回/抛异常即清零 seed）；取消返回 `null` |
| `usablePasskeys({passkeys, passkeyAvailable, origin})` | passkey 选项的**唯一**判定：`passkeyAvailable=false` → 空；否则 `passkeysForOrigin` 过滤，本 origin 一把都没有 → 空 |
| `signerFromChoice` / `runWithChoice` | 用户选择 → `RecordSigner`；根钥路径顺带与 `/api/auth/mode` 的 `rootPublicKey` 对拍 |
| `WrongPasswordError` / `isRetryableCredentialError` / `credentialErrorText` | 密码错、仪式被取消 → **留在框里让用户重试**；其余错误关框并把异常抛给调用方 |
| `decodeRootPublicKey` | base64url → 32 字节，缺失/畸形一律 `null` |
| `usePasskeys(api, {enabled})` | 拉一次 `GET /api/auth/passkeys`；失败即视为「没有可用 passkey」，只留密码路径 |
| `rememberSigner` / `takeRememberedSigner` / `forgetSigner` / `wipeSigner` / `SIGNER_REUSE_WINDOW_MS` | **从 `node/enrollment.ts` 原样搬过来**（复用窗口本来就不是 enrollment 专属），定时清零语义不变；hook 卸载时自动 `forgetSigner()` |

对话框是**不走 portal 的轻量遮罩**：base-ui 的 `Dialog` 靠 portal，静态渲染什么都不输出，而「passkey 选项只在允许时出现」正是靠静态渲染断言的。
密码派生（argon2）在框内进行：`busy` 期间按钮禁用，失败就地报错，不用把「密码错了」变成一条 toast。

### 2. enrollment：签名者可插拔，根公钥来自服务端

- `key-log-actions.ts` 抽出 `signWithPasskey(signer, message)`（challenge 一律 `sha256(待签字节)`，与 `hub-runtime.handleCreateEnrollment` / `applyAdmitNode` 完全一致）与 `enrollmentSignerFrom(RecordSigner): EnrollmentSigner`；`buildSignedRecord` 的 passkey 分支改为复用它，逻辑只此一份。
- `CreateEnrollmentInput`：`rootKey: RootKey` → **`signer: RecordSigner` + `rootPublicKey: Uint8Array`**。
  join 串第二段改用服务端下发的根公钥——passkey 签授权时浏览器手里根本没有根钥。长度不是 32 直接抛。
- 新增 `requireRootPublicKey(mode)`：缺失 / 非 32 字节 / 畸形一律 `ProtocolMismatchError`，**绝不猜**（与 `requireRootEpoch` 同一套路）。
- passkey 路径产出的 `Authorization`：`signer='passkey'`、`credential_id` 落在授权结构体里、`authorization_sig` 是 Borsh `PasskeyAssertion`（不是 64 字节）。hub 与各 node 都能独立验。

### 3. Nodes 页

| 动作 | 之前 | 现在 |
|---|---|---|
| 新增节点 | 表单里一个密码框 → `deriveRootKey` | `prompt.request({purpose:'enroll'})`（密码或 passkey）→ `createEnrollmentOnHub({signer, rootPublicKey})`；签名者进 5 分钟窗口 |
| 确认 / 重试 | `globalThis.prompt()` 要密码 | `prompt.request({purpose:'admit', reuse:true})`——窗口里还有就不弹框 |
| 吊销 | `globalThis.prompt()` 要密码 + `withRootSigner` | `prompt.withSigner(..., {purpose:'revoke'})`，**不进复用窗口**（破坏性动作每次都要当场确认） |

`globalThis.prompt` 只剩「吊销原因」一处（非凭据）。三条路径仍然只走 `POST /api/auth/keylog?hub=sync`，`hubAck` 处理逻辑一行未动。

新增 `canAutoSignAdmit(signer)`：**只有根钥签名者**才在证书到达时后台自动签 `admit-node`。passkey 每签一次都要一次认证器仪式，而仪式必须由用户手势触发（Safari 强制要求，Chrome 也会因缺 user activation 拒掉）——后台自动发起注定失败，于是留在「待确认」，用户点按钮时窗口里的凭证还在，不必再选一次 passkey。

### 4. 账号安全页

- `rotate-root`（改密）：**保持密码路径**，一行未改（必须要旧根钥本身）。
- `set-totp`（启用 TOTP）：**仍然只能用密码**——`k_totp = HKDF(seed, …)` 要的是 seed，passkey 断言给不出。密码框从 section 顶部挪进「扫码 + 验证码」那一步，并就地注明原因。
- `clear-totp`、`add-passkey`、`remove-passkey`：全部改走 `prompt.withSigner`，两种凭据都行。删掉了 PasskeySection 自己那套「勾选框 + 密码框 + 取 `usable[0]`」，凭证由对话框选（多把时有下拉）。

### 5. i18n

新增 `auth.credential.{title,hint,usePassword,usePasskey,passkeySelect}` 与 `auth.credential.purpose.{enroll,admit,revoke,passkey,totp}`、`auth.errors.{ROOT_KEY_MISMATCH,PASSKEY_ABORTED}`；改写 `auth.security.signWithExistingPasskey`（从勾选框标签变成提示）、`nodes.subtitle`、`nodes.enrollment.description`（都不再说「只能用密码/根钥」）；删掉已无引用的 `nodes.enrollment.passwordPrompt`。三语齐全并跑了 `bun run build:i18n`。

---

## 二、测试

| 文件 | 新增用例 |
|---|---|
| `apps/fe/src/auth/credential-prompt.test.tsx`（新，15 例） | `usablePasskeys` 三态（`passkeyAvailable=false` / 按 origin 过滤 / 本 origin 无凭证即空）；对话框静态渲染（无可用 passkey 时**不渲染** passkey 按钮，多把才有下拉，错误就地渲染）；`signerFromChoice`（passkey 直通、根公钥一致才返回、密码错抛 `WrongPasswordError` 且 seed 已清零）；`runWithChoice`（回调返回后 seed 清零、根公钥对不上时**不执行回调**、passkey 原样透传）；错误分类与 `decodeRootPublicKey` |
| `apps/fe/src/node/enrollment.test.ts`（15 → 27） | 假 passkey（Ed25519 顶替 ES256，签 `authenticator_data ‖ sha256(client_data_json)`）+ 与之对拍的假 `verifyPasskeyAssertion`；**passkey 签授权**：`signer='passkey'`、`credential_id` 在授权里、`sig` 是 Borsh 断言且 challenge = `sha256(授权字节)`、join 串仍带服务端根公钥；断言 credential 不符直接拒；根公钥长度不对不产出任何东西；`requireRootPublicKey` 四例；**passkey 签的 `admit-node`**：先用根钥签的 `add-passkey` 让状态机认识凭证，再过 `verifyKeyLogRecord` + `applyKeyLogRecord`（内嵌授权也由 `ctx.verifyPasskeyAssertion` 验），`nodeCerts` 认下 1 条；没有 `verifyPasskeyAssertion` 钩子 → `unknown_signer`；**passkey 签的 `revoke-node`**：记录字段 + 验签通过，换一条记录配旧签名 → `bad_signature`；根钥路径全部原样保留并加断言（`signer='root'`、`sig` 仍是 64 字节） |
| `apps/fe/src/pages/NodesPage.test.tsx`（+2） | `canAutoSignAdmit`：根钥可以、passkey/null 不行 |

| 项 | 基线 | 现在 |
|---|---|---|
| `apps/fe` 测试 | 142 pass / 0 fail | **170 pass / 1 fail**（171 例，见下） |
| `apps/fe` tsc | 0 | **0** |
| biome（本任务 8 个文件 + `apps/fe/src/{auth,node,pages}` 全量 47 文件） | — | `No fixes applied.` |
| `packages/shared` i18n 测试 | — | 2 pass |

> **那 1 个 fail 不是本任务引入的**：`apps/fe/src/node/mesh-events.test.ts`「ENROLL_REDEEMED 缺证书 / 签名长度不对时作废」。并行的 grok 任务把 `packages/shared/src/ws-borsh/schema.ts` 的 `EnrollRedeemedSchema` 收紧成 `enrollPk: b.bytes(32)` / `certSig: b.bytes(64)`（工作区里 `M packages/shared/src/ws-borsh/schema.ts`），该测试的夹具还在用 10 字节 certSig 构帧，序列化阶段就抛。`mesh-events.test.ts` 不在本任务 file scope，且对方多半正在改，**故未动**——需要由 schema 改动的负责人把夹具改成 64 字节（或用 `assertEnrollRedeemedFields` 走新的校验路径）。

---

## 三、文件清单

| 文件 | 说明 |
|---|---|
| `apps/fe/src/auth/credential-prompt.tsx` | **新**：对话框 + hook + 纯逻辑 + 复用窗口 |
| `apps/fe/src/auth/credential-prompt.test.tsx` | **新** |
| `apps/fe/src/auth/key-log-actions.ts` | `signWithPasskey`、`enrollmentSignerFrom`；`buildSignedRecord` 复用前者 |
| `apps/fe/src/auth/index.ts` | 导出 `credential-prompt` |
| `apps/fe/src/node/enrollment.ts` | `signer` + `rootPublicKey`、`requireRootPublicKey`；复用窗口搬走；改为直接 import `key-log-actions`（走 barrel 会把 React 组件拖进来） |
| `apps/fe/src/node/enrollment.test.ts` | 见上 |
| `apps/fe/src/pages/NodesPage.tsx` | 三条动作统一走凭据对话框；`canAutoSignAdmit`；删掉页面里的密码框与 `globalThis.prompt` 要密码 |
| `apps/fe/src/pages/NodesPage.test.tsx` | +2 |
| `apps/fe/src/pages/AccountSecurityPage.tsx` | `clear-totp` / passkey 增删走对话框；TOTP 密码框挪进设置那一步；`rotate-root` 不变 |
| `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` | 新增/改写 key（+ `bun run build:i18n` 重新生成 `resources.ts` / `types.ts`） |

`apps/fe/src/node/enrollment-watch.ts` 无需改动（它只负责把证书候选喂给 `offerCertificate`，与签名者无关）。

---

## 四、遗留 / 需协调

1. **`set-totp` 仍是密码专属**，不是漏做：`k_totp = HKDF(seed, "tmex-totp"‖root_epoch, uid)` 需要 seed，passkey 断言给不出。`KEY_LOG_SIGNER_MATRIX` 允许 passkey 签 `set-totp`，但前端拿不出密文，所以 UI 不提供该选项。若将来要支持，得先定「passkey 路径下 TOTP 密钥怎么派生/包裹」的方案。
2. **自动 admit 只对根钥生效**（`canAutoSignAdmit`）。用 passkey 建的 enrollment，证书到达后仍需用户点一次「确认」——这是浏览器 user-activation 的硬约束，不是可选项。
3. **依赖后端**：`/api/auth/mode` 必须真的下发 `rootPublicKey`，否则新增节点会直接报 `PROTOCOL_MISMATCH`（有意为之：宁可中止也不能用错的根公钥生成 join 串）。passkey 签的 `admit-node` / `revoke-node` 走 `keylog?hub=sync`，需要 entry 与 hub 两侧的 `verifyPasskeyAssertion` 都接线（b1-3a / b2-5 已具备）。
4. 复用窗口现在归 `@/auth/credential-prompt` 管；`@/node/enrollment` 不再导出 `rememberSigner` 等符号，后续任务若要用请从 auth 侧取。
5. `apps/fe/src/index.css` 的 `noInvalidPositionAtImportRule` 是既有告警（f4-fix 已记录），非本次引入。

未碰生产 tmex、未碰名为 `tmex` 的 tmux session；未跑 `bun install`；未执行任何改状态的 git 命令；未触碰 F3-1（`packages/ws-client/**`、`node-runtimes.ts`）与 grok（`apps/gateway/**`）的文件。
