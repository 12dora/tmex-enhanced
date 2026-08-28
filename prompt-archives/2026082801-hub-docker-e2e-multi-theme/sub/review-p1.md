发现 5 个真实缺陷：

1. P1（高）— key-log 超时被误当成同步完成  
   [uplink-client.ts:522](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:522)、[uplink-client.ts:624](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:624)

   `requestKeyLog()` 超时后返回 `[]`，catch-up 随即跳出循环，并在本地仍落后于 `target.seq` 时调用 `finishNodeList()`。一次超过 10 秒的延迟即可让节点永久缺少后续 `admit-node`，直到 hub 恰好再次广播 `node.list`，直接复现本次修复针对的“学不到晚加入节点”。

   已验证的日志前缀可能已经落库，但未完成部分没有重试；迟到的 `key.log.res` 还可能被下一次无请求 ID 的请求误收。

   修复：让超时成为独立错误，不得调用 `finishNodeList()`；应带退避重试或断开 uplink 触发完整重连。最好给请求/响应增加关联 ID，或超时后关闭当前链路，避免迟到响应串请求。

2. P2（中）— 较旧 `node.list` 会在 catch-up 后覆盖较新的缓存  
   [uplink-client.ts:476](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:476)、[uplink-client.ts:500](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:500)

   V1 正在等待 key log 时收到 V2，V2 会立即写入新元数据；随后 V1 完成并再次执行 `persistAdmittedPeers(V1)`，把名称、endpoint、inventory 和 `listVersion` 回退。V2 又被串行 catch-up 阻塞，回退窗口可能达到 10 秒；期间拨号会使用旧 endpoint，进程退出还会把旧值留在磁盘。

   修复：记录当前连接代次下最新收到的 list，旧任务完成时只持久化最新快照，或直接跳过已被更新 list 取代的 `finishNodeList`。不要仅依赖持久化的 `listVersion` 比较，因为 hub 重启后版本会从零开始。

3. P2（中）— `reach:'relay'` 是推测值，不是实际链路状态，并与实时事件冲突  
   [mesh-runtime.ts:880](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:880)、[mesh-runtime.ts:765](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:765)

   hub 的 `online` 快照只能说明目标当时有 uplink，不能证明 SecureChannel relay 握手成功。overlay 会在尚未调用 `getLink()` 时向 UI 报告实际路径为 relay；目标刚掉线、握手失败或稍后建立 LAN 链路时，徽标都会失真。

   此外 `onNodeList` 发出的 `NODE_EVENT` 没有 `reach`，编码后为 `null`，前端会把刚由 GET 得到的 relay/lan 清掉，造成状态反复。它不影响 `PeerManager.getLink()` 的信任检查，但会误导在线状态和路径诊断。

   修复：把 hub presence 与实际 `reach` 分成两个字段；`online` 可来自 node list，`reach` 只来自已建立链路。若保留 overlay，至少不要称其为实际 relay 路径，并让事件与 GET 使用一致语义。

4. P2（中）— 认证完成前的 `node.list` 可以持久化 `hub_meta`  
   [uplink-client.ts:337](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:337)、[uplink-client.ts:398](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:398)、[uplink-client.ts:466](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:466)

   link 在认证前已绑定 ctl handler，`handleCtl` 对 `node.list` 没有阶段检查。服务端可先发 list、随后让认证失败，伪造的 hub node ID/public URL 仍会写入磁盘，并被 `/api/auth/mode` 和 join 命令生成逻辑使用。

   这不会注入证书或直接取得其他节点权限，但属于持久状态污染。

   修复：为当前 connection generation 维护明确的 authenticated 标志；仅在处理过 `auth.ok` 后接受 `node.list`、key-log、RTC 和 enrollment 帧，断线时清除。不能简单检查 `state === 'online'`，因为合法首个 list 紧跟 `auth.ok`，可能早于异步状态切换。

5. P3（低）— ctl 解码/处理失败仍被完全静默吞掉  
   [uplink-client.ts:337](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:337)

   本次根因正是一次协议字段不兼容导致整帧丢弃；现有 catch 会让同类回归再次表现为“hub 不广播”，没有任何诊断信息，还会吞掉 handler 内的数据库异常。

   修复：区分 decode 错误和 handler 错误，输出限频告警，记录消息类型、长度和错误原因，不记录完整敏感载荷；连续 malformed 帧可关闭连接。

证书信任边界本身未被削弱：未知、跨用户或已撤销节点仍无法进入 `peer_cache`，`getLink()` 仍要求本地有效证书，key-log 仍逐条验签。因此恶意 hub 只能污染元数据或阻断同步，不能凭 `node.list` 获得其他节点访问权。

验证：两个目标单测文件 17/17 通过；新增晚加入节点集成测试单独运行 1/1 通过。完整集成文件在沙箱的既有 `Bun.serve({port: 0})` 处因 `EADDRINUSE` 无法跑完。

Verdict：Request changes。10 秒超时的错误完成语义必须在合并前修复。