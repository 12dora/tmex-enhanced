# 第二十轮计划：可信源免通行密钥二次验证 / 删除「加入地址」

## 背景

- 分支 `feat/round20-passkey-origin-join-address`，worktree `/Users/konata/code/tmex-r20`，基于 main `308b15de`（1.1.19）。
- 1.1.18 起「用户名下任意 origin 注册了通行密钥 → 密码登录必须附带通行密钥断言」（`docs/operations/2026090201-passkey-second-factor-opaque-login.md`）。通行密钥经密钥日志同步到全部节点，所以本机节点也强制。
- WebAuthn 不允许 IP 字面量 origin（`127.0.0.1`、`192.168.x.x`），这些地址永远无法注册通行密钥。
- 第十九轮的域名访问策略已经把「本机 / 内网 / CGNAT 源地址」定义为可信来源（`apps/gateway/src/mesh/domain-access-policy.ts` `isLocalClientSource`），仅按客户端源 IP 判定。

## 问题 1 诊断（codex EX-A）

从 `http://127.0.0.1:9883` 登录：`/api/auth/mode` 返回 `passkeyAvailable=false`、`passkeySecondFactor=true`；前端密码登录后调 `/api/auth/passkey/login/options` 按当前 origin 过滤凭证 → `404 NO_PASSKEY_FOR_ORIGIN`，本地登录直接失败。若入口已有旧会话（delegation 18h），则 hub 管理请求 `401 → NODE_LOGIN_REQUIRED → ensureNodeLogin(hub)` 的登录体无断言 → hub 回 `PASSKEY_REQUIRED` → `HubLoadCoordinator.failed` → UI 只显示「Hub 不可达」（`nodes.hubOffline`），即用户看到的「无法连接 hub」。

hub 校验断言用的是凭证上存的 origin/rpId，不是 hub 自己的 origin；浏览器所有节点登录都经入口 forwarder `/n/<id>/api/auth/*` 走认证 peer 链路（目标侧 `clientIp=peer:<入口>`），没有浏览器直连 hub 公网地址登录的路径。

## 问题 1 方案：可信源豁免 + 入口经 peer 链路打标

- **判定**：新增 `apps/gateway/src/mesh/client-source.ts` `isTrustedLocalClient(req)`：仅 `via=self` 的直达请求；`cf-connecting-ip` 出现 → 否；`trustProxy=false` 且带 `x-forwarded-for`/`x-real-ip` → 否（fail-closed，与第十九轮「反代必须开信任代理头」一致）；无 clientIp → 否；其余按 `resolveClientIp` 后 `isLoopbackClientIp || isLocalClientSource`（回环 / RFC1918 / link-local / ULA / CGNAT）。
- **入口打标**：forwarder 转发 `/n/<id>/...` 时，若浏览器源为可信本地，则在转发头加 `x-tmex-client-source: local`；浏览器自带的该头一律丢弃（`filterRequestHeaders` + `stream-targets` 的 BLOCKED 列表不拦它，因为它来自 peer 链路）。
- **目标侧豁免**：`waivesPasskeySecondFactor(req) = (via self && isTrustedLocalClient) || (isPeerAuthRequest && header==='local')`。`handleMode` 的 `passkeySecondFactor` 在豁免时为 false，另回 `passkeySecondFactorWaived: true`；`checkPasskeySecondFactor` 豁免时直接通过（密码 / TOTP 照旧）。直达请求携带该头无效。
- **安全边界**：信任的是认证 peer 链路（mesh 成员身份），不是头本身。被攻陷的成员节点可为经它登录的浏览器免掉通行密钥——该节点本就能中转终端；不加签名（链路已认证加密，签名不增加保护）。不做开关。
- **e2e**：Playwright 浏览器源就是回环。mesh e2e 实例开 `TMEX_TRUST_PROXY=true`，现有 passkey 二次验证用例给 context 加 `x-forwarded-for: 203.0.113.9` 模拟公网源保持严格路径；新增用例验证回环免二次验证且 hub 管理可达。

## 问题 2 诊断（codex EX-B）

「加入地址」= `TMEX_HUB_URL`（`/api/local/status.hubUrl`），入会时写死的引导种子：`mergeUplinkCandidates` 把它当 `mode=active, epoch=0` 的合成候选（排在已知 standby 之后、真实 writer 之前），主备切换 / 改名 / failover 都不改它，只有 leave 清掉、「更换 Hub」走 leave+重新加入才换。当前 hub、Hub 列表已完整表达挂载事实，用户确认可删。附带缺口：`MeshMembershipStore.clearAll()` 没删 `mesh_hubs`，leave 后残留旧 hub 集合。

## 问题 2 方案

- 前端删除本机卡片「加入地址」行（`seedLine`、`attachedUrl`、i18n `nodes.machine.joinSeed` 三语言），行渲染条件保留 `hubUrl`（未连上时仍显示「未连接」）。
- 后端 `clearAll()` 补删 `mesh_hubs`。

## 任务分工（同一 worktree 并行，文件集互不重叠，agent 不 commit）

| 编号 | 角色 | 范围 |
|---|---|---|
| G1 | grok | `client-source.ts`(+test)、`auth-routes.ts`(+test)、`db/local-auth-http.ts`、`forwarder.ts`(+test)、`stream-targets.ts`(+test)、`packages/api-client/src/auth/types.ts` |
| G2 | grok | `auth/mesh-membership-store.ts`(+test)、`packages/app/src/runtime/local-routes.test.ts` |
| O1 | opus | `local-machine-card.tsx`(+test)、locale `nodes.machine.joinSeed` |
| O2 | opus | 节点管理 hub 失败区分鉴权失败（`hub-load-coordinator`、`mesh-nodes`、`nodes-management`）、passkey 规则文案（`auth.login.*`、账号安全 `passkeySecondFactorHint`） |
| O3 | opus | `apps/fe/tests/helpers/mesh-boot.ts`、`apps/fe/tests/mesh-passkey.spec.ts` |
| 指挥官 | — | build:i18n、分批 commit、codex 审查、单测/e2e、文档、发版、本机替换 |

## 验收

- gateway 单测 ≥ 3738 pass（3 个已知 flake）；fe `bun test src/` ≥ 1721；api-client 155；shared 442。
- `mesh-passkey.spec.ts` 严格路径 + 新增豁免用例通过。
- 临时实例实测：注册 passkey 后从 `http://127.0.0.1:<port>` 密码登录成功、hub 管理可达；模拟公网源（XFF）仍 `PASSKEY_REQUIRED`。
- 发版 1.1.20，本机 `tmex upgrade`。
