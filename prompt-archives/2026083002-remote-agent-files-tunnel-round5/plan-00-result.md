# 第五轮执行结果

分支 `feat/round5-remote-agent-files`（worktree `../tmex-enhanced-wt-r5`），基于 main `52bb1007`（第四轮已快进合入 main 并 push）。按需求分三批推进：六项原始需求 → 五项追加（分栏关闭卡顿、i18n 梳理、命令框动画、图标 tooltip、文案）→ Cloudflare Access / 系统隧道发现 / 侧栏节点默认隐藏 / 设备弹窗。每批 codex 审查后再派修复（review-be-1/2/3、review-fe-1/2/3 共六份），判定不修的项为零。

## 落地清单

| 需求 | 落地 |
|---|---|
| 1 路径选择器 | `GET /api/files/browse`（本机 fs / SSH POSIX sh 循环，不依赖 GNU find）；路径输入右侧「浏览…」→ `DirectoryPickerModal`（面包屑、上一级、隐藏目录、键盘导航、选择此目录）；`/n/:id` 自动代理 |
| 2 远端 agent | `agent_sessions.node_id`（null=self）；session 由 entry 网关持有并跑 LLM，pane I/O 走 `/api/mesh-internal/tmux/*`（仅 `acceptHttpStream` 打的 peer 标记可进，路径先规范化再判定；RemotePaneRuntime 自行 connect、sendInput 可等待）；node 离线 → 停 run 置 `NODE_OFFLINE`，supervisor 与 mesh 启停顺序修正；前端 agent store 统一读 self runtime，activeSession/draft 按 node 分片，`/n/:id` 路由匹配，离线横幅；空态「选择一个会话」 |
| 3 链路徽标 | reach 按对端地址分 lan/wan/relay + peer ping RTT，borsh NodeEvent v3（transport/rttMs，三代解码回退）；failover 先提升备用链路再发一次 link info；前端合并为一枚「直连/局域网/公网/经 Hub 中转 · Xms」 |
| 4 设备卡片 | 「侧栏显示：终端 / 文件」双开关（文件无 roots 禁用，配好默认开）；三点菜单「文件」→ 单设备 `DeviceFilesModal`；`sidebarFilesVisibility` 持久化 |
| 5 断线状态 | 文件侧栏按开关 + 设备连接 + node 在线过滤，离线只留「节点离线」；agent 离线横幅、侧栏灰显；常驻 mesh 订阅、缺行三态 |
| 6 远程访问 tab | `apps/gateway/src/tunnel/*` + `/api/tunnel/*`：cloudflared 安装/登录/创建/临时隧道/进程监督/日志脱敏/check；Cloudflare Access（凭证加密、tmex-allow 策略、hub/api 机器路径 bypass 应用、JWT 守卫在每个入口最外层）；未受保护启动需 `acknowledgeExposure`；系统级隧道探测（launchd/systemd/进程/config，本机 `com.tmex.cloudflared` 已实测识别出 `tmex.konata.tv`）与接管；前端向导动态步骤 + 状态卡 + Access 步骤 + 暴露警示/确认 + 外部隧道接管卡 |
| 追加 1 分栏关闭卡顿 | 根因：URL 指向已杀 pane + 2.5s 选择宽限；修：关闭前先回落路由、快照确认消失不再挂载、取消 select 事务、非焦点 pane 关闭不被捕获阶段先导航 |
| 追加 2 i18n | 147 键 pane→终端/terminal、agent→智能体、补未翻译串与组件硬编码字符串 |
| 追加 3/4 | 命令输入框 grid 0fr→1fr 展开/收起动画（Esc、自动聚焦）；左右上角/侧栏头部/文件页/设备页图标 IconTooltip + aria-label |
| 追加 5 | 智能体空态副标题去「开始」 |
| 追加 侧栏 | 其他节点默认不进侧栏，仅当该节点有设备打开「侧栏显示」才出现；登录入口在管理设备 |
| 追加 设备弹窗 | 未能在 1280×800 / 390×700 / 1280×480 复现溢出（无元素越界）；按稳健方案改 `sm:max-w-2xl` + 视口内滚动（设备编辑 / 设备目录弹窗） |
| 附带 | Hub 显示名优先回落设置页站点名称；tunnel 文案与契约同步 |

## 实测（`sub/live-r5.ts`，hub+node 双实例）
- run5：远端 pane 建 session（origin 经 mesh RPC 采集）→ mock LLM 在 hub 跑 → `send_input` 经 mesh 到远端 pane（`HELLO_FROM_HUB` 回显）→ tool 结果回传，`?nodeId=` 过滤正确；伪造 peer 标记两跳 403；未知 node 404、离线 503；reach=relay + rttMs；tunnel status 401/quick 模式拿到 trycloudflare 地址；bad hostname 400。
- 本机：`/api/tunnel/status` 探测到 launchd 隧道（tunnelId、hostname `tmex.konata.tv`、running）。
- e2e：split-close-pane（新）、agent-session（除既有失败 `enqueues further messages`，main 同样失败）、mesh 项目（需 `TMEX_MESH_E2E_BUILD_FE=1`）。

## 踩坑
- codex `-s read-only` 下要它写报告文件会失败，改为最终消息输出；unquoted heredoc 里的反引号会被 shell 执行。
- seed 本机设备 `session` 固定 `tmex`（隔离 socket 上建同名 session）；REST `/api/tmux/tree` 无 WS 订阅者时为 null。
- 生产源码模式跑临时实例时若后端 agent 正在改 supervisor.ts 会启动失败——实测要挑后端稳定窗口。

## 最终验证数字（`sub/final-tests.txt`）
gateway 2671/0（tsc 21=基线）、fe 866/0、panels 580/0、stores 321/0（tsc 1 既有）、shared 365/0、api-client 132/0（tsc 5 既有）、ui 47/0、terminal-ui 318/0、ws-client 262/0、app 415/0（build 后）。e2e：split-close-pane 3/3、agent-session 2/3（`enqueues further messages` 为 main 同样失败的既有项）、mesh 5/5。

## 上线
`bun run build` → `npm pack`（`tmex-cli-1.0.2.tgz`）→ 解包临时实例烟测（healthz / index 200 / `/api/tunnel/status` / 31 条迁移）→ `npx ./tmex-cli-1.0.2.tgz upgrade --apply-current-package --yes`（生产库三件套先只读拷到 scratchpad 兜底）。
