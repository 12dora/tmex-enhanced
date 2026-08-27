# F4-1 结果：前端登录、会话处理与账号安全

范围：`packages/api-client/src/auth/**` + `client.ts` 一处钩子、`apps/fe/src/auth/**`、`apps/fe/src/pages/Login*`、`apps/fe/src/pages/AccountSecurity*`、i18n locale JSON。未碰 `main.tsx`、`packages/stores`、`apps/gateway`、生产 tmex 与 tmux session。

---

## 一、文件清单

### `packages/api-client/src/auth/`（新增）

| 文件 | 职责 |
|---|---|
| `types.ts` | 全部报文类型（mode / challenge / login / mesh nodes / key-log / passkey），以及不依赖 `@simplewebauthn` 的 WebAuthn JSON 形态 |
| `auth-api.ts` | `AuthApi`：`getMode / listNodes / challenge / login / logout / passkeyRegisterOptions / passkeyRegisterVerify / passkeyLoginOptions / listPasskeys / keyLogHead / appendKeyLog`；`nodeAuthPath(nodeId, path)` |
| `session-interceptor.ts` | 401 统一拦截 + `auth:required` 事件 |
| `webauthn.ts` | `navigator.credentials.create/get` 的 base64url ↔ ArrayBuffer 适配（`startRegistration` / `startAuthentication` / `assertForChallenge`） |
| `index.ts` | barrel（fe 侧 `import ... from '@tmex/api-client/auth/index'`，走 `"./*": "./src/*.ts"` 导出映射） |
| `auth-api.test.ts` / `session-interceptor.test.ts` / `webauthn.test.ts` | 测试 |

### `packages/api-client/src/client.ts`（唯一改动，未碰 URL 逻辑）

新增全局响应钩子注册表：

```ts
export type ResponseHook = (res: Response, ctx: { path: string; url: string }) => void;
export function addResponseHook(hook: ResponseHook): () => void;
export function clearResponseHooks(): void;
```

`ApiClient.fetch` 在**有钩子时**才 `.then(...)` 包一层（无钩子零开销、原 Promise 原样返回），钩子抛错被吞掉不影响请求。

### `apps/fe/src/auth/`（新增）

| 文件 | 职责 |
|---|---|
| `session-key-store.ts` | `sk_sess` / `delegation` / `k_totp` 的纯内存持有者 + 登录与 fan-out |
| `use-session-key.ts` | `useSessionKey` / `useLoginProgress` / `useAuthMode` |
| `key-log-actions.ts` | `user_key_log` 记录构造与签名（根钥 / passkey），纯函数 |
| `account-security-actions.ts` | 改密 / TOTP / passkey 的端到端动作 |
| `totp-uri.ts` | base32 + otpauth URI |
| `NodeLoginButton.tsx` | 「登录此节点」按钮 |
| `index.ts` | barrel |
| `session-key-store.test.ts` / `key-log-actions.test.ts` / `account-security-actions.test.ts` / `totp-uri.test.ts` | 测试 |

### `apps/fe/src/pages/`（新增）

`LoginPage.tsx`、`LoginPage.test.tsx`、`AccountSecurityPage.tsx`。

### i18n

`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 各新增 `translation.auth`（`login` / `node` / `errors` / `security` 四组，共 63 键，含 gateway 返回的全部错误码）。**未动 `resources.ts` / `types.ts`（生成文件），需协调者跑 `bun run build:i18n`。**

---

## 二、公开 API

### 401 拦截

```ts
installSessionInterceptor({ navigate?, currentLocation?, loginPath? }): () => void
configureSessionInterceptor(options): void
onAuthRequired((detail: { nodeId, scope: 'global' | 'node', path }) => void): () => void
handleNodeLoginRequired(nodeId, path?)   // 给 WS 4401 复用
handleGlobalUnauthorized(path?)
nodeIdFromPath(path): string
AUTH_REQUIRED_EVENT = 'auth:required'    // 同时在 globalThis 上派发 CustomEvent
```

判定：401 且 body `code === 'NODE_LOGIN_REQUIRED'` → `scope:'node'`，只发事件；401 且请求路径带 `/n/:id` 前缀但没有 code → 同样按 node 处理（不跳转）；其余 401 → `scope:'global'` + 跳 `/login?next=<当前地址>`。读 body 一律 `res.clone()`，调用方仍能完整消费原响应。

### 会话钥

```ts
establishSessionFromSeed(seed, { uid, entryNodeId, rootEpoch, hasTotp, totpCode?, now? }): SessionKeyInfo
establishSessionFromPassword({ password, kdfParams, ...同上 }): Promise<SessionKeyInfo>
establishSessionFromPasskey({ uid, entryNodeId, credentialId?, api?, now? }): Promise<SessionKeyInfo>
loginToNode(nodeId, { api?, node? }): Promise<{ ok: true } | { ok: false; code }>
loginToAllReachable({ api?, skipLoggedIn? }): Promise<NodeLoginProgress[]>
logoutEverywhere({ api? }): Promise<void>
getSessionKey() / getSessionKeySnapshot() / hasSessionKey() / clearSessionKey()
setTotpCode(code) / clearTotpCode()
subscribeSessionKey(fn) / subscribeLoginProgress(fn) / getLoginProgress()
```

安全性质（有测试覆盖）：

- `establishSessionFromSeed` 派生完根钥与 `k_totp` 后**把传入的 seed 与 `RootKey.seed` 双双清零**；`RootKey` 对象不出该函数。
- `sk_sess` / `delegation_sig` / `k_totp` 只在模块内部闭包里，对外只暴露 `SessionKeyInfo`（无任何私钥字节），`clearSessionKey()` 会 `fill(0)`。
- `loginToNode` 第 1 步拿到的 `nodePk` 与 `/api/mesh/nodes` 的 `publicKey` 不一致时**在签名之前**中止（`NODE_PK_MISMATCH`），不发 login 请求。
- TOTP 仅在 `delegation.method === 'root' && hasTotp` 时随 login 下发；缺验证码直接 `TOTP_REQUIRED` 且不发任何请求。fan-out 结束即清掉一次性验证码（`k_totp` 保留，供新出现的 node 配新码使用）。

### 记录构造

```ts
type RecordSigner =
  | { kind: 'root'; rootKey: RootKey }
  | { kind: 'passkey'; credentialId: string; assert?: AssertFn };

buildSignedRecord({ head, rootEpoch, uid, type, payload, signer }): Promise<{bytes, sig}>
buildRotateRootRecord({...})            // 同步，旧根钥签
buildAddPasskeyRecord / buildRemovePasskeyRecord / buildSetTotpRecord / buildClearTotpRecord
headFromResponse(KeyLogHeadResponse): KeyLogHead   // seq 支持 number | string
deriveRootKey(password, kdfParams) / kdfParamsFromJson(json)
```

passkey 分支必须显式给 `credentialId`：challenge 是 `sha256(recordBytes)` 而 `credential_id` 又在记录里，先做仪式再填 id 会导致两次用户交互。sig 为 Borsh `PasskeyAssertion`（b1-3a-fix 第 4 条的规范编码），断言返回的 credential 与预期不符直接抛错。

### 账号安全动作

```ts
changePassword({ api?, uid, oldPassword, newPassword, currentKdfParams }): Promise<KeyLogAppendResult>
setTotp({ api?, uid, password, currentKdfParams, secret?, issuer? }): Promise<{ result, otpauthUri }>
clearTotp({ api?, uid, signer }) / registerPasskey({ ..., name }) / removePasskey({ ..., credentialId })
rootSignerFromPassword(password, kdfParamsJson): Promise<RecordSigner>
```

### 页面与组件

```ts
// apps/fe/src/pages/LoginPage.tsx
export default function LoginPage(props?: { mode?: AuthModeResponse; api?: AuthApi })
export const PageTitle
export const loginRoute = { path: 'login', moduleLoader: () => import('./LoginPage') }

// apps/fe/src/pages/AccountSecurityPage.tsx
export default function AccountSecurityPage(props?: { mode?: AuthModeResponse; api?: AuthApi })
export const accountSecurityRoute = { path: 'account/security', moduleLoader: ... }

// apps/fe/src/auth/NodeLoginButton.tsx
export function NodeLoginButton({ nodeId, nodeName?, className?, size?, onLoggedIn? })
```

`mode` prop 用于注入（测试 / 外层已拉过 mode），给了就不再请求 `/api/auth/mode`。

**账号安全为什么独立成页而不是塞进 Settings tab**：设计 §4 把「账号安全」写成 Nodes 页（F4-3）的一个区块，而 SettingsPage 的 tab 列表在 F4-2 的改造范围内——独立页让两边都只需要一个链接即可复用，且 standalone 下整页 `return null`，不会在设置里留一个空 tab。登录页底部固定链到 `/account/security`（即「为本入口注册 passkey」入口）。

`NodeLoginButton`：`hasSessionKey()` 为真时直接静默 `loginToNode(nodeId)`；否则（含 `NO_SESSION_KEY` / `TOTP_REQUIRED`）跳 `/login?node=<id>&next=<当前地址>`，登录页读到 `?node=` 就只登这一台。

---

## 三、与 B2-2b 已落地代码的对齐（重要）

`sub/b2-2b-result.md` 在我开工与收尾时都还没有，但 `apps/gateway/src/mesh/auth-routes.ts`（682 行）已经出现在工作区。按它逐条对过，已在本任务里改掉的差异：

1. **`uid` 是 user id，不是用户名。** `/api/auth/mode` 返回 `{uid, username}` 两个字段，`handleLogin` 要求 `login.uid === user.id`，`checkTotp` 的 AAD 与 `deriveTotpKey` 的 info 也用 `user.id`。前端已改为：输入框里是用户名，实际 `login.uid` / `delegation.uid` / `k_totp` 用 `mode.uid`（仅在输入的用户名与 `mode.username` 一致时替换，否则原样送用户名让后端报 `UNKNOWN_USER`）。
2. **`mode.username` / `mode.uid` / `mode.kdfParams` 可为 `null`**（standalone 或尚无用户），类型与两个页面都已处理。
3. **passkey 注册 verify 需要 `challenge_id`**：`register/options` 响应带 `challenge_id`，`register/verify` 要原样回传，否则 `CHALLENGE_CONSUMED`。`AuthApi.passkeyRegisterVerify(response, challengeId)` 已带上。
4. **passkey 登录的凭证发现**：`passkeyLoginOptions` 的 `allowCredentials` 是用户全部凭证，而 `delegation.credential_id` 必须在仪式**之前**定下（challenge = `sha256(borsh(delegation))`）。实现为：用一个探测 delegation 换回 `allowCredentials` → 选第一把 → 用最终 delegation 再换一次 options → 仪式时把 `allowCredentials` 收窄成选中的那把。**两次 HTTP、一次用户交互。**
5. **`login.target`** 允许是目标 nodeId 或 `self`；前端一律用 `/api/mesh/nodes` 里的真实 id，URL 走 `/n/<id>/api/auth/*`（`self` 由 `nodeAuthPath` 退化成无前缀，仅在显式传 `'self'` 时）。
6. **错误码**：i18n 已覆盖 gateway 实际返回的全部码（`MALFORMED` / `UNKNOWN_USER` / `UNAUTHORIZED` / `CHALLENGE_CONSUMED` / `CHALLENGE_MISMATCH` / `ENTRY_MISMATCH` / `UID_MISMATCH` / `TARGET_MISMATCH` / `TOTP_REQUIRED` / `TOTP_INVALID` / `RATE_LIMITED` / `PASSKEY_VERIFY_FAILED` / `KEY_LOG_FORK` / `DELEGATION_*`），未命中的码用 `defaultValue` 原样显示。
7. **`/api/mesh/nodes`**（`mesh-routes.ts` 已实现）的 `reach` 与 `version` 可为 `null`，类型已放宽。`loginToAllReachable` 按 `online === true && !loggedIn` 过滤。

---

## 四、必须由协调者/后端补的（阻塞项）

1. **`GET /api/auth/keylog/head`（不存在，`auth-routes.ts` 对未知 `/api/auth/*` 直接 404）。**
   构造任何 `user_key_log` 记录都需要 `{seq, hash, rootEpoch, uid}`——没有它，账号安全页的**全部**动作（改密 / TOTP / passkey）都跑不通。前端已按 `KeyLogHeadResponse { seq: number|string, hash: b64url, rootEpoch: number, uid: string }` 接好，后端补上即可。
2. **`/api/auth/mode` 缺 `rootEpoch`。** `k_totp = HKDF(seed, "tmex-totp"‖root_epoch, uid)`，前端缺失时按 `0` 退化——用户一旦 `rotate-root`（epoch ≥ 1），TOTP 登录必然 `TOTP_INVALID`。请在 mode 响应里加 `rootEpoch`（`keyLogService.currentState(uid).rootEpoch`）。
3. **`GET /api/auth/passkeys`（可选但强烈建议）**：账号安全页要列出/删除 passkey。前端对 404 已退化成空列表（只能「添加」，不能「删除」，且「用已有 passkey 授权」不可用）。返回 `{passkeys:[{credential_id, name, rp_id, origin, device_type?, created_at?}]}` 即可。
4. **passkey 签名的 key-log 记录**：b1-3a-fix 已要求 `sig = borsh(PasskeyAssertion)`，但 `apps/gateway/src/auth/passkey.ts` 的 `encodePasskeyAssertionSig` 还是 `JSON.stringify(AuthenticationResponseJSON)`。前端按 **Borsh** 发；后端不改就会 `bad_signature`。`delegation_sig` 的 passkey 形态同理（前端发 Borsh `PasskeyAssertion`）。
5. **路由注册（F4-2 的 `main.tsx`，我未改）**——加到 `createBrowserRouter` 的**顶层数组**（登录发生在任何 node 运行时之前，不放进 `NodeShell` 的 `pageRoutes()`）：

   ```tsx
   const loginModule = () => import('./pages/LoginPage');
   const accountSecurityModule = () => import('./pages/AccountSecurityPage');
   // ...
   { path: '/login', element: <PageWrapper moduleLoader={loginModule} /> },
   { path: '/account/security', element: <PageWrapper moduleLoader={accountSecurityModule} /> },
   ```

6. **拦截器接线**（一次，建议放 `AppRoot` 或 `runtime-setup`）：

   ```ts
   import { installSessionInterceptor } from '@tmex/api-client/auth/index';
   installSessionInterceptor({ navigate: (to) => router.navigate(to) });
   ```

   不传 `navigate` 会退化成 `location.assign`（整页刷新，仍可用）。WS 4401 在 `ws-client` 侧调 `handleNodeLoginRequired(nodeId)` / `handleGlobalUnauthorized()`。
7. **i18n 生成**：跑 `bun run build:i18n` 重建 `resources.ts` / `types.ts`。
8. **F4-3**：`NodeLoginButton` 从 `@/auth`（或 `@/auth/NodeLoginButton`）导入，放进侧边栏 node 行；未登录行直接渲染它即可。

---

## 五、测试 / tsc / biome

### 测试

```
# apps/fe（本任务文件）：bun test src/auth src/pages/LoginPage.test.tsx
 27 pass  0 fail  76 expect() calls
 Ran 27 tests across 5 files. [414.00ms]

# apps/fe 全量：bun test src/
 49 pass  0 fail  124 expect() calls        # 基线 9，其中 27 为本任务、13 为并发 F4-2

# packages/api-client（本任务文件）：bun test src/auth
 23 pass  0 fail  49 expect() calls
 Ran 23 tests across 3 files. [33.00ms]

# packages/api-client 全量：bun test
 69 pass  0 fail  174 expect() calls        # 基线 34

# packages/shared（只改了 locale JSON）：bun test
 277 pass  0 fail
```

覆盖点：

- 拦截器：全局 401 → 事件 + `/login?next=` 跳转；`NODE_LOGIN_REQUIRED` → 只发事件不跳转；`/n/:id` 上无 code 的 401 → 按 node 处理；非 401 无动作；钩子用 clone 读 body 后调用方仍能读；已在登录页时不叠加 `next`；未安装钩子时 fetch 不受影响；`nodeIdFromPath` 解码。
- `AuthApi`：`nodeAuthPath` self/非 self；challenge 请求体；login 401/429 返回 code 而非抛异常；keylog 409 → `KEY_LOG_FORK`；`listPasskeys` 404 → `[]`。
- `webauthn`：options JSON→ArrayBuffer、空 `allowCredentials` → undefined、凭证→JSON base64url、缺可选 getter 不炸。
- `session-key-store`（真实密码学 + mock fetch）：seed 被清零；`loginToNode` 产出的 `delegation` 用 `verifyDelegation`（测试根钥公钥）验过、`login` 签名用 `verifyLogin(login, sig, delegation.sess_pk, expected)` 验过；`NODE_PK_MISMATCH` 中止且不发 login；`UNKNOWN_NODE`；后端 code 透传；**TOTP 仅 `method=root` + `hasTotp` + 有码时才带**、无码 `TOTP_REQUIRED` 且零请求；fan-out 过滤离线/已登录、逐 node 记录成功与错误码、结束后清一次性码。
- `key-log-actions`：`rotate-root` 由旧根钥签且过 `verifyKeyLogRecord`，用新根公钥验必须 `bad_signature`；payload 解码回新公钥与新 kdf；passkey 记录 sig 为 Borsh `PasskeyAssertion`、challenge = `sha256(recordBytes)`、**只做一次仪式**、credential 不符抛错；`headFromResponse` 支持字符串 seq。
- `account-security-actions`：`changePassword` 发出的记录过共享验签器，且「新密码 + payload 里的新 kdf 参数」能重算出 payload 里的新根公钥；`setTotp` 的密文能用 `deriveTotpKey(seed, uid, rootEpoch)` + AAD `{uid, root_epoch, seq=head+1}` 解开，URI 可扫。
- `totp-uri`：RFC 4648 向量 + 往返 + Key Uri Format 参数。
- `LoginPage`（`react-dom/server` + `MemoryRouter`）：`mode:'none'` 渲染为空串；mesh 下有用户名/密码框并预填；`totpEnabled` 才出验证码框；passkey 按钮只在 `passkeyAvailable && passkeysForThisOrigin` 时出现；始终有 `/account/security` 链接。

### tsc

| 包 | 基线 | 现在 |
|---|---|---|
| `apps/fe` | 0 | **0** |
| `packages/api-client` | 5 | **5**（全部为既有 `client.test.ts` / `files-download.test.ts`，`src/auth/**` 0） |
| `packages/shared` | 0 | 0 |

> 中途曾看到 `apps/fe` 出现大量 `@tmex/stores` 相关报错，是并发 F4-2 改 `packages/stores` 的瞬时状态，现已恢复 0。

### biome

`packages/api-client/src/auth`、`packages/api-client/src/client.ts`、`apps/fe/src/auth`、`apps/fe/src/pages/{LoginPage,LoginPage.test,AccountSecurityPage}.tsx`、三个 locale JSON 全部干净（`biome check` 无 error）。未对 `resources.ts` / `types.ts` 等生成文件做任何 lint/format。

---

## 六、已知取舍与遗留

1. **TOTP 一次性码的生命周期**：只在初次 fan-out 期间保留，之后清除。后来新出现的 node 若需要 TOTP，`loginToNode` 返回 `TOTP_REQUIRED`，`NodeLoginButton` 把用户带回登录页重输——比缓存一个会过期的 6 位码更诚实。
2. **`setTotp` 先落记录再展示二维码**：动作是一次性的（加密密钥要绑 `seq`），所以 UI 文案明确「请立即扫码，此密钥只显示这一次」。若要做「先扫码再确认」的两段式，需要把 `secret` 提到页面 state 并二次调用——`setTotp` 已开放 `secret` 注入点。
3. **`registerPasskey` / `removePasskey` 的 passkey 签名者默认取列表第一把**；`/api/auth/passkeys` 缺失时该选项不可用，只能用密码。多把 passkey 时的选择器留给 F4-3 的 Nodes 页（或后续迭代）。
4. **`assertForChallenge` 的 rpId 取 `location.hostname`**：后端没有「按任意 challenge 下发 options」的端点，key-log 记录的 passkey 签名走可发现凭证 + 客户端收窄 `allowCredentials`。若后端后续提供该端点，把 `defaultAssert` 换掉即可。
5. **QR 用已在 `apps/fe` 依赖里的 `qrcode.react`**（未新增依赖，未跑 `bun install`）。
6. `logoutEverywhere()` 已实现（对 `loggedIn` 的 node fan-out `logout` 后清会话钥），但还没有 UI 入口——建议 F4-3 放到侧边栏/账号安全页。
