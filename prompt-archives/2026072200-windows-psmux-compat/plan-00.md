# Windows managed Gateway 与 psmux 兼容计划

## 背景

managed Gateway 当前只覆盖 Unix/移动目标，部分文件名和宿主选择逻辑还隐式依赖构建机平台。Windows 交叉构建必须由目标 triple 决定输出形态，运行时则通过显式绝对路径消费 psmux。

## 实施计划

1. 审计 managed build 目标矩阵、输出文件名、运行时 shell 与 tmux 调用边界。
2. 增加 `bun-windows-x64-baseline` 与 `bun-windows-arm64`，由目标决定 `.exe` 文件名。
3. 平台化 Windows shell、环境变量与 psmux 版本探测，保留 Unix 行为。
4. 增加长期保护构建契约和真实命令契约的必要测试。
5. 运行相关 Bun 测试、类型检查和 managed build 验证，记录结果。

## 审计后的实施决策

- Windows x64 使用 Bun 的 `bun-windows-x64-baseline` 目标，ARM64 使用
  `bun-windows-arm64`；输出扩展名只由目标决定，不能由构建宿主决定。
- Windows 运行时必须显式提供绝对 `TMEX_TMUX_BIN`。路径判定使用 Windows 路径语义，
  兼容盘符路径和 UNC 路径；Unix 继续允许未配置时回退 `tmux`。
- psmux `-V` 的第一行是 tmux 兼容版本，后续行是构建 provenance。比较 client/server
  时只比较规范化首行，健康信息单独保留 provenance。
- Windows 不执行 POSIX 登录 shell 探测，也不运行 `/bin/sh`/`tic` terminfo 安装；保留
  `PATH`、`SystemRoot`、`ComSpec` 等供 psmux 自己发现 shell。psmux 的 `default-shell`
  可由用户配置，因此 parking 使用 PowerShell、cmd 与 Git Bash 均可直接执行的命令，
  Gateway 不重复猜测 shell。
- psmux v3.3.7 尚未提供全部 tmux 鼠标 format；现有缺失字段必须继续降级为空/关闭，
  不能导致快照或历史恢复失败。

以上细节按最佳实践先行。

## 验收标准

- Windows x86_64/ARM64 均生成正确命名的 managed Gateway。
- Gateway 只使用调用方传入的绝对 multiplexer 路径。
- Windows psmux 版本输出可稳定解析，且没有全局会话清理命令。
- 既有平台测试无回归。

## 风险

- Bun target 与实际 PE 架构不一致：通过目标矩阵和产物头检查阻断。
- Windows shell 引号/环境变量语义与 POSIX 不同：避免字符串拼接，使用参数数组和显式环境。
- psmux 会话被误清理：禁止裸 `kill-server`，测试只允许隔离命名空间。
