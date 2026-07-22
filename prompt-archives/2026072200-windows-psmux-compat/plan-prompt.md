# Windows managed Gateway 与 psmux 兼容

## 2026-07-22 初始需求

为 managed Gateway 补齐 Windows x86_64 与 ARM64 构建目标，并保证 Windows 产物使用 `.exe` 后缀。终端多路复用器由调用方通过绝对路径提供 psmux；Gateway 需要正确处理 Windows shell、环境变量、版本探测和二进制路径，不依赖 PATH，也不得对现有会话执行全局 `kill-server`。

要求保持 macOS、Linux、iOS 与 Android 现有行为不变，使用 Bun.js 完成构建矩阵与契约测试。
