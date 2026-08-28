# history-reader 拆分结果

## 做了什么

`pane-history-reader.ts` 的 `readPage`（原 120 行、CC≈19）按职责拆开。`PaneHistoryReader` 仍从原路径导出，公开 API 不变。

| 文件 | 职责 |
| --- | --- |
| `pane-history-session.ts` | cursor / session 生命周期、TTL sweep、容量淘汰、eviction 判定与抛错 |
| `pane-history-page.ts` | 纯函数：range 请求构造、anchor 校验、byte-limit 行选择、空页 |
| `pane-history-reader.ts` | `readPage()` 只串联 session 生命周期、tmux capture 与结果组装 |

`readPage` 现 40 行 / CC 4；`assemblePage` 34 行 / CC 4。抽出函数均 ≤ 60 行、CC ≤ 12。

行为与拆分前一致：分页方向、anchor 边界、eviction 删除时机（`beforeLine > historySize` 与 anchor mismatch 会删 session，row-count mismatch 不删）、超大行 UTF-8 截断、TTL 过期。

## 改动文件

- `apps/gateway/src/tmux-client/pane-history-reader.ts`（编排 + 再导出）
- `apps/gateway/src/tmux-client/pane-history-session.ts`（新）
- `apps/gateway/src/tmux-client/pane-history-page.ts`（新）
- `apps/gateway/src/tmux-client/pane-history-page.test.ts`（新）
- `apps/gateway/src/tmux-client/pane-history-reader.test.ts`（未改）

## Bug

无行为 bug。本次是等行为拆分。

## 测试

```
cd apps/gateway && bun test src/tmux-client/pane-history-page.test.ts src/tmux-client/pane-history-reader.test.ts
# 10 pass / 0 fail（原 reader 3 + 新增 page 7）
```

新增纯函数用例：

- anchor：无 boundary 原样返回；匹配则丢掉最后一行；hash 不匹配 / 空捕获 → `{ ok: false }`
- byte-limit：刚好等于上限整页纳入；少 1 字节只留末行且不截断；多字节行按 `truncateUtf8Tail` 在码点边界截断
- 空页：`selectLinesByByteLimit([])` 零行；`emptyHistoryPage` 零数据、无 nextCursor
- range：首屏 / 续屏 tmux 坐标与现有 reader 测试锁定的 `[-2,-1]` / `[-4,-2]` 一致

全包：`bun test` → **1607 pass / 2 fail**（基线 1473；本任务 +7）。2 个失败均不在本范围，属并行 agent：

- `agent query indexes > list pending confirmations uses (session_id, status, created_at) index`（`db-indexes`）
- `LegacyFeedBroadcaster pane observer counts > skips batching when nobody observes...`（`legacy-broadcaster`，`legacyPaneObserverCount` 未定义）

未修。

## tsc / biome

- `bunx tsc --noEmit -p .`：27 个 `error TS`，与基线一致；**本任务文件 0 条**。
- `bunx biome check --write` 对本任务 4 个实现/测试文件（含未改的 `pane-history-reader.test.ts`）：干净。

## 未做 / 原因

- 未改其它 `tmux-client` 文件、未改 `pane-history-reader.test.ts`（任务要求原测试原样通过）。
- 未给 session store 单独加测试：cursor TTL / eviction 已由原 `pane-history-reader.test.ts` 覆盖。
- 未把 `PaneHistoryPage` 从 session 类型依赖中解开：`nextCursor` 需要 `PaneHistoryCursor`，page 仅 `import type`，运行时无环。
