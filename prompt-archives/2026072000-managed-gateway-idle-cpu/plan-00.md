# Plan 00：Managed Gateway 空闲 CPU 与生产环境契约

日期：2026-07-20

## 目标

1. 活跃终端稳定后不再以每秒三次 tmux 子进程维持状态。
2. 任意时刻最多执行一批完整 snapshot；并发请求合并为至多一次尾随刷新。
3. control mode 结构通知继续即时刷新；周期机制仅作为低频恢复看门狗。
4. managed standalone 无论调用构建脚本时继承何种环境，都以 production 契约构建。

## 实施顺序

1. 先写失败测试，定义“单飞＋一次尾随”的 snapshot 语义。
2. 写失败测试，限制默认恢复看门狗的空闲刷新频率，并验证无选中 pane 时停止。
3. 写产物/构建参数测试，证明 `NODE_ENV` 不会继承为 development。
4. 在 local 与 SSH runtime 实现相同的 snapshot 单飞状态机。
5. 将 1 秒完整快照轮询降级为 10 秒恢复看门狗；即时性继续由 control mode 通知负责。
6. 构建 managed Gateway，运行隔离测试并安装新的 Native 功能候选，比较修复前后 CPU、
   日志速率、健康状态与终端 attach。
7. 若实机仍存在高频工作，按子进程 argv 继续区分看门狗与事件驱动刷新；pane title
   只更新内存快照并合并广播，禁止触发完整拓扑快照。
8. 若子进程频率已受控但 CPU 仍高，检查 loopback WS 背压；统一处理 Bun send status，
   暂停慢 socket、在流出现缺口或持续背压时只隔离该客户端。
9. 若健康 socket 的活跃终端流仍造成高分配成本，在同一事件循环 tick 内按 device/pane
   合并输出并复用 payload 编码；批次必须有硬上限且不能改变 switch barrier 顺序。

## 验收

- 连续 snapshot 请求不产生并行批次，飞行期间任意数量请求最多追加一个批次；
- 默认稳定状态每分钟完整看门狗刷新不超过 6 次；
- 没有选中或订阅 pane 时不运行看门狗；
- `/healthz.env` 在 managed 产物中为 `production`；
- 连续 pane title 更新不启动 tmux 子进程，未知 pane 标题等待下一次结构快照吸收；
- 标题广播有界，local 与 SSH 语义一致；
- 慢 WS 消费者不会让 Gateway 持续发送；短暂无缺口背压可恢复，有缺口或超时只断开该
  socket；
- 同一 tick 的 pane 输出按字节顺序合并、单批不超过 64 KiB，连接释放不残留待 flush
  数据；
- 实机稳定终端场景 Gateway CPU 显著下降，且终端输入、输出、resize、断开恢复无回归。

## 风险

- 看门狗间隔拉长会放大 control mode 丢通知后的最坏恢复时间；10 秒是恢复兜底上限，
  正常 `%layout-change` 仍即时生效。
- 单飞不能吞掉飞行期间的新状态，因此必须保留恰好一次尾随刷新，而不是简单丢弃重复请求。
