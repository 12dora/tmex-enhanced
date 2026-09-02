# 第十六轮计划：本机卡片多 hub 显示 + 常规改密保留 passkey/TOTP/会话

## 背景

基于 v1.1.15（`main` @ `cadfe9cc`），分支 `feat/round16-local-card-rotate-root-keep`，worktree `/Users/konata/code/tmex-enhanced-hotfix2`。探索报告 EX4（codex luna）确认：现行 `rotate-root` 是破坏性改密（清 passkey/TOTP、撤销全部会话），passkey 与会话在密码学上都不依赖 root epoch，TOTP 密文可在改密仪式内用新 seed 重封装。

## 设计

- 本机卡片（已完成，O6）：按 `/api/mesh/hubs` 显示「当前 Hub」（主/备、写者）、「Hub 列表」（≥2 台），种子地址改为「加入地址」。
- 新记录类型 `rotate-root-keep`（追加到枚举末尾；payload `{root_public_key, kdf_params, totp: Option<{root_epoch = E+1, seq = record.seq, payload: SetTotpPayload}>}`，仅 root 签名）：应用后换根钥/KDF/epoch+1，**保留** passkey、TOTP（改为指向本记录）、节点证书、hub 授权，**不**撤销会话；hub 侧仍使未用加入码失效。
- 现有 `rotate-root` 保留为「全量重置」：界面勾选「同时移除所有通行密钥、两步验证并注销全部会话」（说明：适用于密码可能已泄露的情况）。
- 版本门禁：`rotate-root-keep` 要求全网未吊销节点 ≥ 1.1.16（复用 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` 机制，泛化按类型配置最低版本），不允许 force 绕过。
- 新接口 `GET /api/auth/totp-record` 下发当前 TOTP 密文（含 seq/epoch）供前端重封装；服务端只校验结构与 epoch/seq 一致。
- 前端：改密成功后不再清会话钥；用新密码/新 epoch 重建委托并 `loginSelf()`（两阶段替换，失败不丢当前会话；TOTP 用户需再输一次验证码）；`HUB_TIMEOUT`/`HUB_NOT_WRITER` 在账号安全面板给出「主 Hub 不可达，请先切换 Hub 角色」提示。
- 不做：离线改密后合并（哈希链不可分叉）、自动接管。

## 验收

各包测试不低于基线（fe 1524 / gateway 3543 / shared 430），tsc 0，lint 门禁通过；发版 1.1.16 并全网升级；真实主机改密实测：改后 passkey 仍可登录、TOTP 仍可用、当前页面不掉线、其它节点同步。
