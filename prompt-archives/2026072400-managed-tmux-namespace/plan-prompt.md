# Managed tmux Namespace Prompt

## 2026-07-24

为 managed Gateway 增加结构化的 tmux namespace 启动参数，使宿主分发可以显式隔离开发/测试实例，同时保持默认生产语义：

1. 未提供 namespace 时，Gateway 必须连接 tmux 默认 server，不注入任何 namespace。
2. 提供 namespace 时，仅接受安全、非空且非 `default` 的名称，并在业务模块加载前生效。
3. managed 入口必须清除父进程继承的旧 namespace 环境变量，避免未显式传参时仍被环境污染。
4. 参数缺失、重复或非法时应快速失败；`--version` 的即时返回行为保持不变。
5. 删除不再必要的兼容分支，并增加覆盖默认与显式 namespace 行为的长期回归测试。

