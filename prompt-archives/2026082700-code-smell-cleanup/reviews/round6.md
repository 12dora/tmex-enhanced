## 1. [低｜确定] delta flush 测试无法验证 flush 与工具事件的先后顺序

[run-stream-handlers.test.ts:8](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run-stream-handlers.test.ts:8) 将 `flush` 和广播分别记录到 `queued`、`broadcasts` 两个数组，最终也分别断言。因此，即使把 [run-stream-handlers.ts:37](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run-stream-handlers.ts:37) 改成先广播 `tool-call`、再 flush pending delta，该测试仍会通过。

原实现明确要求 pending text/reasoning delta 先于工具事件发出，否则客户端可能先看到工具调用，再收到其前面的文本。验证方式：临时交换任一工具 handler 中 `flush()` 与 `broadcast()` 的顺序，运行 `bun test ./src/agent/run-stream-handlers.test.ts`；现有断言不会失败。测试应使用同一个事件时间线断言跨 sink 顺序。

## 2. [低｜确定] stream-loop 测试无法验证 watchdog 在 dispatch 前重置

[stream-part-router.test.ts:109](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/stream-part-router.test.ts:109) 分别用 `events` 记录 watchdog 调用、用 `hits` 记录 handler 调用。把 [stream-part-router.ts:41](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/stream-part-router.ts:41) 的 `watchdog.reset()` 移到 `dispatchStreamPart()` 之后，两组断言仍完全相同，无法保护原实现“收到 part 后先重置 watchdog，再处理 part”的重置点。

验证方式：临时交换这两行并运行 `bun test ./src/agent/stream-part-router.test.ts`；现有测试仍会通过。应在同一时间线中断言 `reset → handler`。