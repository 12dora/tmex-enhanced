# B2-8 结果 — passkey origin 精确过滤 + verifier origin/uid 绑定

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 做了什么

`POST /api/auth/passkey/login/options` 只下发 `user_keys.origin === 请求可信 origin` 的凭证；空列表 `404 {code:'NO_PASSKEY_FOR_ORIGIN'}`。`GET /api/auth/passkeys` 增加 `usableHere`。注册 options 的 `rpId` / verify 落库 origin 绑定 challenge 里的可信 origin。`makeVerifyDelegationPasskey` / `makeVerifyPasskeyAssertion` 验签永远用凭证存档的 `origin`/`rp_id`，并拒绝 `stored.userId !== delegation.uid`。

可信 origin 与 `session-middleware.publicRequestUrl` 一致：优先 `Origin` 头；缺失时 `via=self && trustProxy` 读 `x-forwarded-proto/host`，否则用 `req.url` origin。转发（`via !== self`）永不信 forwarded 头。

## 文件清单

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/auth-routes.ts` | login/options origin 过滤 + 404；passkeys.`usableHere`；verify 回写 challenge origin |
| `apps/gateway/src/mesh/auth-routes.test.ts` | 双 origin 过滤、trust-proxy、usableHere、register origin 绑定 |
| `apps/gateway/src/auth/passkey.ts` | `verifyRegistration` 存 `input.origin`；delegation verifier 校验 uid |
| `apps/gateway/src/auth/passkey.test.ts` | 错 origin / uid 错配拒绝，counter 不前进 |

## 公开 API / HTTP 契约增量（前端必读）

无新 TypeScript 导出。HTTP 契约变化：

### `POST /api/auth/passkey/login/options {uid, delegation}`（仍公开，无需会话）

- 200：`PublicKeyCredentialRequestOptionsJSON`
  - `allowCredentials` **仅** `origin` 与请求可信 origin **字符串全等** 的凭证（scheme+host+port，无 `rp_id` 回退）
  - `rpId` = 该 origin 的 hostname
- **新增** 404 `{ "code": "NO_PASSKEY_FOR_ORIGIN" }`：该 origin 下一把都没有（含用户存在但凭证都在别的 origin）
- 其它：400 `MALFORMED`、404 `UNKNOWN_USER` 不变

`packages/api-client` 的 `passkeyLoginOptions()` 目前对任何 `!res.ok` 抛泛化 Error，**吃不到** `NO_PASSKEY_FOR_ORIGIN`。登录页需要把它当「本入口没有可用 passkey」，不要再回退到未过滤列表或 `allowCredentials[0]`。

### `GET /api/auth/passkeys`（需会话）

每项现为：

```ts
{
  credential_id: string
  name: string | null
  rp_id: string
  origin: string
  created_at: number
  log_seq: number
  usableHere: boolean  // 新增：row.origin === 请求可信 origin
}
```

`PasskeySummary`（`packages/api-client/src/auth/types.ts`）还没有 `usableHere`。账号安全页应灰掉 `usableHere === false` 的行，并删掉 `passkeysForOrigin()` 的 `rp_id` 回退（见 `f4-fix-review.md` Major）。

### `POST /api/auth/passkey/register/options` / `verify`

- options 的 `rp.id` = 可信 origin hostname（原先已如此；trust-proxy 路径补了测试）
- verify 返回的 `origin`/`rp_id` **固定为 options 时写入 challenge 的值**，不采用 verify 请求自己的 Origin。前端签 `add-passkey` 记录必须用响应里的 `origin`，不要用 `location.origin` 重算

### Verifier（内部，路由已接线）

```ts
makeVerifyDelegationPasskey(userStore, options?: { now?: () => number }): VerifyDelegationPasskey
// expectedOrigin/RPID = stored.origin / stored.rpId（不是请求 origin）
// stored.userId !== delegation.uid → false，且不 bump counter

makeVerifyPasskeyAssertion(userStore): VerifyPasskeyAssertion
// 同样用 stored.origin / stored.rpId
```

跨用户 passkey 登录仍走 B2-2b：`stored.userId !== user.id` → `401 DELEGATION_BAD_SIGNATURE`。

## 测试

```
cd apps/gateway && bun test src/mesh/auth-routes src/auth
  75 pass
  0 fail
  789 expect() calls
Ran 75 tests across 11 files. [6.73s]
```

biome：4 个范围内文件 clean。

## tsc

`apps/gateway`：before **23** / after **23**（未增加）。新增代码无新错误。错误仍全部在既有 push/tmux/ws 文件。

## 协调者需要做的（范围外）

1. **`packages/api-client`**：`PasskeySummary.usableHere?: boolean`；`passkeyLoginOptions` 对 404 `NO_PASSKEY_FOR_ORIGIN` 返回可判别结果，不要当未知失败。
2. **前端登录**（`session-key-store.ts`）：探测 options 404 时直接 `PasskeyCredentialUnknownError`，禁止再 `listPasskeys()` 失败后盲取第一把。
3. **账号安全 UI**：用 `usableHere` 灰掉他 origin 凭证；删 `passkeysForOrigin()` 的 `rp_id` fallback。
4. **i18n**：补 `NO_PASSKEY_FOR_ORIGIN`（`auth.errors`）。
5. 未改 `mesh-routes.ts` / `mesh-runtime.ts` / `mesh-deps.ts` / `session-middleware.ts`（origin 解析已复用 `publicRequestUrl`）。

## 未能做 / 说明

- `register/options` 的 `excludeCredentials` 仍列出该用户全部凭证（含他 origin）。WebAuthn 按 rpId 隔离，任务未要求改。
- `Origin` 头存在时优先于 `x-forwarded-*`（浏览器仪式必须以页面 Origin 为准）。无 Origin 时才走 trust-proxy。
