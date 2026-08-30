# G3 结果：mesh stream targets、node-list projection、stream pump

## 做了什么

1. `stream-targets.ts`：抽出 `stringHeaders` / `requestBodyFromLink` / `str`，HTTP 响应体与上传走 `pumpToLink`；WS teardown / `openWsStream.close` 对 `end()` 加 `.catch`。`cancel()` 不再 `void` 进同步 try/catch。
2. `stream-pump.ts`：统一「读 chunk → write → await end → onError」；`pumpLink` 在 `finally` 里 `releaseLock`。
3. `node-list-projection.ts`：`parseJson`、`versionFromInventory`、`projectNode`、`upsertById`、`pickMeshNodeName`。`collectNodes` / `buildNodeList` 只做 DTO/wire 映射。
4. `mesh-routes.ts`：压 `handleRtcAuthorize` / `handleConnection`（未再拆独立函数，拆开会变长）。

## 变更文件

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/mesh/stream-targets.ts` | 修 cancel/end 未观察 rejection；上传在 head 失败时 abort+cancel；HTTP/WS 拆 adapter/pump/teardown |
| `apps/gateway/src/mesh/stream-targets.test.ts` | cancel / head-fail 取消上传 / WS `end()` 无 unhandled rejection 回归 |
| `apps/gateway/src/mesh/stream-pump.ts` | 新建：`pumpToLink` / `pumpLink`（await `end`，LinkStream 侧释放 reader） |
| `apps/gateway/src/mesh/stream-pump.test.ts` | `end()` rejection 进 onError；pumpLink 释放 reader |
| `apps/gateway/src/mesh/node-list-projection.ts` | 新建：live overlay、hub upsert、inventory JSON、mesh 显示名 |
| `apps/gateway/src/mesh/node-list-projection.test.ts` | overlay / upsert / parseJson / 命名回归 |
| `apps/gateway/src/mesh/mesh-routes.ts` | `collectNodes` 改走 projection；压缩 RTC authorize / connection |
| `apps/gateway/src/hub/uplink-server.ts` | `buildNodeList` 走 projection；`copyDirection` 换成 `pumpLink` |

## 行数（生产代码）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `apps/gateway/src/mesh/stream-targets.ts` | 636 | 580 | −56 |
| `apps/gateway/src/hub/uplink-server.ts` | 1447 | 1416 | −31 |
| `apps/gateway/src/mesh/mesh-routes.ts` | 483 | 431 | −52 |
| `apps/gateway/src/mesh/node-list-projection.ts` | 0 | 64 | +64 |
| `apps/gateway/src/mesh/stream-pump.ts` | 0 | 45 | +45 |
| **合计** | **2566** | **2536** | **−30** |

测试文件不计入目标：`stream-targets.test.ts` 656→817；`stream-pump.test.ts` +64；`node-list-projection.test.ts` +71。

目标 −60 未达到。两份新模块 +109，三份旧文件合计 −139。`collectNodes` 与 `buildNodeList` 数据源不同（certs/reach vs enrolled+registry），共享层只能 overlay/upsert/JSON，call site 仍要写 DTO 字段，投影文件吃掉了大部分节省。

## `git diff --stat`

未跟踪新文件不会出现在 `git diff --stat` 里。已跟踪：

```
 apps/gateway/src/hub/uplink-server.ts        | 119 ++++-------
 apps/gateway/src/mesh/mesh-routes.ts         | 182 ++++++-----------
 apps/gateway/src/mesh/stream-targets.test.ts | 161 +++++++++++++++
 apps/gateway/src/mesh/stream-targets.ts      | 294 +++++++++++----------------
 4 files changed, 389 insertions(+), 367 deletions(-)
```

新文件：`stream-pump.ts`（45）、`stream-pump.test.ts`（64）、`node-list-projection.ts`（64）、`node-list-projection.test.ts`（71）。

## 测试 / tsc / biome

**开始前：**

- `cd apps/gateway && bun test`：2482 pass / 0 fail
- `cd apps/gateway && bunx tsc --noEmit -p .`：21 个 `error TS`
- biome：未跑（无本任务改动）

**结束后：**

- biome：`bunx biome check` 上述 8 个文件，通过
- 范围内：`stream-targets.test.ts` + `stream-pump.test.ts` + `node-list-projection.test.ts` + `mesh-routes.test.ts` + `uplink-server.test.ts` + `direct-path.integration.test.ts`：**106 pass / 0 fail**
- 全量 `cd apps/gateway && bun test`：**2497 pass / 0 fail**（本任务新增 11 个测试：stream-targets 5、pump 2、projection 4；其余增量来自并行 agent）
- gateway tsc：21 个 `error TS`（未增加）

## 修过的 bug

1. **(a) `cancel()` 未观察 rejection**：`requestReader.cancel()` / `responseReader.cancel()` 改为 `void …cancel().catch(() => {})`。回归：`HTTP abort cancel() rejection is not unhandled`。
2. **(b) `writeBody` fire-and-forget + head 失败后上传继续**：`pumpToLink` 内部 catch `write`/`end`；`finally` 里 `stopUpload.abort()` + `upload.reader.cancel()`。回归：peer 干净 END、无 head 时 `cancelled === true` 且无 unhandled rejection。
3. **(c) WS `void stream.end()`**：teardown 与 `openWsStream.close` 均 `.catch(() => {})`。回归：打补丁让 `end()` reject 后 `collectUnhandled` 为空。
4. **`copyDirection` 未 await `dst.end()`**：改为 `pumpLink`，`await end()`，`finally` 释放 reader。回归：`pumpLink awaits dst.end rejection and releases the source reader`。

成功路径顺序未改：先写 head，再泵 body，再 `end`；WS 仍先 `onGatewaySessionClose` / `onClose` 再 `end`/`reset`。

## 刻意跳过

- **`handleRtcAuthorize` 拆成 body/fingerprint/connection 三个函数**：拆开会增加签名与转发，净行数不降。改为原地压缩，校验顺序仍是 userId → rtc 可用性 → body → sid → lookup。
- **把 mesh-routes 的 request-validation 抽到共享模块**：G4 范围（`route-input.ts`），未动。
- **`direct-path.integration.test.ts`**：文件名是 `*.integration.test.ts`，`bun test` 会跑；已包含在范围内 106 pass 中。
