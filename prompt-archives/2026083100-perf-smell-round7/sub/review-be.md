审查已完成，但当前沙箱为只读，无法写入指定文件。报告内容如下：

# Code Review（Round 7，Wave 1）

未发现 P0。发现如下问题：

- [P1] `apps/gateway/src/mesh/mesh-runtime.ts:1129`：node-only 的 `publishAndAck()` 在 hub ACK 后立即触发 head 刷新，但本地 `keyLogService.apply()` 尚未执行（`auth-routes.ts:456-475`）。若本地验签/落库超过 100ms，广播会读取旧 head，提交后又没有第二次通知，直连 peer 将漏收新 `key_log_head`。建议：将通知移至本地 apply 成功之后。

- [P1] `apps/gateway/src/db/agent.ts:256`：批量插入直接返回 `.returning().all()`，随后按该数组顺序广播；SQLite 明确规定 `RETURNING` 行顺序不受保证，因此可能先广播较大的 `seq`。[SQLite 官方说明](https://www.sqlite.org/lang_returning.html#limitations_and_caveats)。建议：返回前按 `seq` 升序排序，或按预生成 `id` 恢复输入顺序。

- [P1] `apps/gateway/src/agent/ws-hub.ts:97-108`：sync 抛错时无条件 `unsubscribe()`，会删除此前已经有效的订阅；并发 subscribe 中一个失败也可能删除另一个调用的订阅，导致永久漏收后续事件。建议：为同一 client/session 串行化 sync，或使用代际 token，仅回滚本次创建的登记。

- [P2] `apps/gateway/src/db/agent.ts:219-260`：所有单条 `appendAgentMessage()` 也改为 `BEGIN/SELECT max/INSERT/COMMIT`，相较原来的单条原子 INSERT 增加事务和查询开销。建议：保留单条写入快路径，仅在批量大于一条时使用事务。