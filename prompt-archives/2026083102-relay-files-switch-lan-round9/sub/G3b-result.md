# G3b 结果：G3 评审 blocker 修复 + 复杂度门禁

## 做了什么

**Blocker 1 — 竞速胜者才 track/rememberKeys**  
`dialWsSecureCandidate` 只返回已握手、未入轨的 candidate（session + keys）。`raceWsSecureEndpoints` 在同一事件循环里选出赢家后，PeerManager 才对赢家调用 `track()` / `rememberKeys()`；输家只 `close` 自己的 handshake session。`track()` 若因同级 live 返回另一条 session，不会把赢家 keys 写到那条 live 上。

**Blocker 2 — abort 后迟到的 wsFactory 结果关 socket**  
`connectWsTransport` 保留 factory promise；abortable 失败或 `stop()` 后用 late-result handler 立刻 `close` 迟到的 transport。既有 “late handshake” 用例补了 `late.closed === true`。

**Should-fix 1 — 每次 dial 一条 attempt**  
`emptyDirectAttempt()` 按 `dial()` 调用新建记录；ws/dc 只写入本次；提交发生在返回已有 relay 或新建 relay 之前。不再从上次记录 merge 字段。直连成功仍走 `installLive` → `clearDirectFailure`。

**Should-fix 2 — `/api/mesh/nodes` 去 O(N²)**  
`linkDetailOf` 改 `userStore.getPeer`（主键）。`projectMeshListNode` 的 `endpoints` 只从已构建的 `peerById` 取，不再用 `detail.endpoints`。

**复杂度**  
抽出 `peer-ws-race.ts`（竞速 / factory leak / 未入轨 handshake）和 `peer-direct-attempt.ts`（attempt 账本）。拆分 `projectMeshListNode`。`wireMeshEventsAndSessions` 用 spread 缩短装配。未改 allowlist。

## 文件

- `apps/gateway/src/mesh/peer-ws-race.ts`（新）+ `peer-ws-race.test.ts`
- `apps/gateway/src/mesh/peer-direct-attempt.ts`（新）+ `peer-direct-attempt.test.ts`
- `apps/gateway/src/mesh/peer-manager.ts` + `peer-manager.test.ts`
- `apps/gateway/src/mesh/node-list-projection.ts` + `node-list-projection.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`（装配减行）

未改：`mesh-routes.ts` / `address-class.ts` / `peer-manager.upgrade.test.ts`（行为已覆盖）。

## 测试 / tsc / gate

| | before | after |
|---|---|---|
| `apps/gateway` bun test | 2997 pass / 0 fail（302 files） | 3008 pass / 0 fail（304 files；本任务 +2 测试文件） |
| `bunx tsc --noEmit -p .` | 22 errors | 22 errors（未增长；owned 文件无新增） |
| biome check（上列改动文件） | — | 通过 |
| complexity gate（owned） | `peer-manager.ts` 2512>2297；`projectMeshListNode` CC 30>20；`mesh-runtime.ts` 1346>1344 | owned 全部低于锁。全仓仍有 **他组** `tmux-command-handlers.ts:89 handleTmuxSelect: CC 17 > 15` |

新增单测要点：同轮两路 handshake 的返回 session / live / keys 属于同一 candidate；winner abort 与 `stop()` 后迟到 factory socket 被关；已有 relay + 能力变更后升级失败只记录本次 dc/ws；projection 的 endpoints 来自 `peerById`。

## 指挥官需跟进

1. 复杂度门禁全仓失败仅剩 `apps/gateway/src/ws/tmux-command-handlers.ts`（他组正在改）。
2. `mesh-runtime.ts:1156` `onNodeEvent: (cb) =>` 的 implicit `any` 属于预存 22 条 tsc，未动。
3. 未跑 Playwright / `bun run dev`。未改 i18n / allowlist / frontend / api-client。
