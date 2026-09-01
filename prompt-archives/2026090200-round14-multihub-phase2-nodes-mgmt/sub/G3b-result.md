# G3b 结果 — Node-side uplink：node.list 立即 fail-back 探测 + Hub RTT 诊断

## 做了什么

`UplinkPool.dispatchNodeList()` 在 `onNodeList`（更新 `mesh_hubs` / `candidates()`）之后比较上一份 hub view：

- 当前挂载之前的候选由 offline/unknown → `online`
- `writerHubId` / `writerEpoch` 变化
- 挂载从「最优」变为「非最优」，或最优候选身份变了

满足任一条件则立即 `probePreferred()`（仍须 `/healthz` 成功 + CA pin + generation 守卫才 `switchTo`）。5 s debounce；探测进行中只 coalesce 一次；日志 `[uplink] failback probe triggered by node.list` 按既有 60 s 节流。原 60 s ±20% 定时器保留作兜底。

每个 `/healthz`（fail-back 与周期探测）用 `performance.now()` 记 monotonic `rttMs`，`rttAt` 用 scheduler 时钟，写入 `diagByUrl`，经 `candidates()` 快照带出。≥2 个候选时每 5 min ±20% 探测全部候选 RTT（`NODE_ENV=test` 默认关闭，测试可 `enablePeriodicRttProbe`）。**不按 RTT 排序或切换。**

连接尝试没有廉价 `/healthz` hook，因此只在实际 healthz 上记 RTT。

## 文件

- `apps/gateway/src/mesh/uplink-pool.ts`
- `apps/gateway/src/mesh/uplink-pool.test.ts`
- `packages/api-client/src/auth/types.ts`（仅 `MeshHubsResponse.candidates` 元素）
- `packages/api-client/src/auth/auth-api.ts`
- `packages/api-client/src/auth/auth-api.test.ts`
- `docs/hub/2026090104-multi-hub-standby.md`（仅「故障切换与切回」）

## `GET /api/mesh/hubs` 需要的一行改动（未改 `mesh-routes.ts`）

`apps/gateway/src/mesh/mesh-routes.ts` `serializeHubCandidate`：

对象分支现为 `lastAttemptAt: entry.lastAttemptAt ?? null,`，改为：

```ts
lastAttemptAt: entry.lastAttemptAt ?? null, rttMs: entry.rttMs ?? null, rttAt: entry.rttAt ?? null,
```

字符串分支同步补 `rttMs: null, rttAt: null`，返回类型补 `rttMs?: number | null; rttAt?: number | null`。

路由已读 `w.uplink.candidates()`（`mesh-runtime.ts` `hubCandidates`），pool 快照已含字段。

## 验证

| 命令 | 结果 |
|---|---|
| `apps/gateway` `bun test src/mesh/uplink-pool.test.ts` | **38 pass / 0 fail** |
| `apps/gateway` `bunx tsc --noEmit -p .` | **0 errors** |
| `packages/api-client` `bun test` | **140 pass / 0 fail** |
| `packages/api-client` `bunx tsc --noEmit -p .` | **5 errors**（`client.test.ts` / `files-download.test.ts` 预存，未新增） |
| `bunx biome check` 上述源文件 | 通过 |

未跑 gateway 全量 `bun test`（其它 agent 并行改同 worktree；本任务文件已绿）。

## 未做 / 留给别人

- 未改 `mesh-routes.ts`（见上）
- 未按 RTT 改变候选顺序或附着策略
- 未测真实 connect 路径的 RTT（无 cheap healthz hook）
