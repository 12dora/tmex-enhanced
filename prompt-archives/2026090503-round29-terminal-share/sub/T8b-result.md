# T8b — PWA 重开时节点迟迟不出现（后端侧 H2 / H3 + Hub 分享登录配额）

对应 `sub/EX2-pwa-slow-nodes-report.md` 的 H2、H3，以及 T3 报告 §7 的遗留项。前端 H1/H4–H7 已由他人提交。

## 一、交付项与实现

### 1. H2-a：用户路径拨号不再被 DC 的 15 s 独占（新文件 `apps/gateway/src/mesh/peer-dial-race.ts`）

- `PeerManager.dial()` 增加 `opts.foreground`；只有 `getLink()` 传 `true`，后台升级扫描（`DcUpgradeCoordinator.dialDc → this.dial(nodeId)`）仍走原来的顺序拨号，DC 照拿满 `CONNECT_TIMEOUT_MS = 15 s`。
- 前台走 `runDirectDialRace()`：
  - `FOREGROUND_DC_BUDGET_MS = 2500`：DC 先独跑 2.5 s，到点就并行开 ws-secure；DC 提前失败（熔断冷却 / 立即报错）也立刻开 ws-secure，不空等预算。
  - `wsFirst`：`lostDirect` 命中、或 `dcRecentlyFailed()`（熔断器已记失败 **或** `lastDirectAttempt.dc` 在 10 min 内失败过）时两条腿同时起跑，一秒都不等。
  - `FOREGROUND_DIRECT_DEADLINE_MS = 4000`：整段直连的墙钟上限，到点停止等待、去中继。
  - 赢家采纳，输家 `abort`（`DOMException('dial-race-lost','AbortError')`）；晚到的会话交给 `discard`（不是赢家也不是当前活链路才 `close`），`dialDc` 的 `releaseRtcAttempt` 照旧执行。
  - 命中总截止时间时**不砍腿**：`outcome.pending` 把还在跑的直连腿交回 `dial()`；中继成功就让它稍后自己 `track()` 成升级，中继也不通才回头 `await` 它（否则「只有 DC 可达、没有中继」的对端会永远连不上）。
- `dialDc()` 被取消时：`settleAbandonedDcDial()` 挂在底层 `rtc.connectToPeer()` 上——晚到的 `pc` 自己 `close()`（不留悬空 RTC 会话），晚到的失败照记进熔断器（否则「取消」会把 DC 一直坏着这件事从账上抹掉，熔断器永远不 trip）。
- **`breaker rearm source=local-fingerprint` 后不再有 15 s 前台惩罚**：前台永远只用短预算，rearm 与否都一样；且 `lastDirectAttempt.dc` 不受 rearm 影响，10 min 内仍会让 ws-secure 立刻起跑。长尝试只留给后台升级。

### 2. H2-b：forwarder 取链路加墙钟上限（`forwarder.ts`）

- `FORWARD_LINK_DEADLINE_MS = 5000`（`setForwardLinkDeadlineMs()` 供测试缩短）。
- `forwardHttp` 的 GET 4 次重试循环每轮开头判 `Date.now() >= deadlineAt` 即 break；`linkBefore()` 用剩余时间给 `peers.getLink()` 封顶，超时抛 `ForwardDeadlineError`（message 为 `timeout`，`classifyUnreachableReason` 据此把 503 的 `reason` 判成 `timeout` 而不是 `no_link`），并且**不再重试**，直接返回既有的 `NODE_UNREACHABLE` 503。
- `handleRemoteWs()` 的 `getLink` 同样走 `linkBefore()`。被放弃的 `getLink` promise 不取消（`PeerManager.pending` 会复用它），只 `void .catch()` 防未处理拒绝。
- 兼容注入零延时 `sleep` 的测试：墙钟没真的走过 deadline 时不认这次超时，回落到 `await pending`。

### 3. H3：uplink 抖动时 hub presence 不再瞬间清空（`mesh-runtime.ts`）

- `HUB_PRESENCE_STALE_MS = 90_000`（`setHubPresenceStaleMs()` 供测试缩短）。
- uplink 掉线：`hubPresenceLive` 照旧立刻置 false（保证「重连后本代 node.list 未到达前不认旧 presence」的原语义不变），但 **不再立刻补发离线事件**；改成记 `hubPresenceStaleUntil = now + 90 s` 并挂一次性定时器。
- `listHubOnline()` 判定改为 `hubPresenceUsable()`：本代 node.list 已到达 → 用；否则 uplink 不在线且仍在陈旧窗口内 → 继续用最后一次 presence；出窗口 → 空集。
- 定时器到点：若本代 node.list 已回来（`hubPresenceLive === true`）就什么都不做；否则退化成「只认 peer 可达性」并补发 `emitSyntheticOffline`（与原逻辑同一套 `hubGeneration` 去重）。`mesh.stop()` 里 `clearHubPresenceDecay()`。
- 日志：`[mesh] hub presence stale hold_ms=…` / `[mesh] hub presence decayed to peer reachability`，各一条。

### 4. H3-b：网络指纹变化重置 uplink 重连退避

- `UplinkClient.resetBackoff()`：把 `runLoop` 的重试计数打回 0，并 abort 当前退避 `sleep`（新增 `backoffSleep()` 抽出重复的两段退避代码）。
- `UplinkPool.resetBackoff()`（越界最小改动，见第四节）：重置 `wrapAttempt` 并 `wakeWrapSleep()`——生产用的是 pool 的轮次退避，client 的 `runLoop` 在 pool 模式下不跑。
- `PeerManager.syncLocalFingerprint()` 在 `endpointBackoff.resetAll()` 旁边加 `this.uplink.resetBackoff()`。

### 5. Hub 侧分享登录配额（新文件 `apps/gateway/src/mesh/share-login-quota.ts`）

- 直接复用 T1 的 `apps/gateway/src/share/share-rate-limit.ts`（`ShareLoginLimiter`，10 次 / 15 min 滑动窗口），没有复制实现。
- `shareLoginShareId(method, path)` 只认 `POST /api/share-access/:id/login`。
- `Forwarder.gateForwardedAuth()` 命中该路径时先查配额：锁定则**转发前**返回 429 `{ error, code: 'SHARE_LOGIN_LOCKED', retryAfterMs }` + `retry-after` 头（与节点侧同形），并打一条 `[mesh] share login locked share=… retry_after_ms=…`。
- `recordForwardedLoginFailure()`：上游 401 记一次失败，2xx 清桶。分桶键是（真实来源 IP，shareId）——正是 T3 §7 指出的、节点侧只看得到 `peer:<hubNodeId>` 的那个洞。

### 6. 顺带修掉的两个真 bug（否则新竞速会踩到）

- `PeerManager.getLink()`：拿到活链路后立刻从 `this.pending` 摘掉本次 attempt。竞速的败者还在收尾时 `dial()` 尚未 settle，`pending` 会一直挡住 `forceDcProbe` / 后台升级（原来靠「顺序拨号恰好早一两个 microtask settle」侥幸不撞）。
- `DcUpgradeCoordinator.maybeUpgrade()`：因 `pending`/`upgrading` 合并时，除了置 `coalesced` 还要 `scheduleCoalescedUpgrade()`。原来合并后只能等下一个偶然的触发点（quiesce ack / 15 s 扫描），`peer-reconnect` rearm 的即时重试因此可能丢。

## 二、文件清单

新增：
- `apps/gateway/src/mesh/peer-dial-race.ts`（竞速编排 + `raceWsSecureDial` + `settleAbandonedDcDial` / `dcDialAborted`）
- `apps/gateway/src/mesh/peer-dial-race.test.ts`
- `apps/gateway/src/mesh/share-login-quota.ts`
- `apps/gateway/src/mesh/share-login-quota.test.ts`

修改：
- `apps/gateway/src/mesh/peer-manager.ts`（`dial`/`dialDirect`、`dialDc` 取消收尾、`getLink` pending、指纹重置 uplink 退避；为守住文件行数门禁把 `eligibleEndpoints`、ws-secure 竞速块、`dcFailureReason` 迁出/内联）
- `apps/gateway/src/mesh/peer-direct-attempt.ts`（新增 `dcRecentlyFailed`、`RECENT_DC_FAILURE_MS`、`eligiblePeerEndpoints`）
- `apps/gateway/src/mesh/peer-dc-upgrade.ts`（合并时排一次重试）
- `apps/gateway/src/mesh/forwarder.ts`（`linkBefore` + 墙钟上限 + 分享登录配额接线）
- `apps/gateway/src/mesh/mesh-runtime.ts`（hub presence 陈旧窗口）
- `apps/gateway/src/mesh/uplink-client.ts`（`resetBackoff` + `backoffSleep`）
- `apps/gateway/src/mesh/rtc/rtc-log.ts`（`dial race won` 归到 debug，避免每次建链一条 info）
- 测试：`peer-manager.test.ts`、`peer-manager.backoff.test.ts`、`forwarder.test.ts`、`mesh-runtime.test.ts`、`uplink-client.test.ts`

## 三、测试

新增用例：
- `peer-dial-race.test.ts`（7 例）：预算到点才开 ws / `wsFirst` 两腿齐发 / DC 提前 settle 立刻开 ws / 截止时间不砍腿并把 `pending` 交回 / 输家晚到走 discard / 零延时 scheduler 下 deadline 不抢跑 / 父 signal abort 连坐两条腿。
- `peer-manager.test.ts`：`foreground dial gives DC only a short budget before racing ws-secure`——假 DC 永不 resolve，`getLink` < 3 s 拿到 ws-secure；随后 DC 晚到，其 `pc.close()` 被调用。
- `peer-manager.backoff.test.ts`：`本机网络指纹变化同时重置 uplink 重连退避`。
- `forwarder.test.ts`：取链路超时 → 503（且 < 2 s）；ws 转发同样受限；分享登录 10 次 401 后第 11 次 429 且不再打上游、别的来源 IP 不受牵连。
- `uplink-client.test.ts`：`resetBackoff` 把退避打回最小值并叫醒等待中的退避。
- `share-login-quota.test.ts`（4 例）：路径匹配、分桶、窗口滑出、成功清桶。

改写的既有用例（H3 语义变更，原断言就是这个 bug 的表述）：
- `mesh-runtime.test.ts` `hub presence is ignored after uplink disconnects…` → `hub presence survives a short uplink drop and decays after the stale window`：断开后立刻查仍为 online，等过陈旧窗口才转 offline。
- `mesh-runtime.test.ts` `hub presence is fresh only after the current generation…`：合成 offline 事件从「断开即发」改成「陈旧窗口到点才发」，跨代去重（仍恰好 1 条）与「重连后本代 node.list 未到达前不认旧 presence」两条断言保持不变。

命令与结果（在 `apps/gateway`）：
- `bun test src/mesh` → **1347 pass / 0 fail**（97 个文件，139 s）
- `bunx tsc --noEmit -p .` → 0 错误（整包）
- `bunx biome check <本任务改动的 17 个文件>` → clean
- 仓库根 `bun scripts/complexity/gate.ts` → `complexity gate ok (1661 files, 14589 functions)`；`peer-manager.ts` 1937 行（allowlist 1939）、`peer-dc-upgrade.ts` 611 行（allowlist 622），都没抬 allowlist。

## 四、越界改动（最小 pointwise）

1. `apps/gateway/src/mesh/uplink-pool.ts`：新增 `resetBackoff()`（6 行）。不加的话指纹重置在生产（pool 模式）上是空转。
2. `apps/gateway/src/mesh/rtc/rtc-log.ts`：`RTC_DEBUG_EVENTS` 加一项 `'dial race won'`（1 行），把每次建链一条 info 降成 debug。
3. `apps/gateway/src/mesh/peer-dc-upgrade.ts`、`peer-direct-attempt.ts` 属于我的作用域（`peer-manager.ts` 的拆分去处），不算越界。

## 五、与契约的偏差 / 需要注意

1. **DC 的败者不是无条件砍掉**：命中 4 s 总截止时间时保留在跑（`outcome.pending`），因为「只有 DC 可达、没有中继」的对端如果被砍就再也接不上（后台升级需要先有一条活链路）。只有在有赢家时才 abort 败者。这是对任务描述「loser is cancelled」的一处有意收窄，理由如上。
2. **零延时时钟的兜底**：`runDirectDialRace` 与 `Forwarder.linkBefore` 都在超时触发后校验 `now()` 是否真的走过截止时间；测试里的 `ImmediateScheduler` / 注入的 `sleep: async () => {}` 会让 `sleep(4000)` 立刻返回，不校验就会把所有既有用例打成「秒超时」。生产用真时钟，不受影响。
3. **`FORWARD_LINK_DEADLINE_MS = 5 s` 与前台直连 4 s 上限的关系**：直连 4 s 用尽后还要开中继，极端情况下 forwarder 会在 5 s 处判死而中继刚要接上。数值可调（两个常量都在同一层），本轮按任务书给的 5 s / 2.5 s 定的，4 s 是我补的中间值。
4. **`dcDialAborted()` 用消息里的 `abort` 做判定**，沿用 `dialDc` 原有的宽松匹配；败者 abort 我特意用 `DOMException('dial-race-lost','AbortError')`，靠 `name` 而不是消息命中。
5. 本轮跑测时 `apps/gateway` 里 `src/hub/**`、`src/share/**`、`src/ws/**`、`packages/shared/src/uplink/**` 有其他 agent 在途改动，期间出现过若干与我无关的 tsc / 测试红（`hub-relay-streams.ts`、`canonical-feed-session.ts`、`share-access-routes.ts`、`uplink-protocol` 1 MiB 用例等），最后一轮已消失，但请指挥官以合并后的全量结果为准。
