# CAN：Canonical State 客户端迁移执行计划

## 背景

ws-borsh v1 同时保留 legacy tmux state 多消息流和 `canonical-state-v1` 单有序流。服务端 canonical feed 已完整实现，共享 schema 已固定，客户端已有事件解码但没有命令编码与消费 wiring。本任务需在不改变 UI/store 形状、不删除 legacy fallback 的前提下打通 canonical 主路径，并验证 mesh failover 的 cursor replay。

## 注意事项

- 当前 worktree 有其他 agent 的未提交改动；只改本任务文件，不整理、不覆盖无关状态。
- `apps/gateway/src/ws/index.ts` 是共享文件；除非 wiring 无法从其他 seam 完成，否则不修改。
- wire schema、discriminator 和协议版本不可改；canonical frame 不得走 generic CHUNK。
- 所有测试使用 Bun；不启动 dev server，不接触生产安装或默认 tmux session。

## 计划

1. 对照协议、共享 schema、服务端 session、客户端 transport/store，列出精确命令/事件状态机和现有入口。
2. 设计并实现 canonical command encoder、capability/kill-switch feed 选择与 diagnostics 暴露，补 golden/gate 测试。
3. 实现客户端 canonical 事件协调器：订阅 ACK/拒绝、epoch、gap、metadata/pane delta，以及 screen/history 事务组装与重同步信号。
4. 将订阅、input、resize、screen/history consumer 按 active feed 路由；保持 legacy fallback 与现有 store/UI payload 不变。
5. 补 client↔server round trip 与 mesh replay/failover 测试，确认 canonical replay 分支及 cursor 行为。
6. 运行相关包定向测试、完整测试、TypeScript、Biome；复核 diff 与并行改动边界。
7. 写 `CAN-result.md`，记录设计、legacy 保留项、replay 核验、实测结果与 reviewer 风险。

## 验收标准

- capability 支持且 kill switch 开启时，主数据路径实际发送/消费 0x0901/0x0902；其他情况逐项维持 legacy。
- gap、epoch 切换、拒绝和事务不完整均不会静默产出错误状态，能触发确定性的重同步。
- canonical payload/frame 遵循共享 schema 与 32 KiB/effective max 限制。
- 新旧路径测试覆盖，相关 package 测试/tsc/biome 不低于给定基线。

## 风险

- HELLO 到订阅建立之间的时序可能造成首次 legacy/canonical 双发或漏订阅。
- canonical delta/transaction 到 legacy store shape 的映射若顺序不一致，可能造成终端历史重复或丢失。
- mesh carrier 切换时 epoch/cursor 的作用域必须与服务端 replay state 一致。
- effective max frame 较小时，命令编码必须在发送前拒绝超限，不能依赖 generic chunk。
