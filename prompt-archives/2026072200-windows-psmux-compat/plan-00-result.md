# Windows managed Gateway 与 psmux 兼容实施结果

## 结果

managed Gateway 已补齐 Windows x86_64 baseline 与 ARM64 目标，并完成 Windows
psmux 的绝对路径、版本、环境、terminfo、parking 与控制模式调用兼容。macOS/Linux
默认行为保持不变，未引入会话级或全局清理命令。

## 代码变更

- `apps/gateway/scripts/build-managed.ts`
  - 增加 `bun-windows-x64-baseline`、`bun-windows-arm64` 固定目标。
  - Windows 宿主目标映射分别为 x64 baseline 与 ARM64。
  - `.exe` 由目标而非构建宿主决定，保证 macOS 交叉编译仍得到 Windows 文件名。
- `apps/gateway/src/config.ts`
  - Windows 使用 `win32` 路径语义接受盘符与 UNC 路径。
  - managed Windows 未提供绝对 `TMEX_TMUX_BIN` 时启动即失败；开源非 managed
    Gateway 仍保留 `tmux` PATH 回退。
- `apps/gateway/src/tmux/local-shell-path.ts`
  - Windows 不探测 POSIX 登录 shell，原样保留继承的 PATH。
  - Windows 环境键按不区分大小写语义过滤 Gateway 注入项并设置 PATH/locale；Unix
    继续按区分大小写语义处理。
  - parking 使用 PowerShell、Windows PowerShell、cmd 与 Git Bash 均能执行的
    `ping.exe -n 31 127.0.0.1`，避免与用户配置的 psmux `default-shell` 分叉。
- `apps/gateway/src/tmux-client/tmux-version.ts`、`apps/gateway/src/api/tmux-health.ts`
  - psmux `-V` 首行作为 tmux 协议版本，后续行作为独立 provenance。
  - client/server 只比较规范化协议版本，健康响应单独暴露 `clientProvenance`。
  - 健康探测与 tmux 命令使用同一套去敏环境。
- `apps/gateway/src/tmux-client/local-external-connection.ts`
  - 普通命令与 control client 共用同一绝对二进制/`-L` namespace argv 构造。
  - Windows 跳过 `/bin/sh`、`tic` 与 `default-terminal` terminfo 配置。
  - parking 命令平台化；版本冲突错误不混入 psmux provenance。
- 契约测试覆盖 Windows 目标命名、盘符/UNC、managed 缺失路径失败、Windows 环境键、
  psmux 两行版本、缺失鼠标 format 降级、无 POSIX/terminfo/`kill-server` 调用，以及
  run/control client 的同路径同 namespace 约束。

## psmux 源码核验

核验对象为 psmux `v3.3.7`，commit
`05cc5d4cded047bd3f3d1955299fd0bd259f2d81`。源码确认：

- `-V` 首行保持 `tmux 3.3.7`，第二行输出 psmux 构建 provenance。
- 支持 `-L` namespace、control mode 与 Gateway 使用的核心命令/格式。
- shell 默认解析顺序为 pwsh → Windows PowerShell → cmd，但 `default-shell` 可配置，
  因此 Gateway 不自行复制这套选择逻辑。
- psmux 尚未提供 Gateway 查询的全部 tmux 鼠标 format；缺失值按关闭状态安全降级。

## 验证证据

- Biome：13 个变更 TypeScript 文件 `biome check` 通过。
- 定向契约测试：61 pass，0 fail，253 expectations。
- Gateway 全量测试：988 pass，0 fail，2864 expectations，97 files。
- 变更独立模块严格类型检查通过：`build-managed.ts`、`config.ts`、
  `local-shell-path.ts`、`tmux-version.ts`、`tmux-health.ts`。
- 仓库全量 `tsc -p apps/gateway/tsconfig.json` 仍为红色基线，共 40 个既有错误，分布于
  agent、push、telegram、SSH、WebSocket 等既有代码；本次新增的独立模块无类型错误。
- Windows x64 baseline 真实交叉编译：
  - `PE32+ executable (console) x86-64`
  - 102282240 bytes
  - SHA-256 `030427c2a3a946b48fb85a202916771356c0877f9b13aa3b21a11df0dd3127e0`
- Windows ARM64 真实交叉编译：
  - `PE32+ executable (console) Aarch64`
  - 99108864 bytes
  - SHA-256 `bc426a7e430ce4be761c2abd69747243d0de1115d95040488b9cc5e1b3af8bdb`
- 两个 PE 均通过 managed artifact fail-closed scanner：`ok: true`，findings 与
  adjacentFindings 均为空；相邻 `ghostty-vt.wasm` 为有效 WebAssembly 模块且 manifest
  SHA 一致。
- `git diff --check` 通过；实现文件搜索无 `kill-server`。

## 验证边界与安全

当前执行宿主为 macOS，因此完成的是 Bun 真实 Windows 交叉编译、PE 架构检查、产物扫描
与 psmux 源码/命令契约测试；原生 Windows 进程级运行验证应由 Windows 发布 Gate 执行。
验证未连接默认 tmux socket、未操作 `tmex` session、未访问 9883、未停止任何服务，也未
执行 commit 或 push。
