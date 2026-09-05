1. **P1 should-fix：心跳失活连接进入排空后，退役截止时间失效。**  
   位置：[apps/gateway/src/mesh/peer-manager.ts:1573](/Users/konata/code/tmex-r28/apps/gateway/src/mesh/peer-manager.ts:1573)、[同文件:1788](/Users/konata/code/tmex-r28/apps/gateway/src/mesh/peer-manager.ts:1788)。

   **失败场景：** ws-secure／relay 连接存在未结束的流，网络黑洞导致连续丢失心跳，但底层尚未报告关闭。新增分支将连接转入 `retiring` 并停止 ping；`maybeFinishRetire()` 却在 `streams > 0` 时直接返回，永远检查不到 30 秒上限。在途流因此无法及时收到关闭通知并触发 failover，只能等待其他层超时，连接资源也继续保留。纯内存复现中，推进 **100 个退役截止周期**后，连接仍未关闭、流数仍为 1。

   **建议：** 为 `missed-pong` 退役设置独立硬截止，在流数判断之前执行；到期关闭旧 session，让在途流进入已有失败切换流程。补充“流始终不结束”的测试。

2. **P1 should-fix：统一改用 16 KiB 分片后，浏览器会拒收合法大帧并关闭直连。**  
   位置：[apps/gateway/src/mesh/rtc/fragmenter.ts:49](/Users/konata/code/tmex-r28/apps/gateway/src/mesh/rtc/fragmenter.ts:49)。接收限制位于 [packages/ws-client/src/direct/fragmenter.ts:98](/Users/konata/code/tmex-r28/packages/ws-client/src/direct/fragmenter.ts:98)。

   **失败场景：** 浏览器已切换到 DataChannel，Watch 规则 `[\s\S]+` 匹配包含 150,300 字符的屏幕，且未开启摘要。通知同时包含消息文本和 `matchedText`，实际编码得到 **301,581 字节、19 个分片**。浏览器接收器仍只允许 17 片，首片即触发 `bad-total`，关闭直连并丢失通知。已用实际 Watch 通知和 Borsh 编码路径复现；当前浏览器代码与旧浏览器均受影响。

   **建议：** 发送端继续满足旧接收器的 17 片限制：大帧采用较大分片，或降低浏览器 Borsh 帧的切块上限。仅提高新版接收器上限无法兼容旧浏览器。补充 gateway → 浏览器的大帧交叉测试。

验证：相关定向测试 191 项通过；bulk 文件测试因只读环境无法创建临时目录，未完成验证。

**无问题的部分：** RTC answer／epoch 过滤及拨号清理、节点间普通 DATA 分片兼容、uplink 排空切换、relay 令牌桶与 RST 分类、WS 重连唤醒及监听清理、cork 发送状态、粘贴流水线顺序。