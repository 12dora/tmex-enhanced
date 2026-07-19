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

## `.22` 实机复验与 WebSocket 背压根因

`0.1.2-local.22` 实机将 Gateway 子进程数从约 207/20 秒降到 2/20 秒，剩余两次严格对应
10 秒完整快照恢复看门狗，证明 title→tmux snapshot 回路已经消除。但 Gateway CPU 仍为
21%～32%，因此资源 Gate 仍不通过。

正常退出前台 App 后，Gateway CPU 没有下降，且仍有 6 条来自 Companion 的 loopback
WebSocket。`nettop` 证明其中一条连接发送窗口为 0、存在重传且累计发送量不再前进；另一条
连接仍持续消费约 10～12 KiB/s。Gateway 的全部发送路径都忽略 Bun
`ServerWebSocket.send()` 返回值，也没有配置 `backpressureLimit` /
`closeOnBackpressureLimit` 或 `drain`。本地 Bun 1.3.14 类型和随包文档明确约定：

- `-1`：帧已入队，但连接进入背压；
- `0`：帧因连接问题被丢弃；
- 正数：已发送的字节数。

因此慢 Relay/客户端 attach 会让 Gateway 持续编码和尝试投递实时终端帧，既无法保证该
客户端的无缺口语义，又持续消耗 CPU。

新增语义要求：

- 所有 Gateway WS 发送路径统一检查 send status，包含普通 envelope、chunk、switch
  barrier 与 Agent/Watch 广播；
- 首次 `-1` 后暂停该 socket 的后续发送；若 drain 前没有新帧被跳过，可恢复使用；
- 背压期间若有实时帧被跳过，drain 后必须隔离该 socket，让客户端重连并通过 history
  恢复，禁止把有缺口的流伪装成连续；
- 持续 5 秒不 drain 必须强制终止，不能无限保留慢消费者；
- `0` 视为连接不可用并终止；
- Bun server 显式设置 1 MiB 背压上限并在达到上限时关闭，不能依赖版本默认值；
- slow consumer 只牺牲自己的 attach，不能影响同设备其他客户端或 tmux runtime；
- 写失败测试覆盖暂时背压恢复、有缺口后的 drain 隔离、超时隔离和 chunk 停发，再安装
  managed 候选复测 CPU、连接数和健康状态。

## `.23` 实机复验与终端帧分配根因

背压修复进入 `0.1.2-local.23` 后，App、Companion 与 Gateway 均由正常安装生命周期换成
新进程。App→Relay 和 Companion→Relay 都保持 Connected，本地终端首帧与渲染正常。
20 秒子进程观察仍只有两次 10 秒恢复快照和一条常驻 control client。

与 `.22` 不同，全部 Gateway loopback TCP 连接均有正常发送窗口、零重传；两个 Relay
attach 各自持续消费约 10～12 KiB/s。正常退出前台 App 后，本地 attach 被回收，Gateway
连接从 7 条降到 5 条，但两个活跃 Relay attach 与约 19%～33% CPU 均保持不变。因此：

- 背压缺陷修复有效，但不是当前稳态 CPU 的主因；
- 前台 App attach 没有泄漏，剩余连接是 Companion 设置 watcher 与 Relay 当前流；
- 不能通过关闭用户远程客户端或操作默认 tmux session伪造空闲 Gate；
- `sample` 显示主线程与 JSC 后台分配/回收持续活跃，没有新的 spawn 热回路。

Gateway 当前对 control mode 的每个 `%output` 回调立即逐客户端重新 Borsh 编码和发送。
同一 stdout read/event-loop task 内的多段输出可以安全合并：使用 microtask 在返回下一项
I/O 事件前 flush，既不增加跨事件可见延迟，也保证新的 select/barrier 消息不能越过旧
输出。实现必须：

- 按 device/pane 保序合并同一 tick 的字节，单批硬上限 64 KiB；
- 超过上限立即 flush，禁止无界积压；
- connection entry 释放时丢弃尚未 flush 的批次；
- 同一 pane 的 Borsh payload 每批只编码一次，再为各客户端生成自己的 envelope/seq；
- switch barrier 仍逐客户端决定 buffer/send，慢客户端隔离语义不变；
- 测试覆盖合并、字节顺序、64 KiB 上限、释放清理和跨 microtask 的背压缺口；
- 用 production managed 候选在相同两个活跃 Relay attach 下复测 CPU、吞吐、终端交互与
  子进程频率，不能只用微基准替代实机 Gate。

## `.25` 符号化 CPU Profile 与跨 I/O tick 批处理

同一微任务批处理进入候选包后，managed Gateway 在真实两个活跃 Relay attach 下仍持续
占用约 19%～30% 单核 CPU。为避免继续根据 UI 或无符号 macOS sample 猜测，使用仓库内
独立数据目录、独立端口和独立 tmux socket/session 启动有限时长的 production source
Gateway，并由 Bun 1.3.14 的 `--cpu-prof-md` 生成符号化 profile。整个测试没有访问默认
tmux socket，也没有操作名为 `tmex` 的 session。

Profile 的主要累计热点为：

- `TerminalOutputBatcher.flush → sendTerminalOutput`：约 40.2%；
- WebSocket `send`：约 25.1%；
- `sendChunked`：约 23.8%；
- Borsh/Zorsh serialize/write/DataView：约 12%；
- control stream pull/read/parser：约 20%；
- 恢复快照 tmux spawn：约 14.7%。

受控 profile 的合成输出频率低于真实工作负载，因此绝对 CPU 只有约 2%～8%，但调用栈
已经证明剩余稳态成本来自相邻 I/O tick 的终端帧编码和发送。`queueMicrotask` 只合并同一
JS turn 中的回调；tmux control stream 的相邻 read 会在不同 turn 到达，实际无法合并。

下一轮语义要求：

- 终端输出按 device/pane 延迟至多 8ms 合并，而不是只等当前 microtask；
- 单批仍以 64 KiB 为硬上限；达到上限立即发送，剩余字节进入新的有界批次；
- 每个 pane 保持字节顺序，同一 device 多 pane 的显式 flush 保持首次出现顺序；
- `TMUX_SELECT` 在启动 switch barrier、修改焦点和发送 ACK 前，强制 flush 该 device
  已排队输出，确保旧 pane 字节不能越过切换事务；
- `TMUX_SUBSCRIBE_PANES` 在修改订阅集合前强制 flush，确保排队字节按旧路由投递；
- release/discard 必须取消定时器并丢弃排队输出，不能让已释放 runtime 的数据逸出；
- 测试使用可注入调度器，不依赖真实 sleep；覆盖跨 tick 合并、8ms 上限、64 KiB 上限、
  显式 flush 顺序、取消语义和 select/subscribe 路由边界；
- 修复后重新跑完整 Gateway 测试、有限时长 CPU profile 和 production managed 实机
  采样；只有 CPU、终端交互、连接状态与顺序语义同时通过才可进入下一 App 候选包。

## 有界时间批处理验证结果

实现采用每个 device/pane 最长 8ms 的有界批次和 64 KiB 硬上限，并在 select 与订阅变更
前显式 flush。验证结果：

- 定向测试 55/55 通过，包含跨 event-loop turn 合并、pane 首次出现顺序、定时器取消、
  64 KiB 立即发送、旧 pane 输出先于 `SWITCH_ACK`、订阅替换前按旧路由发送；
- Gateway 完整测试 953/953 通过；
- Biome 对四个改动文件检查通过；
- Gateway 全量 `tsc --noEmit` 仍被仓库既有的 AI SDK、SSH 类型和旧 fixture 等基线错误
  阻断，本次改动文件未新增错误；
- 隔离 production source profile 使用 `vibex-gateway-prof-20260720-04` 独立 socket、
  同名非 `tmex` session、独立数据库和 29886 端口，测试结束后均已清理；
- 负载为每 2ms 一行终端输出、两个同时选中同一 pane 的 WebSocket 客户端。去掉前三个
  启动样本后，22 个稳定 CPU 样本平均 5.25%，最大 10.8%；
- native WebSocket `send` 自耗从上一轮 profile 的 25.1% 降至 9.5%，证明批次已跨越
  相邻 control stream I/O turn，而不是只合并单个 microtask。

进入 App 候选包前仍需完成 production managed 二进制构建与实机替换复验；实机必须确认
真实 Relay attach、终端交互、连接状态和持续 CPU 同时健康。
