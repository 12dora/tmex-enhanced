## 审查结论

不建议按当前状态合入：发现 **2 个 blocker、1 个 should-fix、无 nit**。权威 key-log apply 的安全不变量本身成立，主要问题在版本门禁和接入顺序。

### Blocker 1：relay 模式会绕过 `readmit-node` 的旧节点版本门禁

位置：[hub-authorization.ts:165](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:165)、[hub-authorization.ts:221](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:221)、[hub-authorization.ts:255](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:255)

`readmit-node` 被归入可以在空成员缓存下 bootstrap 豁免的记录类型；relay 模式只要已有一个 peer，还会直接跳过其他没有 `peer_cache` 的未吊销证书。

因此以下两种情况都会错误放行：

- `peer_cache` 完全为空，但 `node_certs` 中存在未吊销旧节点。
- 至少有一个缓存成员，但另一个未吊销旧节点离线或尚未进入缓存。

这些节点的版本可能低于 1.1.26。它们收到未知的 Borsh enum variant 后会卡在该 key-log seq，无法继续消费后面的 `set-relays`、吊销或密钥轮换记录。这违背了“所有未吊销节点达到 1.1.26”的 fail-closed 要求。

最小修复：

- 不要把 `readmit-node` 纳入空缓存 bootstrap 豁免；它要求已有证书，本身不存在首节点 bootstrap 场景。
- 对 `readmit-node` 禁止 relay 模式的 `skipUncached`。任何未吊销、非本机且版本未知的证书都应作为阻塞节点返回。
- 增加“空 peer cache 但有 cert”和“一个已缓存、一个未缓存 cert”两个测试。

### Blocker 2：远端已经换发并作废旧令牌后才执行 readmit，失败会留下不可用的半状态

位置：[relay-enroll.ts:227](/Users/konata/code/tmex-r25/apps/fe/src/node/relay-enroll.ts:227)、[relay-enroll.ts:235](/Users/konata/code/tmex-r25/apps/fe/src/node/relay-enroll.ts:235)、[relay.ts:186](/Users/konata/code/tmex-r25/packages/app/src/commands/relay.ts:186)、[relay-routes.ts:111](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-routes.ts:111)

FE 和 CLI 的顺序都是：

1. 调用远端 relay enroll。
2. 执行若干 `readmit-node`。
3. 写入 `set-relays`。

但重复 enroll 会立即换发 tenant token，并断开仍持有旧 token 的全部链路：[relay-routes.ts:115](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-routes.ts:115)。

如果随后 readmit 因版本门禁、passkey、hub writer 超时或部分 append 失败而中止，`set-relays` 不会落账，账号仍保存旧 token。已有 relay 会立即不可用；首次接入则会留下孤立 tenant。新增 readmit 步骤把多个正常可预期的失败点放在了不可逆的远端令牌切换之后。

最小修复：

- FE 和 CLI 都应先通过本地 `/readmit/prepare` 完成全部 readmit，再获取新的 proof material 并调用远端 enroll。
- 不要依赖远端 enroll 响应中的 `readmitRequired` 才开始预检；本地 prepare 空列表本来就是无操作。
- 更完整的方案是把 token reissue 改成两阶段提交，在 `set-relays` 确认后才作废旧 token。

已经成功落账的部分 readmit 本身不是危险半状态：它们只推进授权 sidecar，重试时 prepare 会自动略过，证书和当前上级均未改变。

### Should-fix：CLI 无法处理由 passkey 授权的历史成员，FE 也永久依赖原 credential

位置：[relay-session.ts:353](/Users/konata/code/tmex-r25/packages/app/src/lib/relay-session.ts:353)、[readmit-members.ts:162](/Users/konata/code/tmex-r25/apps/fe/src/node/readmit-members.ts:162)、[readmit-members.ts:178](/Users/konata/code/tmex-r25/apps/fe/src/node/readmit-members.ts:178)、[readmit-node-record.ts:43](/Users/konata/code/tmex-r25/packages/shared/src/auth/readmit-node-record.ts:43)

CLI 总是直接用 root 对原 `authorization_bytes` 签名。但 apply 根据字节内部的 `authorization.signer` 选择验证算法；原授权如果是 `passkey`，root Ed25519 签名必然被当作 WebAuthn assertion 解码并拒绝。

FE 会尝试调用原授权指定的 credential。若该 passkey 已移除、丢失或当前设备不可用，即使用户掌握当前 root 密码，也无法重新确认这个仍然有效且未吊销的证书。

最小修复：

- root readmit 时重新编码一份 root-signed `Authorization`，保留相同的 `uid`、`enroll_pk` 等绑定，并使用当前 `root_epoch`、`signer: 'root'`、`credential_id: null`。
- 证书字节继续要求完全一致，因此不会允许换绑 node id 或节点密钥。
- 增加“原 admit 使用 passkey、readmit 使用当前 root”和“原 passkey 已删除”的 CLI/FE 测试。

## 其余核查结果

- **吊销、node id 换绑及旧 epoch 重放：通过。**  
  [readmit-node-record.ts:105](/Users/konata/code/tmex-r25/packages/shared/src/auth/readmit-node-record.ts:105) 先按当前 root/passkey 验证授权，再要求证书已存在、未吊销且证书字节完全一致。key-log 外层仍要求当前 `root_epoch` 和当前签名者，旧根无法重放。并发时，revoke 先落账则 readmit 被拒绝；readmit 先落账则后续 revoke 最终生效。

- **`admit_record_seq` 和 hub 流程：通过。**  
  [user-key-persistence.ts:294](/Users/konata/code/tmex-r25/apps/gateway/src/auth/user-key-persistence.ts:294) 只更新 seq 和授权材料，保留原证书、证书签名、用户归属及吊销状态。`unknown-cert`、`node.list` 和 enrollment 查询均直接使用 `node_certs`/`enrollment_tokens`，不要求该 seq 的记录类型必须为 `admit-node`。  
  [relay-member.ts:64](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-member.ts:64) 已让 `selfAdmitMemberProof` 同时识别 `admit-node` 和 `readmit-node`。

- **relay sidecar：没有新增弱化。**  
  tenant-token 持有者确实可以伪造标记为 passkey-signed 的 readmit sidecar，因为 tolerant-admit 模式无法验证 WebAuthn assertion；但当前 `admit-node` 已经具有完全相同的能力，并能通过同一个 `op: 'admit'` 覆盖未吊销 relay 注册行，因此新类型没有增加攻击能力。relay 对 root-signed sidecar仍验证当前根，对旧 epoch 明确拒绝；revoked 行在 store 中是终态，伪造 readmit/admit 都不能复活它。

- **迁移 0045：通过。**  
  [0045_readmit_node_keylog.sql:2](/Users/konata/code/tmex-r25/apps/gateway/drizzle/0045_readmit_node_keylog.sql:2) 完整复制原列，保留复合主键、到 `users` 的级联外键和 CHECK，并重建唯一索引。仓库中没有表外键引用 `user_key_log`。Drizzle migrator 在事务中执行整个迁移，失败会回滚；`PRAGMA foreign_keys` 在事务内实际不会切换，但该表作为外键子表进行重建仍是安全的。主要升级风险是上面的版本门禁绕过，而不是 SQL 重建本身。