# Managed Gateway 空闲 CPU 修复 Prompt

日期：2026-07-20

上层任务要求先提交已经完成的 Native App、Companion 与终端修复，然后继续原始连接生命周期
工作。安装 `0.1.2-local.20` 后，App→Relay、Companion→Relay、本地 Companion 与终端首帧
均健康，但 managed Gateway 在终端连接稳定后仍持续占用约 25%～38% 单核 CPU。

约束：

- 不得访问默认 tmux socket，不得操作名为 `tmex` 的 session；
- 不得停止、重启或修改本机生产 tmex；
- 先修测试语义，再实现资源安全门；
- 需要同时验证 managed standalone 的 production 环境契约；
- 改动需保持开源、中性，不引入 Vibe X 产品语义。

取证结果：

- macOS `sample` 显示 Gateway 持续进行 `posix_spawn`；
- WebSocket 层只要任一客户端选中/订阅 pane，就每秒调用一次完整 snapshot；
- 每次本地 snapshot 并发启动 `display-message`、`list-windows`、`list-panes` 三个 tmux
  子进程；
- control mode 已把 `%layout-change` 等结构通知映射为即时 snapshot，因此周期轮询只是
  丢通知后的恢复看门狗，不是主同步链路；
- 当前 snapshot 允许并发，纪元号只丢弃旧结果，不能阻止重复子进程；
- Bun standalone 会按构建进程固化 `process.env.NODE_ENV`；当前产物运行时环境为
  `production`，但 `/healthz` 固定返回 `development`。

## `.21` 实机复验与根因补充

第一轮单飞、10 秒恢复看门狗和 production 构建契约已通过自动化测试并装入
`0.1.2-local.21`。实机复验确认 `/healthz.env=production`，但 Gateway 仍占用约
18%～37% 单核 CPU，因此第一轮资源 Gate 不通过。

只读子进程观测在 20 秒内捕获约 207 个 Gateway 子进程，绝大多数为：

```text
tmux list-panes -s -t <session> -F <pane snapshot format>
```

频率约为每秒 10 次；`display-message`、`list-windows` 和 `tmux -V` 仅低频出现。代码
追踪确认控制模式解析每次 OSC pane title 时，local 与 SSH connection 都会把标题写入
`pendingPaneTitles`，随后调用完整 `requestSnapshot()`。标题是既有 pane 的展示属性，
不是 session/window/pane 拓扑变化；活跃程序连续设置标题时不应启动 tmux 子进程。

新增语义要求：

- 已知 pane 的标题更新必须直接更新内存快照，只在值实际变化时向订阅方发出合并后的
  snapshot，不运行完整 tmux snapshot；
- 短时间内连续标题更新需要合并，不能让广播本身形成高频工作回路；
- 未知 pane 的标题可暂存在 `pendingPaneTitles`，等待结构通知触发的完整快照吸收，不得
  仅因标题事件主动探测拓扑；
- `%layout-change`、window/pane add/close/rename 等结构通知仍保持完整快照语义；
- local 与 SSH 实现及测试必须一致；
- 修复后的 managed 实机必须重新用子进程计数和 CPU 采样验收，不能只凭单测判断。
