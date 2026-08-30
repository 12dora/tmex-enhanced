# R5 结果：`packages/app` runtime assembly 瘦身

## 做了什么

把 `assembleTmex` 里内嵌的 TLS / local / setup / Hub / mesh / gateway / SPA / websocket 分派拆成三个顶层函数，HTTP 走有序 handler 数组，行为不变。

- **HTTP pipeline**：`createHttpDispatch` 对 `(req, server) => Response | null | undefined | MeshRewritten` 数组循环。`null` 继续，`undefined` 表示 WS upgrade 停，`Response` 停，`{ rewritten }` 只递归一次。顺序：tls → local → setup → hub → mesh（含 standalone `/api/auth/mode`）→ gateway → SPA。
- **websocket**：`routeWebsocket` 保持 hub-uplink → mesh kind → gateway，以及 `MESH_GATEWAY_WS_KIND` 的 `open`/`cid` 注册、`touchSocket`、`close` 时 mesh 先 unregister。
- **TLS**：`buildTlsLifecycle` 建 `HttpsListener` + `TlsService` + `createTlsRoutes`，仍通过 `tlsSlot` 打破 fetch/listener 循环依赖。
- **去重**：`tryStop` 合并 `stop` / `quiesceMesh` 的 try/catch；`createProcessShutdown` 的成功/失败收口到 `done(code)`。
- **死导出**（`rg` 全仓无文件外 importer）：`AssembleTmexOptions`、`AssembledTmex`、`ShutdownHooks` 去掉 `export`。仍导出：`SHUTDOWN_TIMEOUT_MS`、`meshShutdownNeeded`、`assembleTmex`、`createProcessShutdown`、`installShutdownHandlers`。

## 变更文件

| 文件 | 摘要 |
|------|------|
| `packages/app/src/runtime/assemble.ts` | 抽出 HTTP pipeline / websocket router / TLS builder；压缩 stop/shutdown；去掉无 importer 的 type export |
| `packages/app/src/runtime/assemble.test.ts` | 未改 |

## 行数

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `packages/app/src/runtime/assemble.ts` | 581 | 525 | **−56** |
| `assembleTmex` | 365 | 148 | 低于 150 |
| 内层 `dispatch` | CC26 / 60L | CC5 / 16L | 低于 12 |

目标 −50 已达到（−56）。

## `git diff --stat`

```
 packages/app/src/runtime/assemble.ts | 562 ++++++++++++++++-------------------
 1 file changed, 253 insertions(+), 309 deletions(-)
```

## 测试 / tsc / biome

**开始前：**

- `cd packages/app && bun test`：409 pass / 1 fail（既有 `cpu-features stub plugin`）
- `bunx tsc --noEmit -p .`：1 个 `error TS`（`Cannot find type definition file for 'node'`）

**结束后：**

- `bunx biome check packages/app/src/runtime/assemble.ts`：通过
- `bun test src/runtime/assemble.test.ts`：25 pass / 0 fail
- `cd packages/app && bun test`：409 pass / 1 fail（仍是 `cpu-features stub plugin`）
- tsc：仍 1 个 `error TS`（未增加）

全量 `packages/app` 测试曾短暂出现 52 fail（`user-key-service.ts` 里 `tryDecodeRecord is not defined`），属并行 agent 改 R3 范围文件的中间态，非本文件。重跑后回到 409/1。

## 修过的 bug

无。未改 wire / 错误码 / stop 顺序（mesh → hub → gateway）/ 事务边界。

## 刻意跳过

- **Hub `/hub/uplink` 升级成功后 `handleRequest` 返回 `undefined` 会落入后续 handler**：与「非 Hub 路径返回 `undefined` 表示未处理」无法区分。改成「upgrade 后停」会改变 `undefined` 继续往下走的现有语义，且 `assemble.test.ts` 没有覆盖该路径。保持原样。
- **未动** `assemble.test.ts`、发版文件、以及前三轮保留热点（本文件不含那些符号）。
