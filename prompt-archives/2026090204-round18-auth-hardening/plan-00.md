# 第十八轮计划：登录失败模糊化、通行密钥二次验证、公网暴露安全排查、HTTPS 状态误报、窄屏终端宽度

## 背景

- 分支 `feat/round18-auth-hardening`，worktree `../tmex-r18`，基于 main `8f2049c1`（1.1.17）。
- 目标是把 tmex 暴露到公网前补齐登录面的基本卫生，但避免过度防御。
- 探索报告（codex luna）在 scratchpad `ex/EX-{A,B,C,D}-report.md`，关键结论摘录在本文。
- 分工：grok 4.6（后端）、Opus（前端）、codex sol（审查）、指挥官自跑实测与分批 commit。

## 现状要点（来自探索）

- 登录是"浏览器用 Argon2id 从密码派生根钥 → 用根钥签 delegation（method=root）→ 会话钥签 login 信封"。密码从不上送；密码错在服务端表现为 `DELEGATION_BAD_SIGNATURE`，前端映射成「密码不正确」。
- `/api/auth/mode` 是按**主用户**返回的（单用户系统），预填用户名、kdfParams、totpEnabled、passkeysForThisOrigin、rootPublicKey；未登录也能拿到。
- `/api/auth/challenge` 未知用户直接 404 `UNKNOWN_USER`；`/api/auth/login` 未知用户 404，签名错 401。
- passkey 直接登录：delegation.method=passkey，`delegation_sig` = borsh(PasskeyAssertion)，WebAuthn challenge = `sha256(borsh(delegation))`，凭证经 key-log `add-passkey` 复制到所有节点，所以同一断言可在所有节点复用（每节点各自维护 counter）。
- TOTP 只对 root delegation 生效；开了 TOTP 的密码会话不持久化，每次登录节点都要新码。
- HTTPS 设置区显示的是 `tls_config.mode` + 内置监听器状态，反代终止 TLS 时 mode 为 none/external、监听器停止，于是显示「关闭 / 未监听」；没有「有效 HTTPS」维度。
- tmux 尺寸：`resize-window -x -y` 会把 window-size 置 manual，最后一次上报的客户端赢（tmux 3.7b man 已确认）。

## 任务 1：登录失败提示模糊化（后端 G1 + 前端 O1）

- 后端 `auth-routes.ts`：
  - `handleChallenge` 未知用户不再 404，照常签发 challenge（uid 用原串）。
  - `handleLogin`：未知用户、root delegation 签名错 / method 不匹配、login 签名错统一 401 `{code:'INVALID_CREDENTIALS'}`。结构性错误（CHALLENGE_*、*_MISMATCH、DELEGATION_EXPIRED/INVALID_TTL/ISSUED_IN_FUTURE、MALFORMED、RATE_LIMITED）保持原码。
  - passkey 直接登录路径（method=passkey）失败仍回 `DELEGATION_BAD_SIGNATURE`（前端映射为通行密钥校验失败，不泄露密码信息）。
  - `passkey/login/options` 未知用户与「该 origin 无凭证」统一 404 `NO_PASSKEY_FOR_ORIGIN`。
  - `TOTP_REQUIRED` / `PASSKEY_REQUIRED` 不计入限流失败次数。
  - 检查 `forwarder.ts` 对 `/n/:id/api/auth/login` 401 的改写，确保新码穿透。
- 前端 `login-errors.ts`：`INVALID_CREDENTIALS` 与旧码（`DELEGATION_BAD_SIGNATURE`、`BAD_SIGNATURE`、`ROOT_KEY_MISMATCH`、`BAD_DELEGATION`、`DELEGATION_METHOD_MISMATCH`、`UNKNOWN_USER`）在密码路径统一映射到新文案 `auth.errors.invalidCredentials`「用户名或密码错误。」；`isCredentialFailure` 含 `INVALID_CREDENTIALS`。`LoginPage` 无 kdfParams 时也用该文案。

## 任务 2：通行密钥二次验证（后端 G1 + 前端 O1）

设计（不采用探索报告的"两段式新端点"方案，改为与 passkey 直接登录同构的"断言随信封"方案，保证 fan-out 静默登录其它节点不需要再次弹 Face ID）：

- 契约（已写入 `packages/api-client/src/auth/types.ts`）：
  - `AuthModeResponse.passkeySecondFactor?: boolean`：用户名下任意 origin 有 ≥1 通行密钥。
  - `AuthLoginRequest.passkey?: { credential_id, sig }`，`sig` = base64url(borsh(PasskeyAssertion))，WebAuthn challenge = `sha256(borsh(delegation))`（root delegation）。
  - 新错误码 `PASSKEY_REQUIRED`、`PASSKEY_INVALID`（均 401）。
- 后端：`handleLogin` 在 TOTP 校验后加 `checkPasskeySecondFactor`：method≠root → 通过；`listKeysByUser(user.id)` 为空 → 通过；无 `body.passkey` → `PASSKEY_REQUIRED`；有则用现有 `makeVerifyDelegationPasskey`（校验 stored.userId===uid、时间、断言、counter）→ 失败 `PASSKEY_INVALID`。判定依据是"任意 origin 有凭证"而非"本 origin 有凭证"，避免伪造 Origin 头绕过。TOTP 与 passkey 相互独立、都启用则都要。`mode` 增加 `passkeySecondFactor`。
- 前端：`establishSessionFromPassword` 之后若 `mode.passkeySecondFactor`：调 `passkeyLoginOptions(uid, delegation)` 拿本 origin 的 allowCredentials → WebAuthn get → 编码断言存入会话钥（`passkeyCredentialId` + `passkeySig`，随 delegation 一起持久化，属于签名不是秘密）→ `loginToNode` 携带 `passkey`。`NO_PASSKEY_FOR_ORIGIN` 时提示「本地址未注册通行密钥，请在已注册通行密钥的地址登录后为本地址添加」。服务端回 `PASSKEY_REQUIRED`（mode 快照过期）时执行同一仪式后重试一次；`PASSKEY_INVALID` 显示校验失败。账号安全面板通行密钥区加一句说明：注册后密码登录需通行密钥二次验证、仅在注册地址生效、移除全部通行密钥即关闭。
- 移除最后一把通行密钥自动关闭二次验证（无新增开关、无新表）。

## 任务 3：公网暴露安全排查（后端 G3 + G1 后续）

EX-B 审计结论：组装后的生产 runtime 对 `/api/*`、`/ws`、`/n/:id/*`、文件、系统路由均有会话门禁；mesh 头在边缘被剥离、peer/uplink 靠证书签名；tmux/ssh 命令均为 argv/引号拼装；SQL 参数化。落地的"便宜且有效"项：

- **JSON 请求体封顶**（1 MiB）：`apps/gateway/src/api/http.ts` `readJsonObjectBody` 与 `packages/app/src/runtime/http.ts` `readJsonBody`，未登录的登录/挑战/passkey/redeem/setup 都经这两处。
- **代理 IP 取值顺序**：`client-ip.ts` 改为 `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` **最后一段**（nginx 追加真实客户端在末尾，首段可伪造，否则限流可绕）。
- **挑战存储封顶**（4096，淘汰最旧）与**限流表封顶**（1 万 key、周期清理）。
- **G1 后续（auth-routes.ts）**：`/api/auth/challenge` 按 IP 限速；`/api/auth/mode` 的 `rootPublicKey` 仅对已登录请求返回（未登录只需 kdfParams；公开根公钥 + KDF 参数等于把密码离线爆破的 oracle 送出去；CLI `hub-client` 只读 uid/kdfParams，前端消费方均已登录）。

明确**不做**（过度防御或部署侧问题）：裸 `apps/gateway` 入口无门禁（生产只跑组装 runtime，属于部署约束，写进文档）；远端文件根 symlink 逃逸（单管理员、已登录）；standalone setup 路由（mesh 模式返回 not_standalone）；WS 入站帧大小（chunk 协议已限界）；uplink 挂起握手上限；WS Origin 白名单（SameSite=Lax 已挡跨站 WS）；HSTS（边缘配置）；CSRF token（JSON + Lax）。

## 任务 4：HTTPS 状态误报（后端 G2 + 前端 O2）

- `TlsStatusResponse` 增加 `https: { source: 'builtin' | 'reverse-proxy' | 'none'; verified: boolean; publicUrl: string | null }`：
  - 内置监听器在跑 → builtin（verified=true）；
  - 否则当前请求经信任代理头（`publicRequestUrl(req)`，仅 trustProxy 且 via=self 时生效）解析为 https → reverse-proxy，verified=true；
  - 否则配置的公开地址（hub publicUrl ?? baseUrl）为 https → reverse-proxy，verified=false；
  - 否则 none。
- 在 `packages/app/src/runtime/tls-routes.ts` 的 GET 分支用 req 装饰；`assemble.ts` 传入公开地址。
- 前端状态头显示「HTTPS：由反向代理提供（已确认 / 按配置地址推断）| 内置 | 关闭」；mode=none 但检测到反代 https 时提示切到「外部反向代理」并开启信任代理头。

## 任务 5：窄屏终端宽度溢出（后端 G4）

EX-D 结论：前端 fit（ghostty-terminal 自定义 FitAddon）按 DPR 取整、等字体就绪、零尺寸守卫都已到位；真因是网关的视口仲裁——每个可见浏览器终端上报 `terminal-viewport` claim，`apps/gateway/src/ws/viewport-policy.ts` `resolveWinner` 取**面积最大**者作为 tmux 窗口尺寸（`resize-window` 使 window-size=manual），其余客户端变 follower 平移显示。桌面标签页 160×48 与手机 42×60 同看一个 pane 时，手机拿到 160 列的 PTY，全屏 TUI 溢出。

改法：仲裁改为**可见 claim 中列数最小者胜**（列数相同取行数小、再取 sessionId 小），最小客户端隐藏/断开后由次小者接管；owner/follower 协议与报文不变。这与 tmux 多客户端 `window-size smallest` 语义一致，任何客户端都不会溢出。不做：`refresh-client -C`（一个 control-mode 客户端服务所有标签页，做不到按标签页尺寸）、`window-size latest`（resize-window 已置 manual）。

## 验收

- 各包 `bun test` 不低于基线：gateway 3593（4 个时序 flake）/ fe 1570 / shared 442 / api-client 142 / app 652（1 个需构建的 cpu-features 用例）/ terminal-ui 待测；tsc 错误数不高于基线（app 1、api-client 5，其余 0）。
- 临时实例实测：错密码提示模糊；注册 passkey 后密码登录弹 WebAuthn；反代 https 状态正确。
- 发版并 `tmex upgrade` 替换本机。
