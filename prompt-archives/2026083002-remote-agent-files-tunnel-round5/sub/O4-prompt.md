# Task O4 — Settings → "远程访问" (Remote access) tab: Cloudflare Tunnel wizard (frontend)

Read `common-rules.md` in this directory first (ground rules, baselines, fixed contracts).

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-tunnel-report.md sections 1 and 4 (Settings tab registration, setup-wizard components to reuse: `SetupNotice`, `FormField`, `SwitchRow`, `RestartPanel` in apps/fe/src/pages/settings/nodes/setup/form-parts.tsx; TLS section's busy lock + pending polling pattern).

## Scope (files you own)
- apps/fe/src/pages/SettingsPage.tsx (+ test): add tab `remoteAccess` immediately to the RIGHT of `terminal` in the visible order; URL param `?tab=remoteAccess`.
- NEW apps/fe/src/pages/settings/remote-access/** (tab, wizard steps, hooks, tests)
- i18n: new `settings.remoteAccess` sub-object + `settings.tabGroup.remoteAccess` key.

## Contract (fixed, backend built in parallel by agent G4)
`packages/shared/src/contracts/tunnel.ts` and `packages/api-client/src/local/tunnel-api.ts` (`fetchTunnelStatus`, `runTunnelAction`, `TunnelApiError`). Read both fully. The API always targets the machine the browser is connected to (self); on a `/n/:id/settings` route the tab must show a notice "远程访问只能在当前连接的机器上配置" and render nothing else (detect via the route node id ≠ self).

## UI
A status card + a step-by-step wizard (all copy concise, product-grade; no exclamation marks):
- Status card header: "远程访问" with a state pill: 未配置 / 已停止 / 启动中 / 运行中 / 错误; when running show the public URL (copy button, open-in-new-tab), mode label (临时隧道 / 命名隧道), restarts count if > 0, and an "检查连通性" button (`check` action) whose result shows inline (可访问 / 不可达 + message). Buttons 启动 / 停止 / 移除 depending on state. A collapsible "日志" section showing `status.log` in a monospace box (last 200 lines, auto-scroll).
- Wizard steps (numbered, current step highlighted, completed steps ticked; reuse the visual language of the Hub setup wizard):
  1. 安装 cloudflared — shows installed/version/source, or an "安装" button (job `install`, progress via `job.step`: 下载 / 解压 / 校验). Unsupported platform → notice.
  2. 选择方式 — two option cards: "临时隧道"（无需账号，地址随每次启动变化，适合测试）and "命名隧道"（需要 Cloudflare 账号与已托管的域名，固定地址）.
  3a. 临时隧道 → button 启动 (`quick_start`); success shows the trycloudflare URL.
  3b. 命名隧道 → sub-steps: 登录 Cloudflare (`login` → shows `auth.loginUrl` as a button "打开授权页面" plus copy; polling until `auth.loggedIn`; 取消 button → `cancel_login`; timeout error shown) → 主机名 input (validated: lowercase RFC 1123 host, e.g. `tmex.example.com`) + optional 隧道名称 → button 创建并启动 (`create`), progress via `job.step` (创建隧道 / 配置 DNS / 启动).
  4. 反向代理信任 — SwitchRow for `trustProxy` (`set_trust_proxy`), helper text "tmex 位于隧道之后时需要开启，以便正确识别客户端地址与协议"; when `restartRequired` show `RestartPanel`-style restart prompt (reuse the existing restart-now hook if it is generic enough, else a notice with the CLI hint).
  Also: 随 tmex 启动 switch (`set_auto_start`).
- Polling: `useQuery` on `fetchTunnelStatus` with `refetchInterval` 2 s while `job?.state === 'running'` or process state is `starting`, else 10 s. Mutations go through one serialized runner with a busy lock (buttons disabled while busy); `busy` (409) shows "另一项操作正在进行".
- Errors: map `TunnelErrorCode` to copy in i18n (`settings.remoteAccess.errors.<code>`), fall back to the server message.
- Node role note: if the current machine is a Hub (see how NodesTab/`useMeshNodes` determines `isHub`/self role), show a one-line hint under the hostname step: "作为 Hub 时，请将 Hub 公开地址设为此主机名" linking to `?tab=nodes`.

## Tests
SettingsPage test updated for the new tab + order; remote-access tab tests with mocked api (state pill matrix, wizard step progression for quick and named, login URL rendering + cancel, error mapping, remote-route notice).

Verify: `cd apps/fe && bun test src/ && bunx tsc --noEmit -p .` + biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O4-result.md
