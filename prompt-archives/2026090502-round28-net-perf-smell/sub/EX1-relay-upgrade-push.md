# EX1 经中继远程升级推包失败（Opus 探索报告摘要）

## 结论

`[mesh][forward] raw-body push aborted … err=stream-aborted` 只可能来自 `byteTransportFromStream.onAbort`（`packages/shared/src/link/secure-channel-link.ts:153-157`）：承载 peer 加密链路的**中继隧道流被 RST**，内层 mux 整条 link 关闭；紧邻的 `rst recv reason=relay-rst` 即中继复位。PUT 在 forwarder 里不可重试（`forwarder.ts:66` `IDEMPOTENT_HTTP` 只含 GET/HEAD → attempts=1），服务端 `.part` 被删，无续传。两台节点同秒失败 ⇒ 共因在中继或 hub 中继上行。

## 推包路径

`system/upgrade-service.ts:348` → `system/remote-upgrade-job.ts:237-250`（download 10 min / push 15 min / start 60 s）→ `:286-331` `PUT /api/system/upgrade/package` via `forwardAuthorizedHttp` → `mesh/forwarder.ts:224-289` → `stream-targets.ts:293-430 openHttpStream` → peer link（relay 时 `peer-protocol.ts:439-447` LinkMux(SecureChannelLink(隧道流))）→ 外层 `relay-uplink-client.ts:390-425`（WebSocketLink 无 logContext）→ 中继 `relay/relay-stream-router.ts:23-149`（`pumpRelayPair` / `pumpMetered` 令牌桶）→ 节点 `stream-targets.ts:171-268` → `api/system.ts:227-258` → `system/upgrade.ts:269-378 stagePackage`（`.part-<random>`，失败即 rm）。

## `relay-rst` 产生条件

`relay-stream-router.ts:85-99` 与 `hub/uplink-server.ts:2213-2231` 的 `abortBoth()`：任一侧流 abort（顶号 `relay-uplink-auth.ts:167-177 'relay-replaced'`；中继心跳判死 `relay-uplink-server.ts:509-521` 15 s×3；kick/租户消失/停机；ctl 帧超 64 KB；mux 协议错 `mux.ts:514-517,709-718,581-584`：帧 >1 MiB、链路未确认 >32 MiB、流数 >256；ws 丢帧 `websocket-link.ts:176-181`）或 `pumpMetered` 抛错（任一方向出错双向 RST）。

## 令牌桶 / 尺寸 / replaced / 切换

- 令牌桶 `relay-quota.ts:103-124` 只 sleep 不丢帧，默认 `bandwidthBytesPerSec:null`；但整租户一条串行 Promise 链，且限速时外层 1 MiB 窗口打满 → 内层 ctl ping 被 DATA HOL 阻塞（`secure-channel-link.ts:150-162` 串行发送队列）→ 45 s `dropPeer('missed-pong')`（`peer-manager.ts:1526-1539`）。
- 无 per-stream 字节上限、无流级 idle 计时；ws 无 maxPayload；`STAGED_PACKAGE_MAX_BYTES=256 MiB`。
- `reason=replaced` = hub `retirePeer(prev,'replaced')` → `finishRetire` → 外层隧道流 `reset('replaced')`（`peer-manager.ts:1171,1873-1896`）。
- 在途流保护：退休路径有（`maybeFinishRetire` `:1821-1834`）；`dropPeer` **无**（`:1606-1615`）；`UplinkPool.retireClient`（`uplink-pool.ts:900-916`）、`considerNearestSwitch`（`:1175-1198`）、`reconfigureUplinkPool`（`relay-wiring.ts:78-90`）、`onHubRelayStream` stale reset（`:871`）**全部无视在途流**。

## 接收端与 UI

- 节点无请求级超时；写盘/算 hash 忙时 pong 迟到 → 中继 45 s 判死。
- `forwarder-unreachable.ts:6-44` 把 `stream-aborted/relay-rst/link-closed` 都归 `no_link`。
- FE `use-node-upgrade.ts:72` `BUDGET_MS=6 min` < 后端 push 15 min；`:315-320` 原样展示英文错误串。
- 成功路径噪声：`remote-upgrade-job.ts:329 body?.cancel()` 触发 `reset('aborted')` + `forward aborted status=200 sent=0`。
- 隐患：`MAX_LINK_UNACKED 32 MiB` vs `maxStreams 64 × 1 MiB` 窗口不自洽，33 条打满流即整链 protocolError。

## 修复建议

- P0-1 可续传 + 可重试：PUT 增 `offset`/幂等键 `(version,sha256)`、`GET/HEAD` 查已收偏移、`.part` 确定性命名不删、`fileReadableStream(start)`、job push 阶段查偏移续传+退避重试；能力位 `staged-package-resume`；forwarder 改为调用方显式 `retry` 而非把 PUT 塞进白名单。
- P0-2 在途流保护：`dropPeer` 的 missed-pong/idle 走退休宽限；ping 计数「有入站帧即活」（mux `lastFrameAt`）；`uplink-pool` 有在途流时推迟就近切换、旧 client 排空再 stop；`reconfigureUplinkPool` 同。
- P0-3 中继侧：心跳期间有字节流动不累加 misses；令牌桶按流公平 + 小帧免排队 + 最小保底速率；`pumpMetered` 出错区分方向、RST 原因细化。
- P1-4 错误分类 `link_lost`；job 快照带 `phase/pushedBytes/totalBytes`；FE 预算按字节增长；中文文案。
- P1-5 `body?.cancel()` 改 `text()`；relay 上行 WebSocketLink 加 logContext；unacked 与 window 自洽。
- P2-6 测试：独立中继大包用例、推包中途顶号续传、在途流期间切换排空、streams>0 时 missed-pong 不立即关链。现有：`large-push.integration.test.ts`（hub 当中继 24 MiB）、`forwarder.test.ts:1807`、`remote-upgrade-job.test.ts`、`relay-membership.integration.test.ts:219`。
