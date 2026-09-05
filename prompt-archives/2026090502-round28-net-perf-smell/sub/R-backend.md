1. **P1 should-fix：手动停止后，异步自愈仍会重新启动隧道。**  
   位置：[edge-recovery.ts:49](/Users/konata/code/tmex-r28/apps/gateway/src/tunnel/edge-recovery.ts:49)、[manager.ts:1323](/Users/konata/code/tmex-r28/apps/gateway/src/tunnel/manager.ts:1323)。  
   **场景：**隧道零连接触发自愈，等待 DoH 时用户点击停止。停止会调用 `reset()`，但不会使在途恢复失效；解析完成后仍无条件调用 `restart()`，将已停止的隧道重新开放。内存桩已复现：`active=false` 后仍发生一次重启。  
   **建议：**给恢复操作增加 generation／取消机制；解析完成及停止旧进程之后都校验操作仍有效，确保手动停止优先。

2. **P1 should-fix：把完整长度的 `.part` 误当成已完成暂存，导致升级无法续传。**  
   位置：[remote-upgrade-job.ts:352](/Users/konata/code/tmex-r28/apps/gateway/src/system/remote-upgrade-job.ts:352)、[remote-upgrade-job.ts:415](/Users/konata/code/tmex-r28/apps/gateway/src/system/remote-upgrade-job.ts:415)。  
   **场景：**目标写完最后一个数据块、尚未提交正式包时进程退出，留下完整长度的 `.part`。重启后查询返回 `receivedBytes=totalBytes, complete=false`，入口却跳过 PUT，直接启动升级；目标因没有正式暂存包返回 `409 PACKAGE_NOT_STAGED`。再次尝试仍会命中同一状态。内存桩已确认实际调用只有 GET、POST。  
   **建议：**保留查询结果中的 `complete`，仅在明确为 `true` 时跳过推包；完整长度但未提交时，执行空体续传完成校验和提交，或重新上传。

3. **P1 should-fix：DoH 首选端点超时，会耗尽备用端点完成解析所需的预算。**  
   位置：[edge-resolver.ts:158](/Users/konata/code/tmex-r28/apps/gateway/src/tunnel/edge-resolver.ts:158)、[edge-resolver.ts:242](/Users/konata/code/tmex-r28/apps/gateway/src/tunnel/edge-resolver.ts:242)。  
   **场景：**系统返回 fake-IP，Cloudflare DoH 黑洞超时，Google DoH 正常。SRV 查询先消耗约 5 秒，再通过 Google 成功；随后 A 查询又从 Cloudflare 开始，耗尽剩余约 5 秒，Google 的 A 查询根本不会执行，最终无法绕行。注入时钟已复现请求顺序为 Cloudflare SRV → Google SRV → Cloudflare A。  
   **建议：**一次解析期间记住成功端点，后续查询优先复用，并跳过已经超时的端点；或并行查询并合理分配总预算。补充超时故障转移测试。

4. **P1 should-fix：自愈获得的静态边缘地址没有用于实际重启。**  
   位置：[manager.ts:1326](/Users/konata/code/tmex-r28/apps/gateway/src/tunnel/manager.ts:1326)、[provider.ts:246](/Users/konata/code/tmex-r28/apps/gateway/src/tunnel/provider.ts:246)。  
   **场景：**恢复解析成功得到静态地址，但 `restartWithEdge(edge)` 仅把它写入展示状态；`supervisor.start()` 随后让 provider 再次解析。若第二次 DoH 因网络抖动失败，实际进程仍不带 `--edge`，而恢复标志已经设为 `done=true`，零连接期间不会再自愈。  
   **建议：**将本次成功解析结果显式传入 supervisor/provider，直接用于此次 spawn；补充“恢复解析成功、后续解析失败”的测试。

5. **P2 nice：显式重试复用已锁定的请求体，第二次尝试必然失败。**  
   位置：[forwarder.ts:263](/Users/konata/code/tmex-r28/apps/gateway/src/mesh/forwarder.ts:263)、[forwarder.ts:283](/Users/konata/code/tmex-r28/apps/gateway/src/mesh/forwarder.ts:283)。  
   **场景：**取消升级调用 DELETE，并指定 `attempts: 2`。即使没有传 `body`，这里也会创建 `{}` 的 JSON 流。第一次尝试取得 reader 后发生链路中断，第二次复用该流，`openHttpStream()` 抛出 `ReadableStream is locked`，清理重试失效。已用实际流实现复现。  
   **建议：**每次尝试重新创建 JSON 请求体；`rawBody` 继续限制为一次。补充首次上传启动后断链、第二次成功的测试。

验证：相关只读测试共 **135 pass、0 fail**；另完成 **2630 次** codec 基线差分比较。上述边界不在现有测试覆盖内。

**无问题的部分：**codec 拆分与 1.1.30 既有帧兼容、node-id 归一化、shared async helpers、旧节点升级能力分支、暂存接口鉴权与参数校验、`.part` TTL 清理、tunnel-routes parseAction、tmux 粘贴流水线、WS 批发送与背压结算。