# 多 Hub Phase 2 传输侧探索报告

先给出两个代码事实：

- `packages/shared/src/mesh/**` 当前不存在；uplink wire codec 实际在 `packages/shared/src/uplink/codec.ts`。
- `apps/gateway/src/tls/**` 主要是配置存储；TLS 运行时在 `packages/app/src/tls/**`。

## 1. Hub-to-hub relay

### Current

- 节点建链顺序位于 `apps/gateway/src/mesh/peer-manager.ts:1276`：DC → `ws-secure` → relay。
- relay 使用现有 `LinkStream`，不是 `UPLINK_CTL` 消息：
  - `packages/shared/src/link/types.ts:49`
  - `packages/shared/src/link/mux.ts:449`
  - `apps/gateway/src/mesh/uplink-client.ts:347`
- 节点打开 relay 时仅发送 `{ to: nodeId }`。Hub 在 `apps/gateway/src/hub/uplink-server.ts:1049` 的 `onIncomingStream()` 中：
  - 校验来源连接、证书、撤销状态、同用户；
  - `registry.get(open.to)` 查找目标；
  - 目标必须存在于当前 Hub 的本地 `NodeRegistry`；
  - 在 `apps/gateway/src/hub/uplink-server.ts:1078` 打开目标连接并在 `:1086` 双向 pump。
- 因此当前 relay 只能到达同一 Hub 的节点。`HubRuntime.registry` 是本进程内存映射，`apps/gateway/src/hub/node-registry.ts:12`、`:39`。
- 没有 Hub relay 表：
  - `nodes` 只有节点状态、版本、端点，`apps/gateway/src/db/schema.ts:597`；
  - `peer_cache` 只有节点端点和 inventory，`:652`；
  - `mesh_hubs` 只有 Hub 元数据，`:718`；
  - `mesh_hubs` 没有节点归属字段。
- `/n/<nodeId>/api` 与 `/n/<nodeId>/ws` 只是入口代理：
  - 路由解析：`apps/gateway/src/mesh/forwarder.ts:145`
  - HTTP 转发：`:629`、`:670`
  - WebSocket 转发：`:688`、`:703`
  - 最终仍调用 `PeerManager.getLink()`，所以也只能依赖当前 Hub 的 relay。
- 浏览器 `/mesh/ws` 只承载 RTC signalling，不是数据 relay：
  - Borsh signal 解码：`apps/gateway/src/mesh/mesh-routes.ts:170`
  - 当前 origin 生成 `/mesh/ws`：`apps/fe/src/node/mesh-events.ts:188`
- `rtc.signal` 当前只能转发到同 Hub 的 `NodeRegistry`：
  - `apps/gateway/src/hub/uplink-server.ts:1007`
  - 目标查找及发送：`:1028`、`:1030`
  - DC signal 也只查本地 registry：`:1033`
- Hub 间目前只有“standby 作为 node 连接 writer”的 uplink，没有专用 inter-hub endpoint：
  - Hub WebSocket endpoint：`apps/gateway/src/hub/hub-runtime.ts:290`
  - B→A 的本地/远端 uplink wiring：`apps/gateway/src/mesh/mesh-runtime.ts:975`
- relay 数据进入 WebSocket session 时由 `LinkStreamCarrier` 承载：
  - `apps/gateway/src/mesh/stream-targets.ts:490`
  - `apps/gateway/src/mesh/link-stream-carrier.ts:6`

`attachedHubId` 当前不存在。`node.list` 的节点字段只有 `id/name/online/endpoints/inventory/direct_capable/version`，见 `packages/shared/src/uplink/codec.ts:259`、`:363`、`:664`。

### Proposed

采用现有“standby uplink → writer”的连接，不新增独立 Hub TCP/WS 链路。

1. 每个 Hub 保存一个内存路由表：

   ```text
   nodeId -> attachedHubId, attachmentVersion, lastSeen
   ```

   本地节点归属来自本地 `NodeRegistry`；standby Hub 将自己的本地 attachment 集合通过 writer uplink 上报。

2. 增加 Hub-only 的 `hub.attachments` 控制消息。接收方只能接受：

   - 发送连接的 node id 位于 `TMEX_HUB_PEERS`；
   - 已通过 Hub CA pin / expected node id 校验；
   - 连接发送过合法的 `node.status.hub` 广告。

3. `node.list.nodes[]` 增加可选 `attachedHubId`。writer 将自己掌握的 attachment route 投影给所有节点。

4. relay 的跨 Hub 转发：

   - C 在 A 上打开 relay 到 D；
   - A 根据 `D -> B` 路由，在 A 与 B 的已认证 Hub uplink 上打开 `hub-relay` stream；
   - B 将该 stream 转给本地 D；
   - 返回方向使用相同机制。
   - Hub 只转发加密的 relay payload，不终止节点间 relay handshake。

5. `rtc.signal` 增加 Hub-only forwarding envelope，例如：

   ```text
   {
     t: "hub.forward",
     kind: "rtc.signal",
     originHubId,
     returnHubId,
     visitedHubIds,
     signal
   }
   ```

   目标 Hub 将 signal 注入本地 `UplinkServer`/registry；返回 signal 根据 `returnHubId` 返回浏览器所在 Hub。

6. loop prevention：

   - `visitedHubIds` 不得重复；
   - `hopCount` 设置上限，当前两 Hub拓扑上限为 2；
   - 禁止根据客户端提供的 `attachedHubId` 建立信任，只把它当路由提示；
   - 跨 Hub link 必须是 allowlist Hub 的已认证连接。

7. failover：

   - Hub uplink 断开时，正在传输的跨 Hub stream reset；
   - 不迁移正在进行的 relay/WS stream；
   - 节点根据新 writer 的 `node.list` 重新获取 attachment route 并重新 dial；
   - 旧 writer 恢复后，现有 epoch fencing 将其留在 standby，避免旧 route 重新成为 writer。

### Files to touch

- `packages/shared/src/uplink/codec.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/node-registry.ts`
- `apps/gateway/src/mesh/uplink-client.ts`
- `apps/gateway/src/mesh/uplink-pool.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/mesh/node-list-projection.ts`
- `apps/gateway/src/mesh/peer-manager.ts`
- `apps/gateway/src/mesh/rtc/signaling.ts`
- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`

### Wire/DB changes

- 新增 `UPLINK_CTL_TYPES`：
  - `hub.attachments`
  - `hub.forward`
- `node.list.nodes[]` 新增可选 `attachedHubId`。
- relay OPEN payload 增加 `kind/originHubId/nextHubId/visitedHubIds`。
- `rtc.signal` 通过 `hub.forward` 封装。
- 最小设计不修改 DB。路由是连接态数据，应在 uplink 重建。
- 不修改 `nodes`、`peer_cache`、`mesh_hubs`。

### Risks

- 被攻陷的 Hub 可丢弃、延迟、重排自己的流量，但不能成为全局信任根。
- 必须避免把 `attachedHubId` 当作授权依据。
- `hub.attachments` 必须限制大小、版本和过期时间。
- 跨 Hub 会增加 relay 带宽和 backpressure 压力。
- RTC session route 需要 TTL，不能永久保留 `rtcSession -> Hub` 映射。

---

## 2. 按 RTT 选择最近 Hub

### Current

节点候选来源和排序：

- `MeshHubStore.orderedEndpoints()`：`apps/gateway/src/auth/mesh-hub-store.ts:122`
- 存储 Hub 与 seed 合并：`apps/gateway/src/mesh/uplink-pool.ts:198`
- seed 默认 priority 从 1000 开始：`:231`
- 当前排序为 active 优先、active 的 `writerEpoch` 降序、priority 升序：`:251`
- writer 选择为 active 中 epoch 最大，再 priority，再 node id：`apps/gateway/src/auth/mesh-hub-store.ts:156`
- 连接尝试循环：`apps/gateway/src/mesh/uplink-pool.ts:638`
- 每个候选最多三次失败，认证 deadline 20 秒：`:33`、`:705`

当前没有 RTT 字段。`UplinkCandidate` 只有 Hub 标识、角色、epoch、priority、CA 和诊断信息，见 `apps/gateway/src/mesh/uplink-pool.ts:43`。

failback：

- 只对当前候选顺序中位于 attached 之前的 Hub 做探测；
- `GET /healthz` 只返回 boolean：`apps/gateway/src/mesh/uplink-pool.ts:319`
- 定时器 60 秒，±20% jitter：`:995`、`:1001`
- 探测成功后调用 `switchTo()`：`:1032`、`:1039`
- 当前不测 RTT，也不因 RTT 变化主动切换。

浏览器：

- `/mesh/ws` 永远使用当前页面 origin：`apps/fe/src/node/mesh-events.ts:188`
- `MeshEventSource` 默认使用该地址：`:281`
- `/n/<nodeId>/ws` 也从当前页面 origin 派生：`packages/api-client/src/node-url.ts:117`
- `ApiClient` 默认使用相对 URL：`packages/api-client/src/client.ts:57`
- `/api/mesh/hubs` 已存在且需要 session，返回：
  - `hubs[]`
  - `attached`
  - `writerHubId`
  - `candidates[]`
  见 `apps/gateway/src/mesh/mesh-routes.ts:202`、`:209`。
- `candidates[]` 当前只有 `publicUrl/lastError/lastAttemptAt`，`packages/api-client/src/auth/types.ts:250`。
- FE 只保存 `hubs/attached/writerHubId`，丢弃 candidates：`apps/fe/src/node/mesh-hubs.ts:112`。
- Hub UI 当前只是展示 chip，不可选择：`apps/fe/src/pages/settings/nodes/management/hub-strip.tsx:35`、`:68`。

关键限制：当前节点只有一个 active uplink。节点附着 standby 后，写请求会被拒绝：

- `POST /api/auth/keylog` 在 `apps/gateway/src/mesh/auth-routes.ts:475`
- standby 检查在 `:488`
- 返回 `HUB_NOT_WRITER` 在 `:706`

### Proposed

#### Node

将“数据附着 Hub”和“writer 写入路径”分离：

- `attachUplink`：按 RTT 选择最近的 authorized Hub，用于 relay、节点状态、普通 mesh 数据。
- `writerUplink`：始终连接当前 `writerHubId`，用于 `key.log.append`、key-log sync 和其他 writer-only 操作。
- writer 变化时只切换 writer uplink，不强制切换最近的 attach Hub。
- 在未实现独立 writer uplink 前，不能允许节点任意附着 standby，否则现有写路径必然继续返回 409。

RTT 测量：

- 只测 `mesh_hubs` 中已授权且有 CA/合法 HTTPS 身份的 Hub；
- seed 的 `hubNodeId === null` 在完成身份确认前不能参与最近 Hub 选择；
- 对每个 Hub 的 `/healthz` 测量 monotonic elapsed time；
- 保留 `rttMs/rttAt/healthy` 为内存诊断；
- 排序优先使用健康状态，再 RTT；RTT 接近时使用当前 epoch/priority/node id 稳定打破平局；
- 加最小切换收益阈值和最短驻留时间，避免网络抖动导致频繁切换；
- writer 选择仍由 epoch fencing 规则决定，不能被 RTT 覆盖。

#### Browser

- `/api/mesh/hubs` 继续作为 Hub 列表来源；
- FE 对每个 `publicUrl/healthz` 做轻量 GET 计时，保存本地 `rttMs/rttAt`；
- `HubStrip` 展示 RTT、在线状态、attached 和 writer；
- 点击 Hub 后导航到该 Hub origin，页面重新创建相对 URL 的 `ApiClient` 和 `/mesh/ws`。
- 不直接复制当前 session cookie。cookie 是 host-only：
  - cookie 名称：`tmex_s_<nodeId>`，`apps/gateway/src/auth/cookies.ts:20`
  - 没有 `Domain`，生成逻辑在 `:24`
  - 当前 session 校验依赖本地请求上下文，`apps/gateway/src/mesh/session-middleware.ts:74`
- 因此切换 origin 后通常需要重新登录。若以后需要无感切换，应增加短时、一次性、同用户 handoff token；不能把 SID 放到 URL。

### Files to touch

- `apps/gateway/src/mesh/uplink-pool.ts`
- `apps/gateway/src/mesh/uplink-client.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/mesh/auth-routes.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`
- `packages/shared/src/uplink/codec.ts`
- `packages/api-client/src/auth/types.ts`
- `packages/api-client/src/client.ts`
- `packages/api-client/src/node-url.ts`
- `apps/fe/src/node/mesh-hubs.ts`
- `apps/fe/src/node/mesh-events.ts`
- `apps/fe/src/pages/settings/nodes/management/hub-strip.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`

### Wire/DB changes

- `HubEndpointInfo`、`UplinkCandidate`、`MeshHubsResponse` 增加可选 `rttMs/rttAt`。
- writer uplink 是连接模型变化，不需要 DB 表。
- attachment route 依赖第 1 节的 `attachedHubId/hub.attachments`。
- 不修改 `mesh_hubs` 表。

### Risks

- `/healthz` RTT 只能证明 URL 可达，不能单独证明 Hub 身份；必须使用已授权 URL、CA pin 和返回 node id 校验。
- 浏览器跨 origin 会影响 cookie、WebSocket、CORS、passkey origin 和 session renewal。
- 最近 Hub 不等于 writer；写请求必须单独路由。
- RTT 探测过于频繁会增加 Hub 暴露面和网络负载。

---

## 3. Automatic writer election

### Current

配置来源：

- `TMEX_HUB_MODE` 默认 active：`apps/gateway/src/config.ts:140`
- priority 默认 active=100、standby=200：`:147`
- `TMEX_HUB_WRITER_EPOCH` 默认 1：`:160`
- `TMEX_HUB_PEERS` 解析为 32-hex Hub id allowlist：`:189`
- 配置最终进入 gateway config：`:271`

writer/fencing：

- `UplinkServer` 构造时从 config 固定读取 epoch：`apps/gateway/src/hub/uplink-server.ts:215`
- mode 从 config/effective start mode 初始化：`:216`、`:226`
- `isWriter()` 只允许当前 mode 为 active，并调用 `pickWriterHub()`：`:269`
- `setMode()` 修改内存 mode，同时 upsert `mesh_hubs` 并广播 node list：`:303`
- 更高 epoch 的 active Hub 会让本机降为 standby：`:1376`
- 相同 epoch 只每 60 秒告警 split-brain：`:1389`
- `mesh_hubs` 表保存 `mode/priority/writer_epoch/online`：`apps/gateway/src/db/schema.ts:718`

Hub peer status poll：

- 启动延迟 2 秒；
- 之后每 60 秒 ±20%；
- timeout 5 秒；
- 连续 3 次失败后标记 offline；
  见 `apps/gateway/src/hub/hub-peer-poller.ts:13`、`:96`、`:146`、`:258`。
- 只轮询 `mesh_hubs` 中且通过 `TMEX_HUB_PEERS` 的 Hub：`:160`
- 请求 `/api/hub/status`：`:243`
- 返回 id 必须与 allowlist/mesh_hubs 行一致：`:214`
- endpoint 本身公开，但代码要求 TLS CA pin、expected id 和 allowlist 才信任，见文件注释 `:1`。

当前没有自动 promote、quorum、投票或 writer view。

持久化边界：

- `setMode()` 只写当前进程的 `mesh_hubs` 行，不修改 env，见 `apps/gateway/src/hub/uplink-server.ts:303`。
- CLI promote 会写 `TMEX_HUB_MODE=active` 和新 epoch：`packages/app/src/commands/hub.ts:1161`、`:1181`
- CLI demote 会写 `TMEX_HUB_MODE=standby`：`:1192`、`:1199`
- 重启时 epoch 仍从 env 读取，`UplinkServer` 不直接恢复自己的 `mesh_hubs.mode`；只检查其他 Hub 是否有更高 epoch，`:1350`。
- 因此“运行时 fencing 状态写入 mesh_hubs”是事实，但“任意 `setMode()` 后重启必然恢复 standby”并不完全成立；通常只有更高 epoch 记录仍在时才会再次被 fence。

### Proposed

采用保守的自动 promote：

1. 默认关闭，由 `TMEX_HUB_AUTO_PROMOTE=1` 显式开启。
2. Standby 必须连续 N 次无法取得当前 writer 的合法 status。建议沿用三次失败，但 2 Hub 时使用更长的总超时。
3. 候选必须是所有 authorized standby 中 priority 最低者；priority 相同用 node id 稳定排序。
4. 需要 quorum：

   - N≥3 时，要求超过半数 authorized Hub 的新鲜 writer view 认为旧 writer down；
   - status response 增加可选 `writerView: { hubNodeId, writerEpoch, reachable, observedAt }`；
   - 只统计 freshness 窗口内的 view；
   - 不把未经 allowlist、CA 或 node id 校验的 view 计入 quorum。

5. promote 必须一次性完成：

   - 新 epoch = `max(env epoch, 本地 mesh_hubs epoch, 已观察 epoch) + 1`；
   - 先持久化本机 `mesh_hubs` 的 epoch 和 active mode；
   - 再更新内存 mode 并广播 `node.list`；
   - 旧 writer 恢复后通过更高 epoch 被现有 fencing 降为 standby。

mode/epoch 建议分工：

- env 是安装/CLI 的 bootstrap 和人工期望配置；
- `mesh_hubs` 是运行时已观察状态、fencing 状态和自动 promote 的持久记录；
- 启动时取本机 row 与 env epoch 的较大值；
- 本机 row 是 standby 且 epoch 不低于 env epoch 时，继续保持 standby；
- CLI promote 使用更高 env epoch 覆盖旧 fencing；
- 不增加新表，避免把 election 状态拆散。

两 Hub 情况：

- 两个 Hub 无法形成真正 quorum；网络分区时无法区分“writer down”和“链路断开”。
- 默认不自动 promote。
- 只有 `TMEX_HUB_AUTO_PROMOTE=1` 时才允许；
- 使用明显更长的超时，例如 10 分钟；
- 必须接受 split-brain 风险，恢复时依赖 epoch fencing 和人工确认。

### Files to touch

- `apps/gateway/src/config.ts`
- `apps/gateway/src/hub/hub-peer-poller.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/auth/mesh-hub-store.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `packages/app/src/commands/hub.ts`
- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`

### Wire/DB changes

- `/api/hub/status` 增加可选 writer view/election 状态字段。
- 新增 `TMEX_HUB_AUTO_PROMOTE` 及超时配置。
- `mesh_hubs.writer_epoch` 已存在，可复用。
- 最小方案不增加 DB 列；启动逻辑需要正确读取本机 row。
- 不使用普通 node certificate 作为 Hub 信任凭据。

### Risks

- 2 Hub 自动 promote 无法从理论上消除 split-brain。
- 被攻陷的单个 Hub 可以伪造自己的 status/view，但在多数 Hub 场景下不应单独触发 promote。
- quorum 计算必须使用新鲜 view，不能把旧的 `mesh_hubs.online` 当投票。
- `pickWriterHub()` 当前不考虑 `online`，自动 election 不能只修改 online 标志，必须提升 epoch。

---

## 4. Fail-back notification

### Current

节点侧：

- 当前 attached Hub 不是候选第一个时，`UplinkPool.syncProbe()` 创建 failback timer：
  - `apps/gateway/src/mesh/uplink-pool.ts:995`
  - interval 60 秒 ±20%：`:1001`
- `probePreferred()` 逐个调用 `/healthz`，成功后 `switchTo()`：
  - `:1014`
  - `:1026`
  - `:1039`
- 当前没有 `hub.available` 消息，也没有 node list 到达后立即触发 failback。

Hub 侧：

- peer status poll 是 2 秒启动、之后 60 秒 ±20%：`apps/gateway/src/hub/hub-peer-poller.ts:96`、`:146`
- 发生变化后调用 `UplinkServer.broadcastAllNodeLists()`：`apps/gateway/src/hub/hub-runtime.ts:186`
- 已有 `node.list.hubs[]` 和 `online` 字段，不需要新消息类型。
- Hub uplink 重新认证时，现有代码已经立即发送 `auth.ok` 和 node list：
  - `apps/gateway/src/hub/uplink-server.ts:726`
  - 若缓存未变化，仍发送缓存 node list：`:727`
- standby B 的 uplink 收到 node list 后进入：
  - `apps/gateway/src/mesh/mesh-runtime.ts:865`
  - 更新 `mesh_hubs`：`:871`
  - Hub B 复制并广播给自己的节点：`apps/gateway/src/hub/hub-runtime.ts:220`、`:242`

一个现有准确性问题：

- `UplinkServer.toHubEndpoint()` 的 `online` 当前主要根据本地 registry 判断，见 `apps/gateway/src/hub/uplink-server.ts:1403`、`:1422`；
- 它没有直接采用 `mesh_hubs.online`。因此仅由 peer poll 得到的远端在线状态可能不能正确出现在下一个 `node.list.hubs[]` 中。

### Proposed

选择“不增加新消息，复用现有认证 uplink + node.list”的方案：

1. writer 恢复后，standby B 的既有 writer uplink 重连。
2. A 在 B 认证成功后立即发送现有 `auth.ok/node.list`。
3. B 收到 node list 后立即向本地节点广播更新后的 `node.list.hubs[]`。
4. `UplinkPool.dispatchNodeList()` 检测到：
   - writer Hub 从 offline 变 online；
   - writer epoch 变化；
   - 当前 attached Hub 不是最佳候选；
   时，立即调用一次 `probePreferred()`，仍需通过 `/healthz` 后才切换。
5. 保留原 60 秒 ±20% timer，作为没有有效 writer uplink 时的 fallback。
6. 修正 `toHubEndpoint()`：本 Hub 自身和本地 registry 使用实时状态；其他授权 Hub 使用 `mesh_hubs.online`，避免 peer poll 结果被丢弃。
7. 不把“有人 GET `/api/hub/status`”当作通知。该 endpoint 当前公开，入站 GET 不是已认证 Hub push，不能产生可信副作用。

### Files to touch

- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/mesh/uplink-pool.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`

### Wire/DB changes

- 不增加 `hub.available`。
- 继续使用已有：
  - `auth.ok`
  - `node.list`
  - `node.list.hubs[]`
  - `HubEndpointInfo.online`
- 不修改 DB schema。

### Risks

- writer 恢复但 standby uplink 本身未恢复时，仍只能等待 peer poll。
- node list 可能频繁广播，需要 debounce。
- 收到 node list 只触发探测，不应直接切换；切换仍需 CA pin、healthz 和 generation guard。
- 正在进行的 stream 不迁移，HTTP GET/HEAD 才能依赖既有 forwarder retry。

---

## 5. TLS CA rotation event

### Current

TLS 配置数据库：

- `tls_config` 保存 CA、证书、模式和 ACME 状态：`apps/gateway/src/db/schema.ts:666`
- Hub trust pin 保存于 `hub_trust`：`:711`

实际 TLS 服务不在 `apps/gateway/src/tls/**`，而在 `packages/app/src/tls/tls-service.ts`。

已有 in-process callback：

- `TlsServiceOptions.onStatusChange`：`packages/app/src/tls/tls-service.ts:91`
- 每次 mutation 完成后回调：`:276`
- `withMutation()` 在 `:282`，结束时调用 `endMutation()`。

证书变化路径：

- self-signed CA 过期前 30 天旋转：`:603`、`:611`、`:615`
- self-signed leaf/CA 写入：`:590`、`:616`
- ACME 新证书写入并重新应用 listener：`:523`、`:541`
- HTTPS listener 使用新 cert/key 重建 Bun server：`packages/app/src/tls/https-listener.ts:39`
- external 模式只写 trust-proxy 配置、停止本地 TLS 并要求重启：`packages/app/src/tls/tls-service.ts:335`、`:347`
- 当前没有发现应用内的 external reverse-proxy 证书热加载入口。

mesh 广告：

- `HubAdvertisement.caFingerprint` 已存在：`packages/shared/src/uplink/codec.ts:285`
- node.status 携带 hub 广告：`:340`
- `UplinkClient.sendStatus()` 发送：`apps/gateway/src/mesh/uplink-client.ts:322`
- mesh 启动时刷新，之后每 10 分钟 fallback：
  - `apps/gateway/src/mesh/mesh-runtime.ts:117`
  - `:1351`
  - `:1431`
- runtime 已经把 TLS callback 接到 mesh 刷新：
  - `packages/app/src/runtime/assemble.ts:718`
  - `:723`
  - `:728`

现有缺口：

- `refreshTlsAndAdvertise()` 更新 mesh state 后只调用 `uplink.sendStatusIfChanged()`，见 `apps/gateway/src/mesh/mesh-runtime.ts:1351`。
- `UplinkServer.ownHubSnapshot()` 使用构造时保存的 `selfCaFingerprint`，见 `apps/gateway/src/hub/uplink-server.ts:277`、`:297`。
- 因此本 Hub 的 `/api/hub/status` 可能保留旧 CA fingerprint，即使 `mesh_hubs`/node.status 已更新。

### Proposed

不新增 EventEmitter；复用已有 callback，并修正事件语义：

1. TLS listener 成功应用新材料后触发一次 mesh refresh。
2. mesh refresh 使用 in-flight promise/coalescing，避免一次 TLS mutation 触发多次 node.status。
3. 刷新顺序：

   ```text
   TLS material persisted
   → HTTPS listener applied successfully
   → update HubRuntime/UplinkServer self CA fingerprint
   → upsert self mesh_hubs row
   → send node.status if changed
   → broadcast node.list if needed
   ```

4. 修改 `UplinkServer`/`HubRuntime` 提供更新自身 CA fingerprint 的方法，确保：
   - `/api/hub/status`
   - `mesh_hubs`
   - `node.status.hub.caFingerprint`
   三者一致。
5. 保留 10 分钟轮询作为进程恢复、外部变更和漏事件的 fallback。
6. external 模式仍只能由外部代理负责证书 reload；应用只能刷新自身可见的 TLS 状态。

### Files to touch

- `packages/app/src/tls/tls-service.ts`
- `packages/app/src/runtime/assemble.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `packages/app/src/tls/https-listener.ts`
- 相关 TLS、mesh integration test 文件

### Wire/DB changes

- 不增加 wire 类型；继续使用已有 `node.status.hub.caFingerprint` 和 `/api/hub/status.caFingerprint`。
- 不增加 DB 表或列。
- 继续使用现有 `tls_config.ca_cert_pem`、`mesh_hubs.ca_fingerprint`、`hub_trust`。

### Risks

- 新 CA 应在 listener 成功后再广告，否则节点可能收到尚未可连接的 fingerprint。
- self-signed CA 旋转会使旧节点 pin 失效；现有代码已明确提示 joined nodes 需要重新加入。
- ACME leaf renewal 通常不改变 CA fingerprint，但仍可能触发状态广播。
- external reverse proxy 的证书变化不在本进程可观察范围内，只能依赖轮询或重启。

---

## 现有 multi-hub 测试 harness

测试入口：

- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts:39`
- 当前共有 15 个 `test()`：
  - 14 个多 Hub场景；
  - 1 个 isolated A smoke test，`:646`
- 已覆盖：
  - Hub 集合传播；
  - standby replication；
  - standby 写 fencing；
  - A down 后 C/D failover 到 B；
  - 同 Hub relay；
  - 手工 failback；
  - epoch fencing；
  - stale frame；
  - legacy node.list；
  - unauthorized Hub；
  - key log fencing。

Harness：

- `FastScheduler`：`apps/gateway/src/mesh/integration/multi-hub-harness.ts:59`
- `HubRouter`：`:81`
- fake socket pair + `WebSocketLink`：`:118`、`:125`
- 本地 uplink 的 in-memory pair：`apps/gateway/src/mesh/mesh-runtime.ts:991`
- replication wiring：`multi-hub-harness.ts:344`
- A/B/C/D topology：`:630`
- `GET /api/mesh/hubs` helper：`:782`

当前 `transport=memory` 只模拟 node→Hub uplink，不模拟 Hub↔Hub relay、真实 RTT、真实 TLS 或跨 origin session。

建议扩展：

- Relay：
  - C 附着 A、D 附着 B；
  - 验证 C→D HTTP/WS relay；
  - 验证双向 RTC signal；
  - 验证重复 hop、未知 Hub、stale route 被拒绝；
  - A down 后验证 route 重建。
- RTT：
  - `HubRouter` 增加每个 Hub 的可控 health delay；
  - 验证最近 standby 被选为 attach；
  - 验证 writer uplink 仍指向 writer；
  - 验证 RTT 抖动不会频繁切换。
- Election：
  - 模拟多 Hub status response、failure count、writer view；
  - 验证 priority winner、quorum、不足 quorum、两 Hub opt-in；
  - 验证 epoch 持久化和旧 writer 回归后的 fencing。
- Failback：
  - 不直接调用 `switchTo()`；
  - 让 A 恢复并触发 B 的认证/reconnect；
  - 验证 node.list 到达后立即触发 probe/switch。
- TLS：
  - mock TLS callback；
  - 验证 CA fingerprint 立即进入 node.status、node.list 和 `/api/hub/status`；
  - 验证 10 分钟 poll 仍作为 fallback。

## Baseline

已执行：

```bash
cd apps/gateway && bun test
```

结果：

```text
3016 pass
311 fail
1 error
14264 expect() calls
Ran 3327 tests across 321 files
exit code 1
```

本次运行处于只读 sandbox，失败中包含 `mkdtemp`、监听端口、tmux 和临时目录 `EPERM`，因此这不是一个干净的代码回归基线。