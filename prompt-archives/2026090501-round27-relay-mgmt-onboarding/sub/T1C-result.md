# T1C 结果 — backend review fixes + file splits

## 结论

R4 六项均已按最小修复落地；`relay-routes.ts` / `relay-uplink-client.ts` 已拆到 600 行以下。根目录 `bun run lint` 通过（复杂度门禁 ok）。

## 测试

| 范围 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/relay src/mesh` | **1384 pass / 0 fail**（基线 1376；新增 8） |
| `bunx tsc --noEmit -p apps/gateway` | 0 errors |
| `cd packages/api-client && bun test` | **222 pass / 0 fail**（基线 220；新增 `switchRelay` 502 details 1 条，另 1 条为并行 agent 改动） |
| `bunx tsc --noEmit -p packages/api-client` | 0 errors |
| `bunx biome check --write`（仅触达文件） | 通过（18 files，Fixed 4） |
| `bun run lint`（仓库根） | **通过**，见下方摘录 |

## Part A — 六项修复

1. **切换超时真正取消**  
   `UplinkPool.switchTo(url, signal?)` 把调用级 `AbortSignal` 与 pool stop signal 合成。超时使本次 `switchToken` 失效、停掉 pending client、等待清理后再抛 `connect-timeout`。路由不再 `Promise.race` 丢弃底层连接。  
   测试：`switchTo 超时后迟到的连接不得 promote`；`超时后连接成功也不得写入首选`。

2. **被取代的 `switchTo` 不再静默成功**  
   token 失效 / 未挂上目标时抛 `superseded`（或超时的 `connect-timeout`）。路由 200 前校验 `attachedHub()` 等于请求 URL 且 live online；首选 URL 只在这次成功路径写入。  
   测试：`older switchTo must not promote` 现期望 `rejects.toThrow('superseded')`；`被并发切换取代的请求不得写成首选`。

3. **在线链路终止错误写入 per-URL 诊断**  
   `waitActiveSession` 返回终止 reason；`tryCandidate` finally 在 `clearLive` / `stop()` 前把非 `stopped`/`aborted` 的 `lastConnectError` 写入 `diagByUrl`。客户端 `bindLink` 在远端 close 时保留 close reason。  
   测试：heartbeat-lost / kicked 写入 candidate `lastError`；status 行 `lastErrorCode` 为 `heartbeat-lost` / `kicked`；远端 `heartbeat-timeout` 保留在 `lastConnectError`。

4. **分类器**  
   `heartbeat[-_]timeout → heartbeat-lost`（排在泛化 timeout 之前）；`unknown-tenant → auth-rejected`；`protocol[_-]error → protocol`；kick/close 覆盖 `relay-kicked` / `relay-password_rotated` / `relay-revoked` / `relay-tenant-gone`。  
   测试：对 `relay-uplink-auth.ts` + `relay-uplink-server.ts` 全部实际 close/reject reason 做表驱动。

5. **`RelayApiError.details`**  
   可选 `{ lastError?, lastErrorCode? }`；tenant `readError` 从 502 `{ code, lastError, lastErrorCode }` 填入。  
   测试：`switchRelay 502 保留 lastError / lastErrorCode`。

6. **`lastUsagePush` 泄漏**  
   `RelayUplinkServer.forgetTenant` 删条目；`handleRelayTenantDelete` 调用；`stop()` 清空 Map。  
   测试：`删除租户清掉 lastUsagePush；stop 清空整表`。

## Part B — 复杂度拆分

| 文件 | 行数 |
|---|---|
| `apps/gateway/src/mesh/relay-routes.ts` | 573（原 646） |
| `apps/gateway/src/mesh/relay-switch-route.ts` | 94（新建：switch 路由 + `RelayUplinkView`） |
| `apps/gateway/src/mesh/relay-uplink-client.ts` | 491（原 609） |
| `apps/gateway/src/mesh/relay-uplink-ctl.ts` | 257（新建：认证后 ctl / list / status / auth） |
| `apps/gateway/src/mesh/uplink-pool.ts` | 1564（allowlist 1597，未超） |
| `apps/gateway/src/mesh/uplink-pool-switch.ts` | 190（新建：`runUplinkSwitch`） |

公开名保持：`RelayRoutes`、`RelayUplinkView`、`RELAY_SWITCH_TIMEOUT_MS`、`RelayUplinkClient`、`UplinkPool.switchTo`。行为变化仅限 Part A。

## 触达文件

**新建**

- `apps/gateway/src/mesh/relay-switch-route.ts`
- `apps/gateway/src/mesh/relay-uplink-ctl.ts`
- `apps/gateway/src/mesh/uplink-pool-switch.ts`

**修改**

- `apps/gateway/src/mesh/uplink-pool.ts` / `uplink-pool.test.ts`
- `apps/gateway/src/mesh/relay-routes.ts` / `relay-routes.test.ts`
- `apps/gateway/src/mesh/relay-uplink-client.ts` / `relay-uplink-client.test.ts`
- `apps/gateway/src/mesh/relay-link-error.ts` / `relay-link-error.test.ts`
- `apps/gateway/src/mesh/relay-wiring.ts`
- `apps/gateway/src/relay/relay-uplink-server.ts` / `relay-uplink.test.ts`
- `apps/gateway/src/relay/relay-admin-routes.ts`
- `packages/api-client/src/relay/admin-api.ts`（仅 `RelayApiError`）
- `packages/api-client/src/relay/tenant-api.ts` / `tenant-api.test.ts`

## `bun run lint` 尾部

```
Checked 2665 files in 1034ms. No fixes applied.
complexity near limit: apps/gateway/src/mesh/relay-routes.ts: 574 lines (limit 600)
…（其它 near-limit 警告与本任务无关）
complexity gate ok (1533 files, 13712 functions)
```

（biome 后再测 `relay-routes.ts` 为 573 行；警告不失败。）

## 未做 / 不确定

- `relay-routes.ts` 仍在 90% 警告带（573/600），lint 不失败。若要消警告需再拆 enroll 路径。
- 为让 `runUplinkSwitch` 访问 pool，若干原 private 方法改为包内公开（`spawn` / `promote` / `beginSwitch` 等）；外部调用面未改。
- `packages/api-client` 测试 222 vs 基线 220：本任务只加了 1 条 `switchRelay` 失败测试，多出的 1 条来自并行 agent。
- 未跑 e2e / Playwright；未起 dev server；未碰生产 tmex。
