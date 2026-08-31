# 第九轮执行结果

日期：2026-08-31（至 09-01 凌晨）　分支 `feat/round9-relay-files-perf`（worktree `../tmex-enhanced-wt-r9`）　版本 1.1.4

## 分工与产物

| 角色 | 任务 | 产物 |
|---|---|---|
| codex luna（探索） | E1 徽标/下载键、E2 侧栏文件、E3 切换延迟、E4 直连、E5 key-log 同步、E6 升级安全 | `sub/e1..e6-explore.md` |
| cursor grok（后端） | G1 文件根排序 API、G2/G2b/G2c 切换屏障、G3/G3b/G3c 直连拨号与诊断、G5/G5b BIOS 式升级 | `sub/G*-prompt.md` / `sub/G*-result.md` |
| Opus（前端/测量/实测） | O1 徽标与详情、O2 侧栏文件多节点、O3 保活热切换（5 轮）、M1 切换延迟测量、V1 双实例实测 | `sub/O*-result.md`、`sub/M1-result.md` + `sub/measure/`、`sub/V1-result.md` + `sub/live/` |
| codex sol（审查） | A（G1/G2/O1）、B（O2）、C（G3）、D（O3）、E（G2b）、F/H（O3 复审）、G（G3b）、I（G5） | `sub/review-*.md` |

## 各任务结论

### 1. 终端右上角徽标与详情
- 「经 Hub 中转」→「中转」（en Relay / ja 中継），`transportRelay` 同步。
- 连接详情按链路种类渲染：公共行（到达路径/承载/延迟「测量中」/已连接时长）；中转链路显示中转地址 + 最近一次未直连原因（ws/dc）；ws-secure 显示对端地址；ICE 五行只在浏览器 WebRTC 直连时列出。实测（V1）浮层无「未知」。
- `/api/mesh/nodes` 新增 `peerAddress / linkSinceAt / endpoints / directFailure`（REST only）。
- 终端工具栏「下载」图标实为 jump-to-latest（滚到底部），已删除；文件页下载保留。

### 2. 侧栏文件多节点
- `FilesTab` 拆为外壳 + `FilesNodeSection` + `FilesNodeRoots`；`app-sidebar` 按 mesh 节点分节（self 在前，顺序复用 `sidebarNodeOrder`），节头显示节点名，远端未登录显示登录行，离线显示提示，每节挂该运行时的 settings-update 失效订阅。
- 节与节内目录可拖动排序；网关新增 `PUT /api/files/roots/order`。
- V1 实测：两节点分节名正确（`tmex` / `r9-remote-node`），远端根文件来自远端，重排 API 生效。

### 3. 终端切换延迟（属实，已深度调优）
- 根因：网关 `switch-barrier.ts` 在 TERM_HISTORY 后固定等 450ms 才发 LIVE_RESUME；单 pane 视图每次切换销毁并重建 Terminal（字体 await、Ghostty 实例、4 层 canvas、history 重放）。
- 改动：立即 LIVE_RESUME（DataChannel 承载用 `hasPendingWrites` 有界轮询代替 G2b 的 drain 回调设计，见 review E）；`wantHistory:false` 走 focusPane 不 capture；单 pane 视图保活最近 3 个 pane（`KeepAliveTerminalStack`，池归组件实例 + useLayoutEffect 发布，StrictMode 安全），warm select 不起事务不重放；缺口账本 `pane-stream-gaps.ts` 极其保守（设备断开/自动重连/网关 WS 掉线/快照删 pane 全部标缺口或丢隐藏实例）；字体缓存命中同步启动；首次 resize 去重。
- 测量（`sub/measure`，baseline2→after2）：单 pane 窗口 first_content 89.7→18.7ms、LIVE_RESUME 532.6→21.4ms、不再下发 history；分屏窗口 LIVE_RESUME 554→103ms（分屏不走保活）；同窗切 pane 不变。
- e2e：全量 97 pass / 7 fail / 1 skip；7 个失败中 5 个在 base 上同样失败（agent-session:404、settings-llm:42、ws-borsh-theme-resize:39、sidebar-resize:40、mobile-mouse-reporting:205），`terminal-selection-canvas:131` 与 `ws-borsh-switch-barrier:145` 是 spec 隐含假设被 450ms 移除戳破，已调整 spec（提交 `0a711e45`）。

### 4. 内网直连
- 代码层：ws-secure 并发拨号（同网段优先、赢家原子选出、输家与迟到 socket 关闭、接收端 keys 跟 session 走）、每次 dial 记录直连失败原因、`linkDetailOf` 纯内存。
- 环境事实：本机（192.168.3.x，Surge utun4）当前到 10.110.88.3/5 的 9883/39001 全部超时；历史 ICE 候选显示本机曾在 10.110.10.x；生产日志 RTC 只对 hub 节点拨号、只有 host 候选。
- **根因：本机 `node_certs` 只有 seq 2/3/4，`peer_cache` 停在 08-30，从未发出 `key.log.req from_seq=5`**——Hub（08-29 旧构建）没有把含新节点的 node.list 发给本机；main 上 `b095b237/8b575725/c279221e` 已修此类问题。**需要升级远端 Hub**（本机无 ssh key，需用户执行）。
- 结论：办公网（10.110.10.x）下可望 ws-secure（TCP 39001）直连；macOS Surge TUN 吞 UDP，dc 不现实。

### 5. 升级崩溃安全（追加需求）
- 评估（`docs/release/2026083101-upgrade-crash-safety.md`）：原流程原地 rm/copy、无 DB 备份、健康检查前写 meta、断电无自愈。
- 实现（G5 + G5b，分支 `feat/crash-safe-upgrade` 提交 `e7cc4ac7`）：`versions/<v>` + 原子 `current` + journal + 锁 + preflight + DB 三件套备份 + healthz version 校验 + 回滚 + `--repair` + GC + 旧布局迁移 + `--no-service` + 未知参数拒绝。scratch 演练 1.1.3→1.1.4 committed，人为破坏后 `--repair` → `rolled_back` 回到 1.1.3。
- review I 判定 9 个 blocker → G5b 修复；review J 复审仍列 7 个 blocker（repair 误删在飞 staging、legacy 转换过早删顶层目录、preflight 触发生产副作用、1.0.2 无 startedAt 回滚卡住、pid 所有权、sha256 404 fail-open、backup 阶段崩溃重复启动）。**决定：1.1.4 不带新升级器发布**（保留旧路径 + 未知参数拒绝 + healthz version），新升级器留在分支等下一轮加固与 launchd/systemd 双模式演练。

### 6. 终端光标狂闪（追加需求）
- 根因（O4，真实 wasm 探针实测）：应用一次重绘的字节分多个 write 到达，rAF 落在中途时光标位于「刚写完的字符后一格」，下一帧再挪回；ratatui 类每帧 `?25l/?25h` 表现为整帧熄灭/点亮。与闪烁定时器、焦点状态无关（`blinking` 默认 false）。
- 修复：光标层 `cursor-layer.ts` 引入落定语义，输出触发的帧只挂起、输出静默的下一帧落笔（250ms 兜底）；20Hz×2s 合成流落笔 78→0。遗留：`writeCanonicalSnapshot` 的 `terminal.reset()` 会把 DECTCEM 恢复为可见而 history 不带 `?25l`（隐藏光标的应用切回后出现幻影光标，需网关下发 `#{cursor_flag}`）。

### 7. 远程运维通道
- `sub/hub-ops/hub-ops.ts`：经 Hub HTTP/WS（浏览器同款协议）在 mesh 任意节点列设备、开临时 window 跑命令、上传文件。实测：Hub `s0522` 1.0.2 于 `/root/tmex-hub/install`（root，github.com 不通、objects.githubusercontent.com 通）；jiefa-app 1.1.3 于 `/home/ubuntu/.local/share/tmex`（github.com 通）；jiefa-app 7 个 pane 全被 codex/grok/top 占用，只能 `--new-window`。

## 事故记录
- 22:49 演练时误执行 `node bin/tmex.js upgrade --help`（新 CLI 不识别 `--help`，按默认安装目录跑了真实升级）：生产安装目录被 1.1.3 delegator 重装同版本并重启（healthz ok，数据未变），遗留 `~/Library/Application Support/tmex/staging/1a0584b963d-6ef05fbe`（58MB）。G5b 已被要求加未知 flag 拒绝；后续 `--repair`/升级会清掉该目录。

## 提交
`4ee1152c` files 多节点 → `06f0a6b2` 徽标/详情 → `de145abf` 切换性能 → `310af64f` 保活收口 → `96ba9a92` mesh 直连 → `0a711e45` e2e spec →（G5b 后）升级安全 + 文档/档案/版本。

## 遗留 / 需用户决定
- 升级远端 Hub 到 1.1.4（否则本机永远学不到新节点，直连无从谈起）。
- `SelectionToolbar` 覆盖终端顶部居中区域吞点击（O3 发现的既有 UX 问题）。
- `node-login-<id>` testid 在设备页与侧栏 Files 分节重复（V1 O5），mesh e2e helper 需按容器收窄。
