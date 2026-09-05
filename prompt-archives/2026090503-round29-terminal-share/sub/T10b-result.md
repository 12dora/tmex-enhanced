# T10b 结果：KI-7 下半 —— `PeerManager` 上帝类拆分

## 一、拆法

`apps/gateway/src/mesh/peer-manager.ts` **1937 行 → 589 行**。共享可变状态收进
`PeerManagerState`，由 `PeerManager` 构造一次分发给各协作者；协作者之间**不互持引用**，
跨组调用一律走构造时注入的窄回调（`PeerXxxDeps`），与 T10a 的 `UplinkServer` 拆法一致。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `peer-manager.ts` | 589 | 装配、公开 API、peer-ctl 分派（`handlePeerCtl`）、RTC 信令管道（`receiveRtcSignal` / `rtcListeners`）、`start`/`stop`/`onRevoked`/`getLink`/`listReach` |
| `peer-manager-state.ts` | 120（新增） | `PeerManagerState` + 全部模块常量 + `peerStale` / `throwIfPeerStopped` / `isPeerTrusted` / `comparePeerTransport` |
| `peer-dialer.ts` | 557（新增） | 出站拨号与入站接纳：`dial` / `dialDirect` / `dialDc` / `dialWsSecure` / `acceptDirect` / `acceptRelay` / `forceProbe` / `forceDcProbe` / `syncLocalFingerprint` / `syncPeerEndpointSet` / `hasWsSecureCandidate` / `dcCapable` / `shouldTryDc` / `finishDirectAttempt` / `clearDirectFailure` / `releaseRtcAttempt` / `rememberKeys` |
| `peer-live-registry.ts` | 522（新增） | 当前链路登记：`track` / `installLive` / `bindSession` / `onLocalStream` / `handleInboundStream` / `armIdle` / `clearIdle` / `startPing` / `onPeerPong` / `maybeEmitRtt` / `emitLinkInfo` / `emitOfflineLinkInfo` / `dropPeer` / `promoteRetiring` |
| `peer-link-drain.ts` | 267（新增） | 非当前链路：`parkInbound` / `armParkedDrain` / `dropParked` / `activateParked` / `retirePeer` / `nextRetireDelayMs` / `armRetireTimer` / `maybeFinishRetire` / `finishRetire` / `forceCloseRetiring`，以及为其服务的 quiesce 协商 `restartQuiesce` / `sendLinkHello` / `probeQuiesce` / `markQuiesceCapable` |
| `peer-link-waiters.ts` | 129（新增） | 等待者登记：`waitForTransport` / `notifyTransport` / `failTransportWaiters` / `waitForLive` / `notifyLive` / `awaitEstablishedOrDial` |
| `peer-status-sync.ts` | 185（新增） | `node.status` 广播与 key log 同步：`applyPeerStatus` / `serveKeyLog` / `applyKeyLogRes` / `sendPeerStatus` / `refreshAdvertisedStatus` / `notifyKeyLogHeadChanged` |

生产代码 1937 → 2369 行（+432），增量全在 6 份 `Deps`/`Options` 类型声明与装配接线上。
`peer-dc-upgrade.ts` / `peer-dial-race.ts` / `peer-direct-attempt.ts` / `peer-ws-race.ts` **零改动**
（T8b、RF2 的改动原样保留，`PeerCollaboratorHost` 继续被 `PeerManager` 继承）。

### 状态归属

`PeerManagerState`（`peer-manager-state.ts`）持有被多方读写的：`stopped` / `generation` /
`stopAbort`、`identity` / `userStore` / `uplink` / `scheduler`、`live` / `parked` / `retiring` /
`pending` / `upgrading` / `liveWaiters` / `transportWaiters` / `sessionKeys` / `rtcInbox` /
`lostDirect` / `lastDirectAttempt` / `advertisedEndpointSet` / `endpointBackoff` /
`peerReconnectWake`。只有单个协作者用的仍是它自己的私有字段：`localFingerprint` / `dialLimiter`
（dialer）、`linkInfoHold`（registry）、`parkedSessions`（drain）、`keyLogHeadCache` /
`keyLogStatusDebounce`（status-sync）、`rtcListeners`（PeerManager）。

`PeerManager` 保留 `private readonly rtcInbox = this.state.rtcInbox` 别名指向同一个 Map——
`peer-manager.test.ts:1462` 直接读私有字段，这样测试零改动。

## 二、零改动验证

**未改任何测试**：`git status` 只有 `peer-manager.ts`（M）、`allowlist.json`（M）与 6 个新文件（??）。
`peer-manager.test.ts` / `.upgrade.test.ts` / `.backoff.test.ts` / `rtc-dial-breaker.test.ts` /
`mesh-runtime.ts` 的 diff 为空——`peer-manager.ts` 继续再导出全部常量与类型
（`PEER_*`、`KEY_LOG_STATUS_DEBOUNCE_MS`、`RTC_PEER_INBOX_MAX_MESSAGES`、`PEER_TRANSPORT_RANK`、
`comparePeerTransport`、`winningDialInitiator`），公开导出面逐字不变。

**字符串字面量差分**：把 HEAD 版 `peer-manager.ts` 与拆分后 7 个文件的全部单引号字面量做多重集比对，
差异只有 6 条新增 import 路径与 3 条 `PeerLiveRegistryOptions['onGatewaySession'|...]` 索引类型串；
**日志文案、错误消息、ctl `t` 值、close reason 一条没变、一条没少**（T10a 的教训：文案即行为）。

## 三、踩到的一个真坑

`src/mesh/integration/large-push-harness.ts:185` 通过 `mesh.peers as unknown as PeerDispatchOwner`
**在构造之后改写 `PeerManager` 的私有字段 `dispatchHttp`**。我最初把 `dispatchHttp` 整个搬进
registry，两条 24 MiB 大包用例立刻变 404（handler 装不上）。改法：`dispatchHttp` 仍是 `PeerManager`
的**可写字段**，registry 拿到的是 `() => this.dispatchHttp` 的取值函数，在 `handleInboundStream`
里按调用时读取——语义与原来的「先判空再传」完全一致，测试零改动恢复通过。

全仓再查了一遍同类反射式改写：`mesh.peers` 只有这一处 `as unknown as`，其余对私有面的访问只有
`peer-manager.test.ts` 的 `rtcInbox` 读取（已用别名保住）。

## 四、allowlist

删除：

- `apps/gateway/src/mesh/peer-manager.ts`（fileLines 1939 → 589，回到 600 门禁内）

随方法迁移改键（阈值不变）：

- `peer-manager.ts:applyPeerStatus` → `peer-status-sync.ts:applyPeerStatus`（cc 19）

保留：`apps/gateway/src/mesh/peer-manager.ts:handlePeerCtl`（cc 23，ctl 类型数就是分支数，
分派本身已无逻辑可抽，代码未动）。

**未新增任何条目**：7 个文件全部 ≤ 600 行，新增函数 CC 均在门禁内。

## 五、验证

| 命令 | 结果 |
| --- | --- |
| `apps/gateway` `bun test src/mesh` | **1375 pass / 0 fail**（与改动前基线逐条相同，99 文件） |
| `apps/gateway` `bunx tsc --noEmit -p .` | 0 error |
| `packages/app` `bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check`（7 个文件 + allowlist.json） | clean |
| 仓库根 `bun scripts/complexity/gate.ts` | **complexity gate ok**（1670 文件 / 14659 函数，0 违规 0 stale） |
| `apps/gateway` `bun test`（全量 434 文件） | 4757 pass / 10 fail |

全量 10 条失败是**既有抖动，非本次回归**：同一命令在 HEAD 版 `peer-manager.ts` 下复跑同样是
4757 pass / 10 fail，且失败的具体用例名两次不同（都落在 `mesh.integration.test.ts` 与
`dc-http-bulk.integration.test.ts` 的级联上）；这两个文件单独跑 26 pass / 0 fail，
`bun test src/mesh` 也 0 fail。与 KI-1 记的「gateway 全量单测在高负载下偶发失败，隔离复跑通过」一致。

## 六、与任务书的偏差

1. **拆成 6 个协作者文件而非 2 个**。600 行的文件门禁下，1937 行按二分法必然顶穿（实测 dialer 组
   ~413 行 + registry 组 ~500 行搬完，`PeerManager` 仍剩 ~800 行）。于是沿天然缝再切三刀：
   - `peer-manager-state.ts`：共享状态 + 常量 + `stale`/`throwIfStopped`/`isTrusted` 三个自由函数。
     常量必须挪出来，否则协作者 import `peer-manager.ts` 会形成循环依赖；`peer-manager.ts` 原样再导出，
     外部导入点不受影响。
   - `peer-link-drain.ts` 从 registry 拆出：retiring/parked 是「非当前链路」的同一类生命周期，
     quiesce 协商（`link.hello` caps / `link.quiesce.probe` / `markQuiesceCapable`）唯一存在理由就是
     判断链路能否排空后退役，跟着一起走。
   - `peer-link-waiters.ts`：`waitForTransport`/`waitForLive` 与其通知面本就是一组；
     `awaitEstablishedOrDial` 的主体就是「拨号 promise 与 live 等待者竞速」，一并移入。
   - `peer-status-sync.ts`：`node.status` 与 key log 同步（任务书说 ctl 处理留在 `PeerManager`，
     因此 `handlePeerCtl` 的**分派**留下，三个 async 分支的**执行体**移入，allowlist 的
     `handlePeerCtl` 键因此不用改）。
2. 任务书把 `lostDirect` / `endpointBackoff` / `advertisedEndpointSet` / `lastDirectAttempt` 列为
   dialer 字段，实际这几项 `PeerManager`（`stop`/`onRevoked`/`start`/`linkDetailOf`）与 registry
   （`installLive`/`dropPeer`）都要读写，按「共享可变状态放 state」的原则放进了 `PeerManagerState`。
   同理 `sessionKeys`/`parked`/`retiring` 放 state，`waitForTransport` 等待者面独立成文件。

## 七、后续

- KI-7 已从 `docs/known-issues.md` 移除（本文件登记的是未解决项）。
- `peer-manager.ts` 剩下的 CC 热点只有 `handlePeerCtl`（23），是 ctl 类型枚举本身；
  若以后 ctl 类型继续增加，可考虑像 T10a 的 `decodeCoreCtl` 那样按类型分区拆两支。
