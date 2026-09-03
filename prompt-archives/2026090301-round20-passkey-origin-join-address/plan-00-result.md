# 第二十轮执行结果

分支 `feat/round20-passkey-origin-join-address`（worktree `/Users/konata/code/tmex-r20`），基于 1.1.19，发版 1.1.20。

## 结论

- **问题 1（127.0.0.1 访问时通行密钥挡住 hub 连接）**：根因是二次验证按「任意 origin 有通行密钥」全局强制且通行密钥经密钥日志同步到全部节点，而 WebAuthn 不允许 IP 字面量 origin。本地登录先停在 `NO_PASSKEY_FOR_ORIGIN`；若入口有旧会话，hub 静默登录回 `PASSKEY_REQUIRED` 被 UI 显示为「Hub 不可达」。
- **问题 2（加入地址指向备 hub）**：「加入地址」= 入会时写进 `TMEX_HUB_URL` 的引导种子，只做拨号候选，主备切换 / 改名 / failover 都不改它；按用户意见从 UI 删除。

## 交付

### 后端（gateway）

- `mesh/client-source.ts`：`isTrustedLocalClient(req)`（`via=self`、套接字对端本身为回环/内网/CGNAT、无 `cf-connecting-ip`、未开信任代理时无 XFF/X-Real-IP、信任代理时解析出的客户端 IP 也须本地）；`waivesPasskeySecondFactor(req)` = 直达可信 或 peer 请求带 `x-tmex-client-source: local`。
- `auth-routes.ts` / `db/local-auth-http.ts`：`/api/auth/mode` 豁免时 `passkeySecondFactor=false`、`passkeySecondFactorWaived=true`（按请求计算，不进缓存）；`checkPasskeySecondFactor` 豁免直接通过（密码 / TOTP / 限速不变）。
- `forwarder.ts`：转发头一律丢弃浏览器自带的 `x-tmex-client-source`，入口判定可信本地时盖 `local`。
- `auth-public-paths.ts`：登录公开路径单一集合，`stream-targets` / `forwarder` / `auth-routes` 共用；peer 流对公开路径无 token 匿名放行、带 token 仍校验（修掉转发 `passkey/login/options`、`mode` 报 missing auth 的既有不一致）。
- `auth/mesh-membership-store.ts`：`clearAll()` 补删 `mesh_hubs`。
- `packages/api-client` 类型加 `passkeySecondFactorWaived`。

### 前端（fe）

- 本机卡片删除「加入地址」行与 `nodes.machine.joinSeed`（三语言）。
- 节点管理：`HubFailureReason`（auth / unreachable）贯穿 `loadHubNodes → HubLoadCoordinator → nodes-management`，鉴权拒绝显示「Hub 拒绝了本次登录（code）」（testid `nodes-hub-login-rejected`）；候选遍历中鉴权拒绝优先于后续候选的不可达；静默登录结果按排除法归类（本地码 `NO_SESSION_KEY/UNKNOWN_NODE/NETWORK_ERROR/NODE_LIST_FAILED` 之外都算拒登）；换目标时清失败态（同目标轮询保留，避免横幅闪烁）。
- 登录页 `passkeySecondFactorNotRegistered` 与账号安全 `passkeySecondFactorHint` 补本机 / 局域网规则。

### e2e / 文档

- mesh e2e 实例 `TMEX_TRUST_PROXY=true`；`mesh-passkey.spec.ts` 严格路径 context 带 `x-forwarded-for: 203.0.113.9`；新增「回环免二次验证」用例：登录入口后经 SPA 登录远端节点（真正走 forwarder → peer 链路 → 远端 `checkPasskeySecondFactor`），`/n/<remote>/api/devices` 200、`navigator.credentials.get` 零调用，且先用公网源 context 轮询远端 `passkeySecondFactor=true` 确认密钥日志已复制；另有「公网源仍强制」用例。
- `docs/operations/2026090304-passkey-trusted-local-source-waiver.md` 新增，旧文档风险条目与 README 索引更新。

## 审查处理

- codex sol 后端 #1（信任代理时直达客户端伪造 `x-real-ip`）→ 已修（套接字对端必须本地）。#2（peer 流公开路径不一致）→ 核实为既有不一致，已修。
- 前端 #1/#2/#3（鉴权拒绝被后续 503 覆盖 / 分类不全 / 失败态残留）→ 已修；#4（e2e 未走 peer 链路）→ 已修；#5（CGNAT 不算局域网的文案）与 #6（1.1.19 旧 changelog）→ 不修。

## 验证

- gateway 3767 pass / 4 fail（stream-failover、large-push×2、RtcPeerManager 负载 flake，隔离通过）；fe `bun test src/` 1737；api-client 155；shared 442；app 687/1（cpu-features 已知）。tsc：gateway / fe 0，api-client 5、app 1 既有。
- mesh e2e 12/12（`TMEX_MESH_E2E_BUILD_FE=1 bun run test:e2e --project mesh`）。

## 安全边界与注意

- 信任的是 mesh 成员身份（认证 peer 链路），不是头本身；被攻陷的成员节点可为经它登录的浏览器免掉通行密钥，与其本就能中转终端属同一信任面。不做签名断言、不做开关。
- 反向代理部署必须开信任代理头且代理位于本机/内网，否则不豁免（fail-closed）。
- CLI `tmex enroll` 密码路径仍打公网 hub，启用通行密钥后照旧不可用（走加入码）。
- 种子 `TMEX_HUB_URL` 在 `mergeUplinkCandidates` 中仍按 `active/epoch 0` 排在已知 standby 之前（与 `docs/hub/2026090104-multi-hub-standby.md` 描述「种子最后」不符），本轮未动。
