# R3 结果 — UserKeyService batch apply / replay / persistence

## 文件变更

| 文件 | 摘要 |
|------|------|
| `apps/gateway/src/auth/user-key-service.ts` | `applyMany` 拆成 prepare（`prepareApplyMany` + `replayStep`）与 CAS commit（`commitPrepared`）；join 链走同一 `replayStep`；`persistApplied` 改为 `(stores, userId, step, now)`，record-type 副作用走 `byType` 表；`persistJoinReplay` / bootstrap / `commitVerified` 共用 `txStores` + `persistApplied`；去掉死字段 `previous`；`VerifyChainForJoinOptions` / `CommitJoinInput` / `BootstrapSelfAdmitInput` 去掉 `export`。 |

`user-key-service.test.ts` 未改。未新增文件。

## `git diff --stat`

```
 apps/gateway/src/auth/user-key-service.ts | 813 +++++++++++-------------------
 1 file changed, 298 insertions(+), 515 deletions(-)
```

`git diff --numstat`：298 / 515（净 **−217**）。

## 行数（`wc -l`）

| 文件 | 前 | 后 | Δ |
|------|----|----|---|
| `user-key-service.ts` | 1229 | 1012 | **−217** |
| `user-key-service.test.ts` | 926 | 926 | 0 |

生产文件净减超过目标 −70。

## CC（与 `cc-baseline.txt` 同一套 McCabe：嵌套函数单独计）

| 函数 | 前 | 后 | 行数（后） |
|------|----|----|-----------|
| `applyMany` | 18 / 155L | **10** | 40L |
| `replayJoinChain` | 20 / 86L | **13** | 44L |
| `persistApplied` | 17 / 109L | **9** | 90L |
| `persistJoinReplay` | 4 / 97L | **4** | 64L |

本文件最大函数 CC = 13（`replayJoinChain`），低于目标 15。拆出的 `replayStep` CC8、`prepareApplyMany` CC4、`commitPrepared` CC1（CAS 在 transaction 回调里，按同一规则不计入父函数）。

## 测试 / tsc / biome

### 开始前（基线）

- `bun test src/auth/user-key-service.test.ts`：**18 pass / 0 fail**
- `wc -l`：1229
- `bunx tsc --noEmit -p .`：任务说明为 **21** 个既有错误（本文件 0）
- biome：未改文件，未跑

### 结束后

- `bun test src/auth/user-key-service.test.ts`：**18 pass / 0 fail**（含 `:330` reset_not_genesis、`:867` abort mid-batch、`:915` 2000 条原子提交）
- `cd apps/gateway && bun test`：第一次 **2498 pass / 1 fail**（失败不在本文件；其他 agent 正在改 stream/uplink/mesh）；紧接着再跑，grep 到 **0 fail**
- `bunx biome check src/auth/user-key-service.ts`：**clean**
- `bunx tsc --noEmit -p .`：**21** 个错误，与基线相同；**`user-key-service.ts` 为 0**

未跑 `packages/app` / `packages/shared` / `packages/ws-client`：本范围只改 gateway 该文件，且对外仍 export 的 `kdfParamsFromJson` / `kdfParamsToJson` / `UserKeyService` 签名未变。

## 修掉的问题

无外部指定 bug。重构过程中 `prepareApplyMany` 成功类型曾与 `ApplyManyResult` 的 `ok: true` 重叠导致 tsc 无法收窄，已收窄返回类型并修掉；无行为变化。

## 有意跳过

- **未从 `index.ts` 再导出的类型才去了 `export`**：`ApplyKeyLogInput` 等仍被 `apps/gateway/src/auth/index.ts` re-export，改 index 超出 SCOPE。
- **未合并 `persistJoinReplay` 的 wipe/create 与 `bootstrapUserWithSelfAdmit`**：bootstrap 的 else 分支不调用 `wipeUserDerivedState`（不删 nodes / enrollment tokens），行为不同。
- **bootstrap 内部 throw 文案**：genesis/admit 的 verify 失败现在也走 `bootstrap … apply failed:`（原先分 verify/apply）。无测试或客户端依赖该字符串。
- **`kdfParamsFromJson` / persistJoinReplay 的 KDF JSON 解码 fallback**：外部/损坏 JSON 的兼容路径，有既有默认值行为，未动。
- **未碰** `emitOsc` / `encodeMouseEvent` / `classifySshError` / control-mode `parse` / `dispatchPaneStreamByte` / `runInit` / `sanitizeBunPath`（本文件无这些热点）。
- **未改** version / CHANGELOG / 构建脚本。
- **未改测试文件**：既有 18 条已锁 applyMany / join / persist 行为。
