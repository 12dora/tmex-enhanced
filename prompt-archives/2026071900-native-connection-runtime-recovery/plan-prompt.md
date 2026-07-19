# Prompt Archive

## 2026-07-19

在 `vibex/native-connection-runtime-recovery` 分支实现 Native host connection lifecycle
plan-03 中 tmex Gateway 的两项，严格 test-first：

1. managed `--version` 必须立即、无副作用退出，不加载运行时环境、数据库或监听端口；
2. 新增并贯通 `TMEX_TMUX_BIN`，所有本地 tmux 普通命令、版本 probe 与 control-mode
   client 必须使用该绝对路径，不得被 login-shell PATH 覆盖。

范围限定在 tmex，使用 Bun 测试，不触碰生产服务、默认 tmux socket 或 `tmex` session。

## 2026-07-20：Native 终端空白后续

Vibe X 安装 App 中正式终端和设置终端预览曾同时完全空白。真实受保护 loopback 取证
确认共享根因是 CSP 阻止 Ghostty WASM；修复后正式终端交互与设置预览字形均已出现。
后续 tmex 子实施需要：

1. 为 `TerminalPreview` 提供稳定的测试/诊断语义，测试按预览自身 Canvas 与像素判断，
   不能误用正式终端外壳的 `data-terminal-engine`；
2. 失效 window 深链在快照 settle 宽限后恢复到活动 window/pane，保持合法深链的传播
   宽限，禁止永久停在失效选择；
3. 定向单测必须先红后绿，真实 E2E只操作专用 `vibex-e2e-*` 设备/session，不触碰默认
   `tmex` session或生产服务。

## 2026-07-20：正式 WKWebView 仍白屏的纠正

此前“正式终端交互与设置预览字形均已出现”的判断不成立：它实际来自 Chromium
loopback，不是安装后的 WKWebView。用户安装 `.17` 后明确确认正式终端仍一片白；Rust
attach 已收到大量数据也不能证明前端绘制。

tmex 子实施新增一个平台中立的可选诊断 Provider。真实终端和设置预览只向宿主报告固定
阶段、布尔值和有界计数，Browser 未注入时无行为；不得依赖 Vibe X/Tauri，也不得报告
终端正文、输入、route、任何设备标识、字体名或异常正文。先补采样器和生命周期测试，
再由 Vibe X Native 宿主接入 typed IPC。
