# Task O11 — Remote access tab: Cloudflare Access section (frontend)

Read `common-rules.md`, then `O4-result.md`, `O9-result.md`. The contract `packages/shared/src/contracts/tunnel.ts` gained Cloudflare Access support — read it in full (`TunnelAccessStatus`, `TunnelAccessPolicyRule`, `status.access`, `status.loginEnforced`, actions `set_access_credentials` / `clear_access_credentials` / `configure_access` / `remove_access` / `set_access_enforce`, job kind `access` with steps `create_app` → `policy` → `verify`, errors `access_required` / `access_api_failed`). Backend (agent G8, in parallel) implements it. Product rule: on a standalone instance (`loginEnforced === false`) a named tunnel can only be created/started after Access is configured with JWT enforcement for the same hostname; quick tunnels stay unavailable there (`auth_required`). On mesh-login instances Access is optional but recommended.

## Scope (files you own)
apps/fe/src/pages/settings/remote-access/** (+ tests); i18n `settings.remoteAccess` sub-object only (targeted edits, never delete keys).

## Requirements
1. New wizard step "访问控制 (Cloudflare Access)" placed after the hostname step and BEFORE "创建并启动" in the named flow (order: 安装 → 方式 → 登录 → 主机名 → 访问控制 → 创建并启动 → 反向代理信任). On standalone the step is mandatory (the create/start buttons stay disabled with the hint until `access.configured && access.enforceJwt`); on mesh-login instances it is optional with a "推荐" tag.
   Sub-sections: (a) Cloudflare 凭证：API token（password input，说明需要 "Access: Apps and Policies — Edit" 权限）+ Account ID；保存 → `set_access_credentials`；已保存时只显示「已保存」+ 账户 ID + 团队域（`teamDomain`）+「清除」；(b) 允许访问的用户：rule list editor（邮箱 / 邮箱域两种类型，可增删，至少一条，客户端校验格式）→「应用到 Cloudflare」= `configure_access` (async job；progress via `jobStep.create_app/policy/verify`)；(c) 状态：应用 ID / AUD / 覆盖主机名 / 规则列表 / 「网关校验 Access 令牌」开关（`set_access_enforce`，默认开，关闭时显示明确警告）/ 「移除 Access 应用」(AlertDialog) / `access.lastError`.
2. Replace the standalone "auth_required" notice: standalone now shows a notice above the mode step: 「本机未启用登录：临时隧道不可用；命名隧道必须配置 Cloudflare Access 后才能启动。」and the quick-mode option card is disabled with that reason. Map new errors: `access_required` →「请先为该主机名配置 Cloudflare Access 并开启令牌校验。」/ "Configure Cloudflare Access for this hostname and enable token verification first." / ja equivalent; `access_api_failed` →「Cloudflare API 调用失败：{{message}}」etc.
3. Status card: add an "Access" pill (未配置 / 已保护 / 已配置但未强制) next to the state pill.
4. Copy: concise, product-grade; three locales; add `jobStep.create_app`, `jobStep.policy` (and `verify` exists). Do not touch other sub-objects.
5. Tests: step ordering, standalone gating (buttons disabled + notice), credentials saved/unsaved rendering, rule editor validation (pure function), configure job progress, error mapping, pill matrix. Update all `TunnelStatusResponse` fixtures with `access` + `loginEnforced`.

Verify fe tests + tsc + biome. Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O11-result.md
