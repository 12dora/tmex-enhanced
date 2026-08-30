# 第五轮：远程 Agent / 设备文件与侧栏 / 链路徽标 / 远程访问 Tab

## 背景

- 分支 `feat/round5-remote-agent-files`（worktree `../tmex-enhanced-wt-r5`），基于 main `52bb1007`（第四轮已快进合入 main）。
- 探索报告：`sub/explore-agent-report.md`、`sub/explore-devices-report.md`、`sub/explore-tunnel-report.md`（codex luna xhigh）。踩坑：codex `-s read-only` 下不能让它写文件，要它把报告作为最终消息输出（`-o` 捕获）。
- 基线：`sub/test-baseline.txt`（gateway 2500/tsc 21，fe 671/0，panels 507/0，stores 282/1，shared 365/0，api-client 132/5，ui 47/0）。
- 文案要求：简洁、专业、易懂，大型软件风格；三语 locale 同步改源 JSON，`bun run build:i18n` 由指挥官统一跑。

## 关键设计取舍（已拍板）

1. **远程 Agent**：session 由浏览器直连的 entry gateway（self）持有并执行 LLM；`agent_sessions.node_id`（null=self）。远端 pane 读写走 mesh HTTP：self 通过 `Forwarder.forwardHttp` 打远端的内部路由 `/api/mesh-internal/tmux/*`，远端只接受由 `acceptHttpStream` 标记的「来自可信 peer」请求（外部请求带该标记一律 403）。前端在 `/n/:id` 路由下 Agent 面板改用 self runtime 的 agent store/API 并带 `nodeId`。空状态文案改为「选择一个会话」。node 离线：self 侧停止该 node 的 run 并把 running/waiting 置 error；前端显示离线 banner、禁用输入，上线后恢复。
2. **路径选择器**：新 `GET /api/files/browse?deviceId&path&hidden`（只列子目录，不受 roots 白名单限制——登录用户本就能任意添加 root），本机/SSH 都支持，`/n/:id` 自动代理。前端在路径输入右侧加「浏览」按钮弹出目录选择器（面包屑 + 子目录列表 + 显示隐藏目录 + 选择当前目录）。
3. **链路徽标**：gateway `reach` 改为 `lan|wan|relay|null`（按对端地址是否私网判定），peer ping/pong 记录 `rttMs`，随 `/api/mesh/nodes` 与 node 事件下发；前端合并为一枚徽标：直连(WebRTC) → 「直连 · Xms」，否则 reach 文案 + gateway RTT（「局域网 · 3ms」「公网 · 80ms」「经 Hub 中转 · 120ms」「不可达」）。
4. **设备卡片**：「侧栏显示」分组 + 「终端」「文件」两个开关；文件开关在设备无 roots 时禁用；新 ui store 键 `sidebarFilesVisibility`，默认 = 设备有 roots 即显示。文件侧栏按该开关 + node 在线 + 设备连接状态过滤（离线/断开自动消失）。三点菜单新增「文件」→ 弹窗内嵌 `FilesSettingsTab` 单设备模式。
5. **远程访问 Tab**（设置，位于「终端」右侧）：只配置 entry 自身；后端 `apps/gateway/src/tunnel/*` + `/api/tunnel/status|actions`（契约 `packages/shared/src/contracts/tunnel.ts`）；cloudflared 由 gateway 托管为子进程（自动重启、随 gateway 启动）；模式：quick（trycloudflare 临时地址）/ named（login → create → route dns → run）；binary 缺失时自动下载到数据目录；`TMEX_TRUST_PROXY` 经现有 env patch 能力写入并提示重启。前端向导分步卡片，复用 setup wizard 的 `SetupNotice/RestartPanel`。

## 分工（文件集互不重叠，agent 不 commit）

| id | 角色 | 范围 |
|---|---|---|
| G1 | cursor grok | 远程 Agent 后端：db/schema+migration、agent routes/supervisor/run/tools、mesh-internal tmux 路由与 peer 标记、node offline 传播 |
| G2 | cursor grok | 链路徽标后端：peer-manager reach/rtt、node-list-projection、mesh-routes 事件 |
| G3 | cursor grok | `/api/files/browse` |
| G4 | cursor grok | tunnel 后端 |
| O1 | opus | 远程 Agent 前端（stores/agent*、panels/agent、fe sidebar agent adapters、文案） |
| O2a | opus | 设备卡片两开关 + `sidebarFilesVisibility` + 文件侧栏过滤/离线消失 |
| O2b | opus | 路径选择器 + `FilesSettingsTab` 单设备模式 + `DeviceFilesModal` |
| O3 | opus | 徽标前端（mesh-nodes.ts、device-node-badges.tsx） |
| O4 | opus | 远程访问 Tab 前端 |

指挥官：契约（已写）、i18n 构建、分批 commit、审查（codex sol 三路）、实测（临时实例）、构建 + 本机上线。

## 验收

- 各包 test 全绿、tsc 错误数 ≤ 基线、biome 通过。
- 临时双实例（hub + node）实测：远程 pane 开 agent 能 read_screen/send_input；node 断开后 session 置 error、文件侧栏消失；徽标显示正确 reach + RTT；路径选择器在本机/远端设备可用；tunnel quick 模式能拿到 trycloudflare 地址。
- 构建 tarball 并 `upgrade --apply-current-package` 替换本机。

## 追加任务（第二批）与审查修复分工

| id | 角色 | 范围 |
|---|---|---|
| O5 | opus | O1 遗留：远端路由分屏 pane Agent 徽标、离线判定合并（已完成） |
| O6 | opus | i18n 全面扫描：未翻译串、pane→terminal/终端、agent→智能体、file→文件 |
| O7 | opus | 终端页头部：命令输入框展开/收起动画、左右上角图标 tooltip |
| explore-split-close | codex luna | 分栏视图关闭窗口后卡「连接设备」的根因探索 |
| G5 | grok | 审查修复（review-be-1 全部 6 项）：mesh-internal 路径规范化鉴权、0028 迁移保住子表、内部 RPC 自行 connect + 可等待 sendInput、supervisor/mesh 启停顺序、在线判定统一、paneId/historyLines 校验 |
| G6 | grok | 审查修复（review-be-2 1/2/4/5/6/7/8 + review-fe-2 1/3/4）：无登录禁止公网隧道（auth_required）、tunnelName 白名单与路径收敛、check job 终态、loginUrl 只在登录中返回并脱敏、quick publicUrl 清零、/n/:id 下 404、origin 跟随 bind host、mode≠off 拒绝 create、configuredTrustProxy |
| G7 | grok | 审查修复（review-be-2 3）：dropPeer 先提升备用链路再发 link info，避免瞬时 offline 误杀远端 agent |
| O8 | opus | 审查修复（review-fe-1 全部）：常驻 mesh 订阅、NODE_OFFLINE 残留不再禁用侧栏、缺行三态、按 node 保存 activeSessionId/draft、浮层文案 |
| O9 | opus | 审查修复（review-fe-2 2–7）：check 等 job 终态、trustProxy 已保存/生效分离与伪造头提示、named 已配置只读、remove 二次确认、jobStep 全集、tunnelName 校验与 auth_required 提示 |

指挥官自行修复：SSH 目录浏览改 POSIX sh 循环（去 GNU find 依赖）、borsh NodeEvent v3（transport/rttMs）、facade 导出 browseDirectory、jobStep i18n 补键、智能体空态副标题。

审查判定不修：无。

## 实测记录（sub/live-r5.ts）
- run1–run4：`/n/:id/api/files/browse` 正常（home / 隐藏目录 / 相对路径 400）；伪造 `x-tmex-mesh-peer` 直连与经 /n/:id 均 403；未知 node 404、离线 node 503；reach 初始 null（hub presence 在线）→ 20s 后 `relay` + rttMs；tunnel status 需登录（401）、quick 模式拿到 trycloudflare 地址、坏主机名 400。
- 踩坑：seed 的本机设备 `session` 字段固定为 `tmex`——隔离 socket 上要建同名 session；REST `/api/tmux/tree` 在无 WS 订阅者时 session 为 null（既有行为），harness 改为直接从 `tmux list-panes` 取 pane id；远端 create 需先配置默认模型（mock LLM）。

## 第三批：Cloudflare Access 与系统级隧道发现（用户追加）

用户拍板：Access **可选**；保护层二选一——mesh 登录（用户名/密码/2FA，`loginEnforced`）或 Access（`configured && enforceJwt && hostname 匹配`）；两者皆无时不硬拦，但启动类动作必须显式带 `acknowledgeExposure=true`（否则 409 `exposure_ack_required`），UI 用强警告 + 勾选确认。本机已有 launchd `com.tmex.cloudflared`（token-file 方式、远端配置 ingress `tmex.konata.tv → 127.0.0.1:9883`），面板必须能探测并「接管」（`external` / `adopt_external` / `externallyManaged`），并可从 Cloudflare 同步已存在的 Access 应用（`sync_access`）。

| id | 角色 | 范围 |
|---|---|---|
| G8 | grok | Access API 客户端（app/policy/org）、凭证加密存储、JWT 校验守卫（cf-connecting-ip 请求）、exposure 门禁、系统级 cloudflared 探测与接管、sync_access、迁移 0029 |
| O11 | opus | 远程访问 tab：Access 步骤（凭证/规则编辑/状态/强制开关/移除）、未受保护强警告与确认勾选、外部隧道发现卡片与接管、Access 同步 |

指挥官：设备编辑弹窗 `sm:max-w-2xl` + 视口内滚动（未能复现溢出，按稳健方案处理）；Hub 显示名回落设置页站点名称；live-r5 run5 验证远端 agent 全链路（hub 建 session → mock LLM → send_input 经 mesh 到远端 pane → tool 结果回传）。

## 第三批：Cloudflare Access 与系统级隧道发现（用户追加）

用户拍板：Access **可选**；保护层二选一——mesh 登录（用户名/密码/2FA，`loginEnforced`）或 Access（`configured && enforceJwt && hostname 匹配`）；两者皆无时不硬拦，但启动类动作必须显式带 `acknowledgeExposure=true`（否则 409 `exposure_ack_required`），UI 用强警告 + 勾选确认。本机已有 launchd `com.tmex.cloudflared`（token-file 方式、远端配置 ingress `tmex.konata.tv → 127.0.0.1:9883`），面板必须能探测并「接管」（`external` / `adopt_external` / `externallyManaged`），并可从 Cloudflare 同步已存在的 Access 应用（`sync_access`）。

| id | 角色 | 范围 |
|---|---|---|
| G8 | grok | Access API 客户端、凭证加密存储、JWT 校验守卫、exposure 门禁、系统级 cloudflared 探测与接管、sync_access、迁移 |
| O11 | opus | 远程访问 tab：Access 步骤、未受保护强警告与确认勾选、外部隧道发现卡片与接管、Access 同步 |
| O12 | opus | 侧栏默认不显示其他节点（仅当该节点有设备打开「侧栏显示」才出现），登录入口在管理设备 |

指挥官：设备编辑弹窗 `sm:max-w-2xl` + 视口内滚动（未能复现溢出，按稳健方案处理）；Hub 显示名回落设置页站点名称；live-r5 run5 验证远端 agent 全链路。
