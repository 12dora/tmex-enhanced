# 第十八轮执行结果

分支 `feat/round18-auth-hardening`（worktree `../tmex-r18`），基于 1.1.17，发版 1.1.18。

## 交付

| 任务 | 结果 |
|---|---|
| 1 登录失败模糊化 | 密码路径未知用户 / 密码错 / 会话签名错统一 `401 INVALID_CREDENTIALS`，未知用户照发挑战；`passkey/login/options` 未知用户与无凭证同码；前端「用户名或密码错误。」并兼容旧节点旧码；forwarder 透传 auth 路径 401 原码。 |
| 2 通行密钥二次验证 | 任意 origin 有通行密钥 → root 登录必须附带绑定 delegation 的断言（`passkey:{credential_id,sig}`，challenge=`sha256(borsh(delegation))`，一份断言全节点复用并随 delegation 持久化）；`mode.passkeySecondFactor`；`PASSKEY_REQUIRED`/`PASSKEY_INVALID`；TOTP 独立叠加；移除全部通行密钥即关闭；节点登录按钮可补做仪式；后台登录遇 `PASSKEY_INVALID` 只丢断言。 |
| 3 公网暴露排查 | 采纳：JSON body 1 MiB 封顶、客户端 IP 顺序改 `cf → x-real-ip → XFF 末段`、挑战存储/限流表上限、挑战+options 每 IP 60/min（入口按真实 IP，目标对 peer 不计 IP 桶）、uid ≤256 字节、`/api/auth/mode` 仅登录后返回 `rootPublicKey`。不做：裸 gateway 入口门禁（部署约束）、远端 symlink、standalone setup、WS 帧上限、uplink 挂起上限、WS Origin、HSTS、CSRF token、滚动升级版本门禁。 |
| 4 HTTPS 状态误报 | `GET/PUT/renew /api/tls` 增 `https:{source,verified,publicUrl}`（builtin / reverse-proxy 已确认或按公开地址推断 / none）；HTTPS 区显示「对外 HTTPS」，监听行改「内置监听器：」，none 模式下检测到反代 https 提示切换外部反代模式。hub 公开地址推断用 `hubPublicUrl ?? baseUrl`。 |
| 5 窄屏终端溢出 | 真因：视口仲裁取面积最大者，手机与桌面同看一个 pane 时手机拿到桌面宽度 PTY。改为最小列数优先（tie → 行数小 → sessionId 小），协议不变。 |

## 审查

codex sol 三路审查：R1（后端）4 条——版本门禁（不做，记录滚动升级窗口行为）、CLI enroll 不可用（改为提前给出说明）、超长 uid 撑爆存储（已修）、转发鉴权按 peer 计桶可被锁（已修：入口按真实 IP 限速）；R2（前端）3 条全部修复；R3 1 条（hub 用 hubUrl 推断）已修。

## 验证

- gateway ≈3627 pass（全量下 3～4 个时序 flake，隔离全绿；含 stream-failover、large-push、RtcPeerManager、BulkTransfer、DataChannelLink、WeixinClient）；fe 1605；app 670；shared 442；api-client 144；stores 419；panels 747。tsc：gateway/fe/shared/panels 0，app 1、api-client 5、stores 1（既有）。
- e2e：见下文 O3 记录。
- `bun run build` 成功。

## 文档

- `docs/operations/2026090201-passkey-second-factor-opaque-login.md`
- `docs/operations/2026090201-effective-https-status.md`
- `docs/operations/2026090101-public-login-hardening.md`（IP 顺序、资源上限）
- `docs/terminal/2026090101-viewport-policy.md`（最小客户端）

## 踩坑

- locale 有第三语言 `ja_JP.json`，agent 只改 zh/en，需指挥官按 zh 结构补齐后再 `build:i18n`。
- 只暂存 locale 子树：python 合并 HEAD JSON + 工作区子树 → `git hash-object -w --stdin` → `git update-index --cacheinfo`。
- Opus 子代理可能因 API 证书错误在开头即死，重开即可。
- BSD sed 不支持 `r file` + `d` 组合写法，拼 prompt 用 python。
