1. **P1 — 取消与 promote 不是原子操作，可能返回 502 但实际已切换。**  
   [uplink-pool-switch.ts:85](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-switch.ts:85)、[uplink-pool-switch.ts:105](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-switch.ts:105)、[uplink-pool.ts:888](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:888)、[relay-switch-route.ts:68](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/relay-switch-route.ts:68)  
   `promote()` 先把新客户端写入 `live`/`attached`，随后才 `await old.stop()`。若信号在这个 await 期间中止，`invalidateSwitch()` 因 `liveClient() === client` 不会停止新客户端；promote 返回后又没有重新检查 token/signal。池调用可能在中止后仍成功，路由则因为 `ac.signal.aborted` 返回 502，并留下已经切换但未持久化 preferred URL 的状态。  
   最小修复：明确原子提交点。发布新 `live` 后不要再阻塞于旧客户端清理，可将 `old.stop()` 改为受控的异步清理，使 promote 在同一执行段内完成；或者让 promote 返回提交结果并在中止获胜时回滚。路由应以提交结果决定 200/502，保证不会出现“502 但已切换”。

2. **P1 — 终止诊断会写到手动切换前的旧 URL。**  
   [uplink-pool.ts:787](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:787)、[uplink-pool.ts:1026](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.ts:1026)  
   `waitActiveSession()` 会随着 `this.live` 的替换继续等待新的客户端，但只返回错误字符串；调用方始终用最初进入 `tryCandidate()` 的 `cand` 写诊断。比如启动循环连接 B，手动切到 A 后 A 因 `missed-pong` 断开，错误会记到 B；finally 中因为 `live !==` 最初的 B，也不会再为 A 调用 `persistTerminalError()`。  
   最小修复：让 `waitActiveSession()` 返回 `{ publicUrl: current.hubUrl, reason }`，并按实际终止客户端的 URL 写入；更稳妥的是在循环内每次观察到 terminal error 时立即持久化，再决定是否跟随替换后的 live。

3. **P2 — 连接抛错路径绕过取消/取代状态归一化。**  
   [uplink-pool-switch.ts:61](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-switch.ts:61)、[uplink-pool-switch.ts:102](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-switch.ts:102)  
   token 和 signal 只在 `connectCandidate()` 成功返回后检查。若旧切换已被新切换取代，但其连接随后抛出 `connect-failed`，旧请求仍抛该底层错误并污染目标 URL 的诊断，而不是 `superseded`。同理，调用超时令连接抛出 `aborted`/`stopped` 时，池不会归一化为 `connect-timeout`，且 `noteSwitchFailure()` 会跳过诊断；只是路由层碰巧将其遮蔽成超时。  
   最小修复：catch 中先根据状态归一化错误：调用信号已中止为 `connect-timeout`，pool 已停止为 `aborted`，token 已过期为 `superseded`，最后才保留底层连接错误；再统一记录和抛出。新切换开始时最好同时取消旧 pending 连接。另将 [uplink-pool.test.ts:1118](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool.test.ts:1118) 的三选一正则改为精确期望 `connect-timeout`，否则该回归仍会被测试接受。

4. **P2 — 每次带调用信号的切换都会向长期存活的 pool signal 泄漏监听器。**  
   [uplink-pool-switch.ts:48](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-switch.ts:48)、[uplink-pool-switch.ts:172](/Users/konata/code/tmex-r27/apps/gateway/src/mesh/uplink-pool-switch.ts:172)  
   `anyAbort()` 在两个父信号上安装监听器，但成功完成时二者都不会中止；`finally` 只移除了单独的 `onAbort`，没有清理 `anyAbort()` 的监听器。即使调用信号超时，其对应监听器只会自行移除，pool stop signal 上的监听器仍保留到整个池停止。长期运行中反复切换会持续积累监听器。  
   最小修复：让组合函数同时返回 cleanup，并在 `runUplinkSwitch()` 的 finally 中从两个父信号移除监听器；任一父信号中止时也立即移除另一侧监听器。