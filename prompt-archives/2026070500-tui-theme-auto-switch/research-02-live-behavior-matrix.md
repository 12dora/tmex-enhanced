# 实测行为矩阵：tmux 六版本 × 四 TUI（spike 结果）

按 plan-00 执行的全量实测结论。测试脚本随 worktree `theme-spike` 归档于 `scripts/spike-theme/`（spike-up.sh 容器编排、test-runner.sh 容器内 T1-T11 采集、spike-assert.ts 宿主断言（复用生产 `unescapeControlModeData` 解码）、pty-harness.py PTY 直连采集、u2-inject.sh tmux 内注入、analyze-tui.py / sgr-window.py 分析器）。原始日志（全部 observed hex）在会话 scratchpad `spike-logs/`、`tui-profiles/`、`u2/`。

## 实测环境

- 容器（Apple `container` CLI 1.0.0）：ubuntu:22.04→**3.2a**、debian:12→**3.3a**、ubuntu:24.04→**3.4**、debian:13→**3.5a**、alpine:3.24→**3.6b**。alpine:edge 因 VM 内核过旧（musl `renameat2` 缺失）不可用，**3.7b 改为本机源码构建**（同 3.2a，brew libevent/ncurses，`build-tmux.sh`）跑同一套 runner。
- 真 TUI：claude 2.1.201 / codex 0.142.5 / opencode 1.17.13 / omp 16.3.6，PTY 直连（python pty）+ 独立 socket tmux 内两种方式；配置隔离（HOME / CLAUDE_CONFIG_DIR），登录态验证经用户批准复制真实配置副本完成后**已删除**。

## 阶段 1：tmux 版本行为矩阵（受控 fake TUI）

| # | 结论 | 3.2a | 3.3a | 3.4 | 3.5a | 3.6b | 3.7b |
|---|---|---|---|---|---|---|---|
| T1 | pane 的 `?2031h/l`、`?1004h/l`、多参数、`?2004h`、`?1049h` 在 `%output` **全部透出** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T2a | OSC 10/11 查询与 `?996n` 在 %output 透出 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T2b | OSC 10/11 代答（**设 window-style 后**） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T2c | OSC 10/11 代答（无 window-style） | ✗ | ✗ | ✓(纯黑) | ✓(纯黑) | ✓(纯黑) | ✓(纯黑) |
| T2d | `?996n` 应答 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| T3 | `send-keys -H` 注入 997 逐字节完整 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T4 | 注入 OSC 11 应答（ST/BEL）完整且恰好一份 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T5 | 注入 focus 序列完整（focus-events on/off 均不拦截） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T6 | idle shell 注入 997 / OSC 应答 → **污染**；注入 focus → **无污染** | 全版本一致（bash/zsh） | | | | | |
| T7a | 订阅 2031 即回发当前主题 997 | — | — | — | — | ✓ | ✗（theme 未知/未变不发） |
| T7b | `set -s theme` 存在 | ✗ | ✗ | ✗ | ✗ | **✗** | **✗**（master 未发版） |
| T7c | **window-style 变化触发原生 997** | — | — | — | — | ✓ | ✓ |
| T7e | 订阅状态 format 变量 | 无 | 无 | 无 | 无 | 无 | 无 |
| T8 | DECRQM `?2031$p`/`?1004$p` 应答 | ✗(透出) | ✗(透出) | ✗(透出) | ✗(透出) | ✓ | ✓ |
| T9 | pane 用户选项 `@tmex_2031` set/show/list、pane 亡则消 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T10 | 背压 pause 模式下输出不丢（改发 `%extended-output`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| T11 | DCS `Ptmux;` 包裹序列原样透出（含内嵌 `\e\e[?2031h` 形态） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

细节：代答的终止符跟随查询（BEL→BEL、ST→ST）；rgb 位宽 3.2a 为 2 位/通道（`rgb:26/26/26`）、3.3+ 为 4 位（`rgb:2626/2626/2626`），TUI 解析正则均为 `{1,4}` 兼容。T5 例外：3.2a/3.3a 在 focus-events on 且 pane 订阅 1004 时 `\e[I` 到达 2 份（tmex 默认 off 不受影响）。

## 阶段 2：真 TUI 行为

**U1 订阅/查询/生命周期档案**（PTY 直连；TERM=xterm-256color 与 TERM=tmux-256color+TMUX 环境变量行为**一致**）：

| | ?2031h | ?1004h | OSC 10/11 查询 | DECRQM 探测 | 干净退出清位 | 挂起(SIGTSTP)清位 |
|---|---|---|---|---|---|---|
| claude | ✓ | ✓ | 仅 theme=auto 时查 OSC11（2s 超时重试一次） | ✗ | ✓（2031l+1004l） | 未测 |
| codex | ✗ | ✓ | ✓（10+11） | ✗ | ✗（SIGTERM 无清位） | — |
| opencode | ✓ | ✗ | ✓（10+11） | ✓（DCS 包裹，非 tmux 环境也发） | ✓（2031l+1049l） | **✗（不发 2031l）** |
| omp | ✓ | ✗ | ✓（11） | ✓ | ✓（2031l） | 未测 |

**U2 换肤实证**（时序：先改 window-style 再注 997）：

- **claude（theme=auto，登录态主界面）**：997;2n → 文字色切亮底配色（246→241、211→131），997;1n 切回。双向 PASS。
- **opencode**：PTY 直连与 tmux 3.2a / 3.7b 内均完整换肤（bg 10;10;10 → 255;255;255）。PASS。
- **omp**：997 → 重查 OSC 11 →（window-style 代答亮色）→ 切 light 槽位（文字 156;163;176 → 108;108;108），连 setup 界面都响应。PASS。
- **codex（登录态）**：997 与 focus cycle 均无反应（diff 仅 spinner 噪声）。**focus 救 codex 不成立**（0.142.5，未登录与登录态一致），codex 定性为"重启后拾取新色"。

**其余**：

- U3：opencode 接受 997 后 100ms 的盲 push 应答；**omp 不接受乱序盲 push**，依赖真实代答（window-style）→ 实现不做盲 push，统一走 tmux 代答。
- U5：重复同值 997 **幂等**（仅 32 字节输出、不重绘）；200ms 内 dark→light→dark 快速交替末态正确（有过程闪烁，实现用 latest-wins 合并规避）。
- U6：claude theme 固定 dark 时收 997 无操作、无崩溃 → 无差别注入对配置固定的用户安全。
- U7：opencode 挂起不清位（见 U1）→ 挂起回 shell 后注入会命中 T6 的 997 污染签名，**必须用 OSC 133;A prompt-marker 清位兜底**（tmex 已解析该标记）。
- F1：ghostty-terminal 无"解析→回写"通道（onData 仅交互触发，静态+运行时验证），查询/通知/应答序列 feed 进渲染流**零残渣**。多标签多应答风险不存在。
- 时序铁律反例实证：先注 997 后改 window-style → opencode 重查拿回旧色、正确拒绝切换（屏幕不变）。

## 对前两轮调研的修正

1. "OSC 11 代答需要 tmux ≥3.3" **错**——3.2a 设 window-style 即代答。`<3.3 完整兼容`的主要障碍不存在，反应式 OSC 代答模块（OscColorResponder）不需要。
2. "codex FocusGained 重查颜色" 在 0.142.5 **不成立**（网络调研引用的 repo HEAD 行为）→ focus 注入通道整体砍掉（唯一受益者无效；claude 被 `¬2031` 排除；opencode/omp 不订阅 1004）。1004 订阅跟踪保留（未来 codex 版本可能恢复重查）。
3. "3.7b 可能已含 `set -s theme`" **否**——3.6b/3.7b 均 invalid option。
4. T10 的漏记担忧不成立：pause 模式改发 `%extended-output`，数据完整（tmex 生产 parser 已支持该形态）。
5. claude 仅在 theme=auto 时查询 OSC 11；非 auto 不查询但仍订阅 2031/1004。

## 实现方案定稿要点

1. **pane-stream-parser 加 CSI 收集态**（旁路观察+原样回填）：只识别 `?2031h/l`（含多参数形态如 `?1004;2031h`）；DCS `Ptmux;` 解包内容单独打标不入订阅状态（T11）。
2. **订阅状态**：内存 Map + tmux pane 用户选项 `@tmex_2031` 持久化（T9 全版本可用）；gateway 重启后 `list-panes -F` 恢复。清位信号：`?2031l`、RIS、DECSTR、**OSC 133;A prompt-marker**（关键兜底，U7）、pane 退出。
3. **ThemeNotifier**（复活 signalThemeChange 调用链）：主题切换 → **await window-style 全部更新完成** → 对 2031 订阅 pane 注入 `\x1b[?997;{1|2}n`。版本无关统一注入：≥3.6 上 window-style 变化会触发原生 997（T7c）造成同值双发，U5 幂等实证无害，不做版本 gate 换取实现简单。设备级 latest-wins 合并队列。
4. **不做**：focus 注入与 mode 1004 跟踪（U4 证实无消费者，2026-07-05 用户决策：不保留；未来 codex 恢复 focus 重查时再按 CSI 收集态的既有扩展点补回）、OSC 10/11 反应式代答（T2b）、盲 push 应答（U3 omp）、996/DECRQM 代答（无消费者，YAGNI）。
5. **安全网**：env kill switch；注入走现有 `sendInput` 序列化链。
6. codex 文档如实说明"切主题后需重启 TUI 生效"（新启动经 window-style 代答拿到正确亮暗，T2b 全版本成立）。

## 残余风险（不变，见 plan-00 风险清单）

TUI 版本漂移（本结论为 2026-07-05 版本快照）；崩溃/强杀残留订阅态（prompt-marker 兜底降概率、无法归零，tmux 3.6 原生实现同样存在）；发行版补丁版本行为未证伪。
