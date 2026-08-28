审查结论：**Request changes / 暂不建议合入**。发现 3 个真实缺陷。

- **P1：链路替换会丢失已发送但尚未到达对端的旧链 stream。**  
  [peer-manager.ts:847](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:847)、[peer-manager.ts:885](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:885)、[peer-manager.ts:1152](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1152)。  
  `retirePeer()` 只依据本端已经观察到的 `streams` 决定是否立即关链；但 `LinkMux.openStream()` 返回只代表 `OPEN` 已写入载体，不代表对端已处理。若后台升级恰好发生在这段窗口，对端看到旧链 `streams === 0` 后立即以 `replaced` 关闭，或把稍后到达的 `OPEN` 以 `stale-link` 重置。只读反例稳定得到 `link-closed/replaced`。这会中断并发打开的 HTTP、WebSocket、终端或文件流。  
  修复需要旧链上的有序 drain/quiesce 屏障：停止新建旧链 stream 后发送 fence，对端处理完 fence 前的全部 `OPEN` 并确认，双方再等待 stream 归零后关闭。现有 [peer-manager.test.ts:701](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.test.ts:701) 使用同步内存链，无法覆盖延迟投递窗口；应补 delayed transport 以及单边、双边同时升级测试。

- **P1：端点变化可完全绕过 10 秒冷却，且没有全局升级拨号并发上限。**  
  [peer-manager.ts:393](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:393)、[peer-manager.ts:476](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:476)、[peer-manager.ts:277](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:277)。  
  只有 endpoints 原始 JSON 完全相同时才检查冷却；变化时直接拨号。已认证 peer 交替发送两个 endpoint 值，LAN 连接快速失败后即可立即再次触发。我在固定 `scheduler.now()` 的情况下连续变更 20 次，实际产生 20 次拨号。稳定失败时，15 秒扫描也会让所有 relay peer 同时重试，因为扫描间隔大于冷却。`pending` 只能保证单 peer 同时一个，并不是聚合并发上限。  
  应对所有触发应用最小间隔，失败后使用带 jitter 的指数退避，并设置全局拨号 semaphore；pending 期间发生的变化应合并为一次后续尝试。还应限制 peer `node.status` 的 endpoint 数量与长度。新增测试只覆盖“相同 endpoints 的连续通知”，没有覆盖交替 endpoints、多 peer 周期扫描或全局并发。

- **P2：全局 status 去重会使部分 live peer 永久漏收 endpoint 更新。**  
  [peer-manager.ts:403](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:403)、[peer-manager.ts:1069](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/peer-manager.ts:1069)。  
  `lastAdvertisedStatusJson` 对所有 peer 共用，而 `track()` 向任意一条新链调用 `sendPeerStatus()` 时就会更新它。场景：A 同时连接 B、C；A 的 endpoints 改变；B 恰好重建链并收到新 status；随后周期刷新认为 status 已发送，不再通知仍持有旧值的 C。只读反例显示 B 收到 `new`，C 始终停留在 `old`。hub 离线后，C 后续断链只能拨旧地址，无法重连。  
  应将最后发送的 status hash 放进每个 `LivePeer`，逐链去重；或者只有完成向全部 live peer 广播后才更新全局快照。需增加三节点测试，覆盖“状态变化期间只重建其中一条链”。

升级拨号确实复用了 `handshakeWsDirect`，包含证书、节点 ID 和 transcript 签名校验，没有发现新增的信任绕过。新扫描 timer 也在 `stop()` 中清理，共用的 abort signal 会取消在途拨号；这两项不是阻塞问题。