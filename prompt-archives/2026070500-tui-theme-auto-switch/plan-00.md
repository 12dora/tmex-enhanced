# TUI 亮暗主题自动切换：可行性实测（spike）计划

## Context

tmex 前端切换颜色模式后，pane 内**正在运行**的 TUI（Claude Code / codex / opencode / oh-my-pi）不会跟随。前序研究（`prompt-archives/2026070500-tui-theme-auto-switch/research-00/01.md`）确认：Claude Code(theme=auto)/opencode/omp 订阅 mode 2031 并处理 `CSI ?997;1|2n`（后两者收 997 后重查 OSC 10/11）；codex 只在启动和 FocusGained（mode 1004）时重查。tmex 有现成注入通道（`send-keys -H`，ASCII 保真）与 `%output` 字节级解析基础设施。历史事故（无守卫广播注入污染 idle shell）是边界处理问题，非路线不可行。

用户已定边界：(1) 只做 gateway 注入路线，但不能与 tmux 3.6+ 原生机制冲突；(2) **tmux <3.3（3.2a）也要完整兼容**——gateway 自己解决 OSC 10/11 应答；(3) 兼容 mode 1004（focus 注入救 codex）；(4) **禁用 pane_current_command 黑/白名单**——守卫只能基于输出流中 mode 订阅的精确跟踪；(5) 关键行为全部实测，用现有容器工具测好典型环境。

本轮新发现的两个设计约束（来自代码审查）：

- **focus 注入铁律 `1004 ∧ ¬2031`**：tmex 有两处既有工程动作（全局 `focus-events off`，`local-external-connection.ts:605-614`；parking window，`:721-744`）专防 `ESC[I` 落进 Claude Code（它会判定"用户在场"→通知永久静默）。Claude Code 同时订阅 1004 和 2031，无条件对 1004 订阅者注 focus 会精确复现该事故。
- **逻辑挂载点必须是 `control-mode-subscription.ts`**（local/ssh 两条 connection 共享的 per-pane parser 创建处），挂在 connection 层会漏掉 SSH 设备。

本计划 = 实测方案（本次执行）+ 实现框架草案（实测后按结果定稿，另出实现 plan）。**本次不改产品代码**。

## 实测环境

- **容器**（Apple `container` CLI 1.0.0，daemon 已运行）：ubuntu:22.04→tmux 3.2a、debian:12→3.3a、ubuntu:24.04→3.4、debian:13→3.5a、alpine:3.24→3.6b、alpine:edge→3.7b（全 arm64 官方镜像）。容器名前缀 `tmex-spike-*`，避开在跑的 `nk-*` 容器，结束后清理。
- **本机多版本 tmux（阶段 1.5）**：源码构建 3.2a / 3.6b 或 3.7b 到 scratchpad（brew 提供 libevent/ncurses），加系统 3.4，供真 TUI 交叉实测；全部用独立 socket `-L spike-<ver>`。
- **真 TUI**：本机已装四家。Claude Code 用 `CLAUDE_CONFIG_DIR` 隔离 + theme=auto；四 TUI 尽量用独立 `HOME=$SCRATCH/home-<tui>` 隔离，用户真实配置只读。
- 红线：严禁触碰名为 `tmex` 的 session、默认 socket、9883 生产服务、用户真实配置文件。脚本硬编码防呆：socket 名为空或 session 名为 tmex 时拒绝运行。

## 阶段 0：pilot（半小时级，最早暴露工程风险）

Apple container 1.0.0 的 `exec -d`/stdin 语义是全链路最不可信环节：起一个容器跑通"装 tmux → 起 session → control mode 观察者落盘 → send-keys 注字节 → 读日志"最小闭环，再铺开矩阵。

## 阶段 1：容器 × tmux 版本行为矩阵（受控 fake TUI，不跑真 TUI）

方法（镜像生产架构，结论可直接迁移）：

- 观察者：`container exec -d <c> sh -c 'tail -f /dev/null | tmux -L spike -C attach -t t >/log/cm.log'`（`tail -f` 恒开 stdin，防 tmux -C 在 EOF 退出——tmex 代码里就有此陷阱注释）。观察者纯只读，所有 tmux 命令走独立一次性 `tmux -L spike <cmd>` 进程。
- fake TUI：python3 脚本，`--emit-hex` 启动即发序列，raw 模式无回显、stdin 逐字节"时间戳+hex"落盘，命令 FIFO 支持中途再发（多步测试用）。T6 换真 bash/zsh。
- 断言：bun 脚本 **直接 import 生产的 `control-mode-parser.ts`** 解码 cm.log（顺带验证生产解码路径对这些序列的还原度）；输出 `测试项|版本|PASS/FAIL|observed hex` 行，聚合成矩阵。等待策略一律"轮询模式匹配 + 5s 死线"，禁固定 sleep。
- 脚本进 `scripts/spike-theme/`（可复现），日志进 scratchpad。

**测试顺序：T1/T2 是闸门，先在全部 6 版本跑完**，结果决定后续分支哪些还需要测。

| # | 测试项 | 判定标准 |
|---|---|---|
| T1 | pane 发 `?2031h` / **`?1004h/l`** / 多参数 `?1004;2031h`，加对照组 `?2004h`、`?1049h` → `%output` 可见性 | 解码后逐字节命中即 PASS，每 mode × 每版本单独记录。3.6+ 消费 2031 后是否透出是整条路线命门；1004 各版本都消费，更可能被吞。旁证：tmux 消费 OSC 133 但 tmex prompt-marker 仍工作，"消费≠不透传"有先例，仍须逐版本验证 |
| T2 | pane 发 `]10;?` / `]11;?`（BEL/ST 两种终止）/ **`?996n`** → **两列独立观测量**：查询是否透出 %output；tmux 是否代答 | window-style 设/不设 × 版本全组合。四种组合对应不同实现分支（见决策树）。tmux 代答的**应答字节逐字节存档**（终止符跟随查询与否、rgb 位宽），gateway 代答须逐字节模仿；与 `getOsc11ResponseColor`（`appearance.ts:90`）比对 |
| T3 | `send-keys -H` 注入 `?997;1n` → pane 收到字节完整性 | fake TUI stdin 日志与注入 hex 逐字节相等（各版本，3.2a 重点验 send-keys -H 存在性） |
| T4 | 注入 OSC 11 应答（ST/BEL 两种）→ pane 收到什么 | 逐字节相等**且恰好一份**（防输入方向篡改/复制） |
| T5 | 注入 `ESC[O` `ESC[I` → pane 收到什么 | focus-events on/off × 版本；逐字节收到且 cm.log 无 tmux 额外反弹事件 |
| T6 | **污染签名采集**：bash/zsh 默认配置 × 注入 997 / focus / OSC 应答 | `capture-pane -p` 注入前后 diff，归一化为可 grep 签名（供实现阶段"污染检测器"用，不只是记录） |
| T7 | 3.6b/3.7b 原生行为专项：(a) 订阅 2031 时是否立即回发 997（3.6 vs 3.7 差异）；(b) `tmux show -s theme` 是否存在（3.7b 可能已含 master 的 theme option，实测定）；(c) **window-style 变化是否触发原生 997（双发冲突核心判定）**；(d) control mode client 哪些既有动作会无意触发原生 997；(e) 是否有 format 变量可读出 pane 的 2031 订阅状态（≥3.6 重启恢复可直接问 tmux） | (a)(c)(d)：动作后 2s 内 fake TUI stdin 是否出现 997；(b)(e)：命令退出码与输出存档 |
| T8 | DECRQM `?2031$p` / `?1004$p` 各版本应答；不应答时查询是否透出 %output | 应答字节（`?2031;<v>$y`）或"无应答+透出与否"存档——opencode 靠它探测分支 |
| T9 | **pane 用户选项持久化可用性**：`set-option -p @tmex_2031 on` / `show-options -p -v` / `list-panes -F '#{@tmex_2031}'` | 6 版本行为一致、pane kill 后选项消失 → 订阅状态持久化方案成立（优于 DB：与 pane 同生共死、SSH 状态存远端、一条 list-panes 全量恢复） |
| T10 | control mode `%pause` 期间 pane 输出是否丢弃（`refresh-client -f pause-after` 制造） | %continue 后 pause 期间的标记序列是否在 cm.log——决定订阅漏记风险等级 |
| T11 | DCS passthrough 包裹序列（`ESC Ptmux; ...`）的 %output 可见性 × `allow-passthrough` on/off | opencode 用 passthrough 探测；tmex parser 会解包重处理（`pane-stream-parser.ts:215`），须定 ModeTracker 对解包内容记/不记/单独打标 |

## 阶段 2：真 TUI 行为实测（本机，{3.2a, 3.4, 3.7b} 三档交叉）

前提修正：TUI 行为是 `f(tmux 应答)` 不是常量（opencode 按 DECRQM 应答分支），所以 U2–U5 在三档 tmux 上跑，<3.3 分支必须接触真 TUI。

| # | 测试项 | 判定标准 |
|---|---|---|
| U1 | 四 TUI **全生命周期序列采集**（python pty 双向 tee + 时间戳）：启动（TERM 变体 × TMUX 环境变量设/不设）、干净退出、Ctrl-C、Ctrl-Z 挂起/fg 恢复、kill -9 | 记录：mode 置位是否多参合并；是否发 ?996n；DECRQM 探测及无应答降级路径；**OSC 查询等待超时时长**（SSH 代答时延预算）；**退出/挂起是否发 l 清位**（守卫生命周期另一半）。逐 TUI 归档"序列档案" |
| U2 | tmux 内注入 997 → 各 TUI 换肤 | 注入后 2s 内 `capture-pane -e` SGR 背景变化 + %output 见重查序列；三档 tmux |
| U3 | <3.3 关键：盲 push OSC 10/11 应答（不等查询）接受性；**"997 后立即预置应答"变体**（省 RTT，SSH 质变）；重查无应答时 opencode/omp 的行为（回退/卡住/超时时长） | 换肤成功 × push 延迟档位（0/50/200/1000ms）矩阵 |
| U4 | codex focus cycle：`I` 单发 / `O,I` / 结尾留不留 focused 态；重查后配合盲 push 能否闭环换肤；**结尾 focused 态的副作用评估**（对照 parking window 所防事故） | codex UI 变化 + PTY 日志中 FocusGained 后重查序列 |
| U5 | 重复 997 幂等 + **200ms 内 dark→light→dark 快速交替** | 末态颜色正确、无重查风暴闪烁 |
| U6 | claude theme 固定 dark（非 auto）收 997 | 无操作、无崩溃——"注入不区分 TUI"的安全性验证 |
| U7 | TUI Ctrl-Z 挂起后立即注 997（守卫失效最危险场景） | shell 污染形态与 T6 签名一致性——验证污染检测器可行性 |
| F1 | 前端 `ghostty-terminal` 收到 OSC 10/11 查询 / DECRQM / ?996n 是否经 onData 自动应答 | headless 模式单测：feed 查询字节断言 onData 零触发（若自动应答，N 个标签 N 份应答会搅乱代答设计） |

Claude Code 换肤验证若隔离配置停在 onboarding 不足以判定：先测 onboarding 界面主题响应，仍不足再向用户申请凭证方案。

## 实现框架草案（实测后定稿，另出实现 plan）

```
%output → pane-stream-parser（新增 CSI 收集态：旁路观察 + 原样回填 output）
              │ 识别 ?2031h/l、?1004h/l（预留任意私有 mode）、OSC 10/11 查询、?996n
              ▼
        control-mode-subscription.ts 挂 onPaneMode/onColorQuery 回调（local/ssh 共享层）
              ▼
   ┌── OscColorResponder（常驻反应式，仅 <3.3 档启用）：代答 ]10;?/]11;?/?996n
   │      —— 同时解决 <3.3 上 TUI 启动初始检测（守卫天然自洽：只答刚查询者）
   └── ThemeNotifier（主题变化事件驱动，复活 signalThemeChange 调用链）：
          1. await window-style 全部落盘
          2. 对 2031 订阅 pane 注 997（997-on-subscribe：<3.6 档观察到新订阅即回发当前主题）
          3. <3.3 且 U3 证实：紧跟预置 push OSC 10/11 应答
          4. 对 1004 ∧ ¬2031 订阅 pane 注 focus 序列（形态由 U4 定）
```

- 持久化：tmux pane 用户选项 `@tmex_2031`/`@tmex_1004`（T9 验证通过为前提），重启恢复 = 一条 `list-panes -F`；恢复态标记 `restored`，首次注入后污染检测（比对 T6 签名，命中即清位+告警）。
- 清位信号全集：`?2031l`/`?1004l`、RIS、DECSTR、**OSC 133;A 提示符标记**（tmex 已解析——提示符出现即前台回到 shell，清全部 mode 状态）。
- 注入走 connection 现有 `sendInput` 序列化链（不另开旁路）；设备级 latest-wins 合并队列防主题快速切换乱序。
- 安全网：env kill switch（事故史区域，必配）。
- `tmux-version.ts` 改能力位：`{ oscProxy: ≥3.3, native2031: ≥3.6, themeOption: T7b 实测 }`；≥3.6 档若 T7(c) 证实 window-style 已触发原生 997，则 gateway 不注 997 防双发。
- <3.3 决策树：T2"查询透出"→ 反应式代答为主；"查询被吞"→ 只剩订阅触发的盲 push，opencode/omp 初始检测无解（除非 996 透出），文档分档。若 T1 显示 ≥3.6 吞掉 2031h → 该档守卫失明，退化方案（单条 `set -s theme` 防冲突命令）届时单独向用户确认。

## 执行顺序

1. **先存档**：本轮 prompt 追加 `prompt-archives/2026070500-tui-theme-auto-switch/plan-prompt.md`；本计划存 `plan-00.md`。
2. 阶段 0 pilot → 阶段 1 容器矩阵（T1/T2 闸门先行）→ 阶段 1.5 本机多版本 tmux 构建 → 阶段 2 真 TUI（U1 先行，其余按闸门结果裁剪）。
3. 汇总行为矩阵存档 `research-02-live-behavior-matrix.md`（含全部 observed hex，结论可复核），向用户汇报可行性定论 + 实现方案定稿建议。

## 风险清单（按"实测后仍可能翻车"排序）

1. TUI 版本漂移（高频更新的二进制，实测结论是快照非契约）→ 序列档案入库 + kill switch + 污染检测器把翻车代价压到"功能失效"而非"屏幕污染"。
2. 崩溃/挂起残留订阅态 → 注入进 shell：清位信号 + 污染检测器降概率，无法归零（tmux 3.6 原生实现同样存在，协议固有）。
3. 发行版补丁版本行为偏离原版矩阵（RHEL/Ubuntu 补丁不可证伪）→ 能力判定保守 + 日志充分。
4. SSH 高延迟下反应式代答超时 → 预置 push 省 RTT + U1 超时数据做预算校验。
5. 1004-only 非 codex 程序被假 focus 波及（vim autocmd 等，禁名单无法定向豁免）→ 整体评估后接受或 focus 注入做成默认关的选项。
6. Apple container CLI 1.0.0 工程性坑 → pilot 前置，只影响进度不影响结论。

## 清理

实测后：删除 `tmex-spike-*` 容器、`tmux -L spike-* kill-server`、删临时 HOME/CLAUDE_CONFIG_DIR；scratchpad 日志保留至存档完成。
