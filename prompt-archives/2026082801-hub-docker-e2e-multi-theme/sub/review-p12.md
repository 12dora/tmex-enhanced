结论：**Request changes。** P11 的 P1 已关闭：Hub 入站恒定限制 64 KiB，默认拒绝 `key.log.res`，认证前仅接受 `auth.response`。

1. **P2 — `HUB_CTL_QUEUE_MAX=8` 会误杀合法 CTL 突发。**  
   [uplink-server.ts:531](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:531)、[mux.ts:195](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/link/mux.ts:195)、[rtc-peer-manager.ts:512](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:512)

   一个正常 `key.log.req` 阻塞于 `keyLogSource.list()` 时，8 个并发 WebRTC 会话各自产生一条 local-description `rtc.signal`。请求占用一个槽位，前 7 条信令填满队列，第 8 条在 `q.depth === 8` 时触发 `ctl-overflow`，中断 uplink、key-log catch-up 和 RTC。

   这些小帧远低于 mux 的 1 MiB 初始窗口，因此 WINDOW 延迟尚未形成背压，消息数硬顶已经先断链。节点允许 64 个并发 browser authorization，Hub 允许 1024 个 RTC session，故 8 不是合法协议突发上限。建议改用累计字节上限，或显著提高消息数上限并保留字节背压。

未发现其它新增 P1/P2。补丁与提交 diff 的 SHA-256 一致；相关 5 个测试文件 fresh 运行结果：**95 pass / 0 fail**。