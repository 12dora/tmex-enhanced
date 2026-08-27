# B1-1-fix 结果 — session/carrier close 语义

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

按 `b1-1-review.md` 五条全部落地：显式 `closeSession`、`handleCarrierClose` 必须带实际关闭的 carrier、入站拒绝已关闭 session、direct 原子替换、metrics 展开全部 carrier。`attachStreamSession` 返回值形状未改，`onClose` / `onMessage` 走同一套 close/inbound 路径。

## 做了什么

1. **`WebSocketServer.closeSession(session, code, reason)`** 成为唯一终止入口：先标 `closed`，再 `forget` + `close` 所有已附着 carrier，detach direct，并从 `connectedClients` / `canonicalSessions` / `sessionStateStore` / `switchBarrier` / `agentWsHub` / device registry 清掉。幂等。
2. **`handleClose` 改名为 `handleCarrierClose(session, carrier, code?, reason?)`**：禁止从 `activeCarrier` 反推。primary → `closeSession`；非 active / active direct → 只 detach（active 时切回 primary，不发 `CARRIER_SWITCH`）。已关闭 session 的 Bun close 是 no-op。
3. **入站**：`handleMessage` / `handleBorshMessage` / `handleDrain` / `attachStreamSession().onMessage` 在 `closed === true` 时直接返回。关 primary 会一并关闭 direct。
4. **`attachCarrier(c, 'direct')`**：已有 direct 时先把 active 切回 primary，经 `onCarrierDetached` forget，close 旧载体（`1000` / `direct carrier replaced`），再装新的。同一 carrier 挂两次抛错。
5. **metrics**：`session.carriers()` 展开全部附着载体；日志字段改为 `ws_backpressured_carriers` / `ws_unavailable_carriers`。
6. **managed-entry 重启**：`closeRuntimeWebSockets` 调 `websocket.closeSession`，不再把 session 强转成 `ServerWebSocket`。`import.meta.main` 包住入口副作用，便于单测 import。

## 文件清单

| 文件 | 变更 |
|---|---|
| `apps/gateway/src/ws/gateway-session.ts` | `carriers()`、`onCarrierDetached`、atomic replace、同 carrier 抛错 |
| `apps/gateway/src/ws/gateway-session.test.ts` | 替换 / 重复挂载 / `carriers()` |
| `apps/gateway/src/ws/test-helpers.ts` | `FakeCarrier.closeCalls` |
| `apps/gateway/src/ws/index.ts` | `closeSession` 公开、`handleCarrierClose`、closed 入站守卫、hook |
| `apps/gateway/src/ws/index.test.ts` | 关闭语义 + metrics 回归 |
| `apps/gateway/src/ws/gateway-metrics-log.ts` | 全 carrier snapshot + 字段名 |
| `apps/gateway/src/runtime.ts` | drain/close 传入确切 carrier；`websocket.closeSession` |
| `apps/gateway/src/managed-entry.ts` | 重启走 `closeSession`；导出 helper / 常量 |
| `apps/gateway/src/managed-entry.close.test.ts` | **新增** 重启时 dual-carrier 清理 |

未改 `apps/gateway/src/mesh/stream-targets.ts`（`attachStreamSession` 返回形状不变）。

## 公开 API

```ts
class GatewaySession {
  onCarrierDetached: ((carrier: Carrier) => void) | null
  carriers(): Carrier[]
  attachCarrier(carrier: Carrier, role: CarrierRole): void
  // 已附着同一 carrier → throw 'carrier is already attached to this session'
  // 替换已有 direct：若其是 active 则先切回 primary → onCarrierDetached(old) → old.close(1000, 'direct carrier replaced') → 安装新
}

class WebSocketServer {
  handleCarrierClose(session: GatewaySession, carrier: Carrier, code?: number, reason?: string): void
  // code 默认 1006，reason 默认 'carrier closed'
  closeSession(session: GatewaySession, code: number, reason: string): void
  attachStreamSession(carrier: Carrier): {
    session: GatewaySession
    onMessage(bytes: Uint8Array): void
    onClose(): void
  }
}

interface GatewayRuntime {
  websocket: {
    // ...open/message/drain/close
    closeSession(session: GatewaySession, code: number, reason: string): void
  }
}

// managed-entry.ts
export const RUNTIME_RESTART_CLOSE_CODE = 1012
export const RUNTIME_RESTART_CLOSE_REASON = 'Gateway runtime restarting'
export function closeRuntimeWebSockets(
  socketOwners: Map<GatewaySession, { websocket: { closeSession(session, code, reason): void } }>,
  runtime: { websocket: { closeSession(session, code, reason): void } },
): unknown
```

已删除：`WebSocketServer.handleClose(ws)`（session 关闭语义）。`handleCloseWindow` / `handleClosePane` 保留。

## 测试

`cd apps/gateway && bun test`：

```
 1619 pass
 0 fail
 5436 expect() calls
Ran 1619 tests across 192 files. [35.52s]
```

任务基线 1573；本任务约 +11（gateway-session 3、index close 7、managed-entry 1）。其余增量来自同 worktree 其他 agent。

回归覆盖：

- 重启且 direct 为 active → 两载体都以 1012 关闭，registry 清空，且**不会**把 session 当成 `ServerWebSocket`
- 非 active direct 关 → session 存活
- primary 关（direct 为 active）→ 两载体都关；之后 direct 入站 / drain 丢弃
- `attachStreamSession().onClose` 在 direct 为 active 时结束整个 session
- 已关闭 session 的 `handleCarrierClose` 是 no-op
- direct 原子替换；重复 attach 抛错
- metrics 两个 backpressured carrier → `ws_backpressured_carriers=2`

## tsc / biome

| | 数量 |
|---|---|
| 任务基线 `apps/gateway` | 23 |
| 本次全量 | **27**（本任务触及文件 **0** 条新错） |

多出的 4 条全在范围外 `src/mesh/mesh-runtime.test.ts`（其他 agent 的 WIP：缺 `./mesh-runtime` 模块、implicit any）。其中 **1 条是本任务引起的**：`GatewayRuntime.websocket` 新增必填 `closeSession`，其 mock 未提供。

biome：触及文件 **clean**。

## 协调者必须做

1. **`apps/gateway/src/mesh/mesh-runtime.test.ts`**（范围外）的 `fakeGateway().websocket` 补：

```ts
closeSession() {},
```

否则该文件 tsc 会继续报 `Property 'closeSession' is missing`。其余 3 条（缺模块 / implicit any）是那边自己的未完成代码。

2. `attachStreamSession` 返回形状未改，B2-2a / `stream-targets.ts` 不用动。
3. `CARRIER_SWITCH` 通知仍留给 Phase 3；active direct 断开只切回 primary 状态。
