# Control Mode 外部窗口删除收敛 Prompt

日期：2026-07-23

## 上下文

Vibe X 的 canonical terminal state feed 基于 tmex Gateway 的
`DeviceSessionRuntime`。在 Native 真机终端首帧问题排查中发现：测试从同一个隔离
tmux socket 外部执行 `kill-window` 后，tmux 实际只剩一个窗口，但 Native 与 Webapp
收到的 canonical metadata 仍包含已删除窗口。点击该失效窗口时无法取得 screen
snapshot，界面会停在 `Restoring terminal state…`。

对应用户反馈：

> 卡restoring terminal state

此前相关要求：

> 同样的问题记得在webapp里也要解决

## 已有证据

- 隔离测试容器的 `tmux -L vibex-test list-windows` 显示每个实例仅剩 `@0`；
- Native / Webapp canonical metadata 仍显示此前测试创建后又从 tmux 外部删除的窗口；
- tmux 3.7b 手册明确列出 `%window-close` 与 `%unlinked-window-close` 两种 Control
  Mode 通知；
- parser 已识别 `%unlinked-window-close`，但 subscription 只把
  `%window-close` 投影为结构删除，因此另一种通知不会进入 metadata projection。

## 约束

- 修复属于开源 tmex 的通用 Control Mode / canonical metadata 行为，提交信息保持中性；
- 必须同时覆盖 local 与 SSH connection 共用的 subscription；
- 只增加保护真实协议回归的测试，不增加与产品行为无关的覆盖率测试；
- 验证只使用仓库测试与隔离 tmux socket，严禁触碰系统安装的 tmex 和默认
  `tmex` tmux session。
