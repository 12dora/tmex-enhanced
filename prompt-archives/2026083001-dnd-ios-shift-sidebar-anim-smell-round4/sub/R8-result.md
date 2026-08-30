# R8 结果 — hub redeem 事务 + mesh 节点列表 / RTC authorize

## 文件变更

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/hub/hub-runtime.ts` | `handleRedeem` 保持「解析 try → RedeemAbort/validationError；其余 try → RedeemAbort 映射、其它 rethrow」。事务后副作用抽到 `finishRedeem`。重复 `throw new RedeemAbort` 收成 `abortRedeem` / `decodeOrAbort`；node_exists / node_revoked / epoch / expired 顺序不变。 |
| `apps/gateway/src/mesh/mesh-routes.ts` | `collectNodes` 变成对 `projectMeshListNode` 的 map；`handleRtcAuthorize` 把 body/fp/connectionId 校验抽到 `rtcAuthFields`，lookup 失败走 `lookupFail`。`transportOf` 以闭包调用，避免把未绑定 method 传出丢失 `this`。 |
| `apps/gateway/src/mesh/node-list-projection.ts` | `MeshNodeDto` 迁入；新增 `projectMeshListNode`（online / 直连能力 / hub / self overlay / 公钥解码 / loggedIn）。`projectNode` 行为未改，`uplink-server` 仍用旧入口。 |

测试文件未改。未新增文件。

## `git diff --stat`

```
 apps/gateway/src/hub/hub-runtime.ts           | 292 +++++++++++++-------------
 apps/gateway/src/mesh/mesh-routes.ts          | 216 ++++++++-----------
 apps/gateway/src/mesh/node-list-projection.ts |  87 ++++++++
 3 files changed, 316 insertions(+), 279 deletions(-)
```

`git diff --numstat`：147/145、82/134、87/0。净 **+37**。

未达到目标 −40：把 `collectNodes` 的 per-node 分支搬进 projection 时，15 参数签名 + `MeshNodeDto` 迁入把税交在 `node-list-projection.ts`（+87），`mesh-routes.ts` 只收回 −52。继续削 projection 会把分支加回 `collectNodes`，CC 会重新超 15。

## 行数（`wc -l`）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `hub-runtime.ts` | 772 | 774 | **+2** |
| `mesh-routes.ts` | 431 | 379 | **−52** |
| `node-list-projection.ts` | 64 | 151 | **+87** |
| 测试（四份） | 未改 | — | 0 |
| **合计** | **1267** | **1304** | **+37** |

## CC（与 round2 同一套 McCabe：嵌套函数单独计）

| 函数 | 前 | 后 | 行数（后） |
|------|----|----|-----------|
| `handleRedeem` | 22 / 61L | **4** | 15L |
| `redeemInTransaction` | 23 / 84L | **14** | 85L |
| `collectNodes` | 28 / 69L | **7** | 35L |
| `handleRtcAuthorize` | 19 / 42L | **9** | 28L |

四个目标函数均 **< 15**。拆出的 `finishRedeem` CC14 / 40L（事务后 notify 顺序：`updateMeta` → `enroll.redeemed` sendTo → `broadcastNodeList`，未改）。`projectMeshListNode` CC19（不是点名的四个函数；再拆 `meshNodePk` 会净增行）。

## 测试 / tsc / biome

### 开始前（基线）

- 范围内四份测试：`hub-runtime.test.ts` + `mesh-routes.test.ts` + `node-list-projection.test.ts` + `uplink-server.test.ts`：**87 pass / 0 fail**
- `cd apps/gateway && bun test`：**2500 pass / 0 fail**（任务写 2499；本 worktree 开跑即为 2500）
- `bunx tsc --noEmit -p .`：**21** 个既有错误
- `wc -l`：772 / 431 / 64

### 结束后

- 范围内四份：**87 pass / 0 fail**
- `cd apps/gateway && bun test`：**2500 pass / 0 fail**
- `bunx tsc --noEmit -p .`：**21** 个错误，与基线相同；**三份改动文件 0**
- `bunx biome check` 三份源文件：**clean**

未跑 `packages/app` / `packages/shared` / `packages/ws-client`：范围只改 gateway 这三份，且 `projectNode` / `parseJson` / `upsertById` 签名未变。

## 修掉的问题

- **`transportOf` 丢 `this`**：把 `peers.transportOf` 当函数值传入 projection 后，FakePeers 的 `this.transport` 为 undefined（6 个 mesh-routes 节点列表测试红）。改为 `(nid) => this.deps.peers.transportOf?.(nid) ?? null`，与原先 `this.deps.peers.transportOf?.(id)` 一致。既有 GET `/api/mesh/nodes` 测试覆盖。
- **tsc 不增加**：`abortRedeem(!token)` 的 `asserts` 收不窄 `token`/`stored`；解析路径改回 `if (!token)` / `if (!stored)` throw。`alreadyAdmitted` 标注为 `boolean`，避免 `let x = false` 被推断成字面量 `false` 后 `admitted.certificateBytes` 变成 `never`。

## 有意跳过

- **净行数 −40**：见上。CC 四个函数已 <15；再把 `projectMeshListNode` 压回 `collectNodes` 会把 CC 打回去。
- **`projectMeshListNode` CC19**：再拆公钥解码会净增行，未拆。
- **未改测试文件**：既有 87 条已锁 redeem（含 replay / reused / expired / node_exists / node_revoked / already_admitted）、节点列表（self overlay / hub-online / loggedIn / 吊销丢弃）、RTC authorize（503 / 409 / connectionId）以及 projection 的 `projectNode`。
- **未碰** `uplink-server.ts`（只跑了它的测试作消费者回归）。
- **未碰** `emitOsc` / `encodeMouseEvent` / `classifySshError` / control-mode `parse` / `dispatchPaneStreamByte` / `runInit` / `sanitizeBunPath`。
- **未改** version / CHANGELOG / 构建脚本。
- **`handleRedeem` 双 catch**：按审查修复保留——解析错误 → 400/`validationError`，事务及之后内部异常照旧抛出。
