# Round 4 代码异味清理报告

基于 [cc-baseline.txt](/Users/konata/code/tmex-enhanced-wt-r4/prompt-archives/2026083001-dnd-ios-shift-sidebar-anim-smell-round4/sub/cc-baseline.txt) 及源码静态核对。已排除用户列出的前几轮保留热点。净行数为估算值；同一编号表示应由同一 agent 打包处理，`X` 为跨端协同项。

## BACKEND

1. **[B1] uplink catch-up 与错误分类（同文件）**

   位置/指标：`apps/gateway/src/mesh/uplink-client.ts:823` `runCatchUpFromList`，CC59/175L；`:1269` `classifyUplinkConnectError`，CC35/68；文件 1437L。  
   气味→建议：catch-up 同时处理 head、向 Hub 推送、拉取分页、CAS 应用、重试、fork 与 teardown，分支高度耦合。拆为 `readCatchUpHead`、`pushMissingRecords`、`pullAndApplyPage`、`verifyCatchUpTarget`；错误分类改为有序 predicate 表。  
   净变化：约 -60～-100L；风险：高；覆盖：`apps/gateway/src/mesh/uplink-client.test.ts:57`、`:943`、`:1025`、`:1302`、`:2387`。

2. **[B2] 双份 uplink 协议解码器**

   位置/指标：`apps/gateway/src/mesh/uplink-protocol.ts:206` `decodeUplinkCtl`，CC56/190；`apps/gateway/src/hub/uplink-protocol.ts:190` `decodeUplinkCtl`，CC45/109。  
   气味→建议：两套实现重复边界检查、JSON 递归限制、base64/字段校验和消息分派，仅 wire 类型与大页策略不同。抽取无 Node 依赖的 `packages/shared/src/uplink/codec.ts`，保留 Hub/mesh 的薄适配层。  
   净变化：约 -80～-140L；风险：高；覆盖：`mesh/uplink-protocol.test.ts`、`hub/uplink-protocol.test.ts`、`uplink-client.test.ts`。

3. **[B3] TLS 配置 patch 合并**

   位置/指标：`apps/gateway/src/tls/tls-config-store.ts:135` `upsert`，CC45/89。  
   气味→建议：明文 secret 加密、partial/null 语义、数据库 insert/update 字段各写一遍。使用字段描述表分别生成 `nextSecrets`、`values` 和 conflict update，严格保留“未提供”和“显式 null”的区别。  
   净变化：约 -30～-50L；风险：中；覆盖：`apps/gateway/src/tls/tls-config-store.test.ts:78`、`:163`。

4. **[B4] PeerManager 传输阶梯与控制分派（同文件）**

   位置/指标：`apps/gateway/src/mesh/peer-manager.ts:1238` `dial`，CC29/99；`:1338` `dialWsSecure`，CC18/42；`:1476` `track`，CC19/93；`:1669` `handlePeerCtl`，CC25/65；文件 2204L。  
   气味→建议：DC、WS-secure、relay fallback 与 stopped/generation 检查重复；`track` 同时做 stale、信任、竞态、park、retire、安装生命周期。拆成 transport attempts、peer admission、control-handler map，并统一异步 handler 监督。  
   净变化：约 -75～-130L；风险：高；覆盖：`peer-manager.test.ts:225`、`:706`、`:808`、`:911`、`:1804`，`peer-manager.upgrade.test.ts`。

5. **[B5] UserKeyService 批量应用与副作用持久化（同文件）**

   位置/指标：`apps/gateway/src/auth/user-key-service.ts:351` `applyMany`，CC18/155；`:839` `replayJoinChain`，CC20/86；`:1121` `persistApplied`，CC17/109；文件 1229L。  
   气味→建议：验证、状态推进、CAS transaction、record effects、session effects 全部混在同一层。拆成 prepare/replay、transaction commit、按 record type 的 effect handlers；保留 transaction 边界和 CAS 语义。  
   净变化：约 -70～-120L；风险：高；覆盖：`apps/gateway/src/auth/user-key-service.test.ts:330`、`:867`、`:915`。

6. **[B6] Hub enrollment/redeem 事务**

   位置/指标：`apps/gateway/src/hub/hub-runtime.ts:374` `handleCreateEnrollment`，CC24/102；`:477` `handleRedeem`，CC34/178；内层 transaction 匿名函数 CC24/85；`:167` `handleRequest` CC22/51；文件 790L。  
   气味→建议：base64 解码、授权校验、passkey、token 消费、node 替换、幂等 replay、广播和响应组装交叉嵌套。抽取 request parser、authorization verifier、redeem transaction、success payload builder。  
   净变化：约 -55～-95L；风险：高；覆盖：`apps/gateway/src/hub/hub-runtime.test.ts:132`、`:212`、`:497`。

7. **[B7] mesh auth login**

   位置/指标：`apps/gateway/src/mesh/auth-routes.ts:228` `handleLogin`，CC29/118；`:106` `handle`，CC24/48；文件 985L。  
   气味→建议：路由匹配、challenge/entry/target 校验、delegation、signature、TOTP、session issuance 和错误计数集中在一个函数。拆成 login envelope parser、delegation verifier、login verifier、session issuer，并用路由表替换长 if 链。  
   净变化：约 -35～-65L；风险：高；覆盖：`apps/gateway/src/mesh/auth-routes.test.ts:851`、`:886`、`:923`、`:1134`。

8. **[B8] Mesh runtime 组装**

   位置/指标：`apps/gateway/src/mesh/mesh-runtime.ts:561` `createMeshRuntime`，CC20/777；文件 1337L。  
   气味→建议：store、Hub、RTC、PeerManager、HTTP routes、事件去重、session binding、start/stop 全部在一个 factory 中。拆成 dependency factory、event/session wiring、HTTP wiring、lifecycle builder；保持 `peerManager → uplink → http → rtc` 的停止顺序。  
   净变化：约 -70～-130L；风险：高；覆盖：`mesh-runtime.test.ts:58`、`:350`、`:819`，`integration/wiring.test.ts`、`hub-contract.integration.test.ts`。

9. **[B9] stream target HTTP/WS 处理（同文件）**

   位置/指标：`apps/gateway/src/mesh/stream-targets.ts:125` `acceptHttpStream`，CC30/161；`:506` `acceptWsStream`，CC18/83；文件 636L。  
   气味→建议：协议解析、认证、request body stream、response head/body、abort、RST、session teardown 混在一起。抽取 open parser、request-body adapter、response pump、WS teardown；同时修复未等待的 `cancel/end`。  
   净变化：约 -45～-85L；风险：中高；覆盖：`stream-targets.test.ts:36`、`:55`、`:109`、`:231`、`:529`，`direct-path.integration.test.ts`。

10. **[B10] 节点列表投影与 RTC authorize**

    位置/指标：`apps/gateway/src/mesh/mesh-routes.ts:211` `collectNodes`，CC30/81；`:324` `handleRtcAuthorize`，CC20/51；`apps/gateway/src/hub/uplink-server.ts:1277` `buildNodeList`，CC17/71；文件分别 483L、1447L。  
    气味→建议：mesh DTO 与 Hub wire DTO 都重复组合 online、inventory、direct capability、name、hub 信息。抽取 gateway 内部 `node-list-projection`，两侧只负责 DTO/wire 映射；同时把 RTC body/fingerprint/connection lookup 拆开。  
    净变化：约 -45～-85L；风险：中；覆盖：`mesh-routes.test.ts`、`uplink-server.test.ts:892`。

11. **[B11] Forwarder failover/HTTP response（同文件）**

    位置/指标：`apps/gateway/src/mesh/forwarder.ts:273` `failover`，CC25/73；`:432` `handleRemoteHttp`，CC18/60；`:551` `adaptResponse`，CC17/82；文件 1061L。  
    气味→建议：failover 重试、replay、队列 flush；HTTP retry；401/session header 重写分别是三个独立 seam。拆出 retry/open、replay completion、response policy；`flushQueue` 目前在成功路径连续调用两次，第二次因 `splice(0)` 恒为空。  
    净变化：约 -45～-80L；风险：中高；覆盖：`forwarder.test.ts:443`、`:453`、`:587`、`:668`，`integration/stream-failover.integration.test.ts`。

12. **[B12] enroll 主流程与输入处理**

    位置/指标：`packages/app/src/commands/enroll.ts:295` 匿名 `withAuth` 回调，CC34/183；文件 478L。  
    气味→建议：本地 Hub token、远端 login/enrollment、TOTP、poll、admit-node 全部在一个 callback 中。拆成 local enrollment、remote enrollment、poll/admit 三段，并统一 abortable sleep。  
    净变化：约 -30～-60L；风险：中高；覆盖：`packages/app/src/commands/enroll.test.ts:54`、`:175`、`:347`、`:393`。

13. **[B13] init 配置构建**

    位置/指标：`packages/app/src/commands/init.ts:107` `buildInitConfig`，CC27/134；文件 370L。  
    气味→建议：角色、端口、Hub、TLS、direct 配置和 env fallback 在一个函数中解析。按配置域拆成 builders；不触碰用户明确保留的 `runInit`。  
    净变化：约 -25～-40L；风险：中；覆盖：`packages/app/src/commands/init.test.ts`。

14. **[B14] assemble runtime dispatch**

    位置/指标：`packages/app/src/runtime/assemble.ts:153` `assembleTmex`，CC17/365；内层 `dispatch` `:285`，CC26/60；文件 581L。  
    气味→建议：TLS、local/setup、Hub、mesh guards、gateway、frontend fallback 和 websocket 分派顺序全内嵌。抽取 HTTP pipeline、websocket router、TLS lifecycle builder，保留当前优先级顺序。  
    净变化：约 -45～-85L；风险：高；覆盖：`packages/app/src/runtime/assemble.test.ts:117`、`:517`、`:647`、`:866`。

15. **[B15] CLI hub join**

    位置/指标：`packages/app/src/commands/hub.ts:489` `performHubJoin`，CC18/121；文件 884L。  
    气味→建议：token/url/TLS pinning、auth-mode、redeem、certificate validation、commit 混在一个流程。拆成 token/url preparation、Hub handshake、verified commit；将 CLI error mapping 移到独立模块。  
    净变化：约 -20～-35L；风险：中；覆盖：`packages/app/src/commands/hub.test.ts`、`join.test.ts`。

## FRONTEND

16. **[F1] direct carrier controller**

    位置/指标：`packages/ws-client/src/direct/direct-carrier-controller.ts` 文件 1200L；`runAttempt` `:430-506` 约 77L，CC 未超过 baseline 的 >15 阈值。  
    气味→建议：attempt 生命周期、REST authorize、signaling queue、ICE 状态、stats/network listener 都在一个 class。保留 façade，拆出 attempt runner、signaling queue、diagnostics/network modules。  
    净变化：约 0～-30L；风险：高；覆盖：`direct-carrier-controller.test.ts:166`、`:244`、`:496`、`:590`、`:642`。

17. **[F2] 浏览器 loginToNode**

    位置/指标：`apps/fe/src/auth/session-key-store.ts:418` `loginToNode`，CC22/65。  
    气味→建议：node lookup、TOTP gate、challenge、public-key pinning、login payload 和错误映射集中处理。拆成 target resolution、challenge validation、signed request builder。  
    净变化：约 -10～-20L；风险：中；覆盖：`apps/fe/src/auth/session-key-store.test.ts:187`、`:232`、`:262`。

18. **[F3] LocalMachineCard（同文件）**

    位置/指标：`apps/fe/src/pages/settings/nodes/local-machine-card.tsx:206` `LocalMachineCard`，CC18/221；`:428` `DirectSection`，CC19/103；文件 602L。  
    气味→建议：角色切换、direct mutation、restart、leave dialog 和大量 JSX 交织。抽出 `DirectSection`、role section、dialog/actions；保留 controller 和现有测试选择器。  
    净变化：约 -25～-50L；风险：中；覆盖：`local-machine-card.test.tsx:101`、`:235`、`:365`。

19. **[F4] nodes table row**

    位置/指标：`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:95` `NodeRowView`，CC17/193；文件 295L。  
    气味→建议：rename/revoke 异步动作与 9 列 JSX 混合。抽出 row actions、status cells 和 mutation hooks。  
    净变化：约 -25～-45L；风险：低中；覆盖：`nodes-management.test.tsx:63`、`nodes-tab.test.tsx`。

20. **[F5] useNodeLoginGate**

    位置/指标：`apps/fe/src/auth/use-node-login.ts:52` `useNodeLoginGate`，CC19/62。  
    气味→建议：mode/list loading、silent login、failure state 和 retry 状态集中在一个 hook。拆成数据 gate 与 silent-login effect hooks，避免继续增加 effect 分支。  
    净变化：约 -10～-20L；风险：低中；覆盖：`apps/fe/src/auth/use-node-login.test.tsx:55`。

21. **[F6] DeviceManagementPanel**

    位置/指标：`packages/panels/src/device-management/device-management-panel.tsx:198` `DeviceManagementPanel`，CC18/243；文件 440L。  
    气味→建议：query hydration、首屏动画、optimistic reorder、empty/loading/error 分支和 DnD JSX 混合。抽出 `useDeviceManagementState` 与 `DeviceGridBody`；当前未发现直接 panel render test，只有 device card/form/events 间接覆盖。  
    净变化：约 -35～-60L；风险：中；覆盖：`packages/panels/src/device-management/device-card.test.tsx`、`device-form.test.ts`、`device-management-events.test.ts`。

## 跨端协同

22. **[X1] DataChannel fragmenter 双实现**

    位置/指标：`apps/gateway/src/mesh/rtc/fragmenter.ts:62-179`，`push` CC16/61；`packages/ws-client/src/direct/fragmenter.ts:104-231`，`push` CC16/55；文件分别 241L、267L。  
    气味→建议：frame header、LE 编解码、分片、pending frame、超时、最大帧和 eviction 逻辑重复，但错误策略不同。抽取 `packages/shared/src/link/fragment-core.ts`，Node/browser 只保留 timeout、violation callback 和错误类型适配。  
    净变化：约 -100～-160L；风险：高；覆盖：两侧 `fragmenter.test.ts`、`data-channel-carrier.test.ts`、`data-channel-link.test.ts`、`dc-handshake.test.ts`。

23. **[X2] LinkStream/ WebSocket queued pump**

    位置/指标：`apps/gateway/src/mesh/link-stream-carrier.ts:90` `pump`，CC16/42；`packages/shared/src/link/websocket-link.ts:122` 内层 `pump`，CC16/38。  
    气味→建议：队列、pumping guard、close、backpressure/drain 和重入处理重复。抽取通用 `packages/shared/src/link/queued-transport.ts`，用 hooks 注入 async `write/end` 与 sync WebSocket send 语义。  
    净变化：约 -45～-70L；风险：中高；覆盖：`link-stream-carrier.test.ts`、`packages/shared/src/link/websocket-link.test.ts`。

同一编号内应合并处理；BACKEND 与 FRONTEND 的普通候选文件集不重叠，X 项需两侧共同调整接口。

## 重复代码对

| 重复位置 | 建议抽取 |
|---|---|
| `mesh/uplink-protocol.ts:141-178,206-395` ↔ `hub/uplink-protocol.ts:140-180,190-550` | `packages/shared/src/uplink/codec.ts`：bounded JSON、字段校验、base64、seq 转换；两端保留 wire adapter。 |
| `mesh/rtc/fragmenter.ts:34-179` ↔ `ws-client/direct/fragmenter.ts:59-231` | `packages/shared/src/link/fragment-core.ts`：header、分片、重组和 pending accounting。 |
| `link-stream-carrier.ts:90-131` ↔ `websocket-link.ts:122-162` | `packages/shared/src/link/queued-transport.ts`：队列/pump/backpressure 状态机。 |
| `mesh-routes.ts:211-291` ↔ `hub/uplink-server.ts:1277-1347` | `apps/gateway/src/mesh/node-list-projection.ts`：节点在线状态、inventory、direct capability、name 的内部模型。 |
| `auth-routes.ts:230-266`、`mesh-routes.ts:331-356` ↔ `hub-runtime.ts:338-394,477-511` | `apps/gateway/src/api/route-input.ts`：required string、base64、JSON body 和统一 validation error；业务错误码仍由各 route 映射。 |
| `packages/app/src/runtime/setup-routes.ts:11-17` ↔ `local-routes.ts:25-31` | 复用 `packages/app/src/runtime/http.ts` 中的通用 `mapError`。 |
| `stream-targets.ts:343-366` ↔ `hub/uplink-server.ts:1433-1447` | `apps/gateway/src/mesh/stream-pump.ts`：读取 LinkStream chunk、写入目标、await end、错误回调。 |

## 发现的 bug 与风险

1. `packages/app/src/commands/enroll.ts:274-281`：`if (io?.totpCode)` 内再判断 `if (!io.totpCode)`，后者不可达。显式传入空 TOTP 时会改为交互式 prompt，而不是拒绝空值。

2. `packages/app/src/commands/enroll.ts:69-84`：`sleep` 在 timer 正常完成时没有移除 abort listener；polling 多轮后会在同一 signal 上累积 listener。

3. `apps/gateway/src/mesh/stream-targets.ts:162-177`：`requestReader.cancel()` / `responseReader.cancel()` 返回 Promise，却在同步 `try/catch` 中使用 `void`，异步 rejection 无法被捕获。

4. `apps/gateway/src/mesh/stream-targets.ts:343-366,453-456`：`writeBody` 被启动后只执行 `void writeBody`。无 body、`Uint8Array` body 的 `stream.end/write` rejection 没有顶层 catch；同时 response head 读取失败时上传任务可能继续运行。`LinkStream.end()` 明确返回 `Promise<void>`，见 `packages/shared/src/link/types.ts:57-63`。

5. `apps/gateway/src/mesh/stream-targets.ts:541-546,617-618`：WS teardown 与 `openWsStream.close` 对 `stream.end()` 使用 `void`；`end()` rejection 会绕过外层同步 `try/catch`，产生 unhandled rejection。

6. `apps/gateway/src/hub/uplink-server.ts:1433-1445`：`copyDirection` 调用 `dst.end()` 未 await。其 `try/catch` 不能捕获异步失败；应 await 并在 finally 中释放 reader。

7. `apps/gateway/src/mesh/peer-manager.ts:1707-1713`：`applyPeerStatus`、`serveKeyLog`、`applyKeyLogRes` 全部 fire-and-forget。前者的 `userStore.upsertPeer` 可抛异常，后者在 `decodeBase64url` 或 `applyMany` 失败时没有内部 catch，错误会变成未处理 rejection。

8. `apps/gateway/src/mesh/forwarder.ts:444` 注册 request abort listener 后没有显式移除。通常会随 Request 回收，但若上游持有长期 signal，会保留 `AbortController` 闭包；建议在 response/error/finally 中清理。

## Dead code

以下是针对本轮重点目录用 `rg` 核验后确认“仓库内无外部 importer”的导出；建议先去掉 `export`，不要直接删除内部实现：

- `apps/gateway/src/mesh/uplink-client.ts:55` `UplinkLastConnectError`：仅被同文件字段使用，未被 barrel 导出。
- `apps/gateway/src/mesh/uplink-client.ts:1256` `sanitizeUplinkCtlType`、`:1260` `stripCtlControlChars`、`:1396` `mapUplinkCtlError`：仅同文件使用。
- `apps/gateway/src/mesh/uplink-protocol.ts:29-74,202`：`UplinkAuthChallenge`、`UplinkAuthResponse`、`UplinkAuthOk`、`UplinkPing`、`UplinkPong`、`UplinkNodeStatusMsg`、`UplinkNodeInfo`、`UplinkKeyLogHead`、`UplinkHubInfo`、`UplinkKeyLogReq`、`UplinkKeyLogRes`、`UplinkKeyLogAppend`、`UplinkCtlType`、`DecodeUplinkCtlOptions` 未被 `mesh/index.ts` 或其他源码引用。
- `apps/gateway/src/hub/uplink-protocol.ts:54` `NodeListHubInfo`、`:81` `KeyLogAckMessage` 未被 `hub/index.ts` 或其他源码引用。
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:90` `formatLastSeen`：仅自身 `:245` 使用。
- `apps/fe/src/pages/settings/nodes/local-machine-card.tsx:179` `useDirectMutations`：仅自身 `:243` 使用。

未发现可安全确认的整文件 dead code。`apps/gateway/src/mesh/rtc/rtc-loopback.integration.ts` 虽不是 `*.test.ts` 且无普通 importer，但仓库文档与历史命令明确通过 `bun test ./src/mesh/rtc/rtc-loopback.integration.ts` 显式执行，不能删除；`hub-test-helpers.ts`、`mesh/test-support.ts` 也被测试文件直接引用。