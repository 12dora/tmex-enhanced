# Opus 前端/测量 agent prompt 存档（O1/O2/O3/M1）

四个 Opus agent 以 Agent 工具（model: opus）启动，prompt 均以与 `G*-prompt.md` 相同的 Ground rules 开头（worktree、并行隔离、禁 git 写操作、禁触碰生产 tmex/默认 tmux socket、只跑单测、基线数字、biome、i18n 三语 + build:i18n、文案规范、结果文件路径）。任务正文摘要如下（完整措辞见指挥官会话）：

## O1 — 徽标改名 + 连接详情去「未知」 + 删除 jump-to-latest
- Owned: `apps/fe/src/node/{device-node-badges,mesh-nodes,direct-diagnostics}*`、`packages/api-client/src/auth/auth-api.ts` 类型、`packages/panels/src/device-console/{device-console-toolbar,use-device-console-actions,use-device-console-effects}*` 及测试、locale `nodes.reach/nodes.badge/nav.jumpToLatest`。
- 契约：`/api/mesh/nodes` 新增可选 `peerAddress/linkSinceAt/endpoints/directFailure`（G3 提供）；NODE_EVENT patch 不得清掉这些字段。
- 详情按承载分支：公共（到达路径/承载/RTT「测量中」/已连接时长）、relay（中继地址 + 未直连原因 ws/dc）、ws-secure（对端地址）、dc/浏览器直连（ICE 五行）。弹出时 `refreshMeshNodes()` 一次。
- 删除 toolbar `jump-to-latest`（快捷键 `scrollToBottom` 保留），文件页下载不动。

## O2 — 侧栏 Files 多节点 + 拖排
- Owned: `packages/panels/src/files/**`、`app-sidebar.tsx`、`packages/api-client/src/file-resources*`、locale `files.*`。
- app-sidebar 用 `useMeshNodes` + `sidebarNodeOrder` 算出分节，每节 `NodeRuntimeScope` 包 `FilesNodeSection`；节头显示节点名/在线态；远端未登录走 `useNodeLoginGate` 同款登录行；离线显示 `files.nodeOffline`；节内 roots 用各自 runtime 查询并经 `selectVisibleFileRoots` 过滤；保留 500 行上限。
- 拖排：分节复用 `sidebarNodeOrder`；节内 roots 乐观更新 + `reorderFileRoots(rootIds, client)` → `PUT /api/files/roots/order`（G1 提供）。

## O3 — 单 pane 视图热切换
- Owned: `packages/panels/src/device-console/terminal-stage*`、`use-pane-selection-dispatch*`、`use-pane-route-reconciliation*`、新建 keep-alive 文件、`packages/terminal-ui/src/components/**`、`packages/stores/src/{tmux-selection-actions,pane-subscriptions}*`。
- 最近 3 个 pane 保持挂载（同盒隐藏、cols/rows 一致、不发 resize 风暴），设备切换/卸载即清空，split 视图不受影响；热切换发 `select-pane wantHistory:false`、不 reset/重放；焦点与 `__tmexE2e*` 指向可见实例；字体已加载不 await；避免重复首次 resize；补单测与人工验证脚本。

## M1 — 切换延迟测量
- 只在 `sub/measure/` 与 scratch 下建文件；用 `git archive c850e077` 的基线源码 + 预构建 dist（`fe-dist-base`）起临时网关（端口 19765、tmux `-L tmex-r9-perf`），Playwright 驱动侧栏点击，≥12 次交替，测 t0→placeholder 消失/首个目标 marker 内容/首个实时输出（tmux send-keys nonce），并挂 WS 包装记录 SWITCH_ACK/TERM_HISTORY/LIVE_RESUME 时刻；输出 CSV + 中位数/p90；脚本可用 env 指向改后源码与新 dist 复跑。

## R1 — hub-ops 远程运维脚本（经 Hub API/WS，无需 ssh）
- 只在 scratch 与 `sub/hub-ops/` 建文件；登录复用 `packages/shared/src/auth`；子命令 nodes / devices / run（WS：HELLO → TMUX_SELECT（必须带 windowId）→ LIVE_RESUME 后发 TERM_INPUT，解析 TERM_OUTPUT 的 BEGIN/DONE 标记；`--new-window` 走 TMUX_CREATE_WINDOW 以免打扰远端正在跑的 agent pane）/ roots / root-add / upload（init → 顺序 PUT 分片 → NDJSON commit）。实测：Hub 1.0.2 `/root/tmex-hub/install`（root），jiefa-app 1.1.3 `/home/ubuntu/.local/share/tmex`；Hub 不通 github.com（objects.githubusercontent.com 通），jiefa-app 通 github.com。

## O4 — 终端光标在 TUI 中狂闪
- Owned：`packages/ghostty-terminal/src/**`、必要时 terminal-ui 的 focus/visibility 接线。三个假设：damage-driven 重绘与光标层/闪烁相位在每帧被清或重置；blur→focus 与 tab 切换/隐藏→可见路径重复启动闪烁定时器；应用高频移动光标被当作「闪烁重置为可见」。要求用假定时器写复现单测（20Hz 写字符+移光标 2s，光标绘制/清除切换次数 ≤ 闪烁节奏），找根因修复，覆盖首次聚焦、blur→focus、hidden→visible 三条路径。
