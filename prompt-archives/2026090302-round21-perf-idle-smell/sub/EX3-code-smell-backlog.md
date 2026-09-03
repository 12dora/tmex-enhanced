# EX3：第二十一轮 code smell 重构 backlog

只读探索产出。基线 worktree `/Users/konata/code/tmex-r21`，`main` @ `e4ae3dd2`（1.1.20 已发）。

口径与工具：
- 门禁：`scripts/complexity/gate.ts:11` `LIMITS = { cc: 15, fnLines: 120, fileLines: 900 }`；跳过目录 `scripts/complexity/gate.ts:12`（含 `dist`/`resources`/`docs`/`bench`/`scripts`）、跳过测试文件 `scripts/complexity/gate.ts:23`、跳过 i18n 生成物与 `vendor`/`tests` `scripts/complexity/gate.ts:24`。
- allowlist：`scripts/complexity/allowlist.json`，151 条，语义是「不许比记录值更差」（`scripts/complexity/gate.ts:180-190`）。
- 本报告的「更广普查」用同一套 AST/McCabe 算法，但**额外扫入测试、bench、`scripts/`**，阈值放宽到 CC≥15 / 文件>700 行，以便看到门禁盲区。

---

## 0. 现状一句话

`bun scripts/complexity/gate.ts` **失败，24 条违规、0 条 stale**。其中 **13 条是「新增未入册」**（第 13–20 轮加的 mesh/hub/多 hub/auth/TLS 代码），**11 条是「已入册但继续恶化」**。同时 allowlist 里有大量条目实测值已低于锁值（例：`tunnel-routes.ts:parseAction` 锁 CC 40、实测 30），一次 `--tighten` 就能收敛。

产品代码全量（门禁口径）：1207 文件 / 11172 函数 / CC>15 共 72 个 / >120 行共 74 个（`bun scripts/complexity/gate.ts --report` 首行）。
放宽口径（含测试/scripts）：CC≥15 共 122 个（产品 115、测试与 bench 7），>700 行文件 103 个（产品 45、测试 58）。

---

## 1. 当前 24 条违规（逐条裁决）

表内「锁值」= allowlist 现有值，`—` 表示无条目（全新违规）。

| # | 位置 | 实测 | 锁值 | 裁决 |
|---|---|---|---|---|
| 1 | `apps/fe/src/components/side-panels/account-security-panel.tsx:469` `TotpSection` | 191 行 | 186 | **RETAIN**（重锁 191） |
| 2 | `apps/fe/src/components/side-panels/account-security-panel.tsx:665` `PasskeySection` | 166 行 | 154 | **RETAIN**（重锁 166） |
| 3 | `apps/fe/src/pages/settings/nodes/https/acme-panel.tsx:53` `AcmePanel` | 255 行 | 216 | **REFACTOR**（S） |
| 4 | `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:82` `NodesManagement` | 250 行 / CC18 | 249 | **RETAIN**（重锁 250） |
| 5 | `apps/fe/src/pages/settings/nodes/management/node-detail-dialog.tsx:406` `NodeDetailDialog` | 122 行 | — | **REFACTOR**（S） |
| 6 | `apps/fe/src/pages/settings/use-site-settings-form.ts:74` `useSiteSettingsForm` | 151 行 | — | **REFACTOR**（S） |
| 7 | `apps/gateway/src/mesh/mesh-runtime.ts` | 1658 行 | 1634 | **REFACTOR**（M，随 #9 一起降） |
| 8 | `apps/gateway/src/mesh/mesh-runtime.ts:742` `createMeshStoresAndServices` | 137 行 | 136 | **RETAIN**（装配根，重锁 137） |
| 9 | `apps/gateway/src/mesh/mesh-runtime.ts:984` `handleUplinkNodeList` | CC21 | 19 | **REFACTOR**（S） |
| 10 | `apps/gateway/src/mesh/auth-routes.ts` | 1091 行 | 998 | **REFACTOR**（M） |
| 11 | `apps/gateway/src/mesh/auth-routes.ts:329` `handleLogin` | CC21 | — | **REFACTOR**（S） |
| 12 | `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:89` `classifyRtcDialFailure` | CC21 | — | **RETAIN**（分类器扁平分派，入册） |
| 13 | `apps/gateway/src/mesh/peer-ws-race.ts:108` `classifyWsDialFailure` | CC35 | — | **RETAIN**（同上，入册） |
| 14 | `apps/gateway/src/mesh/peer-ws-race.ts:342` `dialWsSecureCandidate` | CC22 | — | **REFACTOR**（M） |
| 15 | `apps/gateway/src/mesh/peer-manager.ts` | 2540 行 | 2299 | **REFACTOR**（L） |
| 16 | `apps/gateway/src/ws/index.ts` | 941 行 | — | **REFACTOR**（S，纯搬迁） |
| 17 | `packages/app/src/runtime/assemble.ts:672` `assembleTmex` | CC21 | 18 | **REFACTOR**（M） |
| 18 | `packages/app/src/runtime/assemble.ts:672` `assembleTmex` | 173 行 | 156 | 同 #17 |
| 19 | `packages/app/src/tls/tls-service.ts:478` `doRunAcme` | CC16 | — | **REFACTOR**（S） |
| 20 | `packages/app/src/tls/tls-service.ts:678` `resolveAcmeDnsPatch` | CC33 | — | **REFACTOR**（M） |
| 21 | `packages/stores/src/tmux.ts:33` `createTmuxStore` | 333 行 | 331 | **REFACTOR**（S）或重锁 |
| 22 | `packages/ws-client/src/direct/direct-carrier-controller.ts` | 1198 行 | 1118 | **REFACTOR**（M） |
| 23 | `packages/ws-client/src/direct/direct-carrier-controller.ts:1055` `publish` | CC18 | — | **REFACTOR**（S） |
| 24 | `packages/ws-client/src/direct/direct-dial-breaker.ts:42` `classifyDirectDialFailure` | CC16 | — | **RETAIN**（分类器，入册） |

汇总：**16 条走重构，8 条重锁/入册**。

---

## 2. 更广普查

### 2.1 产品代码 CC≥15（按 CC 降序，115 条中的高位）

已在 allowlist 且实测未恶化的省略理由，只标裁决。

| CC | 行 | 位置 | 裁决 |
|---:|---:|---|---|
| 76 | 177 | `packages/shared/src/uplink/codec.ts:1247` `decodeHubInner` | RETAIN（协议扁平分派，历轮已定） |
| 67 | 181 | `packages/shared/src/uplink/codec.ts:686` `decodeMeshUplinkCtl` | RETAIN |
| 55 | 131 | `apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts:41` `emitOsc` | RETAIN |
| 49 | 102 | `packages/shared/src/uplink/codec.ts:868` `encodeMeshUplinkCtl` | RETAIN |
| 35 | 58 | `apps/gateway/src/mesh/peer-ws-race.ts:108` `classifyWsDialFailure` | RETAIN（新入册） |
| 33 | 201 | `apps/fe/src/pages/settings/remote-access/status-card.tsx:65` `TunnelStatusCard` | RETAIN（纯条件 JSX） |
| 33 | 80 | `packages/app/src/tls/tls-service.ts:678` `resolveAcmeDnsPatch` | **REFACTOR** |
| 33 | 86 | `packages/ghostty-terminal/src/ghostty-wasm.ts:1290` `encodeMouseEvent` | RETAIN（FFI，第七轮实测非热点） |
| 32 | 103 | `apps/gateway/src/ws/error-classify.ts:1` `classifySshError` | RETAIN |
| 32 | 118 | `packages/app/src/lib/args.ts:90` `resolveNestedCommand` | RETAIN |
| 30 | 84 | `apps/gateway/src/api/tunnel-routes.ts:104` `parseAction` | RETAIN（锁值 40 → 可收紧到 30） |
| 26 | 38 | `apps/fe/src/pages/settings/remote-access/tunnel-model.ts:247` `wizardStepState` | RETAIN |
| 26 | 72 | `apps/gateway/src/tmux-client/control-mode/metadata.ts:14` `parse` | RETAIN（语法即分支） |
| 26 | 83 | `apps/gateway/src/agent/tools/send-input.ts:76` `execute` | RETAIN |
| 26 | 54 | `apps/gateway/src/tunnel/external-detect.ts:395` `parseCloudflaredYml` | RETAIN |
| 24 | 87 | `packages/app/src/cli-auth-entry.ts:7` `dispatchAuthCli` | RETAIN |
| 24 | 55 | `packages/shared/src/uplink/codec.ts:468` `parseHubWriteForwardMessage` | RETAIN |
| 23 | 62 | `apps/gateway/src/mesh/forwarder.ts:267` `forwardAuthorizedHttp` | RETAIN |
| 23 | 44 | `apps/gateway/src/mesh/peer-manager.ts:1933` `handlePeerCtl` | RETAIN（扁平 ctl 分派） |
| 22 | 86 | `apps/gateway/src/mesh/peer-ws-race.ts:342` `dialWsSecureCandidate` | **REFACTOR** |
| 22 | 110 | `apps/gateway/src/hub/uplink-server.ts:1536` `handleKeyLogAppend` | RETAIN（锁 23，实测 22，可收紧） |
| 22 | 79 | `apps/gateway/src/hub/hub-role-routes.ts:108` `handlePostHubRole` | RETAIN |
| 21 | 79 | `apps/gateway/src/mesh/mesh-runtime.ts:984` `handleUplinkNodeList` | **REFACTOR** |
| 21 | 67 | `apps/gateway/src/mesh/auth-routes.ts:329` `handleLogin` | **REFACTOR** |
| 21 | 28 | `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:89` `classifyRtcDialFailure` | RETAIN（新入册） |
| 21 | 86 | `apps/gateway/src/hub/uplink-server.ts:1944` `buildNodeList` | RETAIN |
| 21 | 51 | `apps/gateway/src/hub/hub-authorization.ts:244` `applyKeyLogHubRuntime` | RETAIN |
| 21 | 45 | `apps/gateway/src/hub/attachment-router.ts:124` `applyFromHub` | RETAIN |
| 21 | 26 | `apps/gateway/src/hub/hub-peer-poller.ts:744` `parsePeerStatusBody` | RETAIN |
| 21 | 173 | `packages/app/src/runtime/assemble.ts:672` `assembleTmex` | **REFACTOR** |
| 20 | 80 | `apps/gateway/src/tunnel/external-detect.ts:260` `enrichCandidate` | RETAIN |
| 20 | 64 | `apps/gateway/src/hub/uplink-server.ts:1216` `onCtl` | RETAIN |
| 20 | 51 | `packages/shared/src/link/websocket-link.ts:150` `pump` | RETAIN（背压泵，已试拆并回退） |
| 19 | 123 | `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:111` `NodeRowView` | RETAIN（锁 21/127 → 可收紧 19/123） |
| 19 | 44 | `apps/gateway/src/mesh/peer-manager.ts:1978` `applyPeerStatus` | RETAIN |
| 19 | 34 | `apps/gateway/src/mesh/mesh-routes.ts:146` `handle` | RETAIN |
| 19 | 34 | `apps/gateway/src/tunnel/access-jwt.ts:87` `verifyAccessJwt` | RETAIN（安全门顺序） |
| 19 | 53 | `apps/gateway/src/system/remote-upgrade-job.ts:151` `cancelRemoteUpgradeJob` | RETAIN |
| 19 | 58 | `packages/panels/src/device-folders/folder-tree-model.ts:159` `resolveDrop` | RETAIN |
| 19 | 65 | `packages/shared/src/auth/key-log.ts:255` `verifyKeyLogRecord` | RETAIN（安全顺序） |
| 18 | 27 | `apps/gateway/src/mesh/uplink-pool.ts:1185` `considerNearestSwitch` | RETAIN |
| 18 | 105 | `apps/gateway/src/mesh/stream-targets.ts:172` `acceptHttpStream` | RETAIN |
| 18 | 35 | `apps/gateway/src/tmux-client/pane-stream-parser.ts:55` `dispatchPaneStreamByte` | RETAIN |
| 18 | 65 | `apps/gateway/src/tunnel/manager.ts:388` `handleAction` | RETAIN（锁 23 → 收紧 18） |
| 18 | 31 | `packages/ws-client/src/direct/direct-carrier-controller.ts:1055` `publish` | **REFACTOR** |
| 17 | 21 | `apps/gateway/src/mesh/uplink-client.ts:561` `handleCtl` | RETAIN |
| 17 | 24 | `apps/gateway/src/mesh/stream-pump.ts:5` `pumpToLink` | RETAIN |
| 17 | 38 | `apps/gateway/src/mesh/rtc/bulk.ts:315` `pumpDownload` | RETAIN |
| 17 | 48 | `apps/gateway/src/mesh/session-middleware.ts:49` `authenticateRequest` | RETAIN（鉴权优先级顺序） |
| 17 | 68 | `apps/gateway/src/auth/user-store.ts:700` `applyEnrollmentTokenReplication` | RETAIN |
| 17 | 41 | `apps/gateway/src/agent/tools/read-screen.ts:27` `execute` | RETAIN |
| 17 | 54 | `apps/gateway/src/hub/hub-replication.ts:21` `applyReplicatedNodeList` | RETAIN |
| 17 | 27 | `packages/app/src/lib/native-manifest.ts:165` `detectLibcFamily` | RETAIN |
| 17 | 72 | `packages/shared/src/auth/key-log.ts:459` `applyAdmitNode` | RETAIN |
| 16 | 49 | `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts:531` `awaitHubRoleSwitch` | RETAIN |
| 16 | 137 | `apps/gateway/src/mesh/mesh-runtime.ts:742` `createMeshStoresAndServices` | RETAIN |
| 16 | 40 | `apps/gateway/src/mesh/auth-routes.ts:438` `handlePasskeyRegisterVerify` | RETAIN |
| 16 | 92 | `packages/app/src/tls/tls-service.ts:478` `doRunAcme` | **REFACTOR** |
| 16 | 24 | `apps/gateway/src/mesh/uplink-pool.ts:199` `parseKeyUsageFromRaw` | RETAIN |
| 16 | 42 | `apps/gateway/src/mesh/link-stream-carrier.ts:95` `pump` | RETAIN |
| 16 | 65/53 | `apps/gateway/src/tunnel/manager.ts:300` `status` / `:928` `jobCheck` | RETAIN |
| 16 | 88 | `apps/gateway/src/system/upgrade.ts:289` `stagePackageLocked` | RETAIN |
| 16 | 30 | `apps/gateway/src/tls/tls-config-store.ts:101` `get` | RETAIN（逐字段回退链） |
| 16 | 75 | `apps/gateway/src/hub/uplink-server.ts:614` `handleHubWriteForward` | RETAIN |
| 16 | 24 | `apps/gateway/src/hub/hub-relay.ts:49` `parseHubRelayOpen` | RETAIN |
| 16 | 51 | `packages/app/src/commands/enroll.ts:410` `pollAndAdmit` | RETAIN |
| 16 | 64 | `packages/shared/src/auth/key-log.ts:629` `verifyKeyLogChain` | RETAIN |
| 16 | 41 | `packages/shared/src/uplink/codec.ts:1432` `encodeHubUplinkCtl` | RETAIN |
| 16 | 14 | `packages/ws-client/src/direct/direct-dial-breaker.ts:42` `classifyDirectDialFailure` | RETAIN（新入册） |

CC 恰好 =15 的 33 个（门禁不判违规）不逐条列，仅点名两个**未入册但值得盯**的：
- `apps/gateway/src/mesh/peer-manager.ts:1571` `dialWsSecure`（CC15 / 95 行）——本轮 #15 拆分会顺手降低。
- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts:843` `resumeHubRoleSwitch`（CC15 / 60 行）——恢复流程与 `runHubRoleSwitch:706` 高度对称，见 §3.6。

### 2.2 测试/bench 里的 CC≥15（门禁盲区，7 条）

| CC | 位置 | 说明 |
|---:|---|---|
| 24 | `packages/shared/bench/legacy-snapshot-diff.bench.ts:18` `referenceApply` | 与下一条**逐字重复** |
| 24 | `packages/shared/src/ws-borsh/legacy-snapshot-draft.test.ts:25` `referenceApply` | 同上，见 §3.7 |
| 19 | `apps/gateway/src/tunnel/manager.test.ts:787` `fetchImpl` | 测试 fake，RETAIN |
| 18 | `apps/gateway/src/mesh/integration/dc-http-bulk.integration.test.ts:202` `tick` | RETAIN |
| 17 | `apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts:51` `<anon>` | RETAIN |
| 16 | `apps/gateway/src/tmux-client/local-external-connection.test.ts:67` `<anon>` | RETAIN |
| 15 | `apps/gateway/src/mesh/auth-routes.test.ts:330` `challengeAndLogin` | RETAIN |

另外三个在 `apps/gateway/scripts/` 下（门禁 SKIP_DIRS 命中 `scripts`）：`scan-managed-artifact.ts:53` `scanManagedArtifact`（CC24/100 行）、`run-managed-smoke.ts:76` `main`（CC20/210 行）、`scripts/complexity/gate.ts:42` `visit`（CC16）。均为一次性运维脚本，**RETAIN**，与第三轮「dev scripts 不动」一致。

### 2.3 产品源文件 > 700 行（45 个，全量）

| 行数 | 文件 | 锁值 | 裁决 |
|---:|---|---:|---|
| 2540 | `apps/gateway/src/mesh/peer-manager.ts` | 2299 | **REFACTOR L** |
| 2261 | `apps/gateway/src/hub/uplink-server.ts` | 2261 | **REFACTOR M**（不违规但已顶格） |
| 1658 | `apps/gateway/src/mesh/mesh-runtime.ts` | 1634 | **REFACTOR M** |
| 1624 | `packages/ghostty-terminal/src/ghostty-wasm.ts` | 1624 | RETAIN（FFI 所有权边界） |
| 1597 | `apps/gateway/src/mesh/uplink-pool.ts` | 1647 | RETAIN（收紧到 1597） |
| 1473 | `packages/shared/src/uplink/codec.ts` | 1473 | RETAIN（协议编解码） |
| 1425 | `apps/gateway/src/tunnel/manager.ts` | 1428 | RETAIN（收紧 1425）；可选 M 级拆分见 §2.4 |
| 1386 | `apps/gateway/src/hub/hub-runtime.ts` | 1399 | RETAIN（收紧 1386）；可选拆 redeem |
| 1343 | `apps/fe/.../management/use-hub-role-switch.ts` | 1343 | RETAIN |
| 1313 | `packages/app/src/commands/hub.ts` | 1349 | RETAIN（收紧 1313）；可选拆 join |
| 1283 | `apps/fe/.../management/use-node-upgrade.ts` | 1283 | RETAIN |
| 1198 | `packages/ws-client/src/direct/direct-carrier-controller.ts` | 1118 | **REFACTOR M** |
| 1091 | `apps/gateway/src/mesh/auth-routes.ts` | 998 | **REFACTOR M** |
| 1041 | `apps/gateway/src/system/upgrade.ts` | 1041 | RETAIN |
| 992 | `apps/gateway/src/mesh/integration/multi-hub-harness.ts` | 992 | RETAIN（测试夹具） |
| 967 | `packages/ghostty-terminal/src/render-state.ts` | 967 | RETAIN |
| 964 | `apps/gateway/src/mesh/forwarder.ts` | 995 | RETAIN（收紧 964） |
| 960 | `apps/gateway/src/auth/user-store.ts` | 960 | RETAIN |
| 941 | `apps/gateway/src/ws/index.ts` | — | **REFACTOR S**（纯委派门面，见 §2.4） |
| 918 | `apps/gateway/src/tunnel/external-detect.ts` | 918 | RETAIN |
| 899 | `apps/gateway/src/ws/tmux-command-handlers.ts` | — | 未越线，观察 |
| 899 | `packages/app/src/lib/upgrade-apply.ts` | — | 未越线，观察 |
| 898 | `apps/gateway/src/mesh/uplink-client.ts` | — | 未越线，观察 |
| 897 | `packages/app/src/runtime/assemble.ts` | — | 未越线；#17 拆分后会降 |
| 881 | `apps/fe/src/node/enrollment-engine.ts` | — | 观察 |
| 867 | `apps/gateway/src/auth/user-key-service.ts` | — | 观察 |
| 865 | `apps/fe/src/node/mesh-nodes.ts` | — | 观察 |
| 865 | `apps/gateway/src/db/schema.ts` | — | RETAIN（DDL 表定义） |
| 848 | `packages/ghostty-terminal/src/terminal.ts` | — | 观察 |
| 831 | `apps/fe/src/components/side-panels/account-security-panel.tsx` | — | 观察（#1/#2 所在文件） |
| 822 | `packages/app/src/tls/tls-service.ts` | — | #19/#20 拆分后会降 |
| 807 | `apps/gateway/src/hub/hub-peer-poller.ts` | — | 观察 |
| 807 | `packages/shared/src/link/mux.ts` | — | RETAIN（协议） |
| 793 | `apps/gateway/src/tmux-client/external/session-commands.ts` | — | RETAIN |
| 786 | `apps/fe/src/pages/settings/remote-access/access-step.tsx` | — | 观察 |
| 782 | `packages/ws-client/src/state-machine.ts` | — | RETAIN（状态机） |
| 776 | `apps/fe/src/node/enrollment.ts` | — | 观察 |
| 747 | `packages/app/src/runtime/setup-service.ts` | — | 观察 |
| 738 | `packages/ghostty-terminal/src/canvas-renderer.ts` | — | RETAIN（渲染管线） |
| 734 | `apps/gateway/src/tmux-client/ssh-external-connection.ts` | — | 观察 |
| 724 | `packages/ws-client/src/client.ts` | — | 观察 |
| 712 | `apps/gateway/src/tmux-client/external-tmux-core.ts` | — | 观察 |
| 711 | `apps/gateway/src/agent/supervisor.ts` | — | 观察 |
| 708 | `packages/theme/src/preset-palettes.ts` | — | RETAIN（生成式数据表） |
| 704 | `apps/fe/src/auth/session-login.ts` | — | 观察 |

### 2.4 测试文件 > 700 行（58 个，Top 15）

门禁不管测试，本轮**不建议拆测试**（拆分会打散「一个模块一个 spec」的定位性），但要点名两处：

| 行数 | 文件 |
|---:|---|
| 3754 | `apps/gateway/src/mesh/peer-manager.test.ts` |
| 3677 | `apps/gateway/src/mesh/auth-routes.test.ts` |
| 2983 | `apps/gateway/src/hub/uplink-server.test.ts` |
| 2966 | `packages/ghostty-terminal/src/terminal.canvas.test.ts` |
| 2475 | `apps/gateway/src/mesh/uplink-client.test.ts` |
| 2340 | `apps/gateway/src/hub/hub-runtime.test.ts` |
| 2328 | `apps/gateway/src/mesh/uplink-pool.test.ts` |
| 2320 | `apps/gateway/src/mesh/mesh-routes.test.ts` |
| 2129 | `apps/gateway/src/tmux-client/local-external-connection.test.ts` |
| 1994 | `apps/gateway/src/mesh/mesh-runtime.test.ts` |
| 1980 | `apps/gateway/src/tunnel/manager.test.ts` |
| 1969 | `apps/fe/src/pages/settings/remote-access/remote-access-tab.test.tsx` |
| 1969 | `apps/gateway/src/mesh/forwarder.test.ts` |
| 1967 | `apps/gateway/src/ws/index.test.ts` |
| 1878 | `apps/fe/.../management/nodes-management.test.tsx` |

**必须注意**：`peer-manager.test.ts`（3754 行）与 `auth-routes.test.ts`（3677 行）是 §4 任务 A / 任务 C 的验收基座——它们是重构的安全网，不要在同一轮里同时动测试和实现。若产品文件按计划拆分，**测试文件保持原名不动**，只补 import（新模块从原文件 re-export，或测试直接 import 新模块）。

---

## 3. 重复度普查

### 3.1 双份熔断器：`RtcDialBreaker` vs `DirectDialBreaker` —— **可统一（高价值）**

- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:113` `class RtcDialBreaker`
- `packages/ws-client/src/direct/direct-dial-breaker.ts:58` `class DirectDialBreaker`

同构证据：
- 常量四件套完全一致：`rtc-dial-breaker.ts:3-7`（3 / 30_000 / 30min / 60_000）对 `direct-dial-breaker.ts:1-4`（同值）。
- `PeerState` 形状：`rtc-dial-breaker.ts:47-59` 比 `direct-dial-breaker.ts:22-30` 多 3 个字段（`lastFailureAt`、`activeAttempt`、`establishedAttempt`）。
- 方法逐个对应且实现几乎逐字相同：`shouldTry`（`rtc:148` / `direct:74`）、`snapshot`（`rtc:167` / `direct:88`）、`beginAttempt`（`rtc:178` / `direct:99`）、`forceProbe`（`rtc:184` / `direct:105`）、`noteFailure`（`rtc:188` / `direct:109`）、`noteChannelEstablished`（`rtc:224` / `direct:126`）、`noteHealthy`（`rtc:232` / `direct:132`）、`reset`（`rtc:263` / `direct:154`）、`ensure`（`rtc:268` / `direct:159`）、`maxLevel`（`rtc:293` / `direct:172`，**逐字相同**）、指数退避公式（`rtc:288` / `direct:120`，等价）。

真正的分歧（全部可参数化）：
1. rtc 版有 `onTrip`/`onReset` 回调（`rtc-dial-breaker.ts:135-145`）与 `RtcDialFailureResult` 结构化返回；direct 版返回 `boolean`。
2. direct 版有 `SKIP_KINDS` 前置过滤（`direct-dial-breaker.ts:45,110`）；rtc 版没有。
3. rtc 版有 `notePeerChanged`（`rtc-dial-breaker.ts:253`）与若干 `@deprecated` 兼容别名（`rtc-dial-breaker.ts:9,161,259`）。
4. direct 版多一个 `remainingCooldownMs`（`direct-dial-breaker.ts:148`）。

结论：**分歧不是承载语义的**，全是包装层差异。建议抽 `packages/shared/src/net/dial-breaker.ts`（纯逻辑、浏览器安全、不碰 `node:*`），两侧各留一个薄包装保留现有对外签名与 `@deprecated` 别名。两个 spec（`apps/gateway/src/mesh/rtc/rtc-dial-breaker.test.ts`、`packages/ws-client/src/direct/direct-dial-breaker.test.ts`）原样跑通即为验收。

### 3.2 三份拨号失败分类器 —— **分歧承载语义，不统一**

- `apps/gateway/src/mesh/peer-ws-race.ts:108` `classifyWsDialFailure`（CC35）：入参是 `unknown` 错误对象，读 `err.code` errno（`peer-ws-race.ts:98` `errorErrno`）+ `instanceof PeerHandshakeError`（`peer-ws-race.ts:116`），输出 `WsDialError`（带 `url`），词表接 `ReachabilityFailureKind`（`peer-endpoint-backoff.ts:8`）用于**端点级退避**。
- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:89` `classifyRtcDialFailure`（CC21）：入参是**字符串 reason**，输出诊断标签（`liveness-timeout`/`missed-pong`/`ice`/…），只用于日志与 `lastFailureKind` 展示。
- `packages/ws-client/src/direct/direct-dial-breaker.ts:42` `classifyDirectDialFailure`（CC16）：入参字符串，**输出可为 `null`**（`direct-dial-breaker.ts:44,45`：`signaling not ready` / `no_connection` 表示「不计入失败」）——语义与前两者相反。

三者的输入类型、输出类型、下游消费方（退避表 / 诊断展示 / 计数门）都不同，交集只有「按子串排序匹配」这个形状。强行统一成一张规则表会把**三套优先级顺序**压进同一个抽象，恰是第三轮／第六轮拒绝的做法。**RETAIN，入册 allowlist**；只把 `errorErrno` 之类的取值助手保持在各自文件内即可。

### 3.3 `readBodyCapped` / JSON body 读取 —— **逐字重复，必须统一**

- `apps/gateway/src/api/http.ts:41` `readBodyCapped` + `apps/gateway/src/api/http.ts:23` `readJsonObjectBody`
- `packages/app/src/runtime/http.ts:42` `readBodyCapped` + `packages/app/src/runtime/http.ts:25` `readJsonBody`

两份 `readBodyCapped` **逐字相同**（32 行，含 content-length 预检、逐块累计、超限 `reader.cancel()`、单块快路径、多块拼接）；两份 JSON 解析包装也只有函数名不同（`apps/gateway/src/api/http.ts:23-38` vs `packages/app/src/runtime/http.ts:25-39`）。`JSON_BODY_MAX_BYTES = 1024*1024` 也各写一份（`apps/gateway/src/api/http.ts:21` / `packages/app/src/runtime/http.ts:22`）。

统一去处：`packages/shared`（只用 Web `Request`/`ReadableStream`，浏览器侧无害，不触发 `node:fs externalized` 问题）。两侧保留原导出名做 re-export，调用点零改动。**这是一处真实的安全边界重复**——上传体积上限的实现分两份，改一处漏一处就是缺口。

### 3.4 候选/上行合并逻辑 —— **已统一，只剩一处局部重复**

`mergeUplinkCandidates`（`apps/gateway/src/mesh/uplink-pool.ts:245`）、`orderCandidatesByNearest`（`:330`）、`recordsFromNodeList`（`:375`）都是单实现，被 `mesh-runtime.ts:1126`、`uplink-pool.ts:545/985/1214`、`mesh/index.ts:84` 共用——**不重复**。

唯一的局部重复是 `apps/gateway/src/mesh/uplink-pool.ts:982` `refreshAttachedFromList` 与 `:993` `refreshAttachedFromCandidates`：两者末尾三行赋值（`hubNodeId`/`mode`/`writerEpoch`）逐字相同，只是候选来源不同。合并为一个私有 `applyAttachedMatch(match)` 即可（-8 行，零风险）。

另外 hub 记录落库存在三处调用点、过滤条件各不相同：`mesh-runtime.ts:994`（叠加 `meshHubNotRetired` 过滤）、`uplink-pool.ts:985`、`uplink-pool.ts:1214`（只取 online 投影）。**分歧是承载语义的**（退网 hub 不许回写、快照视图不落库），不要统一。

### 3.5 退避/抖动助手 —— **部分重复，低价值**

- 抖动：`apps/gateway/src/mesh/uplink-pool.ts:239` `jitteredIntervalMs` 已被 `hub-peer-poller.ts:139` 复用（**好**）；但 `apps/gateway/src/mesh/ctl.ts:95` 另写了一份 `0.5 + Math.random()*0.5` 的指数退避抖动。
- 指数退避封顶公式在四处独立出现：`ctl.ts:95`、`peer-endpoint-backoff.ts:105` `delayMs`、`rtc-dial-breaker.ts:288` `cooldownMs`、`direct-dial-breaker.ts:120`。后两处由 §3.1 统一；`ctl.ts` 与 `peer-endpoint-backoff.ts` 的常量与语义（重连节奏 vs 端点黑名单）不同，**保留**。

### 3.6 hub 角色切换的 run/resume 对称路径 —— **分歧承载语义**

`apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts:706` `runHubRoleSwitch` 与 `:843` `resumeHubRoleSwitch`（CC15）走同一串阶段（admit→demote→promote→wait），但 resume 版要从 `loadHubRoleSwitch`（`:791`）读回 phase 并**跳过已完成阶段**。共享部分已经抽成 `promoteHub:616`、`switchWriter:650`、`awaitHubRoleSwitch:531`、`guardHubRoleRun:457`。剩下的差异就是「从哪一阶段起跑」，再抽只会造出一个带 `startPhase` 参数的分支怪物。**RETAIN**。

### 3.7 `referenceApply` 测试参考实现 —— **逐字重复，建议共享**

`packages/shared/bench/legacy-snapshot-diff.bench.ts:18` 与 `packages/shared/src/ws-borsh/legacy-snapshot-draft.test.ts:25` 是同一份 75 行 CC24 参考实现。抽到 `packages/shared/src/ws-borsh/test-fakes.ts`（或 bench 侧 import 测试模块）即可。**非门禁项，顺手做**。

### 3.8 gateway 与 app 之间的 auth/session 助手 —— **未重复**

排查结论：`packages/app` 不自建会话校验，`assembleTmex` 通过 `createRouteAuthenticate(...)` 把 gateway 的实现注入 `LocalRouteDeps.authenticate`（`packages/app/src/runtime/assemble.ts:766`），`handleLocalRequest` 只消费（`packages/app/src/runtime/local-routes.ts:74`）。`clientIpFromRequest` 也是单点（`apps/gateway/src/mesh/client-ip.ts:25`，被 `auth-routes.ts:331/977`、`forwarder.ts:606` 共用）。**无需处理**。

### 3.9 零散小助手 —— **不值得统一**

`errMsg`/`errMessage`/`errorMessage` 六份（`apps/fe/src/node/hub-load-coordinator.ts:90`、`apps/gateway/src/mesh/uplink-pool.ts:1553`、`apps/gateway/src/mesh/uplink-key-log-sync.ts:666`、`apps/gateway/src/mesh/uplink-client.ts:768`、`packages/app/src/tls/acme-service.ts:94`、`packages/app/src/tls/tls-service.ts:134`），以及 `quiet`（`apps/gateway/src/mesh/peer-ws-race.ts:174`）/`quietly`（`packages/ws-client/src/direct/direct-carrier-controller.ts:199`）/`tryStop`（`packages/app/src/runtime/assemble.ts:182`）。各 3–5 行、跨包边界、语义微差（有的 trim、有的截断）。跨包共享的收益小于新增依赖边的成本，**RETAIN**。

---

## 4. 并行任务拆分（7 个任务，文件集严格不相交）

统一前提：同一个 worktree、按文件范围隔离；每个任务**只允许改自己列出的文件 + 自己新建的文件**；`scripts/complexity/allowlist.json` 由指挥官在全部任务合入后统一跑 `bun scripts/complexity/gate.ts --tighten` 一次（见 §5），**任务内不得手改 allowlist**。

通用验收：`bun run --filter <涉及包> test` 相对基线只增不减；`bunx tsc --noEmit` 错误数不高于基线（gateway 21 / stores 1 / api-client 5 / app 1）；`biome check .` 通过。

---

### 任务 A：peer-manager 拆两个协作者（L）
**文件**：`apps/gateway/src/mesh/peer-manager.ts`（唯一可改的既有文件）；新建 `apps/gateway/src/mesh/peer-dc-upgrade.ts`、`apps/gateway/src/mesh/peer-rtc-wake.ts`。

**缝**（`PeerManager` 字段自成闭包，`peer-manager.ts:261-338` 已给出全部状态）：
1. `DcUpgradeCoordinator` ← `upgradeGate` / `dcUpgradeRetry` / `dcBreaker` / `dcHealth` / `dcAttemptSeq` / `upgradeInflight` / `upgradeWaiters` / `upgradeScan`（字段定义 `peer-manager.ts:312-331`），方法 `wantsUpgrade:739`、`ensureGate:748`、`noteUpgradeResult:757`、`scheduleCoalescedUpgrade:771`、`acquireUpgradeSlot:790`、`releaseUpgradeSlot:816`、`maybeUpgrade:822`、`queueUpgrade:846`、`runUpgradeDial:864`、`cancelDcUpgradeRetry:1006`、`nextDcAttemptId:1014`、`cancelDcHealthTimer:1019`、`armDcHealthTimer:1026`、`dcUpgradeRetryDelayMs:1050`、`armDcUpgradeRetry:1056`、`scheduleDcBreakerProbe:1125`（约 450 行）。注入端口：`{ scheduler, live: () => Map, dialDc, shouldTryDc, dcCapable, emitLinkInfo, log }`。
2. `RtcWakeGate` ← `wakeGate` / `incomingWakeGate` / `rtcWakeNonces`（`peer-manager.ts:313-315`），方法 `handleIncomingRtcWake:892`、`acceptSignedRtcWake:928`、`rememberRtcWakeNonce:954`、`pruneRtcWakeNonces:968`、`ensureIncomingWakeGate:975`、`consumeWakeVerifyToken:988`、`ensureWakeGate:1190`、`abortDeferredRtcWakes:1199`、`disarmDeferredRtcWake:1205`、`armDeferredRtcWake:1210`、`releaseRtcWakeAttempt:1232`、`dispatchRtcWake:1239`（约 200 行）。注入端口：`{ identity, userStore, scheduler, sendRtcSignal, dcCapable, maybeUpgrade, stopSignal }`。

**行为不变的保证**：全部是 `private` 方法，无外部调用点；`PeerManager` 保留同名 `private` 转发（一行）供内部调用不变；`stop()`（`peer-manager.ts:414`）里补两个协作者的 `dispose()`。

**验收**：`apps/gateway/src/mesh/peer-manager.test.ts`（3754 行）与 `peer-manager.upgrade.test.ts`（1009 行）零改动全绿；`apps/gateway/src/mesh/integration/*.integration.test.ts` 全绿；`peer-manager.ts` ≤ 1950 行（门禁条目从 2299 收到 ≤1950）。

---

### 任务 B：mesh-runtime 节点列表投影（M）
**文件**：`apps/gateway/src/mesh/mesh-runtime.ts`；新建 `apps/gateway/src/mesh/node-list-apply.ts`。

**缝**（`mesh-runtime.ts:984` `handleUplinkNodeList`，CC21 / 79 行）：
1. `reconcileHubStoreFromNodeList(d, list)` ← `mesh-runtime.ts:988-1001`（source 退网判定 + `replaceAll` + 二次清理）。
2. `emitListedNodeEvents(d, list, reach, rejectPeer)` ← 内层 `emitListed` 闭包（`:1008-1027`）+ 遍历（`:1046-1050`）。
3. `emitUnlistedHubEvents(d, list, reach)` ← 内层 `emitHubIfUnlisted`（`:1028-1045`）+ 分派（`:1057-1060`）。
`pruneStaleListedPeers`（`:1064`）一并搬过去。

**行为不变的保证**：三个函数都是纯 `d` 驱动、无新状态；`reach` 由调用方一次算好后透传（保持只调一次 `listReach()` 的现状，`:1002`）。

**验收**：`apps/gateway/src/mesh/mesh-runtime.test.ts`（1994 行）+ `mesh-runtime-node-presence.test.ts` 全绿；`handleUplinkNodeList` CC ≤ 10；`mesh-runtime.ts` ≤ 1560 行（门禁 1634 → 1560）。

---

### 任务 C：auth-routes 拆 key-log 子域 + handleLogin（M）
**文件**：`apps/gateway/src/mesh/auth-routes.ts`；新建 `apps/gateway/src/mesh/auth-key-log-routes.ts`。

**缝一（文件行数）**：`AuthRoutes` 里 key-log 与 hub 同步是一个完整子域，与登录/passkey/TOTP 正交：`handleKeyLogHead:512`、`handleKeyLog:542`、`usesHubSync:590`、`handleKeyLogHubSync:595`、`previewKeyLog:631`、`syncToHub:664`、`safePublishAndAck:690`、`hubAlreadyHasRecord:707`、`identicalAppliedRecord:725`、`keyLogSuccess:743`、`refuseUnsupportedHubAuthRecord:767`、`authorizedHubRows:787`、`refuseIfAttachedNotWriter:794`、`hubNotWriterResponse:811`、`resolveHub:822`（约 300 行）。抽成 `AuthKeyLogRoutes` 协作者，`AuthRoutes` 构造时组合，`handle`（`:218`）里的路由分派保持原样调新对象。

**缝二（`handleLogin` CC21，`:329-395`）**：
1. `fail` 闭包 + 前置限流（`:330-345`）→ `createLoginFailureSink(deps, { peer, ip })`，返回 `{ uidHint 更新, fail(code, status) }`。
2. 第二因子链（`:381-392`：`checkTotp` + `checkPasskeySecondFactor`）→ `verifySecondFactors(...)`，返回 `{ ok } | { ok:false, code }`。

**行为不变的保证**：错误码与限流打点的**顺序**必须逐字保留（`TOTP_REQUIRED`/`PASSKEY_REQUIRED` 不记失败，`:336`）——这是 1.1.18 登录模糊化的安全语义，抽取只搬不改。

**验收**：`apps/gateway/src/mesh/auth-routes.test.ts`（3677 行）零改动全绿（如需新增 import 走 re-export）；`auth-login-limiter.test.ts`、`auth-totp-record.test.ts` 全绿；`auth-routes.ts` ≤ 800 行（可从 allowlist 删除 fileLines 条目）；`handleLogin` CC ≤ 12。

---

### 任务 D：拨号熔断器统一 + peer-ws-race 拨号预算（M）
**文件**：`apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts`、`packages/ws-client/src/direct/direct-dial-breaker.ts`、`apps/gateway/src/mesh/peer-ws-race.ts`；新建 `packages/shared/src/net/dial-breaker.ts`（+ 在 `packages/shared` 对应 index 导出）。

1. **统一熔断器**（§3.1）：共享类带选项 `{ skipKinds?, onTrip?, onReset?, trackAttempts? }`；rtc/direct 各留薄包装保持现有导出名、`@deprecated` 别名（`rtc-dial-breaker.ts:9,161,259`）与返回类型。
2. **`dialWsSecureCandidate` CC22**（`peer-ws-race.ts:342-424`）：抽 `createDialBudget(signal, totalMs)` → `{ combined, budgetExpired(), connectTimeoutMs(base), handshakeTimeoutMs(elapsed), dispose() }`（覆盖 `:358-368`、`:375-378`、`:390-392`），再抽 `handshakeOrClose(ws, opts, combined)`（`:393-419` 的 try/catch 清理）。
3. **入册（不改代码）**：`classifyWsDialFailure`、`classifyRtcDialFailure`、`classifyDirectDialFailure` 只加 allowlist 理由，代码不动（§3.2）。

**验收**：`apps/gateway/src/mesh/rtc/rtc-dial-breaker.test.ts`、`packages/ws-client/src/direct/direct-dial-breaker.test.ts`、`apps/gateway/src/mesh/peer-ws-race*.test.ts`、`peer-direct-attempt.test.ts` 全绿；`dialWsSecureCandidate` CC ≤ 12；新增 `packages/shared` 侧共享实现的直测。
**注意**：`packages/shared/src/net/dial-breaker.ts` 必须是纯逻辑，禁止 `node:*` import（会进前端 bundle）。

---

### 任务 E：app 装配根 + TLS/ACME（M）
**文件**：`packages/app/src/runtime/assemble.ts`、`packages/app/src/tls/tls-service.ts`；新建 `packages/app/src/runtime/assemble-routes.ts`、`packages/app/src/tls/acme-dns-patch.ts`。

1. **`assembleTmex` CC21 / 173 行**（`assemble.ts:672-844`）：
   - `buildLocalRouteDeps(...)` ← `:736-781`（`routeDeps` 对象，45 行）→ `assemble-routes.ts`。
   - `buildHttpAndWs(...)` ← `:783-796`（`createHttpDispatch` 数组 + `routeWebsocket`）。
   - `wireTlsLifecycle(...)` ← `:797-822`（`invalidateTlsCaches`/`refreshMeshTls`/`buildTlsLifecycle`/`setHealthzTlsProvider`）。
   - `createAssembledLifecycle(...)` ← `:825-843`（`start`/`stop`/`setProcessShutdown`/`isRestartRequested`）。
2. **`resolveAcmeDnsPatch` CC33**（`tls-service.ts:678-757`）：拆三个纯函数进 `acme-dns-patch.ts`——`resolveRequestedProvider(input, current)`（`:690-694`）、`resolveIncomingCredentials(input, legacyToken)`（`:707-725`）、`resolveStoredFallback(input, current, requestedProvider, usedNewFields)`（`:740-756`）。**硬约束：`dns_provider_required` / `dns_credentials_required` / `cloudflare_token_required` 三个错误码的抛出顺序逐字不变**（第十九轮 DNSPod dns-01 的兼容语义）。
3. **`doRunAcme` CC16**（`tls-service.ts:478-569`）：抽 `tryReuseValidCert(row, secrets, reason, epoch, tuple): Promise<boolean>` ← `:491-513`，命中即 return。

**验收**：`packages/app/src/runtime/assemble.test.ts`（1843 行）、`packages/app/src/tls/tls-service.test.ts`（769 行）全绿；`assembleTmex` ≤ 120 行且 CC ≤ 15（可从 allowlist 删条目）；`resolveAcmeDnsPatch` CC ≤ 12；`doRunAcme` CC ≤ 12。

---

### 任务 F：ws-client 直连控制器 + gateway ws 门面（M）
**文件**：`packages/ws-client/src/direct/direct-carrier-controller.ts`、`apps/gateway/src/ws/index.ts`；新建 `packages/ws-client/src/direct/direct-diagnostics.ts`、`apps/gateway/src/ws/tmux-command-facade.ts`。

1. **`publish` CC18**（`direct-carrier-controller.ts:1055-1085`）：CC 全在那个九字段比较的 `if`（`:1070-1081`）。抽纯函数 `sameDirectDiagnostics(prev, next)` 到 `direct-diagnostics.ts`（连同已有的 `sameIce`，`:1187`），`publish` CC 降到 ~5。顺带把 `DirectDiagnostics` 构造（`:1058-1068`）抽成 `buildDirectDiagnostics(state, ...)`，文件行数从 1198 降到 ~1130（回到锁值 1118 附近）。
2. **`ws/index.ts` 941 行**：`:705-940` 共约 235 行是**纯一行委派**（`tmuxCommands.handleTmuxSelect(this, ...)` 等，见 `ws/index.ts:727-733`、`:867-881`；以及 `this.feed.*` / `this.overlays.*` / `this.registry.*`，见 `:883-893`）。把 `tmuxCommands.*` 那一组（`:727-882`，约 155 行）搬到 `tmux-command-facade.ts` 定义为基类 `WebSocketServerTmuxFacade`，`WebSocketServer` 改为 `extends` 它。**零调用点改动、零签名改动**，文件降到 ~790 行。

**验收**：`packages/ws-client/src/direct/direct-carrier-controller.test.ts`（1102 行）全绿；`apps/gateway/src/ws/index.test.ts`（1967 行）+ `tmux-command-handlers.test.ts` 全绿；`ws/index.ts` < 900（不入 allowlist）。

---

### 任务 G：前端设置页三处（S）
**文件**：`apps/fe/src/pages/settings/use-site-settings-form.ts`、`apps/fe/src/pages/settings/nodes/management/node-detail-dialog.tsx`、`apps/fe/src/pages/settings/nodes/https/acme-panel.tsx`；新建 `apps/fe/src/pages/settings/use-site-settings-save.ts`、`apps/fe/src/pages/settings/nodes/management/use-node-detail-state.ts`、`apps/fe/src/pages/settings/nodes/https/acme-dns-fields.tsx`。

1. **`useSiteSettingsForm` 151 行 / CC2**（`use-site-settings-form.ts:74-224`）：把 `saveMutation`（`:148-208`，60 行，含 rename→PATCH→`onSettled` 回流三段）抽成 `useSiteSettingsSave({ plan, hubApi, linkage, languagePreview, draft, applySettings, refreshSettings, refreshHub, setPinnedName })`。宿主降到 ~95 行。
2. **`NodeDetailDialog` 122 行**（`node-detail-dialog.tsx:406-527`）：把 `state`/`patch`/`latest` ref/加载 effect（`:416-455`）+ `save`（`:459-473`）+ `onAllowedChange`（`:475-479`）抽成 `useNodeDetailState(row, open, { io, rename, writerPublicUrl, onChanged, onOpenChange })`，组件只剩 JSX（~75 行）。**注意保留 `biome-ignore lint/correctness/useExhaustiveDependencies` 与 `rowId` 触发器语义**（`:429-431`），这是「轮询换 row 不许冲掉草稿」的既有修复。
3. **`AcmePanel` 255 行 / CC14**（`acme-panel.tsx:53-307`）：把 DNS provider / 凭证字段那一段抽成 `AcmeDnsFields`（消费 `storedProvider:31`、`hasStoredCredentials:36`），宿主 ≤ 180 行。

**验收**：`apps/fe/src/pages/settings/site-settings-form.test.ts`、`use-node-rename-channel.test.tsx`、`nodes/https/https-section.test.tsx`、`tls-form.test.ts`、`nodes/management/nodes-management.test.tsx`（1878 行）全绿；三个函数均 ≤ 120 行。

---

### 可选任务 H（若人手够）：跨包 HTTP body 助手统一 + 零散重复（S）
**文件**：`apps/gateway/src/api/http.ts`、`packages/app/src/runtime/http.ts`、`apps/gateway/src/mesh/uplink-pool.ts`（仅 `:982-1004` 两个方法）、`packages/shared/bench/legacy-snapshot-diff.bench.ts`、`packages/shared/src/ws-borsh/legacy-snapshot-draft.test.ts`；新建 `packages/shared/src/http/read-body.ts`。

- §3.3 `readBodyCapped`/`JSON_BODY_MAX_BYTES` 统一；两侧保留原导出名 re-export（调用点零改动）。
- §3.4 `refreshAttachedFromList`/`refreshAttachedFromCandidates` 合并末尾赋值。
- §3.7 `referenceApply` 抽共享 fixture。

**验收**：`apps/gateway/src/api/*.test.ts`、`packages/app/src/runtime/local-routes.test.ts`、`packages/shared/src/ws-borsh/*.test.ts` 全绿；`uplink-pool.ts` 行数不升。
**冲突提示**：H 与 D 都碰 `packages/shared`，但文件不同（`shared/src/http/` vs `shared/src/net/`）；若两者的 index 导出在同一个文件，请由 D 先合入、H 后合入。

---

### 文件占用矩阵（确认零重叠）

| 任务 | 独占既有文件 |
|---|---|
| A | `mesh/peer-manager.ts` |
| B | `mesh/mesh-runtime.ts` |
| C | `mesh/auth-routes.ts` |
| D | `mesh/rtc/rtc-dial-breaker.ts`、`mesh/peer-ws-race.ts`、`ws-client/direct/direct-dial-breaker.ts` |
| E | `app/runtime/assemble.ts`、`app/tls/tls-service.ts` |
| F | `ws-client/direct/direct-carrier-controller.ts`、`gateway/ws/index.ts` |
| G | fe 设置页三文件 |
| H | `gateway/api/http.ts`、`app/runtime/http.ts`、`mesh/uplink-pool.ts`、两个 shared 测试/bench |

无交集。A/B/C/D 都在 `apps/gateway/src/mesh/` 目录下但文件互不相同；D 碰的 `peer-ws-race.ts` 被 A 的 `peer-manager.ts` **import**（`peer-manager.ts` 用 `dialWsSecureCandidate`），但 D 承诺不改其导出签名，因此可并行。

---

## 5. allowlist 策略建议

### 5.1 原则

第六轮定的语义是「有意保留的热点入册并锁当前值，只许变好」。三轮下来的问题是：**入册理由被大量复制成同一句「内聚顺序逻辑，拆分只增行」**（151 条里约 60 条），已经失去判别力。建议本轮加两条约束：

1. **新入册必须写清「为什么这个形状是对的」**，而不是「拆了会变长」。可接受的理由类型仅限第三轮那四类：扁平协议分派 / 语法即分支的 parser / 逐字段回退链 / 纯条件 JSX；外加「装配根」「FFI 所有权边界」「背压泵状态机（已试拆并回退）」。
2. **文件级 `fileLines` 条目视为债务而非豁免**：每条要写上「什么条件下会被拆掉」。本轮有 12 条 `fileLines`，建议把 `auth-routes.ts`、`mesh-runtime.ts`、`peer-manager.ts`、`direct-carrier-controller.ts` 四条按 §4 拆掉（其中 `auth-routes.ts` 可直接删除条目）。

### 5.2 24 条违规的处置分配

**走重构（16 条）**：#3、#5、#6（任务 G）；#7、#9（任务 B）；#10、#11（任务 C）；#14（任务 D）；#15（任务 A）；#16、#22、#23（任务 F）；#17、#18、#19、#20（任务 E）。

**重锁/新入册（8 条）**，理由必须按 §5.1 重写：
- #1 `TotpSection` 191、#2 `PasskeySection` 166、#4 `NodesManagement` 250：纯条件 JSX + 单一职责表单区，1.1.16/1.1.18/1.1.20 的 passkey/TOTP 增量把它们推过锁值。**重锁到实测值**，不改代码。
- #8 `createMeshStoresAndServices` 137：装配根，第六轮已按职责拆过一次，**重锁 137**。
- #12 `classifyRtcDialFailure` CC21、#13 `classifyWsDialFailure` CC35、#24 `classifyDirectDialFailure` CC16：**新入册**，理由「拨号失败分类扁平分派：分支顺序即优先级，三者输入/输出/下游各异（§3.2），表驱动会掩盖优先级」，与既有 `ws/error-classify.ts:classifySshError` 条目同类。
- #21 `createTmuxStore` 333：二选一。推荐**做**（把 `connect/disconnect/reorder` 抽成 `tmux-device-actions.ts`，与已有 `tmux-selection-actions.ts`/`tmux-viewport-actions.ts` 同构，`packages/stores/src/tmux.ts:33`），一致性收益明显；若人手不够则重锁 333。

### 5.3 顺手收紧（`--tighten` 会自动完成，无需人工）

实测已低于锁值、`--tighten` 一跑即收敛的条目（抽样）：`api/tunnel-routes.ts:parseAction` 40→30、`tunnel/manager.ts:handleAction` 23→18、`hub/uplink-server.ts:handleKeyLogAppend` 23→22、`nodes-table.tsx:NodeRowView` 21/127→19/123、`mesh/uplink-pool.ts` 1647→1597、`mesh/forwarder.ts` 995→964、`tunnel/manager.ts` 1428→1425、`hub/hub-runtime.ts` 1399→1386、`commands/hub.ts` 1349→1313。

**流程建议**：所有任务合入后由指挥官跑一次 `bun scripts/complexity/gate.ts --tighten`，再人工补写新入册条目的理由字段（`--tighten` 保留 reason 原文，新条目要手写）。任务内不得改 allowlist，避免七个 agent 在同一个 JSON 上打架。

### 5.4 门禁本身的两个盲区（本轮不改，记账）

1. `SKIP_DIRS` 含 `scripts`（`scripts/complexity/gate.ts:12`），导致 `apps/gateway/scripts/run-managed-smoke.ts:76` `main`（CC20 / 210 行）等运维脚本完全不受约束。第三轮已判定「dev scripts 不动」，**维持**，但注意 `apps/gateway/scripts/` 里已有 300+ 行的托管产物扫描逻辑，若继续长大应考虑移入 `src/` 并入门禁。
2. 测试文件完全不受约束（`scripts/complexity/gate.ts:23`），已出现 3754 行的 `peer-manager.test.ts`。**维持不管**（拆测试会损失定位性），但可以考虑给测试单独加一条「>4000 行报警」的软提示。
