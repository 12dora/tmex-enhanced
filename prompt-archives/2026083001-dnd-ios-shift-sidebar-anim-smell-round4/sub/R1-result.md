# R1 结果：uplink client catch-up 拆分与错误分类

## 文件变更

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/mesh/uplink-client.ts` | 拆分 `runCatchUpFromList`；`classifyUplinkConnectError` 改为有序谓词表；`handleCtl` 改为 else-if（未采用 handler map）；去掉 4 个无外部引用的 `export`；合并 `trackApplier`/`trackCatchUp` |
| `apps/gateway/src/mesh/uplink-client.test.ts` | 未改（既有测试即契约） |

## `git diff --stat`

```
 apps/gateway/src/mesh/uplink-client.ts | 616 +++++++++++++++------------------
 1 file changed, 275 insertions(+), 341 deletions(-)
```

## 行数（`wc -l`）

| 文件 | 改前 | 改后 | Δ |
|------|------|------|---|
| `apps/gateway/src/mesh/uplink-client.ts` | 1437 | 1371 | **−66** |

git numstat：+275 / −341，净 −66。目标 −60 已达到。

## 做了什么

1. **`runCatchUpFromList`（原 ~175 行 / CC59）** 拆成：
   - `runCatchUpFromList`：编排（empty userId、seq 比较、fork、push vs pull）
   - `readCatchUpHead`：head 读取 + retry
   - `pushMissingRecords`：本地超前时的 push + retry
   - `pullAndApplyPages`：paged pull、empty、seq-gap
   - `applyCatchUpPage`：applyMany、head 重读、fork / reject / stall
   - `verifyCatchUpTarget`：收尾 hash 校验、incomplete、finish
   - 日志字符串、retry 上限、`catchUpAliveCtx` vs `catchUpCurrent` 的差异（apply 成功后仍可 head/failFork，即使 epoch 已变）均保留。
2. **`classifyUplinkConnectError`**：`UPLINK_CONNECT_RULES` 有序表 + first-match-wins；HTTP 抽取插在 tls 行之后、auth_rejected 之前（`if (code === 'tls')` 哨兵），与原 if-chain 顺序一致。
3. **`handleCtl`**：else-if 链净减行且 CC < 20；`key.log.res` 抽到 `handleKeyLogRes`。Handler map 会更长，未用。
4. **去掉 `export`**（`rg` 确认无文件外引用）：`UplinkLastConnectError`（类型内联后删除）、`sanitizeUplinkCtlType`、`stripCtlControlChars`、`mapUplinkCtlError`。`classifyUplinkConnectError` 仍导出（测试导入）。
5. 其它净减：`trackApplier`+`trackCatchUp` → `trackTask`；`awaitHead`；`errMsg`。

最大函数 CC 均低于 20（原 `runCatchUpFromList` CC59、`classifyUplinkConnectError` CC35、`handleCtl` CC20）。

## 测试 / tsc / biome

| | 改前 | 改后 |
|--|------|------|
| `bun test src/mesh/uplink-client.test.ts` | 42 pass / 0 fail | **42 pass / 0 fail** |
| `cd apps/gateway && bun test` | 本 session 基线被 `tail` 缓冲卡住后中止；指挥官给出的基线为 2497 pass / 0 fail | **2499 pass / 0 fail**（257 files；其它 agent 可能多了 2 个测试） |
| `bunx tsc --noEmit -p .` | 21 errors（既有） | **21 errors**（未增加） |
| `bunx biome check apps/gateway/src/mesh/uplink-client.ts` | — | **clean**（0 errors） |

未跑 `packages/app` / `packages/shared` / `packages/ws-client`（不在本 scope）。

## 修过的行为偏差

拆分初稿把 `applyMany` 返回 `error`（非 fork）当成「不更新 local 的 retry」，导致 **partial apply 后下一次 `key.log.req` 仍从旧 seq 拉**。既有测试 `partial apply re-reads head so the next request resumes from the committed prefix` 抓住了。修复：`applyCatchUpPage` 在 reject 后仍返回重读的 head，且 **不清零** retry 计数（`{ local, reset: false }`）。这是拆分引入的回归，不是原文件的既有 bug。

## 故意跳过

- **`handleCtl` handler map**：typed map + 断言会比 else-if 更长，不满足 net-negative。
- **未改测试文件**：契约已在 `uplink-client.test.ts`（含 :57、:943、:1025、:1302、:2387 及邻居）。
- **未动** `uplink-protocol.ts`、热区函数、版本号 / CHANGELOG。
- **`stripCtlControlChars` 未改成 regex**：biome `noControlCharactersInRegex` 禁止 `[\x00-\x1f]`，保留原 code-point 循环。
