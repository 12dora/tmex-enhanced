# R4 结果 — mesh runtime assembly

## 文件变更

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/mesh/mesh-runtime.ts` | 将 `createMeshRuntime`（原 ~777 行）拆成同文件四个顶层函数：`constructMeshDeps` / `wireMeshEventsAndSessions` / `wireMeshHttp` / `assembleMeshRuntime`；压缩 `register`、`lookup`、`isAdvertisablePeerAddress`；删除死代码 `ZERO_HASH`；合并 stop 的重复 try/catch 与 rtc.signal 载荷。 |
| `apps/gateway/src/mesh/mesh-runtime.test.ts` | 在改 `isAdvertisablePeerAddress` 前加表驱动表征测试；stop 顺序断言补上 `rtc`（`peer → uplink → rtc`）。 |

未新增 sibling 文件（不满足「搬 ≥250 行且 glue ≤20」的净减条件）。

## `git diff --stat`

```
 apps/gateway/src/mesh/mesh-runtime.test.ts |  72 ++-
 apps/gateway/src/mesh/mesh-runtime.ts      | 749 +++++++++++++----------------
 2 files changed, 401 insertions(+), 420 deletions(-)
```

`git diff --numstat`：`mesh-runtime.ts` 331 / 418（净 −87）；test 70 / 2（净 +68）。

## 行数（`wc -l`）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `mesh-runtime.ts` | 1337 | 1250 | **−87** |
| `mesh-runtime.test.ts` | 1126 | 1194 | +68 |

`createMeshRuntime`：777 行 → **6 行**（目标 <300）。

拆出的顶层函数：

- `constructMeshDeps` 199 行（依赖：store / identity / hub / RTC / session binding）
- `wireMeshEventsAndSessions` 298 行（uplink / PeerManager / 事件与 RTC 信令）
- `wireMeshHttp` 92 行
- `assembleMeshRuntime` 100 行（公开 API + start/stop）

stop 顺序保持：`peerManager → uplink → http → rtc → bulk`（`stopQuietly` 按数组顺序 `await`）。

## 测试 / tsc / biome

### 开始前（基线）

- `cd apps/gateway && bun test src/mesh/mesh-runtime.test.ts`：**22 pass / 0 fail**
- `bunx tsc --noEmit -p .`：**21** 个既有错误（均不在本文件）
- biome：未改文件，未跑

### 结束后

- `bun test src/mesh/mesh-runtime.test.ts`：**23 pass / 0 fail**
- `bun test src/mesh/mesh-runtime.test.ts src/mesh/integration`：**56 pass / 0 fail**（8 files, 61s）
- `bunx biome check` 两个改动文件：**clean**
- `bunx tsc --noEmit -p .`：当前工作区 **23** 个错误；**`mesh-runtime.ts` / `mesh-runtime.test.ts` 为 0**。多出的 2 个在 `user-key-service.ts`、`push/supervisor.test.ts` 等（其他 agent 正在改），不是本范围引入的。

## 修掉的问题

- 删除未使用的 `ZERO_HASH`（死代码）。
- 未发现需要单独回归测试的行为 bug。`isAdvertisablePeerAddress` 的接受/拒绝集已用表征测试钉死后再压缩（含 `240.0.0.1` / `255.255.255.255` 当前被接受、`::`/`::1`/fe80/ff00 拒绝等）。

## 有意跳过

- **未去掉 `export`**：`CONNECTION_ID_BYTES`、`generateConnectionId`、`resolveUserId`、`NetworkInterfacesFn`、`isAdvertisablePeerAddress` 仅被 `apps/gateway/src/mesh/index.ts` barrel 再导出，仓库内无其他 importer。改 barrel 超出范围（`index.ts` 不在 SCOPE），去掉 `export` 会立刻弄坏 barrel。
- **未改 `integration/*.test.ts`**（按 SCOPE）。
- **未碰** `emitOsc` / `encodeMouseEvent` / `classifySshError` / control-mode `parse` / `dispatchPaneStreamByte` / `runInit` / `sanitizeBunPath`。
- 过程中两次看到 `user-key-service.ts`（`tryDecodeRecord` / `replayStep`）和 `uplink-client.ts`（`trackApplier`）的瞬时失败，均属其他 agent 编辑、非本文件；最终 integration 全绿。
