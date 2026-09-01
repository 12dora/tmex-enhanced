结论：暂不应合入。发现 5 个 blocker，其中普通节点伪造 hub 是直接违反威胁模型的安全漏洞。

## Blocker

1. **任意普通节点都能自封 writer、降级真实 writer，并把全网引向攻击者 hub。**

   [uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:614) 只校验普通节点证书；[uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:728) 无条件接收 `node.status.hub`；[uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:1241) 将发送者写入 `mesh_hubs`，并在高 epoch 时降级自身。

   失败场景：失陷普通节点发送 `{mode:'active', writerEpoch: 999999, publicUrl: attacker}`。真实 active 立即变 standby，广播把攻击节点选为 writer；全体节点持久化该地址，并可能通过 [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:598) 信任攻击者提供的 CA 指纹。攻击者由“只能影响本机”升级为全网控制面 DoS、信令/目录篡改和 uplink 劫持。

   最小修复：必须分离“节点已认证”和“节点获授权充当 hub”。优先在用户签发的节点证书/`admit-node` 中加入 hub capability；短期可由 writer 配置 hub nodeId allowlist。未授权广告不得写入 store、参与 writer 选择、触发 fencing 或传播 CA 指纹。仅限制 fencing 还不够，因为攻击节点仍会被广播和加入 failover 池。

2. **`hub,node` 生产路径绕过了整个远端 failover 池，standby 实际不会 uplink 到 active。**

   [mesh-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:1327) 默认把本机 `HubRuntime` 设为 `uplinkHub`；[mesh-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:1398) 总是建立本机 `InMemoryLink`。[uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:332) 的 custom-connect 分支也不会遍历其他候选。

   失败场景：standby 的 `TMEX_HUB_URL` 指向远端 active，但链路实际接入本机 hub。客户端按远端 host 签 auth transcript，本机 hub 按本机 public URL 验证，认证会持续失败；即使两个 URL 相同，也永远不会 failover、复制远端注册表或切回 writer。

   最小修复：让 transport 按候选选择——只有候选确实是本机 hub 时用 `InMemoryLink`，其余候选走正常 WS；不能用 `start(connectOnce)` 锁死整个池。

3. **写入围栏只检查配置模式，不检查本机是否为当前 writer；自动降级重启后会复活成 writer。**

   [uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:207) 每次启动从 env 恢复 `currentMode`；`setMode()` 只改内存。[hub-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-runtime.ts:198) 也仅判断 `mode === standby`。

   失败场景：A(epoch 1) 被 B(epoch 2) 降级后重启；数据库仍知道 B 是高 epoch active，但 A 从 env 恢复为 active，并立即接受 enrollment/rename/revoke，形成双 writer。

   最小修复：启动时依据已授权 hub 集合重新 fencing；所有写入口同时要求 `mode === active && pickWriterHub(...) === self`。自动降级还应持久化，或至少保证每次启动都先完成该检查再开放写路由。

4. **候选顺序变化后不会启动 preferred-hub probe，正常 promote 后节点可能永久留在旧 standby。**

   `node.list` 在 [mesh-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:856) 更新 store，但 probe 只在 [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:549) 的成功 promote 时同步。

   失败场景：节点原本挂 A，B 以更高 epoch promote，收到的新列表把 B 排到第一、A 改为 standby；节点仍连着健康的 A，既不断线也没有 probe timer，因此永不切换 B。

   最小修复：处理并持久化每个 live `node.list` 后重新执行 `syncProbe()`，并刷新 `attached.mode/writerEpoch/hubNodeId`。

5. **standby 接受 chain-extending `key.log.append`，实质上仍是第二个日志 writer，存在确定的 fork 风险。**

   [uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:588) 和 [uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.ts:850) 没有模式围栏。

   失败场景：节点 X 将本地生成但尚未被 writer 接受的 seq=N+1 推给 standby；同时 active 从节点 Y 接受另一个合法签名的 N+1。两边分别延长不同链，随后同步触发不可恢复的 hard fork。当前协议无法区分“writer 已接受的 catch-up”与“新鲜 append”。

   最小修复：standby 只允许 identical replay，拒绝任何延长链的 append；它可通过本进程 node uplink 从 active 拉取并写入共享 DB。若必须接收延长记录，需要 writer receipt 或专用、可验证来源的复制协议。

## Should-fix

1. **`switchTo` 与连接/probe 没有 single-flight。**

   [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:413) 会覆盖 `pending`，而 [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:475) 的旧连接完成后仍可 `promote`，把刚切好的链路关闭。最多 16 个顺序 probe 可超过 60 秒，[uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:700) 又允许下一轮并发进入。增加 switch token/mutex、probe in-flight guard，并给 60 秒周期加抖动，避免全网探测风暴。

2. **复制源 ID 错用 legacy writer，且真实共享-store 调用顺序仍会删除自身 hub 行。**

   [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:577) 用 `list.hub.nodeId` 作为来源；连接 standby 时这个字段指向 active writer，并不是发送列表的 standby。自源忽略因此可能失效。

   同时 node 侧先在 [mesh-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:862) `replaceAll`，外部 listener 才进入 [hub-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/hub-runtime.ts:178)。若入站列表暂未包含本机，HubRuntime 此时已无法取得用于保留的 own row。来源应取实际 authenticated client/candidate；hub 自身行应由配置快照无条件重新加入，而不是依赖 store 中仍存在。

3. **CA pin 算法正确，但下载和证书验证过弱。**

   [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:166) 计算的 SHA-256 SPKI hex 与现有 TLS 实现一致，比较也正确；正常路径只从当前已认证 uplink 的 `node.list` 触发。没有独立的“未认证指纹直接入库”路径，但 blocker 1 会把未授权广告洗成已认证广播。

   [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:198) 没有超时/大小限制，接受任意首张证书而不验证 CA basic constraints。恶意已授权 hub 可让所有节点无限下载直至内存耗尽。应限制约 64 KiB、5 秒超时、严格单 PEM、要求 CA/keyCertSign，并校验指纹为 64 位 hex；按 URL 对 bootstrap single-flight。

4. **pool 级 generation guard 未完全覆盖 relay/fork 回调。**

   `node.list`、RTC、enrollment 的 superseded-client 检查存在，旧 client 的 key-log reset/AbortSignal 也基本正确。但 [uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:326) 会把 relay handler 同时装到 pending client，`onKeyLogFork` 也没有 live-client guard。pending 链路可在正式 promote 前注入 relay/fork 事件。应只在 promote 后启用 relay，并用 client identity/generation 包装所有外部回调。

5. **CA 指纹只在启动时读取一次。**

   [mesh-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/mesh-runtime.ts:828) 的 `refreshTls()` 只调用一次。运行中 CA 轮换后仍广告旧指纹，新节点下载新 CA 后比较失败。TLS 变更应刷新状态并调用 `sendStatusIfChanged()`。

## Nit

- [uplink-client.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-client.ts:294) 已在认证成功后发送一次 `node.status`，[uplink-pool.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/mesh/uplink-pool.ts:565) promote 后又立即发送一次。通常只造成额外 DB/inventory-version 更新和广播，可去重。

## 核对为正常

- v1.1.5 的 `node.list`/`node.status` decoder 确实忽略未知键；兼容性判断正确。
- 旧 hub 缺少 `hubs[]` 时的 legacy synthesis、legacy `hub` 指向 writer、`peer_cache node_id='hub'` 保持 writer 元数据，逻辑一致。
- `/api/auth/mode` 的空 store 回退到旧 sentinel；hub 角色回退自身，符合当前兼容约定。
- make-before-break 的基本顺序是新链认证成功、替换 live、再关闭旧链；all-candidate backoff 和旧链 `node.list` 丢弃也正确。
- `applyReplicatedNodeList` 的证书/吊销 gating、缺席节点不删除、离线节点不刷新 `last_seen_at` 本身正确。
- `HUB_NOT_WRITER` 返回的 nodeId/public URL/epoch 属于本就广播的路由元数据；redeem 公开返回这些字段可以接受，不构成敏感信息泄露。
- relay 诊断已改成动态读取当前 attached hub host，方向正确。

## 测试评估

我实际运行了相关现有测试：gateway 3 个针对性文件 **57 pass / 0 fail**，shared codec **11 pass / 0 fail**。这些测试确认当前实现行为，但没有覆盖关键安全与真实装配场景：

- [uplink-server.test.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.test.ts:2078) 反而把“任意普通节点高 epoch 广告能 fencing”作为成功用例。
- 没有真实 dual-role standby→active→failover/切回集成测试。
- pool 全是假 client，缺少 concurrent `switchTo`、动态重排后启动 probe、重叠 probe 和 pending relay。
- CA 测试没有真实证书、超大/悬挂响应、非 CA、失效链路负向用例。
- replication 测试直接调用 HubRuntime，没有覆盖 node handler 与 HubRuntime 共用 store 的真实先后顺序。
- [uplink-server.test.ts](/Users/konata/code/tmex-enhanced-wt-r13/apps/gateway/src/hub/uplink-server.test.ts:2177) 明确断言了存在 fork 风险的 standby append 行为。