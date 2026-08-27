## major

- `apps/gateway/src/auth/user-store.ts:408`：`markEnrollmentUsed()` 无条件更新令牌，没有检查 `used_at IS NULL` 和 `expires_at > now`，也不返回是否成功消费。因此“读取令牌 → 验证 → 标记使用”无法保证单次消费。两个并发的 enrollment redeem 请求可以同时读取未使用令牌并都完成注册，最终仅由最后一次更新覆盖 `node_id`，但两个请求都可能已获得初始化数据。建议提供原子 `consumeEnrollmentToken()`：在事务中执行带 `used_at IS NULL AND expires_at > now` 条件的更新并 `RETURNING`，只有成功更新一行的请求才能继续。

- `apps/gateway/src/auth/node-session-store.ts:26`：`IssueNodeSessionInput` 没有约束 delegation 方法与 `credentialId` 的对应关系，`passkey` 会话可以不带 credential，`root` 会话也可以带 credential；数据库约束同样只校验方法枚举。实际若登录代码签发 `{delegationMethod:'passkey', credentialId:null}`，删除该 passkey 时 `revokeByCredential()` 永远匹配不到此会话，使其继续有效至最长 7 天。建议将输入改成判别联合类型，并为 `node_sessions` 增加 CHECK：`root` 必须为 NULL，`passkey` 必须非 NULL。

- `apps/gateway/src/config.ts:78`：显式的空值或纯空白 `TMEX_ROLES` 被当作默认 `standalone`，不符合只接受 `standalone | node | hub,node`、其他值应拒绝的配置契约。这是 fail-open：例如部署模板产生 `TMEX_ROLES=` 时，服务不会启动失败，而会进入无应用层鉴权的兼容 standalone 模式。建议仅在 `raw === undefined` 时采用默认值；trim 后为空应与其他非法值一样抛错。

结论：表结构、迁移链、challenge 的进程内原子消费、会话滑动续期与硬上限、cookie 属性及私钥加密接线总体符合设计，但上述三个问题会分别破坏 enrollment 单次性、passkey 撤销语义和角色配置的安全失败模式；修复前不建议合入。