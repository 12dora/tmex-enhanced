# RF1 结果：后端分享服务 + ws 隔离的审查修复

范围：`apps/gateway/src/share/**`、`apps/gateway/src/ws/**`（+ 三个 locale 文件各一行）。未触碰 `mesh/**`、`packages/app/**`、前端。

## 一、finding → fix

| # | 级别 | 问题 | 修复 | 位置 |
|---|---|---|---|---|
| 1 | blocker | 抓屏 / 读历史的异步返回后不复核归属，pane 中途移出 window 仍下发整笔事务 | 事务发送前重新过 scope：抓屏在 `captureCanonicalScreen()` 返回后、`ScreenBegin` 之前判定；历史在 `readPaneHistory()` 返回后、`HistoryBegin` 之前判定；不通过一律回既有的 `ERROR_TMUX_TARGET_NOT_FOUND`（客户端已按此语义处理 resolveTarget 的拒绝），不发任何 Begin/Chunk/Commit | `ws/canonical/screen-jobs.ts:109`、`ws/canonical-feed-session.ts:544` |
| 9 | minor | pane 移出 window 后 active/hot 订阅仍在，继续处理输出并占设备级配额 | metadata patch / rebase 到达时按最新 scope 重放订阅集合，服务端主动撤销越界 pane 的租约订阅，并丢弃该 pane 的待发批次、待发 gap 与首屏任务 | `ws/canonical-feed-session.ts` `revokeOutOfScopeSubscriptions`、`ws/canonical/subscription-coordinator.ts` `revokeOutOfScope`、`ws/canonical/pane-stream.ts` `dropPaneDataBatch` |
| 8 | minor | 越界 pane 的 removal 全部放行，未共享 pane 的 ID 与活动时序仍会泄露 | 新增 `ShareMetadataView`：按连接记录真正下发过的实体，只为「曾暴露、现已移出」的实体发 removal，其余越界变化丢弃；patch 本身照发，revision 连续 | `ws/share-metadata-filter.ts`、`ws/share-session-index.ts`（按 session 持有 view） |
| 6 | major | 限流检查在 argon2 之前、计数在之后，并发请求可全部通过 | `ShareLoginLimiter.begin()` 在验证前预占额度（在途尝试计入上限），`settle()` 结算：成功清空计数、失败落账；同 (分享, IP) 并发验证上限 2，超出直接回 `SHARE_LOGIN_LOCKED` | `share/share-rate-limit.ts`、`share/share-service.ts` `loginAccess` |
| 10 | minor | 解锁时间从最早一次失败算，可只锁 1 ms | 第 10 次失败时单独记 `lockedUntil = now + 15 min`，与滑动失败窗口分开维护 | `share/share-rate-limit.ts` |
| 11 | minor | `endShare` 先改 `ended` 再停 recorder，最后一批录屏被 `appendLog` 的 active 检查拒绝 | 标记 ended **之前**同步 `recorder.flush()`，然后改状态、断开连接、释放 recorder | `share/share-service.ts:endShare` |
| 7 | minor | 永久 / 长期分享续期只延长服务端 token，浏览器 cookie 七天后仍然消失 | `verifyAccessToken` 增加 `renewed` / `maxAgeSec`；`GET /api/share-access/:id` 在本次验证发生续期时重新带 `x-tmex-set-share` + `x-tmex-set-share-max-age` | `share/share-service.ts`、`share/types.ts`、`share/share-access-routes.ts` |
| 新增 | — | 开放（免登录）部署下不得创建分享 | `ShareService.setAuthRequiredResolver(fn)`（默认 `() => true`）；`create()` 不满足时回 `SHARE_AUTH_REQUIRED`，路由映射 409 + `t('apiError.shareAuthRequired')` | `share/share-service.ts`、`share/types.ts`、`share/share-routes.ts` |
| optional | — | `share-session-index.ts` 丢掉 `onEnded` 的解绑函数 | 保存解绑函数，新增 `dispose()`（解监听 + 归零 viewer counter），`WebSocketServer.closeAll()` 调用 | `ws/share-session-index.ts`、`ws/index.ts` |

**#7 的 mesh 侧确认**（只读核查，未改 mesh 代码）：两条路径都对**任意响应**生效，不限 login 路由——
- 本机：`packages/app/src/runtime/assemble-routes.ts:169` 的 `gatewayHttp` 对每个网关响应调 `applyLocalRenewal` → `session-middleware.ts:161` `consumeSetSessionForBrowser`，其中 `hasShareCookieHeaders(response)` 为真即走 `applyShareCookieHeaders`，与 `X_TMEX_SET_SESSION` 无关。
- Hub：`mesh/forwarder.ts:723` `adaptResponse` 对每个转发响应调 `applyAuthPolicy`，其第 40 行无条件 `applyShareCookieHeaders(headers, upstream, nodeId, secure)`。

所以节点侧补发响应头即可完成闭环，无需 mesh 改动。

## 二、结构性改动

- 新增 `ws/canonical/screen-jobs.ts`（`CanonicalScreenJobs`）：首屏事务的任务表、统计与取消逻辑整体搬出 `canonical-feed-session.ts`。该文件原 680 行、allowlist 上限 682，本轮要加 scope 复核与撤销逻辑必须先腾空间；拆完 `canonical-feed-session.ts` 594 行（已低于默认 600 门禁），未新增 / 未放宽任何 allowlist 条目。
- `CanonicalSubscriptionCoordinator` 增加代次 bias：服务端强制改写订阅时 `bias += 1`，对租约用 `clientGeneration + bias`，对客户端仍回其自己的 generation。否则同代次不同内容会触发 `PaneSubscriptionGenerationConflictError`。撤销路径**不回放 replay**——保留 pane 的游标是旧的，重放会向客户端重复推送已收到的输出。
- `filterMetadataForShare` / `filterCanonicalEventForShare` 两个纯函数被 `ShareMetadataView` 的方法取代（`filterMetadataRecordsForShare` / `filterSnapshotForShare` 保留），对应单测已改写。

## 三、i18n

唯一的 locale 改动：三个 locale 文件 `apiError.shareAuthRequired` 各一行（en_US / zh_CN / ja_JP）。跑过一次 `bun run --filter @tmex/shared build:i18n` 让 `t()` 通过类型检查（common.md 允许），未手改任何生成文件。

## 四、验证

| 命令 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/share src/ws` | **430 pass / 0 fail**（44 文件） |
| `cd apps/gateway && bun test src/api src/db` | 537 pass / 0 fail |
| `cd apps/gateway && bunx tsc --noEmit -p .` | 我的范围 0 错（剩余报错在 `src/hub/uplink-node-list.ts`、`src/mesh/peer-dial-race.test.ts`，属其他 agent 在写的文件） |
| `bunx biome check <改动的 28 个文件>` | 0 违规 |
| `bun scripts/complexity/gate.ts` | `src/ws/**`、`src/share/**` 0 违规、0 stale（剩余 9 条违规全在 mesh / hub / panels / terminal-ui，非本任务范围） |
| `cd apps/gateway && bun test src/mesh` | 1335 pass / 3 fail —— 见下 |

**新增回归测试（均已验证「去掉修复即失败」）**：
- `ws/share-canonical.test.ts`：抓屏 / 读历史期间把 pane 移出 window（用 AsyncGate 卡在 tmux 侧，确保请求确实进到了异步读取再翻转 scope），断言无 Begin/Chunk/Commit、只回 `TMUX_TARGET_NOT_FOUND`；pane 移出后服务端撤销订阅、后续输出不投递，且客户端下一次递增代次的订阅仍可用。三条测试在临时移除修复后全部 fail，恢复后全绿。
- `ws/share-metadata-filter.test.ts`：未下发过的 pane 移出不发 removal（patch 保留、revision 连续）、同一 pane 只发一次 removal、只放行已下发过的 window removal。
- `share/share-rate-limit.test.ts`：第 10 次失败起锁满 15 分钟（与窗口独立）、`begin` 预占与并发封顶、`settle(success)` 清空计数。
- `share/share-service.test.ts`：100 次并发错误口令（10 轮 × 10 并发）下 argon2 调用 ≤ 10、并发峰值 ≤ 2、事后锁定且其他 IP 不受影响；未开启登录时 `create` 回 `SHARE_AUTH_REQUIRED`；终止分享前刷出缓冲（最后一批 `in` 不丢）；续期时 `renewed` / `maxAgeSec` 正确。
- `share/share-routes.test.ts`：`POST /api/share` 409 `SHARE_AUTH_REQUIRED`；长期分享续期时 `GET /api/share-access/:id` 重新下发 `x-tmex-set-share` 头（未续期时不发）。

**mesh 的 3 条 fail 与本任务无关**：`uplink-protocol > 1 MiB key.log.res …` 单跑仍失败，属另一 agent 正在重构的 uplink 编解码（`src/hub/uplink-*.ts`、`packages/shared/src/uplink/codec-decode.ts` 均为未提交新文件，且 `uplink-node-list.ts` 当前有 tsc 错误）；`PeerManager DataChannel breaker` 两条单跑 `src/mesh/peer-manager.test.ts` 全绿（80 pass / 0 fail），是全量跑下的计时抖动。我的改动不触碰 mesh。

## 五、给其他 agent 的接口备忘

- **RF2（mesh）**：`getShareService().setAuthRequiredResolver(() => <本节点是否开启登录>)`，在装配处接线（返回 `false` 时 `POST /api/share` 直接 409 `SHARE_AUTH_REQUIRED`）；传 `null` 恢复默认「要求登录」。`VerifiedShareAccess` 新增可选字段 `renewed` / `maxAgeSec`（可选，不破坏现有 mesh 测试的 fake）。
- **RF3（前端）**：新增错误码 `SHARE_AUTH_REQUIRED`（HTTP 409，body `{ error, code }`），前端已有 `share.error.SHARE_AUTH_REQUIRED` 文案，键名一致。分享连接被拒的行为不变（`KIND_ERROR` code 1501 / `SHARE_FORBIDDEN`，4410 `SHARE_ENDED`）。

## 六、遗留 / 风险

1. **撤销依赖设备快照的更新时序**：`isPaneInShareScope` 读 `WebSocketServer` 的 `entry.lastSnapshot`，它由 registry 级 runtime listener 更新，该 listener 早于 canonical 会话的 listener 注册（`Set` 按插入序派发），因此撤销时读到的是新快照。若将来有人改变订阅顺序，最坏结果是读到旧快照 → 少撤销一拍（下一次 patch 补上）；判定本身 fail-closed，不会反向泄露。
2. **代次 bias 只对分享连接生效**（非分享连接 bias 恒为 0，行为逐字节不变）。客户端若违反协议、用同一 generation 发不同内容，仍会拿到租约的冲突错误——与改动前一致。
3. **并发验证上限固定为 2**（`SHARE_LOGIN_MAX_CONCURRENT`），超出回 429 + `retryAfterMs: 1000`。正常单人登录不会触发；若产品上要支持同一 NAT 后大量访客同时首次登录，需要把这个值提到 4–8。
4. R1 的 #2 / #3 / #4 / #5（mesh 侧的开放模式升级、失效 cookie、4401 关闭码、Hub 共用限流桶）不在本任务范围，由 RF2 处理；本轮加的 `setAuthRequiredResolver` 是 #2 的节点侧一半。
