# Managed tmux Namespace Implementation Plan

## 背景

managed Gateway 当前只能通过进程环境选择 tmux namespace。父进程环境可能被继承，且缺少可审计的启动参数边界。需要将 namespace 变为 managed 入口的结构化参数；未传参时恢复 tmux 默认 server 语义。

## 方案

1. 在 managed 入口解析可选的 `--tmux-namespace <name>`。
2. 使用现有 tmux socket 命名约束验证参数，拒绝空值、`default`、重复参数和未知参数。
3. 在动态加载 Gateway 业务模块前：
   - 显式传参：写入 tmex 内部兼容环境值；
   - 未传参：删除父进程继承的内部兼容环境值。
4. 保持 `--version` 无配置、无数据库副作用地立即返回。
5. 增加入口级回归测试，覆盖默认清理、显式设置、非法值和重复参数。

## 验收标准

- 未传 `--tmux-namespace` 时，本地 tmux 命令不带 `-L`。
- 传入安全 namespace 时，本地 tmux 命令使用对应 `-L`。
- 父进程遗留环境值不能改变未传参时的默认行为。
- managed Gateway 既有测试、类型检查与构建通过。

## 风险

- 环境设置必须早于依赖配置的业务模块导入，否则模块级缓存会保留旧值。
- 参数解析不能改变 `--version` 的快速路径，也不能静默接受拼写错误。

