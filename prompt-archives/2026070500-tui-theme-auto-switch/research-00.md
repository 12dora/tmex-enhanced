# 运行中 TUI 自动切换亮暗主题——可行性研究与方案

## 背景

tmex 前端切换颜色模式（`c798142` 已实现端到端主题广播：DB 单一真源 + WS `KIND_SITE_THEME_UPDATE` 广播 + 前端 `ghostty-terminal` 全量热更新 bg/fg/光标/16 色 palette + gateway 同步 tmux `window-style`）后，**正在运行**的 TUI（Claude Code、codex、opencode、oh-my-pi）不会跟随切换亮暗主题。现有链路只覆盖"其后新启动"的 TUI（tmux ≥3.3/3.4 用 window-style 的 bg 原生代答 OSC 11 查询）。

上一轮 spike 的历史结论（`prompt-archives/2026070402-selection-theme-propagation/plan-00.md`）：

- 三大 agent 收到 SIGWINCH 均不重查背景色，SIGWINCH 路线已排除；
- 曾实现向 pane 注入 `ESC[?997;2n` 的 `signalThemeChange`，因无守卫广播、idle shell 把 "997;2n" 回显到命令行而移除，现为 no-op（`local-external-connection.ts:526`、`ssh-external-connection.ts:187`），调用方 `broadcastThemeChange`（`ws/index.ts:1039`）仍连着。

## 核心结论：可行

四个目标 TUI 中三个（Claude Code、opencode、oh-my-pi）完整实现了同一个事实标准协议：**DEC private mode 2031 主题通知**（contour 规范，https://contour-terminal.org/vt-extensions/color-palette-update-notifications/ ）：

| 序列 | 方向 | 含义 |
|---|---|---|
| `CSI ? 2031 h` / `l` | 应用→终端 | 订阅/退订主题变化通知 |
| `CSI ? 996 n` | 应用→终端 | 主动查询当前主题 |
| `CSI ? 997 ; 1 n` | 终端→应用 | 当前/变为 dark |
| `CSI ? 997 ; 2 n` | 终端→应用 | 当前/变为 light |

只要把"终端侧"（对 pane 内程序而言即 tmux + tmex）的这半边协议补齐，三家即可运行中自动热切换。

### 各 TUI 实测证据（本机二进制取证 + 上游源码/文档交叉验证）

| 工具 | 版本 | 初始检测 | 2031/997 热切换 | 颜色输出 | 备注 |
|---|---|---|---|---|---|
| Claude Code | 2.1.201 | 997 上报 → OSC 11 → COLORFGBG → 默认 dark | ✅（theme=`auto` 时，2.1.111 起） | truecolor（另有 `-ansi` 变体） | 二进制含 `THEME_NOTIFY:2031` 常量、`/^\x1b\[\?997;([12])n$/` 解析；settings.json 有 chokidar+轮询热重载 |
| opencode | 1.17.13 | OSC 10/11 + 启动即 `?2031h`（含 tmux passthrough DECRQM 探测） | ✅（收 997 → 重查 OSC 10/11 → 每个主题按 dark/light 双变体 resolve） | 主题 hex truecolor；`system` 主题纯 ANSI 16 色 | `handleSequence` 无条件匹配 `\x1b[?997;1n|2n`，四者中实现最完整 |
| oh-my-pi (omp) | 16.3.6 | OSC 11 → COLORFGBG → macOS 外观 → dark | ✅（`?2031h` + 997 作触发器、实际值重查 OSC 11） | truecolor | `theme.dark`/`theme.light` 双槽位自动二选一；自研 `@oh-my-pi/pi-tui` |
| codex | 0.142.5 | 启动时 OSC 10/11 查询一次（`terminal_probe.rs`） | ❌（repo/二进制 2031/996/997 零命中） | UI 主体 ANSI/终端默认色，语法高亮 truecolor | 唯一死角；仅 FocusGained（mode 1004）时重查（`tui/event_stream.rs`） |

### tmux 侧支持（fact-check 结论）

- **tmux 3.6（2025-11-26）起原生支持 mode 2031**（PR #4353，落地 commit `eaf70c95`）：per-pane 跟踪 `MODE_THEME_UPDATES`（pane 发 `?2031h` 置位），theme 变化时**只对开了 2031 的 pane** 写入 `\033[?997;Nn`，且 theme 未变不发——守卫完备，零 shell 污染。pane 发 `?996n` 会被应答（theme 未知则不答）；DECRQM `?2031$p` 有应答；新增 hook `client-dark-theme`/`client-light-theme` 与格式变量 `client_theme`。
- tmux 对外层终端不支持 997 时会**从客户端背景色猜 theme**；control mode 客户端可通过 `refresh-client` 系列上报颜色触发 `PANE_THEMECHANGED`（`cmd-refresh-client.c`，具体子命令语法实现期以 man 为准）。
- tmux master（截至调研**尚未发版**）新增 `set -s theme dark|light|detect|terminal` server option（commit `8c55a388`），可直接强制设定并触发 997 下发——对 tmex 是最理想的官方触发入口，需确认其进入的 release 版本。
- 最新 release：**tmux 3.7b（2026-07-01）**。本机当前为 **3.4**（homebrew）——不支持 2031，但已支持 OSC 11 代答（现方案赖以工作的基础）。
- tmux 自己应答 pane 的 OSC 11、不透传；取色顺序：control-mode client 上报的 bg → pane/window-style 算出的 bg → 首个 attached client 的 tty bg。
- `allow-passthrough` 是 pane→外层的输出方向穿透，**解决不了**外层→pane 的通知方向。

### tmex 侧现状（与方案直接相关）

- 前端渲染器是自研 `ghostty-terminal`（Ghostty VT → WASM），**不是 xterm.js**；主题切换已全量热更新 palette，索引色内容前端即时变色（codex UI 主体、opencode `system` 主题、Claude Code `-ansi` 变体已被动受益）。
- gateway↔tmux 走 control mode；输入注入唯一通道 `send-keys -H`（任意字节，`input-encoder.ts` 256 字节/块）——注入 `CSI ? 997 ; N n` 在通道上完全可行。
- gateway 已有字节级 pane 输出解析器 `pane-stream-parser.ts`（现处理 OSC 0/1/2/9/99/777/1337/133 与 DCS passthrough）——可扩展为跟踪 pane 声明的 private mode（`?2031h/l`、`?1004h/l`），这是 fallback 路线守卫的关键基础设施。
- `getOsc11ResponseColor`/`hexToOsc11Rgb`（`packages/shared/src/appearance.ts:90-102`）已备好 OSC 11 应答字节格式，仅单测覆盖、运行时未用。
- SSH 远端已有 tmux 版本探测（`ssh-bootstrap.ts` 返回 `tmuxVersion`）与门槛校验（`tmux-version.ts`，现仅卡 ≥3.0 control mode）。

## 方案设计（分层，按设备 tmux 版本自动降级）

### 路线 A（主推）：tmux ≥3.6 原生 theme 代理

主题切换时，gateway 通过 control mode 通知 tmux "theme 变了"，2031/997 的 per-pane 守卫、转发、996 应答全部由 tmux 原生完成。

- 触发方式三个候选，实现期 spike 敲定优先级：
  1. `set -s theme dark|light`（最直接，需确认所需 tmux 版本，master/未来 release）；
  2. control mode 客户端颜色上报（`refresh-client` 系列，3.6 即可用）；
  3. 现有 `setWindowStyle` 更新是否已足以触发 tmux 3.6 的 theme 变化检测（若是则改动最小）。
- 覆盖：Claude Code（theme=auto）、opencode、oh-my-pi 全自动热切换；零 shell 污染风险。
- 需要配套：
  - `tmux-version.ts` 增加 `THEME_NOTIFY_VERSION = 3.6` 能力位，本地与 SSH 设备分别探测、按设备选路线；
  - 本地安装/文档引导用户升级 tmux ≥3.6（homebrew 已是 3.7b）；打包发行如捆绑 tmux 需同步升级。

### 路线 B（fallback）：tmux 3.0–3.5 设备，gateway 模拟 tmux 3.6 行为

复活 `signalThemeChange`，但带上 tmux 3.6 同款守卫，解决历史上被删的污染问题：

1. **跟踪 pane 的 mode 声明**：扩展 `pane-stream-parser.ts` 识别 pane 输出流中的 `CSI ? 2031 h/l` 与 `CSI ? 1004 h/l`，gateway 侧 per-pane 维护 `themeNotify` / `focusReport` 状态位（`h` 置位、`l` 清除、pane 退出/`pane_current_command` 变化时清除）。
   - 前提验证点：control mode `%output` 是否包含 pane 写出的原始 `?2031h` 字节（tmux 3.4 不认识该 mode，预期原样出现在 %output；spike 首先确认）。
2. **主题切换时序**：先更新 `window-style`（保证后续 OSC 11 重查拿到新色），再对 `themeNotify=true` 的 pane `send-keys -H` 注入 `\x1b[?997;1n`（dark）/`\x1b[?997;2n`（light），theme 未变不发。
3. **codex 补偿（可选）**：对 `focusReport=true` 且前台命令为 codex 的 pane 注入 `\x1b[O\x1b[I`（focus out+in），触发其 FocusGained 重查 OSC 11。假 focus 事件对其它开 1004 的程序（如 vim 的 focus autocmd）有轻微副作用，默认可只对 codex 白名单启用。
4. **残余风险与缓解**：程序 crash 未发 `?2031l` → 状态位悬空，之后注入会泄漏进 shell。缓解：`pane_current_command` 变化即清位；注入前用 `getPaneInfo` 二次确认前台命令仍在已知 TUI 名单。

### 路线 C（配置面兜底，不写代码也生效的部分）

- Claude Code 只有 `theme: "auto"` 才跟随——文档/onboarding 引导；**不**去改写 `~/.claude/settings.json`（侵入用户配置、多设备语义混乱，否决）。
- opencode 用户可选 `system` 主题（纯 ANSI 16 色），则仅靠前端 palette 热更新即可完全跟随，连 997 都不需要。
- codex 无主题配置，运行中热切换上游未实现（相关 issue openai/codex#19741）；除路线 B 的 focus hack 外只能重启生效，文档如实说明。

### 不做的事

- 不拦截/代答 OSC 11（tmux 3.4+ 原生代答已工作，重复造轮子且 control mode 拿不到查询）；
- 不用 SIGWINCH（spike 已证无效）；
- 不无守卫广播注入（历史事故根因）。

## 2026-07-05 讨论收敛：仅实现路线 B

结合 research-01 的发行版覆盖面结论（RHEL 9/10、Ubuntu 24.04 等主力服务器平台到 EOL 都拿不到 3.6），决定**只实现路线 B 作为唯一路径**，理由：B 在 ≥3.6 的 tmux 上同样工作（`%output` 预期透出原始字节流，守卫不受 tmux 版本影响），单一路径省去 per-version 分支与双倍测试。成立的边界条件：

1. **硬前提（spike 第一项）**：control mode `%output` 必须透出 pane 写出的 `CSI ?2031h`——需分别在 3.4 与 3.6+ 验证（3.6 会消费该 mode，需确认消费后仍原样透传；从"control 前端需要完整 VT 流渲染"推断大概率透传，tmex 前端渲染正是靠 %output）。若 3.6 下被吞，"仅 B"不成立，需退回 A+B 组合。
2. **gateway 重启盲区**：2031 订阅状态是 gateway 内存态，gateway 重启/重连后丢失（TUI 的声明发生在过去，%output 看不到了）。缓解：守卫放宽为「%output 见过 ?2031h」OR「`pane_current_command` 在白名单（claude/opencode/omp 均无条件订阅 2031）」；白名单对 wrapper/别名可能失配，接受。
3. **≥3.6 下可能双发 997**（若 window-style 更新恰好触发 tmux 原生 theme 检测）：三家 TUI 对重复通知预期幂等，实现时验证即可。
4. **<3.3（RHEL 9、Ubuntu 22.04 的 3.2a）仍是降级兼容**：无 OSC 11 代答，Claude Code 可直接消费 997 值，opencode/omp 收 997 后重查会超时——"兼容所有"在这档是部分兼容，文档如实分档。
5. **架构预留**：触发端抽象成独立模块（守卫/注入与"谁触发"解耦），将来若要给 ≥3.6 设备换 tmux 原生代理（路线 A），只替换触发实现，不动守卫与广播框架。

## 验证点（实现阶段）

1. spike：tmux 3.4 下 `%output` 能否看到 pane 的 `?2031h`；tmux 3.6/3.7 下三个触发候选各自能否引发 997 下发（用 `tmux -L tmex-e2e` 独立 socket，严禁触碰 `tmex` session）。
2. e2e：临时实例（覆盖 `GATEWAY_PORT` 等）+ 测试 socket 里分别跑 claude（theme=auto）/opencode/omp，前端切换主题，断言三者换肤；idle shell pane 无任何字符污染。
3. codex：focus 注入后重查并换色（若实现路线 B 第 3 步）。
4. SSH 设备：3.4 与 3.6+ 两种远端分别走 B/A 路线的自动选择。
5. 回归：`signalThemeChange` 复活后不得影响 IME/粘贴路径（共用 `send-keys -H` 通道）。

## 遗留不确定项

1. `set -s theme` 进入哪个 tmux release（调研时 master 未发版）；
2. control mode 颜色上报的确切子命令语法（`cmd-refresh-client.c`）；
3. window-style 变化能否直接触发 tmux 3.6 的 theme 检测；
4. tmux 3.4 的 `%output` 是否原样透出未知 DECSET；
5. opencode 在 tmux（DECRQM 探测失败）下是否仍无条件监听 997（二进制证据显示 `handleSequence` 无条件匹配，倾向是）；
6. Claude Code settings.json 改 theme 是否热生效（有 settings 热重载机制证据，theme 字段未直接验证——路线 C 已否决该路径，仅存档）。

## 参考

- 调研原始三路报告：tmex 仓库现状（gateway/前端/tmux-client 逐文件）、协议标准 fact-check（contour 规范、tmux CHANGES/源码、各终端 changelog）、本机四 TUI 二进制取证。关键出处已内联在上文。
- 历史归档：`prompt-archives/2026070402-selection-theme-propagation/`（OSC 11 代答与 signalThemeChange 删除决策）、`prompt-archives/2026061105-tmux-osc-color-reply/`。
