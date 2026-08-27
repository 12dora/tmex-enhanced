## blocker

- `apps/gateway/src/mesh/auth-routes.ts:501`：`hub=sync` 即使收到 hub 的明确拒绝或超时，仍会在第 508 行本地应用记录。若本地 head 为 9、hub 已有另一条 seq=10，客户端基于本地 head 生成不同的 seq=10；hub 返回 `fork` 后，本地仍会接受它，直接造成设计要求的“密钥日志分叉”硬失败。应在本地预校验后发送 hub，仅在肯定 ACK 时提交本地；明确拒绝应直接返回 409/4xx，超时则用同一记录做幂等重试或查询 hub head 后消歧。hub 已提交但本地失败时，可依靠相同记录重试恢复。

## major

- `apps/gateway/src/mesh/auth-routes.ts:52`：`publishAndAck` 被声明为可选，但生产组装的 publisher 只有 `publish()`。因此所有 `POST /api/auth/keylog?hub=sync` 都得到 `unavailable`；同时该路径不会执行第 521 行的普通 publish，导致 admit/revoke 只落 entry 本地，hub 完全收不到。现有测试手工注入 `publishAndAck`，未覆盖真实组装。应把同步发布能力接到 `UplinkClient.appendAndAck()`，并用 `createMeshRuntime` 级集成测试覆盖；对 node 角色应将它设为必需依赖。

- `apps/gateway/src/hub/uplink-server.ts:116`：hub 元数据只在可选的 `config.nodeId` 存在时初始化，但生产创建 `HubRuntime` 时没有传 node identity；第 679 行再从尚不存在的 hub meta 回读形成循环依赖。全新 hub 发出的 `node.list` 因而没有 `hub` 字段，普通 node 的 `/api/auth/mode` 会持续返回 `hubNodeId: null`，无法从任意 entry 构造 Hub API 路由。类似地，新增的 `hubPublicUrl` 也未传入生产 `MeshHttpRuntime`。应让 hub `nodeId` 成为必填配置，并从已创建的 `node_identity` 注入，同时把 `hubPublicUrl` 传到 HTTP runtime；测试必须走真实生产组装。

- `apps/gateway/src/mesh/mesh-routes.ts:165`：新增的 `forwardEnrollRedeemed()` 当前只被测试直接调用；生产 `createMeshRuntime` 没有把 `UplinkClient.onEnrollRedeemed` 接到该方法，所以实际 redeem 推送会被静默丢弃，只能依赖轮询。应在 runtime 组装时完成 callback 接线，并增加 hub→uplink→entry→浏览器的集成测试。

- `apps/gateway/src/mesh/mesh-routes.ts:178`：即使完成上述接线，`ENROLL_REDEEMED` 仍通过 `broadcast()` 发给 entry 上所有 `/mesh/ws`，而不是创建 enrollment 的浏览器会话。另一台已登录浏览器会收到不属于自己的证书并产生“未知节点证书”告警。当前 enrollment 只保存 `entry_node_id`，没有足以定向的 sid。应在创建 enrollment 时持久化创建者的 node-session sid，将收件 sid 随 uplink 通知带回，并仅向 `ws.data.sid` 匹配的 socket 发送。

- `apps/gateway/src/hub/uplink-server.ts:444`：记录先持久化，再执行可能抛错的 `applyAppendEffects()`/`broadcastNodeList()`，最后才发送 ACK。若广播过程中某条已关闭 uplink 的 `send()` 抛错，hub 已提交记录但调用方只能超时；重试进入第 452 行的 identical-record 分支后直接 ACK，又不会重跑遗漏的广播。revoke/admit 因此可能长期未通知其他在线 node，直到另一个事件碰巧触发 node.list。ACK 应表示“hub 已持久化”，在持久化成功后立即发送；广播应成为可重试、幂等的后续动作，或通过 outbox 保证恢复，重复 append 时也应补做未完成的投影/广播。

## minor

- `apps/gateway/src/mesh/uplink-protocol.ts:240`：新增 ACK、hub meta 和 enrollment 消息只检查字符串/base64 类型，没有 hub 侧已有的总字节数、字符串长度及字段语义边界；`enroll_pk`、`cert_sig`、`node_id` 也未分别限制为 32 字节、64 字节和 32 位十六进制。异常 hub 可以发送接近链路帧上限的证书、ID或错误字符串，node 随后还会把它重新编码并推给浏览器。应在 node 侧镜像 `UPLINK_CTL_MAX_BYTES` 等限制，并为新字段添加精确或合理上限。

- `packages/shared/src/ws-borsh/schema.ts:492`：`EnrollRedeemedSchema` 把固定长度的 `enrollPk` 和 `certSig` 定义成无界 `b.bytes()`，使畸形长度仍能通过协议解码并进入业务层。应分别改为 `b.bytes(32)`、`b.bytes(64)`，并在编码前限制证书长度、校验 `nodeId` 格式。

结论：该 diff 目前不应合入。根公钥公开、按 `userId` 限制 enrollment 查询以及 hub `publicUrl` 可能被篡改但只能造成 DoS，均符合既定信任模型；主要问题集中在 keylog 同步会制造真实分叉、生产依赖未接线，以及 enrollment 推送缺少浏览器会话级定向。