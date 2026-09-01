# G3d result — RV4-1 / RV4-4 / RV4-10

## What landed

TDD for three RV4 items. `hub-runtime.ts` 的 `applyReplicatedNodeList` 已把 `ownHubSnapshot()` 传进 replication，本任务只改 `hub-replication.ts` 的实际合并逻辑。

### RV4-1 — legacy `node.list` 保留自身 hub 行（blocker）

原先 `if (!list.hubs) return`：1.1.11 standby 接到 1.1.10 的 legacy 列表后，node 侧已把 store `replaceAll` 成「只有 source 一条 active」，hub 侧提前返回，自身 standby 行永远不回来。

现在两条路径都 `replaceAll(filtered + own snapshot)`，source=self 仍在函数入口忽略：

- **`hubs[]` 存在**：行为不变，`authorized ∪ self ∪ source`，再强制写入 `ownHubSnapshot()`。
- **legacy（无 `hubs[]`）**：从 `list.hub` 合成单条 `mode:'active'`（`priority:100`，`writerEpoch: list.writerEpoch ?? 1`，与 `recordsFromNodeList` 一致），**仅当**该 id ∈ `authorizedHubIds ∪ {source}` 才保留；然后写入 own snapshot。

测试：legacy + 先被 wipe → store = {source active, self standby}；未授权合成行丢弃；source 不在 allowlist 仍保留；`hubs[]` / source=self 不变。

### RV4-4 — 发送端 DATA ≤ 256 KiB（should-fix）

未改 `MAX_FRAME_PAYLOAD`（1 MiB，收端校验）和窗口常量。新增 `MAX_DATA_SEND_PAYLOAD = 256 KiB`，`MuxStream.writeInternal` 按 `min(remaining, sendWindow, maxFramePayload, MAX_DATA_SEND_PAYLOAD)` 切帧。收端仍接受任意 ≤ 1 MiB 的帧；窗口按 payload 字节记账，与切几帧无关。

1 MiB DATA 编码后不再是 `1 MiB + 10` 的单 WS 帧，空但慢的 socket 也不会一帧打穿 gateway `backpressureLimit`。

### RV4-10 — 无 drain 时靠 `bufferedAmount` poll 恢复（nit）

`1437377b` 的生产代码未改。新增回归测试：fake server 暴露 `bufferedAmount()`、`send` 永不返回 -1、永不 `emitDrain`；主动 pause 后把缓冲降到 0，队列必须经 16 ms poll 恢复。

反向验证：临时去掉 `scheduleServerPoll()` 后该测试卡在 `resumed`（200 ms 内到不了），恢复 poll 后通过。

## Files touched

- `apps/gateway/src/hub/hub-replication.ts` / `hub-replication.test.ts`
- `packages/shared/src/link/types.ts` — `MAX_DATA_SEND_PAYLOAD`
- `packages/shared/src/link/index.ts` — re-export
- `packages/shared/src/link/mux.ts` / `mux.test.ts`
- `packages/shared/src/link/websocket-link.test.ts`

未改：`hub-runtime.ts`（该方法已传 snapshot）、`apps/gateway/src/mesh/**`、`src/system/**`、`packages/app/**`、`apps/fe/**`。无 git 操作。

## Tests

| Suite | Result |
|---|---|
| `hub-replication.test.ts` | 9 pass / 0 fail（原 5，**+4**） |
| `src/hub` | **102 pass / 0 fail**（G3c 98，**+4**） |
| `mux.test.ts` + `websocket-link.test.ts` | 36 pass / 0 fail（**+2** mux，**+1** WS poll） |
| `cd packages/shared && bun test` | **413 pass / 0 fail**（G4c 410，**+3**） |
| gateway `src/hub` + `large-push.integration.test.ts` + `multi-hub.integration.test.ts` | **119 pass / 0 fail**（10 files）。`src/mesh/**` 无失败 |

TDD：RV4-1 三条 RED（self 丢失 / 未授权合成行留下 / source 未写入）后转绿；RV4-4 先看到 1 MiB 仍是 1 帧、首块仍是 1 MiB，实现后转绿（`readAll` 需先 `end()`，否则等 EOF 超时，已修测试）。

## Verification

| Check | Result |
|---|---|
| `cd packages/shared && bun test && bunx tsc --noEmit -p .` | **413/0**，tsc **0** |
| `cd apps/gateway && bun test src/hub src/mesh/integration/large-push.integration.test.ts src/mesh/integration/multi-hub.integration.test.ts && bunx tsc --noEmit -p .` | **119/0**，tsc **0** |
| `bunx biome check`（8 个改动文件） | **clean** |

`large-push` 实况夹具：relay 24 MiB **71 ms** / ws-secure **12 ms**，均 200。

## Commander

无需代改其他文件。node 侧 `handleUplinkNodeList` 仍会先 `replaceAll` 合成行（`mesh-runtime.ts`，他组在改）；hub 角色依赖随后的 `applyReplicatedNodeList` 把 own snapshot 写回。纯 node 没有 hub snapshot，不在本修复范围。

## Open risks

- Legacy 路径 `replaceAll([source?, own])` 会丢掉 store 里其它已授权 hub。生产上 node 侧已经先 wipe 成单行，不比原来更差；那些 peer 仍需后续 `hubs[]` / advertisement 回来。
- 应用层 `ReadableStream` 现在按 ≤256 KiB 出块，不再可能单块 1 MiB。按字节拼接的路径不受影响；假定「一写一读一块」的代码会看到更多 chunk（mux 测试已改）。
- 切帧不改变窗口：写满 1 MiB 仍要等 WINDOW。混版本收端继续接受 ≤1 MiB 单帧。
