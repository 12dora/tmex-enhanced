# Terminal Render Diagnostics Provider（tmex 子计划）

## 背景

安装后的 WKWebView 中，正式终端仍为空白；Chromium loopback、字体文件存在和 Rust
attach 首帧均不足以定位 WebView 内部。tmex 侧需要提供不绑定具体平台的最小可观察面。

## 实施

1. 在 `terminal-ui` 增加可选 React Provider 与固定诊断 DTO；默认 reporter为空。
2. 提取纯采样器，只输出控制器/字体状态、缓冲区行数、mount/canvas尺寸、固定小网格
   像素摘要和遮罩布尔值。
3. `Terminal` 与 `TerminalPreview` 在固定初始化/失败/延时阶段上报；捕获异步初始化
   拒绝，禁止产生未处理 Promise。
4. 先写采样器、Provider和失败阶段测试，再实现；跑 terminal-ui 定向测试与类型检查。

## 边界

- 不导入 Vibe X、Tauri或 platform-native；
- 不记录/返回正文、输入、route、标识、字体名、错误消息；
- 不启用轮询，单个控制器只在固定阶段进行少量采样；
- Browser未提供 reporter 时不采样、不分配定时任务。

## 验收

- DTO只含固定枚举、布尔值与有界计数；
- 内容已在缓冲区但 Canvas未绘制能从摘要区分；
- Canvas不可读时安全降级，不影响终端；
- 初始化失败形成固定阶段，诊断失败不改变产品行为。
