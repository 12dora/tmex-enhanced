# T1D 结果 — 修复 R5 上行切换路径四项

## 结论

R5 四项均已按最小修复落地。提交点与 HTTP 状态只由实际 commit 结果决定；终止诊断写到真正下线的 URL；连接失败先按状态归一化；组合 abort 监听器有 cleanup。`uplink-pool.ts` 1572 行（allowlist 1597）。

策略（finding 1）：commit 之后 abort 算成功，不回滚。`promote` 发布 `live`/`attached` 后不再 `await old.stop()`，旧客户端清理为受跟踪的非阻塞任务。

## 测试

| 范围 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/mesh src/relay` | **1395 pass / 0 fail**（基线 1384；新增 11） |
| `bunx tsc --noEmit -p apps/gateway` | 0 errors |
| `bunx biome check --write`（仅触达文件） | 通过（6 files） |
| `bun run lint`（仓库根） | **通过**（complexity gate ok，1533 files / 13714 functions） |

聚焦：`uplink-pool.test.ts` + `uplink-pool-switch.test.ts` + `relay-routes.test.ts` → **93 pass / 0 fail**。

## 四项修复

1. **原子提交点（P1）**  
   `promote()` 写入 `live`/`attached` 后 `retireClient(old)`（`void old.stop()`，promise 记入 `retiring`，`pool.stop()` 等待）。abort 在 commit 之后是 no-op（`invalidateSwitch` 发现 `live === client` 直接返回）。  
   `runUplinkSwitch` 返回 `{ ok: true } | { ok: false, reason }`，不再抛分类错误。路由只根据该结果回 200/502，不再看 `ac.signal.aborted`。  
   测试：`promote 提交后旧客户端 stop 延迟，中止仍算切换成功`；`提交成功后调用超时仍记首选`。

2. **终止诊断写到实际下线 URL（P1）**  
   `waitActiveSession()` 返回 `{ publicUrl, reason }`；每次观察到 terminal error 立即 `persistTerminalError(current, current.hubUrl)`。  
   测试：挂在 B → 手动切到 A → A `missed-pong`：A 的 `lastError` 为 `missed-pong`，B 保持干净。

3. **连接失败路径归一化（P2）**  
   catch 中先分类：调用信号已中止 → `connect-timeout`；池已停 → `aborted`；token 过期 → `superseded`；否则保留底层错误。`superseded`/`aborted`/`stopped` 不写诊断。`beginSwitch()` 同时停掉旧 pending 连接。  
   测试：`switchTo 超时后迟到的连接不得 promote` 精确期望 `connect-timeout`；被取代的 `connect-failed` 记 `superseded` 且不污染目标诊断。

4. **组合 abort 不泄漏监听器（P2）**  
   `composeAbortSignals` 返回 `{ signal, cleanup }`；任一父信号中止时卸掉两侧监听器；`runUplinkSwitch` 的 `finally` 再调 cleanup。  
   测试：counting fake 上 N 次组合后 `added === removed`；带调用信号的 N 次成功切换后 pool stop 信号残留监听数不增长。

## 触达文件

- `apps/gateway/src/mesh/uplink-pool-switch.ts`（结构化结果、`composeAbortSignals`、错误归一化）
- `apps/gateway/src/mesh/uplink-pool-switch.test.ts`（新建）
- `apps/gateway/src/mesh/uplink-pool.ts` / `uplink-pool.test.ts`
- `apps/gateway/src/mesh/relay-switch-route.ts` / `relay-routes.test.ts`

未改：`uplink-pool-diag.ts`（`lastErrorCode` 仍由 status 层从 `lastError` 派生，无需落库）。

## 未做 / 不确定

- `uplink-pool.ts` 内部的 `anyAbort()`（wrap sleep / 探测 deadline）仍无 cleanup；R5 只要求切换路径。长期跑 failover wrap 仍可能在 stop signal 上留监听器直到池停止。
- 选择「commit 后报成功」而非回滚：旧客户端可能仍在异步 `stop()`，窗口内 `attachedHub()` 已是新 URL。
