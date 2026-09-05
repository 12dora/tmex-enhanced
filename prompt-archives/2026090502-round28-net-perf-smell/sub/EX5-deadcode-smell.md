# EX5 死代码 / 腐坏测试 / 坏味道审计（Opus 探索报告摘要）

基线：非测试源码 271,490 行；测试 260,647 行（971 文件）；CC>15 函数 78（含 prompt-archives）；函数体 >80 行 216；TODO/FIXME 仅 1 处；无注释代码；无 legacy 分支。`knip`/`ts-prune` 未装，全部 grep + AST。`cc.ts` 硬编码了另一工作树的 typescript 绝对路径。

## A 死代码

- **A1 零引用导出 23 个**（高置信）：`apps/fe/.../use-relay-admit-follow-up.ts:42 resetRelayAdmitFollowUpForTest`、`relay-metrics-model.ts:144 EMPTY_MEMBER_FILTER`、`gateway/settings/broadcaster.ts:48 getTreeOverlayBridge`、`ws/canonical/encoded-size.ts:274 canonicalEventFrameBytes`、`ws/event-loop-lag.ts:192 demandGatewayEventLoopLagFast`、`ws/test-helpers.ts:144 envelopeKind`、`mesh/peer-ws-race.ts:93 resetSharedDirectDialLimiter`、`db/schema/mesh-relay.ts:29,30 MeshRelayRow/MeshSecretRow`、`mesh/mesh-runtime.ts:214 NetworkInterfacesFn`、`messaging/handlers/types.ts:9 CommandModule`、`weixin/ilink/types.ts:13,18-20` 四常量、`api-client/local/tls-types.ts:120 TlsErrorCode`、`local/types.ts:154 ApiErrorBody`、`shared/contracts/system.ts:112 NodeUnreachableErrorBody`、`panels/device-console/terminal-keep-alive.ts:285 readKeepAlivePool`、`stores/tmux-selection-actions.ts:8 snapshotPaneIds`；vendored `node-datachannel/types.ts` 3 个保留。约 100 行。
- **A2 无用 i18n 键 61 个**（三语，已排除动态前缀与复数后缀）：`common.warning/info/enabled/disabled/pending/authorized/empty/none/default/optional/required`、`nav.settings`、`connectDevices.title`、`device.title/devices/localDevice/subtitle/modify`、`terminal.initializing/activePane/activeWindow/closeWindow/closePane`、`settings.title`、`telegram.testMessageSent/expand/collapse/botNotFound`、`weixin.allowAuthRequests/loggedIn/sendTestMessage/removeFailed/userId/expand/collapse/authSuccess/authPending`、`webhook.enabled`、`sshError.agentNoIdentity/timeout`、`deviceStatus.reconnecting/offline`、`websocket.error/checkGateway`、`sidebar.noWindows/currentPane/closeWindow/closePane`、`agent.orphan.process/startedAt`、`agent.panel.title`、`agent.session.none/showAll`、`watch.form.enabled`、`files.transfer.canceled`、`file.notFound/tooLarge/binary`、`nodes.actions.rename`、`nodes.rename.save/done`。约 183 + 生成物 400 行。zh/ja 多出的 5 键与 en 的 `_one/_other` 是复数规则，不要对齐。
- **A3 过度导出 501 个**：热点 `shared/ws-borsh/canonical-state.ts`(27)、`mesh/uplink-pool.ts`(14)、`relay-metrics-tiles.tsx`(13)、`peer-manager.ts`(8)。部分被测试断言，只处理测试也不引用的子集。
- A4 无未引用文件；A5 无死 flag。

## B 腐坏/重复测试

- B1 tmux 版本解析三份（`shared/tmux-version.test.ts` 权威；`gateway/tmux-client/tmux-version.test.ts:11-30`、`app/lib/tmux.test.ts:4-40` 重复 parse/compare）约 55 行。
- B2 `gateway/api/http.test.ts:29-65` 与 `app/runtime/http.test.ts:29-65` 逐字相同且已被 `shared/http/read-body.test.ts` 覆盖，约 75 行。
- B3 `fe/components/global-device-provider.test.ts:90-247` 重测 barrel re-export（原测试在 `device-connection-status.test.ts`、`device-connection-persistence.test.ts`），约 158 行。
- B4 `agent/tools/terminal-encoding.test.ts:9-21` 与 `terminal.test.ts:99-119` 重叠 14 行；B5 `canonical-screen-capture.test.ts` 重复 `bytes.test.ts:24-33` 12 行。
- B6 三份 `FakeSocket`（`ws-client/client.test.ts:18`、`client-pending-queue.test.ts:6`、`websocket-canonical-gate.test.ts:6`）+ 两份 hello 构造器 → `ws-client/src/test-fakes.ts`，约 70 行。
- B7 无 skip/todo 债。

## C 坏味道

- C1 `use-node-upgrade.ts:830 useNodeUpgrade` 453 行 17 个 ref/state → 拆 `useUpgradeRestore/useUpgradeBatch/useUpgradeRowActions`。
- C2 `use-hub-role-switch.ts:1050 useHubRoleSwitch` 249 行 / 文件 1342 行。
- C3 `remote-access/status-card.tsx:57 TunnelStatusCard` CC 33 → 抽 `TunnelStatusNotices` / `TunnelDetailRows`。
- C4 `api/tunnel-routes.ts:104 parseAction` CC 30，`withAck` 展开重复 5 次。
- C5 其它 CC≥18：codec 三函数（见 D1）、`peer-ws-race.ts:109 classifyWsDialFailure` 35（D2）、`tunnel-model.ts:261 wizardStepState` 26、`external-detect.ts:395 parseCloudflaredYml` 26（保留）、`forwarder.ts:225` 23、`uplink-server.ts:1529 handleKeyLogAppend` 22 / `:1930 buildNodeList` 21、`hub-role-routes.ts:108` 21、`hub-authorization.ts:290` 21、`attachment-router.ts:124` 21、`key-log.ts:311`/`access-jwt.ts:87` 安全关键不动、`remote-upgrade-job.ts:151` 19、`nodes-table.tsx:118 NodeRowView` 18（同 DeviceRow 保留）、`stream-targets.ts:172` 18、`tunnel/manager.ts:388 handleAction` 18。
- C6 大文件：`hub/uplink-server.ts` 2246（上帝类，独立立项）、`peer-manager.ts` 1932、`uplink-pool.ts` 1572、`shared/uplink/codec.ts` 1472（本轮最佳目标）、`mesh-runtime.ts` 1472、`tunnel/manager.ts` 1424、`account-security-panel.tsx` 830（三 Section 已独立，直接拆文件零风险）。

## D 重复逻辑

- **D1 uplink codec 双份解码器**：`decodeHubInner:1247`(CC 76) vs `decodeMeshUplinkCtl:686`(CC 67)，`encodeHubUplinkCtl:1432` vs `encodeMeshUplinkCtl:868`，`h*`/`m*` 两套读取族；`NODE_ID_HEX`(`:30`) 大小写敏感 vs `NODE_ID_HEX_I`(`:31`) 不敏感——hub 拒绝大写 node id、mesh 接受（疑似 bug）。步骤 1 拆 `codec-fields/codec-mesh/codec-hub` + barrel（零行为）；步骤 2 统一读取族参数化 error factory；步骤 3 合并 switch（独立立项，保留 exhaustive switch）。
- D2 三份 dial classifier（`peer-ws-race.ts:109`、`rtc-dial-breaker.ts:79`、`ws-client/direct/direct-dial-breaker.ts:29`）→ `shared/net/classifyByKeywords`。
- D3 `err instanceof Error ? err.message : String(err)` 141 处 + 11 份同名 helper → `shared/src/errors.ts errorMessage`。
- D4 8 份 `sleep/delay`（三种 abort 语义）→ `shared/async/sleep.ts`。
- D5 三份 abort 合并（`remote-upgrade-job.ts:452`、`release-download.ts:295` 逐字相同、`peer-ws-race.ts:212`）→ `shared/async/abort.ts`。
- D6 五份滑动窗口限流器（`mesh/auth-login-limiter.ts`、`hub/hub-enroll-limiter.ts`、`relay/relay-enroll-limiter.ts` ×2、`mesh/peer-server.ts:29`）→ `gateway/src/lib/sliding-window.ts`；`uplink-rate-limit.ts` 是令牌桶不并。约 150-180 行。
- D7 确认对话框：`fe/settings/components/danger-confirm-dialog.tsx` 已抽但在 fe；panels 又有 `refresh-confirm-dialog`、`close-confirm-dialog`、`device-delete-dialog`，fe 另有 `pure-relay-confirm`、`relay-switch-dialog` → 上移 `@tmex/ui/confirm-dialog`，testId 逐个保留（e2e 断言）。
- D8 formatBytes 两份（T3 已统一 web 侧；CLI `packages/app` 无 workspace 依赖保留）。
- D9 四处手写 `readError`（`local/tunnel-api.ts:24`、`local/setup-api.ts:31`、`relay/tenant-api.ts:382`、`fe/node/hub-api.ts:112,134`）→ `readCodedError` 加 pick。
- D10 两份 `withTimeout`（`remote-upgrade-job.ts:462`、`acme-service.ts:133`）。

## 建议本轮范围

A1、A2、A3 局部、B1-B6、C3、C4、C6 局部、D1 步骤 1-2、D2、D3、D5、D6、D7、D9、D10；C1/C2 视余力；D1 步骤 3 与上帝类拆分独立立项。
