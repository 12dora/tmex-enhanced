# prompt-archives 历史摘要（2026-02 ~ 2026-08）

本文件是在清理 `prompt-archives/` 时，从各归档目录的 `plan-*-result.md` 提炼的项目演进脉络。原目录已删除，此处为唯一留存。每条按「目录名 → 主题 → 结果」。

## 2026-02 上旬：脚手架与终端基础

- `2026021000-tmex-bootstrap`：monorepo 脚手架（SQLite/加密/JWT、tmux 控制模式解析、WS 与 Webhook/Telegram）；完成。
- `2026021000-tmex-fixes`、`2026021001-terminal-fixes`、`2026021002-terminal-fixes-2nd`：首批终端修复，本地 tmux 改 node-pty，新增 `term/history` 回放与滚动缓冲，重写 Sidebar 并修直链白屏；完成。
- `2026021001-tmex-style-skills`：接入 Tailwind v4 Vite 插件修样式，AGENTS.md 补 `npx skills` 规范；完成。
- `2026021002-tmux-control-mode-fix`：补齐 control mode 协议（`%begin/%end`、八进制解码、ready 握手）；完成。
- `2026021003-browser-tmux-e2e`：建立 Playwright 浏览器端 tmux e2e 全流程；完成。
- `2026021004-terminal-ux-fixes`、`2026021100-terminal-blank-fix`：ResizeObserver 延迟初始化 xterm 修白屏，输入链路双重去重；完成。
- `2026021101-sidebar-terminal-regressions`、`2026021102-terminal-size-history-regression`：关闭按钮、`refresh-client -C` 同步尺寸、先同步再取历史、`capture-pane -e` 保留 ANSI；完成。
- `2026021104-bidirectional-terminal-resize`、`2026021105-resize-sync-color-followup`：浏览器与 iTerm2 双向尺寸同步并收敛竞争（关 aggressive-resize、节流快照）；完成。
- `2026021106-frontend-terminal-header-sidebar`、`2026021107-mobile-topbar-terminal-label-shortcuts`：头部统一 44px、移动端固定顶栏与控制字符快捷键行；仅存计划，无结果文档。
- `2026021108-settings-telegram-bell`、`2026021119-terminal-bell-push-supervisor`、`2026021120-bell-toast-telegram-toggle-html`、`2026021121-bell-url-escape-cjk-width`：设置页与 bell 推送线（独立 Push Supervisor、Toast/Telegram 开关、HTML 转义、URL 编码、unicode11 宽度）；完成。
- `2026021109-ssh-agent-startup-broadcast`、`2026021110-ssh-tmux-reliability`：SSH 用户名回退与 `SSH_AUTH_SOCK` 缺失修复，错误分类模块化与启动广播；完成。
- `2026021111-direct-link-device-mismatch`、`2026021112-sidebar-alignment-highlight-order`：直链冷启动误连他设备、跨设备同 id 误高亮修复；完成。
- `2026021113-pane-history-wrap-fix`、`2026021114-output-duplication-race-fix`、`2026021115-enter-echo-duplicate`、`2026021116-enter-echo-newline-semantic`：历史换行错乱、并发建连导致输出重复 5 次、回车额外回显（最终方案为跨模式相邻同内容去重）；完成。
- `2026021117-gateway-fe-i18n-i18next`：数据层迁移 Drizzle ORM + 启动自动迁移，网关/前端 i18n 落地；完成。
- `2026021118-editor-mobile-title-fixes`、`2026021205-viewport-height-jitter-fix`、`2026021206-mobile-editor-ios-ux`、`2026021207-ios-keyboard-terminal-gap`、`2026021224-ios-pwa-safe-area`：编辑器与移动端/iOS 键盘避让系列（视口高度 RAF 合并、贴键盘、safe-area 按组件启用）；完成。

## 2026-02 中旬：CLI 发布与前端重构

- `2026021200-dev-supervisor-ssh-agent-lifecycle`：dev-supervisor 内联 SSH Agent 生命周期与 healthz 等待；完成。
- `2026021201-novice-deploy-cli`、`2026021202-npm-package-rename`、`2026021203-fix-cli-init-bash-source`：新增 `packages/app` CLI（init/doctor/upgrade/uninstall）与 systemd/launchd 守护，包名改 `tmex-cli`，修 `BASH_SOURCE` 模板插值；完成。
- `2026021204-db-copy-key-mismatch-logging`：DB 复制后 master key 不匹配排障与 journald 日志；仅存计划（结论已入 `docs/operations/2026021200-*`）。
- `2026021223-pwa-manifest`：动态 `/api/manifest.webmanifest` 与 apple-touch-icon；完成。
- `2026021225-frontend-rebuild-shadcn-baseui`、`2026021300-frontend-nova-polish`、`2026021301-frontend-nova-polish-execution`：前端全量重构为 shadcn/ui + Base UI 并 token 化主题，随后修 9 项真机可用性问题；完成。
- `2026021400-sidebar-connection-refactor`、`2026021401-device-window-sync`：GlobalDeviceProvider 统一设备连接，前端跟随设备侧窗口切换；完成。
- `2026021400-terminal-react-xtermjs-refactor`：终端改 react-xtermjs 并抽 Terminal 组件；完成，后被 Ghostty 方案取代。
- `2026021402-tmux-rewrite-ws-borsh`：WS 协议重写为二进制 `tmex-ws-borsh-v1`（Borsh Envelope）并引入 selectToken 切换屏障；阶段性完成，是当前协议的起点。

## 2026-04：外部 CLI 弯路与 Ghostty 底座

- `2026041400-tmux-external-cli-refactor`：默认后端由 `tmux -CC` 改为外部 tmux CLI（pipe-pane + hook）；完成，但已被 `2026061102` 迁回 control mode 取代。
- `2026041600-ghostty-wasm-terminal`、`2026041601-ghostty-canvas-terminal`、`2026041603-ghostty-packaged-wasm`、`2026041604-dual-npm-release`：新增 `packages/ghostty-terminal` 用 Ghostty wasm 替换 xterm 底座，主渲染切 Canvas，wasm 产物加 metadata 校验，独立发布 `ghostty-terminal` 包；完成。
- `2026041600-terminal-restore-bugs`、`2026041602-terminal-blank-line-fix`、`2026041700-terminal-three-bugs-fix`、`2026041701-tui-bg-missing-on-restore`、`2026041702-terminal-input-echo-bug`：恢复路径误发 `TERM_SYNC_SIZE`、history 尾换行多推空行、alt→primary 边沿未清鼠标 tracking、`capture-pane -N` 保留行尾空白、`ESC k` 标题解析；完成。
- `2026041605-ghostty-mouse-events`：鼠标报告模式（SGR/URXVT/X10）编码与 wheel/touch 路由优先级；完成。
- `2026041606-ssh-device-connect`、`2026041800-ssh-error-unified-alerts`、`2026041801-ssh-pane-exit-false-error`：SSH `test-connection` 改真实 probe，统一 `ConnectionAlertNotifier` 告警与节流，修 onClose 误报；完成。
- `2026041703-osc-notification-support`：pane-stream-parser 支持 BEL/OSC 9/777/1337，打通 `terminal_notification` 到前端与 webhook；完成。

## 2026-06 上旬：迁回 control mode、Agent、Watch、Files

- `2026061102-control-mode-migration`：订阅层从 pipe-pane/fifo 迁回 tmux control mode（`tmux -C attach`），含解析器、版本闸门与退避重连；完成，为当前架构。
- `2026061100-web-terminal-shortcut-paste-copy`、`2026061104-selection-column-space`、`2026061105-tmux-osc-color-reply`、`2026061103-history-replay-cursor-restore`：快捷键/复制粘贴、选区统一到屏幕列空间、`TMEX_TMUX_WINDOW_STYLE` 修 OSC 10/11 代答、history 末尾拼光标恢复；完成。
- `2026061101-claude-code-osc-notification`：解包 tmux DCS passthrough 并支持 kitty OSC 99 分片聚合；完成。
- `2026061200-android-keyboard-occlusion`、`2026061201-mobile-close-button-fix`、`2026061202-issue3-sidebar-tab-title-rename`、`2026061402-issue6-ui-changes`：移动端键盘遮挡、关闭确认、窗口自定义名与 sidebar 视觉；完成。
- `2026061300-terminal-agent-watch`、`2026061300-agent-ux-overhaul`、`2026061302-agent-system-prompt-refactor`、`2026061303-run-command-headless-ghostty`、`2026061304-panel-restyle`、`2026061400-agent-default-write-mode`、`2026070401-agent-iteration`：终端 AI Agent 与 Watch 大功能（7 张表、AI SDK provider、WS 扩展），随后补 hosted tools、消息队列/steer、类 JSX system prompt 与凭证消毒、OSC 133 + headless ghostty per-pane emulator 与 `run_command`；完成。
- `2026061301-env-three-tier`：共享 `loadEnv()` 统一 development/test/production 三套环境；完成。
- `2026061400-watch-issue4-fixes`、`2026061401-device-tree-reorder`：Watch 通知修正，设备/窗口/pane 树拖拽排序（`sortOrder` + order 表 + 两个 WS kind）；完成。
- `2026061403-prod-sqlite-full-crash`、`2026061403-prod-tmux-window-debug`：生产 SQLite 崩溃加固（history 超时未解门控、`KillMode=process`），复合窗口 ID 根因为 `LANG=C` 下 TAB 被渲染成 `_`，改 `|` 分隔 fail-closed 解析；完成。
- `2026061404-files-tab`、`2026061405-files-ssh-rsync`、`2026061409-files-context-menu`：Files Tab（file_roots 表、realpath 白名单）、以 rsync 为统一传输层、右键/长按菜单与分块上传/进度/取消/2GB 上限；完成。
- `2026061406-update-feature`、`2026061502-issue28-bun-path`：版本与更新 Tab、安装方式检测与两阶段自升级状态机；bun 路径真因是交互式 `zsh -lic` 的 ANSI 污染，改安装期定路径存 meta；完成。
- `2026061407-e2e-prod-isolation`：e2e 改独立 tmux socket 与 9885/9665 端口，healthz env 断言守卫；完成。
- `2026061408-terminal-text-vcenter`、`2026061500-terminal-line-rendering`：文字垂直居中先用 `textOffsetY`，后改为确定式行高 + 真实字形盒两遍渲染；完成。
- `2026061500-ssh-config-host-not-found`、`2026061500-telegram-url-double-encoding`：`sshConfigRef` 被当路径导致 ENOTFOUND、Telegram 链接二次百分号编码；完成。
- `2026061501-mobile-keyboard-behavior`、`2026061501-terminal-font-settings`、`2026061600-terminal-custom-shortcuts`、`2026061900-issue32-toast-spa-nav-terminal-states`：三种键盘避让模式、Nerd Fonts 构建工具链与字体设置、自定义快捷键列表、toast 改 SPA 导航；完成。
- `2026061403-*` 之外的 `2026061400-confirmed-issues-fix`：issue #10/#11/#15/#16 合并修复（URL 可点击、Dark Mode 文案、SSH 校验、设置页重排）；完成。

## 2026-06 下旬 ~ 2026-07 中旬：通知、分屏、前端拆包

- `2026062000-fe-bundle-size-optimization`：首屏 raw 1246KB→878KB（−30%）；完成。
- `2026062000-weixin-clawbot-notify`、`2026070400-bell-notification-redesign`、`2026070501-notify-search-channels-artifacts`、`2026071100-notify-ws-broadcast`、`2026071101-notify-event-emitters`：通知子系统线（微信 ClawBot 渠道、推送设置由五项收敛为三项、channel 可插拔 + web search provider 插件化、`KIND_NOTIFY_EVENT` 广播、补齐发射面）；完成。
- `2026062900-issue-30-default-working-dir`、`2026062900-issue-34-cjk-filename-fix`、`2026062900-issue-38-dependency-install-guidance`、`2026062900-issue-40-osc52-clipboard`、`2026062900-issue35-notification-pane-name`、`2026063000-pane-cwd-display`：一批 issue 修复（默认工作目录、rsync `LC_ALL=C` 下 CJK 文件名八进制转义、CLI 依赖引导、OSC 52 剪贴板、通知显示 pane 名、pane 显示 `进程名@cwd`）；仅存计划/prompt，无结果存档。
- `2026063000-issue41-output-stall`：输出停滞根因为 control mode `%pause/%continue`，补回调与心跳自恢复；完成。
- `2026070200-split-screen`、`2026070300-issue45-terminal-experience`、`2026071004-terminal-split-regressions`：分屏全链路（layout 解析、split/resize/select-layout 原语、前端分屏区），随后修分屏清屏/TUI 局部清屏与移动端堆叠布局竞态（runtime 级原子 `applyStackedLayout`）；完成。
- `2026070402-selection-theme-propagation`、`2026070500-tui-theme-auto-switch`、`2026070501-terminal-render-bugs`、`2026070501-terminal-file-path-links`、`2026070502-tui-mouse-drag-bugs`：主题跨端广播 + OSC 11 代答 + DEC mode 2031 向 TUI 注入主题、渲染三连 bug（xterm 时代遗留的 `keepShortHistoryVisible`）、文件路径链接、鼠标事件补全；完成。
- `2026070500-capabilities-settings-bindhost`：capabilities 端点、设置变更广播与 tree-order REST、可配置 bindHost；完成。
- `2026070600-fe-package-split`、`2026071000-ws-client-socket-factory`、`2026071100-embeddable-panels-and-console`、`2026071700-native-host-services`：前端拆包起点（抽 `@tmex/ui`），ws-client 支持注入 `SocketFactory`，面板/控制台嵌入宿主适配与 HostServices 抽象；完成（embeddable-panels 仅存计划）。
- `2026071001-site-settings-persist-fix`：`updateSiteSettings` 漏写 4 列导致设置不落库；完成（先红后绿）。
- `2026071002-tmux-tree-endpoint-sidebar-flat`、`2026071003-tmex-sidebar-device-management`：新增 `GET /api/tmux/tree` 并把侧栏改平铺 Collapsible + 设备树管理；完成，平铺方案后被 `2026082701` 的三 Tab 恢复取代。

## 2026-07 下旬 ~ 2026-08：managed gateway、canonical state、清理与发版

- `2026071600-managed-standalone-gateway-spike`、`2026071900-native-connection-runtime-recovery`、`2026072200-windows-psmux-compat`、`2026072300-managed-dynamic-endpoint`、`2026072400-managed-tmux-namespace`、`2026072000-managed-gateway-idle-cpu`：managed standalone gateway 线（入口与构建目标、`TMEX_TMUX_BIN`、Windows/psmux 兼容、loopback 临时端口 + 原子 readiness 文件、`--tmux-namespace`、空闲 CPU 下降）；除 idle-cpu 与 spike 部分目标外均完成。
- `2026072201-canonical-state-feed`、`2026072600-canonical-snapshot-fidelity`：每设备单一 canonical runtime，元数据与 pane 字节分离共用传输通道；随后补快照保真（空行保留、原子截屏三连、按 baseSeq 切分 ScreenBegin）；完成，gateway 1051 单测全绿。
- `2026072301-control-mode-unlinked-window-reconcile`、`2026072302-device-console-route-ownership`、`2026072303-default-local-device-hostname`、`2026072500-use-mobile-hook-race`、`2026071800-ui-interaction-guards`：`%unlinked-window-close` 归一化、路由 active pane 所有权、本地设备名用 `hostname()`、`use-mobile` 断点统一为 `(min-width: 48rem)` 并惰性初始化、全局交互守卫；大部分完成，前者与 ui-interaction-guards 仅存计划。
- `2026072700-release-v1.0.0`：v1.0.0 合并发版，CHANGELOG 双语改写；`tmex-cli@1.0.0` 已发布 npm latest。
- `2026082700-code-smell-cleanup`：代码异味清理第二阶段（重复代码、腐朽测试、死代码、圈复杂度）；完成，源码 91.6k→89.3k 行，测试 63.5k→60.1k 行。
- `2026082701-sidebar-tabs-restore`：个人分支恢复 0.17.0 的三 Tab 侧栏与设备连接/断开 UI；完成并已 push，`main` 保留上游 UI 供 PR。
