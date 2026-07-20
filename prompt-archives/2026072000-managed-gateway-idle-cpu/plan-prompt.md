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

## `.26` 实机 Gate 失败与第二轮语义（2026-07-20）

`0.1.2-local.26` 由 App 正常启动维护流程安装，未手工停止、重启或 signal
Companion/Gateway。App→Relay、Companion→Relay、本地 Companion、system tmux `3.7b`
及本地终端首帧均健康，但 managed Gateway 的 30 个连续样本仍为平均 22.13% CPU，
范围 12.6%～31.5%，因此 8ms 候选没有通过实机 Gate。

只读取证显示：

- Gateway 有 6～7 条来自 Companion 的 loopback WebSocket；
- 稳态实际出站约 20～24 KiB/s，其中两个 Relay attach 各约 10～12 KiB/s；
- macOS `sample` 显示主线程和 JSC heap helper 都持续活跃，没有 spawn 热回路；
- Gateway 当前会为 control stream 上每个 pane 的输出建立定时批次，直到 flush 时才判断
  是否存在选中或订阅该 pane 的客户端。未被任何客户端观察的 pane 仍产生 timer、chunk
  拼接和 GC 工作；
- 小于单帧上限的实时输出仍逐客户端进入通用 chunk 分支，产生可避免的短命对象。

下一轮按最佳实践先行：

1. 在进入 `TerminalOutputBatcher` 前按当前 selected/subscribed 状态丢弃无人观察的 pane
   输出；后续 select 仍以 history/barrier 恢复屏幕，不能依赖此前无人消费的实时增量。
2. 将默认批次窗口对齐一帧，最多 16ms；select/subscription 继续显式 flush，64 KiB
   上限保持不变。
3. 小 payload 直接编码 envelope，只有超过协商单帧上限时才创建 chunk stream。
4. 测试必须证明无人观察输出不会进入 batcher、选中和附加订阅仍收到完整有序字节、
   select/subscription 边界不变。
5. 再跑多客户端隔离 production profile，并安装新候选复测相同真实 Relay attach；
   只有实机 CPU 与终端语义同时通过才关闭本 Gate。

## 第二轮隔离验证结果（2026-07-20）

实现结果：

- `broadcastTerminalOutput` 在创建定时批次前检查当前设备是否至少有一个客户端选中或
  订阅目标 pane；无人观察的增量直接丢弃，后续选择仍由既有 history/switch barrier
  恢复屏幕；
- 默认批次窗口从 8ms 调整为 16ms，64 KiB 硬上限及 select/subscription 前显式 flush
  保持不变；
- 小于协商单帧上限的 payload 直接编码普通 envelope，只有超限时才创建 chunk stream；
- 共享 `clientWantsPaneOutput` 判定，确保进入 batcher 和最终逐客户端投递使用相同语义。

测试与性能证据：

- 新增失败测试先证明旧实现会为无人观察的 pane 入队、默认窗口不是 16ms，且没有单帧
  fast path；实现后定向测试 58/58 通过；
- Gateway 完整测试 961/961 通过，共 2746 个断言、94 个测试文件；
- Biome 对四个改动文件通过；全量 TypeScript 检查仍只有仓库既有 AI SDK、SSH、旧
  fixture 与 BufferSource 基线错误，本次未增加错误类别；
- 首次尝试直接运行 `managed-entry.ts` 时被嵌入式迁移资源门禁拒绝，未进入性能阶段；
  测试端口和专用 tmux socket 均已清理，没有把该结果误记为 profile；
- 随后用 `build-managed.ts` 编译与发布形态一致的 darwin-arm64 standalone，在独立
  数据库、29888 端口和 `vibex-gateway-prof-20260720-06` 专用 tmux socket/session
  下运行；
- 负载为每 2ms 一行输出、7 个客户端同时选择同一 pane、持续 30 秒；共收到 8239 个
 终端帧、1,070,181 字节；
- managed Gateway 的 25 个逐秒 CPU 样本平均 3.74%，最低 1.9%、最高 9.3%；health
  同时确认 production 环境和 system tmux `3.7b`；
- 29888 listener、测试 Gateway、客户端和专用 tmux server 在结束后全部清理，未访问
  默认 tmux socket、未操作 `tmex` session，也未 signal 常驻 Companion/Gateway。

隔离性能 Gate 已通过。下一步必须把同一源码打入 App 候选，由 App 启动维护和 launchd
正常 reconcile 后，在真实 Relay attach、终端输入输出和恢复提示同时存在的最终用户
形态下复验；隔离结果不能替代 installed managed Gate。

## `.27` 实机 Gate 再次失败（2026-07-20）

tmex `6332699` 经 vibex `785dbe7` 打入 `0.1.2-local.27`。App 正常退出、备份式替换后，
由 App 自行 reconcile 统一安装目录和 launchd；没有手工 signal Companion/Gateway。
安装 slot、候选 payload 中的 `tmex-gateway` SHA-256 完全一致，均为
`f6137d7a15de2d917c7252d62b14fbf82a3db5484ffb5abc67ec3bdec3618f36`，因此排除安装了
旧二进制。

运行态确认 App→Relay、Companion→Relay、本地 Companion、system tmux `3.7b` 和本地
终端首帧全部健康。但真实 managed Gateway 的 30 个逐秒样本平均 24.64% CPU，范围
17.3%～32.7%，第二轮仍未通过实机 Gate。同期 `nettop` 显示约 31～40 KiB/s 出站，
常驻 control-mode tmux 子进程自身为 0% CPU；8 秒 `sample` 仍显示工作集中在 Gateway
主线程/JSC，而不是 tmux 子进程或新的 spawn 热循环。

隔离与实机的关键差异现在收敛为真实 control stream 的事件碎片形态，而不是总吞吐：

- 受控 profile 每 2ms 产生一条完整输出，约 500 个事件/秒；
- 真实 TUI 可能以大量很小的 `%output` 片段产生相似字节吞吐；
- 当前 batcher 对每个片段创建 `subarray` view 并保存到数组，flush 时再分配并拼接；
- 实机前置兴趣检查还会为每个片段执行 `Array.from(entry.clients)`，产生额外短命数组；
- 16ms 降低了最终发送频率，但没有限制进入批次前的每事件分配。

下一轮按最佳实践先行：

1. 增加低频、无 pane 内容和无设备标识的终端流量计数，区分 source event/bytes、
   dropped event/bytes、batch/bytes 和 recipient delivery/bytes；日志只进入 Gateway
   运维日志，不输出到普通 CLI 文案。
2. 兴趣检查改为零分配迭代，禁止每个 output 复制客户端集合。
3. batcher 改为单个按需增长、上限 64 KiB 的连续缓冲区，push 时直接复制字节，禁止
   为每个碎片保存 `Uint8Array` view；达到上限立即 flush，16ms deadline 和所有路由
   barrier 保持不变。
4. 先写失败测试证明输入 buffer 后续修改不能污染批次、超多微小片段只持有一个有界
   backing buffer，再用碎片化负载 profile，而不是只测完整行。
5. 新候选实机日志必须先量化事件碎片率，再以同一真实负载复测 CPU；未通过前不得把
   `.27` 隔离数据当作完成证据。

## 碎片输出分配修复（2026-07-20）

失败测试已经分别证明旧实现会保留调用方的可变输入 view、为 10,000 个单字节片段保留
10,000 个 view/数组项，并在每个 output event 上调用 `Array.from(entry.clients)`。
实现改为单个按需增长、上限 64 KiB 的 owned buffer 和 Set 原地早停迭代，同时增加
30 秒窗口的匿名分层计数：

- source events/bytes；
- 未被任何 pane 订阅观察到的 dropped events/bytes；
- 合并后的 batches/bytes；
- 实际成功进入发送路径的 recipient deliveries/bytes。

目标测试 63/63、Gateway `apps/gateway/src` 全量回归 961/961、Biome 与 diff check
通过。仓库级 `tsc` 仍报告既有 AI SDK、SSH fixture 与 Bun `BufferSource` 基线错误，
本轮新增模块没有新增错误。该提交只关闭语义和回归 Gate；CPU Gate 必须由下一候选在
真实 App/Relay attach 下用上述计数和逐秒采样关闭。

## `.28` 指标推翻碎片假设（2026-07-20）

tmex `0ce5366` 经 vibex `91d7c73` 打入 `0.1.2-local.28`，由 App/launchd 正常
reconcile。连接、system tmux 和本地终端 Gate 全部健康，但 30 秒 CPU 仍平均 26.58%，
范围 21.4%～30.7%，因此性能 Gate 不通过。

第二个稳定 30 秒指标窗口：

```text
source_events=869 source_bytes=219979
dropped_events=0 dropped_bytes=0
batches=858 batch_bytes=219979
recipient_deliveries=2574 recipient_bytes=791211
clients=4 devices=1
```

这相当于约 29 个 source event/s、7 KiB/s，batch 与 source event 几乎 1:1，三个
观察者约 86 次 delivery/s；并不存在此前猜测的高频微碎片。`lsof` 证明 Gateway 的
6 条 loopback TCP 都由 Companion 持有；其中指标可见 4 条已协商、3 条观察同一 pane。
唯一 tmux control 子进程为 0% CPU。8 秒 macOS sample 中主线程仍有 JSC 活动，三个
Heap Helper Thread 各出现约 525/4668 个活跃样本，分配/回收仍是显著成本。

下一轮诊断要求：

1. 记录 raw control chunks/bytes 与 parser 输出、title、notification、structure 数量，
   判断是否有大量被吞掉的控制序列；
2. 记录 snapshot、terminal history、tmux event 与入站 WS kind，排除 source output
   指标之外的高频路径；
3. 记录匿名 `clientImpl` 计数和 pane 观察者数量，判断三路 fanout 是正常多端订阅还是
   Companion attach 泄漏；
4. 诊断仍保持 30 秒低频、无 device/pane/content；未定位前不再调整 16ms deadline。

## 分层诊断实现与回归（2026-07-20）

按上述要求增加两组只读、30 秒窗口指标：

- managed control client 记录 raw chunk/bytes、control output/bytes、剥离控制序列后的
  terminal output/bytes，以及 title、bell、notification、structure change 和 block；
- Gateway 记录入站消息 kind/bytes、snapshot 实际投递、terminal history 路由尝试、
  tmux event 路由尝试和匿名客户端类型桶。

日志不包含 device、pane、账号、终端内容或任意 payload；`clientImpl` 只在内存保留最多
64 字符，输出仅分为 `tmex-fe`、`vibex-companion`、other 和 unnegotiated。无法由当前
API 确认成功发送的 history/event 明确命名为 `delivery_attempts`，避免把路由尝试误报
成网络投递成功。control stream 指标只在 externally managed runtime 启用，普通开源
Gateway 路径不创建 collector。

验证结果：

- 定向回归 135/135 通过；
- Gateway `apps/gateway/src` 全量回归 967/967，通过 2756 个断言、95 个测试文件；
- Biome 对 10 个改动文件通过，diff check 待提交前执行；
- Gateway 全量 `tsc` 仍有仓库既有 AI SDK、SSH fixture、旧测试类型和 Bun
  `BufferSource` 基线错误；新增 metrics、subscription 文件没有错误，`index.ts`、
  `codec-borsh.ts` 和 `local-external-connection.ts` 的报告行均为本轮未修改的既有
  基线位置。

该提交只提供定位证据，不宣称修复 CPU。下一步从干净提交构建 `.29`，只经 App/launchd
reconcile 后读取三类指标并在同一 30 秒窗口采样 CPU，再依据实际归属设计修复。
