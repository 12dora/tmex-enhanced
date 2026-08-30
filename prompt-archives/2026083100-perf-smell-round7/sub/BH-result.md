# Task BH 结果：四条 gateway code-review finding

## 主张核实

四条均对照当前源码后成立，全部落地。未改 `stream-targets.ts` / `ws/index.ts` / `auth-routes.ts`。

### 1. [P1] `publishAndAck` 过早刷新 key-log head — **成立**

`mesh-runtime.ts` 原 `publishAndAck` 在 `uplink.appendAndAck` 返回后立刻 `notifyKeyLogHeadChanged()`。node-only hub-sync 路径是：hub ACK → **之后**才 `keyLogService.apply()`（`auth-routes.ts` `handleKeyLogHubSync`）。`PeerManager.notifyKeyLogHeadChanged` 的 debounce 是 100ms 且 **pending 期间后续 notify 直接丢弃**。本地 verify/persist >100ms 时，广播读到旧 head，且没有第二次通知。

未改 `auth-routes.ts`（该文件 898 行，再加 hook 会顶满 900 上限）。改为：

- 从 `publishAndAck` **拿掉** notify（hub ACK 时本地 head 尚未更新）。
- 在 `createMeshStoresAndServices` 用 `attachKeyLogHeadNotify` 包住 `keyLogService.apply`：仅 `result.ok` 后 notify。
- `publish()`（本地先 apply 再 fan-out）仍 notify；与 wrap 的两次调用被 debounce 合成一次。

hub-sync：只有 apply 成功后一次 notify。本地路径：apply wrap + `publish()`，debounce 合成一次、读的是新 head。

### 2. [P1] batch INSERT `RETURNING` 行序 — **成立**

`appendAgentMessages` 返回 `tx.insert(...).returning().all()`，`AgentRun.persistAndBroadcast` 按该数组顺序广播。SQLite 文档明确 RETURNING 无序。已在返回前按 `seq` 升序排序。

补充：本机 SQLite 当前碰巧按插入序返回，**排序前新测试就不会红**；排序是契约防御，不是本机可复现的乱序 bug。

### 3. [P1] `subscribe` catch 无条件 `unsubscribe` — **成立**

`ws-hub.ts:97-108` 原逻辑：先 `addSubscription`，sync throw 就 `unsubscribe`。已有订阅的 re-sync 失败、或同一 client 两次并发 subscribe 其中一个失败，会拆掉仍然有效的注册，之后广播静默丢失。

修复：in-flight 计数 + established 标记。

- `!sync`（session 不存在）：仍退订。
- throw：仅当 **本次未 established 且没有其他 in-flight** 才回滚。
- 成功至少一次后，re-sync 失败保留订阅。
- 并发：先失败后成功 / 先成功后失败，成功一侧的注册都保留。

这比「只看 newlyAdded」多挡了一种顺序：newlyAdded 的那次失败发生在另一次已经 sync 成功之后，不会把成功一侧拆掉。

### 4. [P2] 单行 append 走事务 — **成立**

`appendAgentMessage` 原委托 `appendAgentMessages`，单行也付 BEGIN / SELECT max / INSERT / COMMIT。已恢复与 `enqueueAgentMessage` 相同的原子子查询 `coalesce(max(seq),-1)+1`。`appendAgentMessages`：length===1 走该快路径；>1 仍用事务，并加 seq 排序。seq 语义（从 0、跨 session 独立、并发唯一递增）不变。

## 改动文件

- `apps/gateway/src/mesh/mesh-runtime.ts`（+ 测试）
- `apps/gateway/src/db/agent.ts`（+ `agent-watch.test.ts`）
- `apps/gateway/src/agent/ws-hub.ts`（+ `ws-hub.test.ts`）

## 设计决策

1. **finding 1 不把 hook 放进 auth-routes。** wrap `apply` 覆盖 hub-sync 与本地 apply 两条 HTTP 写入；inbound `applyMany` 仍走原来的 `createKeyLogApplier`。publisher 抽成可单测的 `createKeyLogPublisher`。
2. **finding 1 是「挪走」而不是「两处都 fire」。** 若 hub-ack 与 apply 后都 notify，apply >100ms 会先广播旧 head。现在只有 apply 成功后的 notify 是新 head 的来源。
3. **finding 3 用 established+inflight，而不是只记 newlyAdded。** 单 newlyAdded 过不了「创建方失败发生在另一方已成功之后」的并发序。
4. **finding 4 单行不进事务。** SQLite 写锁下 `INSERT ... SELECT max(seq)+1` 与唯一约束一起保证 seq；与 queue 表同一模式。

## 风险

- **apply wrap 是实例方法替换。** 类内部走 `applyInternal`，不受影响；HTTP `AuthRoutes` 走实例 `apply`，能吃到 notify。若以后有人不经 `createMeshStoresAndServices` 直接 `new UserKeyService` 再塞进 runtime，会丢这条 notify——生产装配只有这一处。
- **本地路径 debounce 窗口内 apply wrap 与 `publish()` 各 notify 一次。** 与原 debounce 语义一致，仍是一次广播。
- **finding 2 在当前 SQLite 上无法用失败测试证明乱序。** 排序后契约测试锁死升序。
- **re-sync 抛错会 `console.error`（原行为保留）。** 测试输出里仍能看到这些日志。

## 测试

新增：

- `mesh-runtime.test.ts`：`attachKeyLogHeadNotify` 成功才 notify / 失败不 notify；`publishAndAck` 不 notify；`publish` 仍 notify。
- `ws-hub.test.ts`：re-sync 失败保留订阅；并发 subscribe 一方失败保留成功一侧。
- `agent-watch.test.ts`：batch 返回数组 seq 升序；单行与 batch 并发仍唯一递增。

| 项 | 基线 | 本次 |
|---|---|---|
| `apps/gateway` `bun test` | 2842 pass / 0 fail | **2854 pass / 0 fail**（本任务 +8；其余 +4 来自并行 agent） |
| `apps/gateway` `tsc --noEmit` | 21 预存 | **21**（无新增；无本任务文件） |
| complexity gate | ok | **ok**（`mesh-runtime.ts` 1345 行 / allowlist 1347） |
| `bunx biome check` 改动文件 | — | **通过** |

未跑 `packages/shared`（未改）。
