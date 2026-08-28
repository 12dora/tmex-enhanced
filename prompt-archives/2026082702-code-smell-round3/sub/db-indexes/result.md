# db-indexes 执行结果

## 做了什么

### 1. 缺失索引（EXPLAIN QUERY PLAN 验证后才加）

对照 `listQueuedAgentMessages` / `listPendingAgentConfirmations` 的真实 SQL，在独立 bun:sqlite 内存库上跑 `EXPLAIN QUERY PLAN`：

| 查询 | BEFORE | AFTER |
| --- | --- | --- |
| `SELECT * FROM agent_queued_messages WHERE session_id = ? ORDER BY seq ASC` | `SCAN agent_queued_messages` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH … USING INDEX agent_queued_messages_session_seq_idx (session_id=?)` |
| `SELECT * FROM agent_confirmations WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC` | `SCAN agent_confirmations` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH … USING INDEX agent_confirmations_session_status_created_at_idx (session_id=? AND status=?)` |

两条索引都被 planner 选中，且消除了 ORDER BY 临时 B-tree。未再加其它索引。

schema 声明后用项目约定的 `bun run db:generate -- --name agent_query_indexes` 生成 `drizzle/0018_agent_query_indexes.sql`，并登记到 `managed-migrations.ts`。

### 2. `appendAgentMessage` / `enqueueAgentMessage` 单语句分配 seq

原先：`max(seq)` + `INSERT` + `SELECT by id`（三趟同步语句）。

现在：一条 `INSERT … VALUES (…, (SELECT COALESCE(MAX(seq), -1)+1 …), …) RETURNING *`。

- 用 `-1` 而不是任务草稿里的 `COALESCE(MAX(seq), 0)+1`，否则空表第一条会变成 seq=1，破坏现有 0-based 行为。
- SQLite 单条 INSERT 原子；`agent_messages` 仍有 `(session_id, seq)` unique。
- `enqueueAgentMessage` 是同一模式，一并改掉。

### 3. N+1 检查

**`db/agent.ts` 逐函数看过：**

- 列表查询（messages / queued / pending confirmations）都是单条 `WHERE session_id … ORDER BY`，没有 for-each 再查。
- create/update 的 insert/update + get-by-id 是单行回读，不是 N+1。
- 真正的多语句问题只有 seq 分配（已收成 RETURNING）。

**`db/watch.ts` 逐函数看过：**

- `getAllWatchRules` / `getEnabledWatchRules` / `getWatchRuleState` 彼此独立；文件内没有「先拉规则再按规则查 state」循环。
- `watch_rule_state.ruleId` 是 PK，调用方（`watch/service.ts` 每 tick、`api/watch.ts` GET state）是 O(1) 点查。
- `api/watch.ts` `handleListRules` 只返回规则 DTO，不带 state，当前列表接口本身也不是 N+1。

为列表+state 场景补了 `listWatchRulesWithState()`（`LEFT JOIN watch_rule_state`，一条 SQL）。**调用方在 scope 外**（`watch/service.ts`、`api/watch.ts`），没有改；后续若列表要带 state，可直接换这个函数。

## 改动文件

- `apps/gateway/src/db/schema.ts` — 两个 index
- `apps/gateway/src/db/agent.ts` — INSERT RETURNING + `nextSessionSeqSql`
- `apps/gateway/src/db/watch.ts` — `listWatchRulesWithState`
- `apps/gateway/src/db/agent-watch.test.ts` — EXPLAIN before/after、并发 seq、join
- `apps/gateway/src/db/managed-migrations.ts` — 注册 `0018_agent_query_indexes.sql`
- `apps/gateway/drizzle/0018_agent_query_indexes.sql`
- `apps/gateway/drizzle/meta/0018_snapshot.json`
- `apps/gateway/drizzle/meta/_journal.json`

## 测试 / tsc

- `bun test src/db/agent-watch.test.ts`：18 pass / 0 fail
- `bunx biome check --write`（上述 5 个 ts 文件）：No fixes applied
- `bunx tsc --noEmit -p .`：27 errors，与 baseline 一致，**无 db 相关新增**
- `bun test`（整个 gateway）：**1615 pass / 0 fail**（baseline 写的是 1473；本 worktree 其它 agent 已增加用例，全绿）

## 刻意没做

- 没有把 `listWatchRulesWithState` 接到 `watch/service.ts` / `api/watch.ts`（超出 Scope）。
- queued messages 的 `(session_id, seq)` 做成普通 index 而非 unique（任务要的是 query plan 用得上的 index；seq 间隙仍靠 INSERT…MAX 保证）。
- 其它 create/update 的 insert-then-get-by-id 未收 RETURNING（不是 N+1，任务也没要求）。
