# EX4：第二十二轮 code smell backlog

只读探索产出。worktree `/Users/konata/code/tmex-r22`，分支 `feat/round22-perf-tui-color-smell`，base = `main` @ `c462f3bd`（1.1.21 已发）。

## 0. 一句话结论

**门禁已经全绿，`--tighten` 一条也收不动 —— 指标驱动的 backlog 本轮枯竭了。**

- `bun scripts/complexity/gate.ts` → `complexity gate ok (1243 files, 11642 functions)`，**0 违规 / 0 stale**。
- allowlist 145 条，按 gate.ts 的 `--tighten` 算法逐条复算：**可收紧 0 条、可整条删除 0 条、stale 0 条**。第二十一轮收尾时已经跑过一次，之后没有新代码把任何锁值推低。
- CC top-40 与函数行数 top-40 **每一条都在 allowlist 里**。也就是说，继续按 CC / 行数找活会 100% 撞上历轮已裁决"保留"的条目。

因此本轮 smell 的价值只能来自另外三处，本报告的重心也放在这里：

1. **逼近门禁的文件**（899/898/897/893/888 行，离 900 线只差 1–12 行）—— 第二十二轮要动终端颜色和性能，一改就爆门禁；
2. **重复**（本轮用自建 AST + 5-gram Jaccard 克隆检测，跑出 135 对生产代码近似重复，其中 6 对逐字相同）；
3. **结构**（8 个循环依赖、god module、跨层反向依赖）。

---

## 1. 新鲜指标

口径：`scripts/complexity/gate.ts` 同一套 walk / McCabe / 命名规则（`LIMITS = { cc:15, fnLines:120, fileLines:900 }`，跳过 `node_modules`/`dist`/`fe-dist`/`resources`/`prompt-archives`/`docs`/`bench`/`scripts`/`vendor`/`tests`、跳过 `*.test.*`/`*.spec.*`/`*.integration.*`/`*.bench.*`/`*.d.ts`、跳过 i18n 生成物）。仅扫 `apps/` 与 `packages/`。

### 1.1 总量

| 指标 | 值 |
|---|---:|
| 源文件数 | 1243 |
| 函数数 | 11642 |
| 源码总行数 | 221 739 |
| CC > 15 的函数 | 66（全部已入册） |
| 函数 > 120 行 | 69（全部已入册） |
| allowlist 条目 | 145 |
| **`--tighten` 可收紧条目** | **0** |
| 门禁违规 | 0 |

对照第二十一轮基线（1207 文件 / 11172 函数 / CC>15 共 72 / >120 行共 74 / allowlist 151→141）：**文件 +36、函数 +470，但超限函数反而 -6/-5**，说明二十一轮的重构确实压住了增量。allowlist 从 141 回到 145，是二十一轮末尾按 §5.2 新入册的 4 条（三个拨号失败分类器 + `dial-breaker` 相关）。

### 1.2 源文件规模分布

| 行数区间 | 文件数 |
|---|---:|
| 0–100 | 579 |
| 100–200 | 321 |
| 200–300 | 157 |
| 300–500 | 109 |
| 500–700 | 31 |
| 700–900 | 28 |
| 900–1200 | 7 |
| 1200–2000 | 10 |
| > 2000 | 1 |

**分布本身健康**（46% 的文件 < 100 行），问题集中在尾巴上的 18 个 >900 行文件，全部已入册。

### 1.3 Top 30 最大源文件

| 行数 | 文件 | allowlist |
|---:|---|---|
| 2261 | `apps/gateway/src/hub/uplink-server.ts` | fileLines=2261 |
| 1930 | `apps/gateway/src/mesh/peer-manager.ts` | fileLines=1930 |
| 1624 | `packages/ghostty-terminal/src/ghostty-wasm.ts` | fileLines=1624 |
| 1597 | `apps/gateway/src/mesh/uplink-pool.ts` | fileLines=1597 |
| 1559 | `apps/gateway/src/mesh/mesh-runtime.ts` | fileLines=1559 |
| 1473 | `packages/shared/src/uplink/codec.ts` | fileLines=1473 |
| 1425 | `apps/gateway/src/tunnel/manager.ts` | fileLines=1425 |
| 1386 | `apps/gateway/src/hub/hub-runtime.ts` | fileLines=1386 |
| 1343 | `apps/fe/.../management/use-hub-role-switch.ts` | fileLines=1343 |
| 1313 | `packages/app/src/commands/hub.ts` | fileLines=1313 |
| 1283 | `apps/fe/.../management/use-node-upgrade.ts` | fileLines=1283 |
| 1114 | `packages/ws-client/src/direct/direct-carrier-controller.ts` | fileLines=1114 |
| 1037 | `apps/gateway/src/system/upgrade.ts` | fileLines=1037 |
| 982 | `apps/gateway/src/mesh/integration/multi-hub-harness.ts` | fileLines=982（测试夹具） |
| 964 | `apps/gateway/src/mesh/forwarder.ts` | fileLines=964 |
| 960 | `apps/gateway/src/auth/user-store.ts` | fileLines=960 |
| 953 | `packages/ghostty-terminal/src/render-state.ts` | fileLines=953 |
| 918 | `apps/gateway/src/tunnel/external-detect.ts` | fileLines=918 |
| **899** | **`packages/app/src/lib/upgrade-apply.ts`** | **无（距门禁 1 行）** |
| **898** | **`apps/gateway/src/mesh/uplink-client.ts`** | **无（距门禁 2 行）** |
| **898** | **`packages/ghostty-terminal/src/canvas-renderer.ts`** | **无（距门禁 2 行）** |
| **893** | **`apps/gateway/src/ws/tmux-command-handlers.ts`** | **无（距门禁 7 行）** |
| **888** | **`packages/ws-client/src/canonical-state-client.ts`** | **无（距门禁 12 行）** |
| 881 | `apps/fe/src/node/enrollment-engine.ts` | 无 |
| 867 | `apps/gateway/src/auth/user-key-service.ts` | 无 |
| 865 | `apps/gateway/src/db/schema.ts` | 无 |
| 863 | `packages/ghostty-terminal/src/terminal.ts` | 无 |
| 853 | `apps/fe/src/node/mesh-nodes.ts` | 无 |
| 837 | `apps/gateway/src/ws/index.ts` | 无 |
| 831 | `apps/fe/src/components/side-panels/account-security-panel.tsx` | 无 |

**这张表最重要的信息是加粗的 5 行**：`upgrade-apply.ts`(899)、`uplink-client.ts`(898)、`canvas-renderer.ts`(897)、`tmux-command-handlers.ts`(893)、`canonical-state-client.ts`(888)。第二十二轮的三个主题（性能、TUI 颜色、精简）全部落在这几个文件的邻域，任何实现动作都会立刻把它们推过 900 行，然后逼迫实现 agent **在赶工时被迫入册 allowlist**——这正是历轮 allowlist 膨胀的机制。**先拆再改** 是本轮最高性价比的动作。

### 1.4 Top 30 最大函数（行数）

全部 40 条实测里 **top 40 无一例外都在 allowlist**。摘录前 20：

| 行数 | CC | 位置 | 名称 |
|---:|---:|---|---|
| 453 | 2 | `apps/fe/.../use-node-upgrade.ts:830` | `useNodeUpgrade` |
| 277 | 1 | `packages/stores/src/tmux.ts:25` | `createTmuxStore` |
| 250 | 18 | `apps/fe/.../nodes-management.tsx:82` | `NodesManagement` |
| 249 | 2 | `apps/fe/.../use-hub-role-switch.ts:1050` | `useHubRoleSwitch` |
| 249 | 9 | `packages/panels/src/settings/weixin-account-login-modal.tsx:47` | `WeixinAccountLoginModal` |
| 240 | 7 | `packages/panels/src/device-folders/device-folder-tree.tsx:329` | `DeviceFolderTree` |
| 238 | 10 | `packages/panels/src/device-tree/sidebar-device-list.tsx:61` | `SideBarDeviceList` |
| 214 | 9 | `packages/terminal-ui/src/components/Terminal.tsx:20` | `<anon>` |
| 211 | 12 | `packages/terminal-ui/src/components/SplitTerminalArea.tsx:45` | `SplitTerminalArea` |
| 208 | 13 | `apps/fe/.../setup/become-hub-form.tsx:54` | `BecomeHubForm` |
| 207 | 8 | `apps/fe/src/pages/LoginPage.tsx:193` | `LoginForm` |
| 206 | 1 | `packages/panels/src/device-console/use-pane-active-follow.ts:20` | `usePaneActiveFollow` |
| 204 | 11 | `packages/panels/src/settings/llm-provider-form-modal.tsx:39` | `LlmProviderFormModal` |
| 201 | 33 | `apps/fe/.../remote-access/status-card.tsx:65` | `TunnelStatusCard` |
| 201 | 9 | `packages/panels/src/settings/search-tab.tsx:27` | `SearchTab` |
| 198 | 7 | `apps/fe/src/pages/devices/use-device-folders.ts:61` | `useDeviceFolders` |
| 198 | 9 | `packages/panels/src/settings/webhooks-tab.tsx:39` | `WebhooksTab` |
| 194 | 1 | `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts:55` | `useKeyboardAvoidance` |
| 191 | 9 | `apps/fe/.../account-security-panel.tsx:469` | `TotpSection` |
| 184 | 13 | `apps/fe/.../membership/use-leave-mesh.ts:90` | `useLeaveMesh` |

**注意 `createTmuxStore` 从 333 行降到 277 行**（第二十一轮拆了 `tmux-device-actions.ts` 109L），锁值已相应更新。剩余 277 行仍是本表第 2 名，但 CC=1，纯装配。

**未入册且逼近 120 行阈值（90–120 行）共 62 个**，前 10：

| 行数 | CC | 位置 |
|---:|---:|---|
| 120 | 2 | `apps/gateway/src/mesh/mesh-runtime.ts:1425 assembleMeshRuntime` |
| 120 | 1 | `packages/stores/src/agent.ts:55 createAgentStore` |
| 119 | 10 | `apps/fe/.../remote-access/remote-access-tab.tsx:51 SelfRemoteAccess` |
| 119 | 1 | `apps/gateway/src/mesh/mesh-runtime.ts:1192 createRtcBrowserWiring` |
| 118 | 11 | `packages/ui/src/components/sidebar/sidebar-layout.tsx:12 Sidebar` |
| 115 | 7 | `apps/fe/.../account-security-panel.tsx:349 PasswordSection` |
| 115 | 9 | `apps/fe/.../https/https-section.tsx:217 HttpsBody` |
| 112 | 9 | `apps/fe/.../remote-access/access-step.tsx:417 RulesEditor` |
| 111 | 10 | `apps/gateway/src/ws/canonical/subscription-coordinator.ts:27 apply` |
| 110 | 8 | `packages/app/src/lib/upgrade-apply.ts:735 executeUpgradeTxn` |

`assembleMeshRuntime` 正好 **120 行 = 阈值**，再加一行就违规。

### 1.5 Top 30 CC 函数（含 allowlist 标记）

| CC | 行 | 位置 | allowlist |
|---:|---:|---|---|
| 76 | 177 | `packages/shared/src/uplink/codec.ts:1247 decodeHubInner` | cc=76 |
| 67 | 181 | `packages/shared/src/uplink/codec.ts:686 decodeMeshUplinkCtl` | cc=67 |
| 55 | 131 | `apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts:41 emitOsc` | cc=55 |
| 49 | 102 | `packages/shared/src/uplink/codec.ts:868 encodeMeshUplinkCtl` | cc=49 |
| 35 | 58 | `apps/gateway/src/mesh/peer-ws-race.ts:108 classifyWsDialFailure` | cc=35 |
| 33 | 201 | `apps/fe/.../remote-access/status-card.tsx:65 TunnelStatusCard` | cc=33 |
| 33 | 86 | `packages/ghostty-terminal/src/ghostty-wasm.ts:1290 encodeMouseEvent` | cc=33 |
| 32 | 103 | `apps/gateway/src/ws/error-classify.ts:1 classifySshError` | cc=32 |
| 32 | 118 | `packages/app/src/lib/args.ts:90 resolveNestedCommand` | cc=32 |
| 30 | 84 | `apps/gateway/src/api/tunnel-routes.ts:104 parseAction` | cc=30 |
| 26 | 38 | `apps/fe/.../remote-access/tunnel-model.ts:247 wizardStepState` | cc=26 |
| 26 | 72 | `apps/gateway/src/tmux-client/control-mode/metadata.ts:14 parse` | cc=26 |
| 26 | 83 | `apps/gateway/src/agent/tools/send-input.ts:76 execute` | cc=26 |
| 26 | 54 | `apps/gateway/src/tunnel/external-detect.ts:395 parseCloudflaredYml` | cc=26 |
| 24 | 87 | `packages/app/src/cli-auth-entry.ts:7 dispatchAuthCli` | cc=24 |
| 24 | 75 | `packages/shared/src/ws-borsh/test-fakes.ts:7 referenceApply` | cc=24 |
| 24 | 55 | `packages/shared/src/uplink/codec.ts:468 parseHubWriteForwardMessage` | cc=24 |
| 23 | 62 | `apps/gateway/src/mesh/forwarder.ts:267 forwardAuthorizedHttp` | cc=23 |
| 23 | 44 | `apps/gateway/src/mesh/peer-manager.ts:1365 handlePeerCtl` | cc=23 |
| 22 | 164 | `apps/gateway/src/mesh/integration/multi-hub-harness.ts:548 enrollAndStart` | cc=22 |
| 22 | 110 | `apps/gateway/src/hub/uplink-server.ts:1536 handleKeyLogAppend` | cc=22 |
| 22 | 79 | `apps/gateway/src/hub/hub-role-routes.ts:108 handlePostHubRole` | cc=22 |
| 21 | 28 | `apps/gateway/src/mesh/rtc/rtc-dial-breaker.ts:55 classifyRtcDialFailure` | cc=21 |
| 21 | 86 | `apps/gateway/src/hub/uplink-server.ts:1944 buildNodeList` | cc=21 |
| 21 | 51 | `apps/gateway/src/hub/hub-authorization.ts:232 applyKeyLogHubRuntime` | cc=21 |
| 21 | 45 | `apps/gateway/src/hub/attachment-router.ts:124 applyFromHub` | cc=21 |
| 21 | 26 | `apps/gateway/src/hub/hub-peer-poller.ts:744 parsePeerStatusBody` | cc=21 |
| 20 | 80 | `apps/gateway/src/tunnel/external-detect.ts:260 enrichCandidate` | cc=20 |
| 20 | 64 | `apps/gateway/src/hub/uplink-server.ts:1216 onCtl` | cc=20 |
| 20 | 51 | `packages/shared/src/link/websocket-link.ts:150 pump` | cc=20 |

**30/30 全部已入册。** `referenceApply` 已按二十一轮建议抽到 `packages/shared/src/ws-borsh/test-fakes.ts`（§3.7 已落地）。

**未入册且逼近 CC=15 阈值的函数共 231 个**，其中 **CC 恰好 =15 的有 39 个**（再加一个 `&&` 就违规）。高危前 10：

| CC | 行 | 位置 |
|---:|---:|---|
| 15 | 98 | `apps/gateway/src/mesh/peer-manager.ts:1000 dialWsSecure` |
| 15 | 90 | `packages/app/src/commands/direct.ts:176 enableDirect` |
| 15 | 86 | `packages/ghostty-terminal/src/terminal-render-coordinator.ts:248 renderNow` |
| 15 | 85 | `apps/gateway/src/mesh/stream-targets.ts:476 acceptWsStream` |
| 15 | 83 | `apps/gateway/src/system/upgrade.ts:590 run` |
| 15 | 80 | `packages/shared/src/auth/key-log.ts:532 applyKeyLogRecord` |
| 15 | 74 | `packages/app/src/commands/init.ts:110 buildInitConfig` |
| 15 | 67 | `apps/gateway/src/mesh/node-list-projection.ts:172 projectMeshListNode` |
| 15 | 66 | `apps/gateway/src/mesh/peer-manager.ts:828 dialDc` |
| 15 | 61 | `packages/ghostty-terminal/src/canvas-renderer.ts:703 drawBlockElement` |

`renderNow`(CC15) 和 `drawBlockElement`(CC15) 都在 round-22 的性能/颜色改动路径上，属于"一改就爆"。

### 1.6 深嵌套（本轮新增指标）

我另外统计了每个函数的最大块嵌套深度。**先说结论：nest ≥ 9 的两条是指标假阳性，不要派活。**

| nest | CC | 行 | 位置 | 判定 |
|---:|---:|---:|---|---|
| 14 | 17 | 21 | `apps/gateway/src/mesh/uplink-client.ts:561 handleCtl` | **假阳性**：`else if` 链，AST 上是嵌套 `if`，实际是扁平协议分派（14 个 `msg.t` 分支，21 行）。与已保留的 `handlePeerCtl` 同类。 |
| 13 | 14 | 29 | `packages/ws-client/src/canonical-state-client.ts:244 handleEvent` | **假阳性**：同上，13 个 `'X' in event` 分支，每支一行转发。 |
| 9 | 23 | 44 | `apps/gateway/src/mesh/peer-manager.ts:1365 handlePeerCtl` | 已入册 |
| 7 | 11 | 15 | `packages/terminal-ui/src/utils/terminalKeySequence.ts:234 escapeForDisplay` | 真嵌套，但 15 行 |
| 6 | 12 | 37 | `apps/gateway/src/mesh/peer-dc-upgrade.ts:428 parseEndpoints` | **真嵌套**，可拆 |
| 6 | 10 | 25 | `apps/gateway/src/ws/canonical-feed-session.ts:135 handleCommand` | 真嵌套 |
| 5 | 12 | 79 | `apps/gateway/src/agent/tools/run-command.ts:231 waitForCommandCompletion` | 真嵌套 |
| 5 | 14 | 65 | `apps/gateway/src/mesh/uplink-pool.ts:790 tryCandidate` | 真嵌套 |
| 5 | 11 | 58 | `packages/ghostty-terminal/src/canvas-renderer.ts:522 drawRowBackground` | 真嵌套，颜色路径 |
| 5 | 20 | 51 | `packages/shared/src/link/websocket-link.ts:150 pump` | 已入册（泵状态机，历轮已试拆并回退） |
| 5 | 16 | 42 | `apps/gateway/src/mesh/link-stream-carrier.ts:95 pump` | 已入册 |
| 5 | 17 | 38 | `apps/gateway/src/mesh/rtc/bulk.ts:315 pumpDownload` | 真嵌套 |
| 5 | 13 | 26 | `apps/gateway/src/mesh/address-class.ts:221 collectLocalNets` | 真嵌套 |

深嵌套整体不严重（最深真嵌套仅 6 层），**不值得为它单独立项**；`drawRowBackground` 顺带在 canvas-renderer 拆分任务里处理即可。

### 1.7 allowlist 收紧分析

逐条按 gate.ts `--tighten` 的算法复算 145 条：

| 结果 | 条数 |
|---|---:|
| 可收紧（实测低于锁值） | **0** |
| 可整条删除（三个字段都回到默认阈值内） | **0** |
| stale（不再匹配任何东西） | **0** |

**本轮跑 `--tighten` 不会产生任何 diff，指挥官不用安排这一步。**

但 allowlist 有一个**未解决的治理问题**（二十一轮 §5.1 提出、未执行）：145 条里 **54 条共用同一句理由** `"内聚顺序逻辑，拆分只增行（S1/S2 报告判定，见 prompt-archives/2026083003-perf-smell-gates-round6）"`。理由字段失去判别力，等于这 54 条实际上处于"无理由豁免"状态。理由分布：

| 条数 | 理由 |
|---:|---|
| 54 | 内聚顺序逻辑，拆分只增行（S1/S2 报告判定，round6） |
| 10 | 协议/编排状态机内聚体，拆分只增行（G8 判定） |
| 5 | 编排 hook 状态机内聚体，拆分只增行（G8 判定） |
| 3 | 共享链路生命周期状态机，S1 判定无干净拆分缝 |
| 3 | 动作状态机与响应契约内聚（S1 判定） |
| 3 | 顺序安全校验，改表会掩盖检查顺序（S2 判定） |
| 3 | 协议扁平分派/编解码，一分支一帧类型（G8 判定） |
| 3 | 协议扁平分派/编解码，表驱动只会掩盖顺序语义（历轮保留） |
| 2×7 + 1×N | 其余逐条具名理由（二十一轮新写的都是具名理由，质量明显更好） |

---

## 2. 新热点（非保留 / 非入册清单里的）

### 2.1 逼近门禁的五个文件（**本轮最高优先级**）

| 文件 | 行数 | 距 900 | 干净的抽取 | 测试 | 风险 |
|---|---:|---:|---|---|---|
| `packages/ghostty-terminal/src/canvas-renderer.ts` | 898 | 2 | 见 §2.2 | `canvas-renderer.{scroll-runs,cursor,layers,vcenter,cursor-settle}.test.ts`（1946 行合计） | 低 |
| `packages/app/src/lib/upgrade-apply.ts` | 899 | 1 | 见 §2.3 | `upgrade-apply*.test.ts` | 中（升级路径） |
| `apps/gateway/src/mesh/uplink-client.ts` | 898 | 2 | 见 §2.4 | `uplink-client.test.ts`(2474L) | 中 |
| `apps/gateway/src/ws/tmux-command-handlers.ts` | 893 | 7 | 见 §2.5 | `ws/index.test.ts`(1993L)、`tmux-command-handlers*.test.ts` | 低 |
| `packages/ws-client/src/canonical-state-client.ts` | 888 | 12 | 见 §2.6 | `canonical-state-client.test.ts`(1602L) | 中 |

### 2.2 `canvas-renderer.ts`（ghostty-terminal / 前端）—— 与本轮 TUI 颜色主题直接相关

`packages/ghostty-terminal/src/canvas-renderer.ts:66-150` 是一组**纯函数颜色/样式判定**，`:152-897` 是单个 `CanvasRenderer` 类（745 行）。

可抽取的两块（都无状态、无 canvas 依赖）：

1. **`canvas-cell-style.ts`**（约 85 行）：`colorKey:66`、`fontVariantIndex:70`、`isBlockElement:94`、`isSpacerCell:98`、`hasVisibleGlyph:102`、`hasDecorations:106`、`cellForegroundColor:111`、`cellBackgroundColor:122`、`blockElementCodepoint:134`。**这就是本轮要改的"颜色决策"逻辑**，抽出来后可以直接单测前景/背景/反显/dim 的取色规则，而不必先造一个 canvas。
2. **`canvas-block-elements.ts`**（约 65 行）：`drawBlockElement:703`（CC15，距阈值 0）+ `drawRowBackground:522` 用到的 block-element 几何。

抽完后 `canvas-renderer.ts` ≈ 750 行，离门禁 150 行余量，`drawBlockElement` 的 CC 也从 15 降下来。
**测试**：`canvas-renderer.vcenter.test.ts`、`.cursor.test.ts`、`.layers.test.ts`、`.scroll-runs.test.ts`、`.cursor-settle.test.ts`、`terminal.canvas.test.ts`(2971L) 原样跑通即验收。
**风险**：低（纯函数外移，无行为变化）。**角色**：ghostty-terminal（前端）。

### 2.3 `packages/app/src/lib/upgrade-apply.ts` 899 行（后端 / app）

`executeUpgradeTxn:735`（110 行、CC8）+ `allocateEphemeralPort:192` + 事务前后的备份/回滚编排混在一个文件里。干净的缝：把**端口/进程探测助手**（`allocateEppheralPort:192`，与 `apps/gateway/src/tunnel/spawn.ts:23 pickFreePort` 近似重复，见 §3）与**事务执行器**（`executeUpgradeTxn` 及其回滚步骤）拆成 `upgrade-txn.ts`。
**测试**：`packages/app/src/lib/upgrade-apply.test.ts`、`upgrade-native.test.ts`、`apps/gateway/src/system/upgrade.test.ts`(1300L)。
**风险**：中——这是崩溃安全升级器路径（v1.1.6 引入），历史上写坏 shim 有过演练事故；必须只做**纯搬移**，不改任何顺序。**角色**：后端。

### 2.4 `apps/gateway/src/mesh/uplink-client.ts` 898 行（后端）

`waitSocketOpen:104`（42 行）与 `apps/gateway/src/mesh/peer-ws-race.ts:239 waitSocketOpen`（37 行）近似重复（Jaccard 0.48），两者都是 "WS open/error/timeout 三选一 + 清理监听" 的同一形状。抽 `packages/shared/src/net/wait-socket-open.ts`（浏览器安全，仅用 `WebSocket` 接口）。
另有 `handleCtl:561`（21 行、14 分支扁平分派）—— **不要动**，见 §1.6。
**测试**：`uplink-client.test.ts`(2474L)、`peer-ws-race.test.ts`。**风险**：中（拨号路径）。**角色**：后端。

### 2.5 `apps/gateway/src/ws/tmux-command-handlers.ts` 893 行 / 31 个导出（后端）—— god module

31 个导出天然分三簇，全部按 `TmuxCommandHost` 接口操作，无共享私有状态：

| 簇 | 导出 | 建议去处 |
|---|---|---|
| 选择/定位 | `canSelectWindow:56`、`canSelectPane:77`、`handleTmuxSelect:105`、`handleTmuxSelectWindow:214`、`findWindowForPane:236` | `tmux-selection-handlers.ts`（约 190 行） |
| 视口/尺寸 | `applyTermResizeToEntry:295`、`handleTermResize:323`、`handleTermViewport:345`、`applyViewportPolicy:410`、`reconcileDeviceViewportSnapshot:451`、`dropViewportClaims:545`、`handleResizePaneById:813` | `tmux-viewport-handlers.ts`（约 300 行，注意与已有 `ws/tmux-viewport-handlers.ts` 重名，需另取名如 `tmux-geometry-handlers.ts`） |
| 窗口/pane 结构 | `handleCreateWindow:577`…`handleFocusPane:877`（14 个） | 留在 `tmux-command-handlers.ts`（约 330 行） |

二十一轮已经因为这个文件超 900 而把 `liveWindowGeometry` 挪进 `viewport-policy`（commit `b220286d`），**这次是同一个问题的第二次发作**，说明该做的是彻底分簇而不是再挪一个函数。
**测试**：`apps/gateway/src/ws/index.test.ts`(1993L)、`tmux-command-handlers.viewport.test.ts` 等。**风险**：低（纯导出搬移 + 更新 import）。**角色**：后端。

### 2.6 `packages/ws-client/src/canonical-state-client.ts` 888 行（前端 / ws-client）

`handleEvent:244` 是扁平分派（不动）。真正可抽的是 `updateMetadataIdentity:616`（CC15，距阈值 0）与其周边的 metadata 身份/overlay 逻辑（`applyOverlays` 一族），可成 `canonical-metadata-identity.ts`。
另 `cloneCommand`（`packages/ws-client/src/websocket-transport.ts:69`，31 行）与 `clonePendingCommand`（`canonical-state-helpers.ts:89`，19 行）Jaccard 0.42，是同一份命令深拷贝的两个版本。
**测试**：`canonical-state-client.test.ts`(1602L)。**风险**：中。**角色**：前端（ws-client）。

### 2.7 其他未入册的中型热点

| 文件 | 行数 | 说明 | 角色 |
|---|---:|---|---|
| `apps/fe/src/node/enrollment-engine.ts` + `enrollment.ts` | 881 + 776 | `enrollment.ts` 有 **41 个导出**，是入网流程的 god module；`enrollment-engine.ts` 是状态机。两者边界模糊（engine 里也有协议编解码，见 §3 的 `encodeJoinTokenZeroing` 重复） | 前端 |
| `apps/gateway/src/auth/user-key-service.ts` | 867 | `bootstrapUserWithSelfAdmit:551`(95L) + key-log 投影混在一起；`user-key-persistence.ts:151 projectRecord`(109L) 与之耦合 | 后端 |
| `apps/gateway/src/mesh/stream-replay-state.ts` | 827 | `reconcilePaneCursors:457` CC15 距阈值 0 | 后端 |
| `apps/fe/src/node/mesh-nodes.ts` | 853 | 与 `mesh-hubs.ts`(331) 是同一个轮询 store 的两份实现，见 §3.2 | 前端 |
| `packages/ghostty-terminal/src/terminal.ts` | 863 | 与 `terminal-dom.ts`(600)、`terminal-render-coordinator.ts`(460)、`terminal-input-bridge.ts`(417) 一起构成 terminal 门面；`renderNow` CC15 距阈值 0 | ghostty-terminal |

### 2.8 理由薄弱、存在干净抽取的 allowlist 条目

只挑**理由是那句 54 连发的模板句、且我实际读过代码确认有干净缝**的：

| 条目 | 锁值 | 干净抽取 | 风险 |
|---|---|---|---|
| `packages/stores/src/tmux.ts:createTmuxStore` | lines=277 | 二十一轮已抽 `tmux-device-actions.ts`(109L)，同构地再抽 `tmux-window-actions.ts` 即可回到 ~180 行。与已有 `tmux-selection-actions.ts`(209L)/`tmux-viewport-actions.ts`(68L) 完全一致的模式 | 低 |
| `apps/fe/.../https/acme-panel.tsx:AcmePanel` | lines=171 | 二十一轮已从 255 拆到 171（任务 G），可再抽 `AcmeDnsSection`；但收益已小 | 低 |
| `apps/fe/src/pages/LoginPage.tsx:LoginForm` | lines=207 | 三种登录模式（口令 / passkey / TOTP）的条件渲染混在一个组件里，可抽 `LoginModeSwitch` | 中（登录路径，1.1.8/1.1.9 有过闪断事故） |

**其余 51 条模板理由条目不建议本轮逐个复核**——那是一次独立的治理任务（见 backlog #X1），不应混进功能轮。

---

## 3. 重复度普查

**工具说明**：仓库 `node_modules` 里**没有** `jscpd`/`madge`/`knip`/`ts-prune`（已确认，未联网安装）。改用自建检测器（TypeScript AST 提取 ≥12 行的函数/类 → 去注释去空白规范化 → 逐字哈希比对 + 5-gram token shingle 的 Jaccard 相似度）。

生产代码（排除 `*.test.*`/`*.spec.*`/`tests/`/`*.integration.*`/`*harness*`/`test-support`/`test-fakes`/`*.bench.*`）：**5706 个单元，135 对 Jaccard ≥ 0.40 的跨文件近似对，其中 6 对逐字相同。**

### 3.1 逐字相同（Jaccard = 1.00）—— 必须处理

| 行数 | A | B | 判定 |
|---:|---|---|---|
| 34 | `packages/shared/src/browser-clipboard.ts:4 writeTextToClipboard` | `packages/ghostty-terminal/src/selection-clipboard.ts:59 writeTextToClipboard` | **合并**：ghostty 侧改为 import shared。两侧都有测试 | 
| 22 | `apps/gateway/src/system/upgrade.ts:870 processStartIdentity` | `packages/app/src/lib/upgrade-lock.ts:40 processStartIdentity` | **合并**：升级互斥锁的进程身份判定分两份 = 安全边界重复 |
| 15 | `packages/app/src/commands/hub.ts:267 withAuth` | `packages/app/src/commands/mesh.ts:13 withAuth`（还有第三份 `enroll.ts:90`，Jaccard 0.88，只差一个默认参数） | **合并**：抽 `packages/app/src/commands/with-auth.ts` |
| 13 | `apps/gateway/src/tmux-client/ssh-auth-resolvers.ts:47 defaultRunSync` | `apps/gateway/src/tmux/local-shell-path.ts:70 defaultRunSync` | **合并**：抽 `apps/gateway/src/tmux/run-sync.ts` |
| 12 | `apps/fe/scripts/run-e2e.ts:6 isPortListening` | `apps/fe/playwright.config.ts:44 isPortListening` | 测试基础设施，顺手合并 |
| 12 | `apps/fe/src/node/mesh-hubs.ts:216 requestRefresh` | `apps/fe/src/node/mesh-nodes.ts:578 requestRefresh` | 见 §3.2 |

### 3.2 `mesh-hubs.ts` ↔ `mesh-nodes.ts`：同一个轮询 store 的两份实现（**高价值**）

`apps/fe/src/node/mesh-hubs.ts`(331L) 与 `apps/fe/src/node/mesh-nodes.ts`(852L) 的骨架逐处对应：

| 关注点 | mesh-hubs | mesh-nodes | Jaccard |
|---|---|---|---:|
| `requestRefresh` | `:216` | `:578` | **1.00** |
| `acquireXPolling` | `:261` | `:660` | 0.86 |
| `startPolling` | `:187`(72L) | `:547`(105L, CC13) | 0.52 |
| `refreshX` | `:123`(26L) | `:403`(22L) | 0.52 |
| store 脚手架 | `setState:56` / `getMeshHubsState:61` / `subscribeMeshHubs:65` / `setMeshHubsStateForTest:73` / `resetMeshHubsStateForTest:77` | 同构 | — |
| `browserVisibility` | `:167` | 同构 | — |
| React hook | `useMeshHubs:301` | `useMeshNodes` | — |

抽 `apps/fe/src/node/create-polling-store.ts`：`createPollingStore<TState>({ pollMs, throttleMs, fetch, visibility })` 返回 `{ getState, subscribe, setStateForTest, resetForTest, refresh, requestRefresh, acquirePolling, useStore }`，两侧各留业务投影（`writerHub`/`hubWritesBlocked` 等）。预计消掉 ~160 行。
**测试**：`mesh-hubs.test.ts`(345L) + `mesh-nodes.test.ts`(1075L) 原样跑通即验收。**风险**：中（涉及第十二轮"隐藏页心跳/事件驱动刷新"的节奏语义，抽取时必须保留各自的 `POLL_MS`/`THROTTLE_MS` 与可见性回调）。**角色**：前端。

### 3.3 `readBodyCapped` 的**第三份**仍在（安全边界 / **必须修**）

二十一轮 §3.3 把 gateway 与 app 的两份合到 `packages/shared/src/http/read-body.ts`，并且确实落地了：

```
apps/gateway/src/api/http.ts:4:      } from '../../../../packages/shared/src/http/read-body';
packages/app/src/runtime/http.ts:3:  export { JSON_BODY_MAX_BYTES, readJsonBody } from '.../read-body';
```

**但漏了第三份**：`apps/gateway/src/api/file-transfer-routes.ts:57` 有一份自己的 `readBodyCapped`（29 行，Jaccard 0.44 —— 返回类型是 `{ok:true;bytes}|{ok:false}` 而 shared 版返回 `Uint8Array|null`），用于 `handleUploadChunk:105` 的**分片上传体积上限**。这正是二十一轮点名的那类问题：**上传体积上限的实现分两份，改一处漏一处就是缺口**。
**修法**：给 `packages/shared/src/http/read-body.ts` 加一个 `readBodyCappedResult()`（或让调用点适配 `null` 语义），删掉 `file-transfer-routes.ts` 的副本。
**测试**：`apps/gateway/src/api/file-transfer-routes.test.ts`、`packages/shared/src/http/read-body.test.ts`、`apps/gateway/src/api/http.test.ts`。**风险**：低。**角色**：后端。

### 3.4 base32 / TOTP 加解密跨端两份（安全边界）

| A | B | 说明 |
|---|---|---|
| `apps/fe/src/auth/totp-uri.ts:8 base32Encode`（17L） | `packages/app/src/lib/totp-uri.ts:5 encodeBase32`（17L） | **逐字同算法**（Jaccard 0.94，只有函数名与常量位置不同）。`packages/shared/src/auth/encoding.ts` 已经是共享编码的家（113 个导出），这两份都应该 import 它。注意 `packages/app/src/lib/totp-uri.ts` **没有任何测试**，fe 侧有 `totp-uri.test.ts` |
| `apps/fe/src/auth/account-security-actions.ts:103 rewrapTotpSecret`（39L） | `packages/app/src/lib/hub-user-passwd.ts:34 rewrapTotpForKeep`（32L） | Jaccard 0.43。核心（`deriveTotpKey(old)` → `decryptTotpSecret` → `deriveTotpKey(new, epoch+1)` → `encryptTotpSecret`）完全一致，分歧只在**怎么拿到记录**（fe 走 `api.getTotpRecord()` 并对 404/`TOTP_NOT_ENABLED` 做特判；CLI 直接收入参）。抽 `packages/shared/src/auth/rewrap-totp.ts` 只吃已取到的 record，两侧各留取数逻辑 |

`rewrapTotp*` 是 1.1.16 "常规改密保留 passkey/TOTP" 的核心路径，**改坏 = 用户 TOTP 永久丢失**（fe 侧注释已明写这个风险）。抽取必须是纯搬移，且两侧测试（`account-security-actions.test.ts`、`packages/app/src/lib/hub-user-passwd.test.ts`）都要跑。**角色**：跨端（建议归后端 agent，因为落点在 `packages/shared`）。

### 3.5 IP 地址判定四处独立实现（安全边界 + 层次倒挂）

| 位置 | 函数 | 问题 |
|---|---|---|
| `apps/gateway/src/mesh/address-class.ts:311` | `parseIpv4`（私有） | **这里才是 IP 分类的正统家**（还有 `isIpv6Ula:97`、`isIpv6SiteLocal:104`、`collectLocalNets:221`） |
| `apps/gateway/src/mesh/client-ip.ts:83` | `isIpv6`（私有） | Jaccard 0.83 与下一行 |
| `apps/gateway/src/mesh/domain-access-policy.ts:169` | `looksLikeIpv6`（私有） | 同上 |
| `apps/gateway/src/db/local-auth-settings.ts:180` | `isLoopbackIpv4`（私有） | Jaccard 0.42 与 `parseIpv4` |

**外加一处层次倒挂**：`apps/gateway/src/mesh/client-ip.ts:1` `import { isLoopbackClientIp } from '../db/local-auth-settings'` —— **mesh 层向 db 层要一个纯 IP 字面量判定**。回环判定是网络语义，不是设置语义；它出现在 `db/local-auth-settings.ts` 只是因为"本机免二次验证"这个功能当初写在那里（第二十轮）。
**修法**：把 `isIpv6`/`isLoopbackIpv4`/`isLoopbackClientIp` 全部收进 `apps/gateway/src/mesh/address-class.ts`（或新建 `apps/gateway/src/net/ip-class.ts`），`db/local-auth-settings.ts` 改为 import。
**测试**：`client-ip.test.ts`、`domain-access-policy.test.ts`、`address-class.test.ts`、`local-auth-settings.test.ts` 都存在。**风险**：中（第二十轮"本机/内网免通行密钥"的判定路径，回归会导致公网被误判为内网 —— 必须逐个跑上述四个 spec）。**角色**：后端。

### 3.6 `packages/api-client` 的 CRUD 模板复制（**行数收益最大**）

135 对里有 **约 45 对**集中在 `packages/api-client/src/*.ts`，全是同一个 15 行模板：

```ts
export async function createX(body, errorFallback = '...', client = defaultApiClient): Promise<X> {
  const res = await client.fetch('/api/xs', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await parseApiError(res, errorFallback));
  const payload = (await res.json()) as { x: X };
  return payload.x;
}
```

涉及函数（不完全列举）：`devices.ts:37 createDevice`、`:54 updateDevice`、`:84 reorderDevices`；`device-folders.ts:24 createDeviceFolder`、`:41 updateDeviceFolder`、`:70 replaceDeviceFolderLayout`；`llm-providers.ts:38 createLlmProvider`、`:54 updateLlmProvider`；`watch.ts:32 createWatchRule`、`:47 updateWatchRule`、`:97 assistRegex`；`agent.ts:66 createAgentSession`、`:82 updateAgentSession`、`:130 sendAgentMessage`；`terminal-shortcuts.ts:17 updateTerminalShortcuts`；`file-resources.ts:25 createFileRoot`、`:53 reorderFileRoots`。

**修法**：`packages/api-client/src/json-mutation.ts`：
```ts
export async function mutateJson<TRes, TWire>(client, method, path, body, errorFallback,
  pick: (wire: TWire) => TRes): Promise<TRes>
```
每个函数缩到 3–5 行。预计消掉 **~220 行**（api-client 生产代码总共才 1552 行，占 14%）。
**唯一分歧**是响应体的 unwrap key（`device`/`folder`/`provider`/`rule`/`session`…），由 `pick` 回调承载，不引入 magic string。
**测试**：`devices.test.ts`(179L)、`device-folders.test.ts`(46L)、`site.test.ts`、`file-resources.test.ts`、`client.test.ts`。注意 **`llm-providers.ts`/`watch.ts`/`agent.ts`/`terminal-shortcuts.ts` 没有直接的单测**，只由上层 panels 测试间接覆盖 —— 建议这个任务同时补一个 `json-mutation.test.ts` 覆盖 ok/非 ok/错误文案三条路径。**风险**：低。**角色**：前端。

### 3.7 前端设置页的表单原语三份

| A | B | Jaccard |
|---|---|---:|
| `apps/fe/.../nodes/https/parts.tsx:25 Notice` | `apps/fe/.../nodes/setup/form-parts.tsx:25 SetupNotice` | 0.95 |
| `apps/fe/.../nodes/https/parts.tsx:46 Field` | `apps/fe/.../nodes/setup/form-parts.tsx:46 FormField` | 0.89 |
| `apps/fe/.../nodes/https/parts.tsx:75 InfoRow` | `apps/fe/.../remote-access/step-shell.tsx:101 DetailRow` | 0.87 |
| `apps/fe/.../nodes/https/parts.tsx:150 CopyableCode` | `apps/fe/.../nodes/copy-feedback.tsx:79 CopyableValue` | 0.86 |

`parts.tsx` 和 `form-parts.tsx` 是**同一批原语的两份拷贝**（连行号都对齐：25/46）。合并到 `apps/fe/src/pages/settings/components/form-primitives.tsx`。
**风险**：低（纯展示组件）。**角色**：前端。

### 3.8 确认对话框四份

| 位置 | 行数 | 与谁重复 |
|---|---:|---|
| `apps/fe/.../nodes/domain-access-row.tsx:207 DomainAccessConfirm` | 47 | `direct-section.tsx:251 RemoveConfirm`（0.55） |
| `apps/fe/.../nodes/direct-section.tsx:251 RemoveConfirm` | 39 | `remote-access/status-card.tsx:357 ConfirmRemoveDialog`（0.44） |
| `apps/fe/.../https/https-section.tsx:167 StopListenerConfirm` | 49 | `status-card.tsx:357`（0.42） |
| `apps/fe/.../remote-access/status-card.tsx:357 ConfirmRemoveDialog` | 44 | — |

四份都是「AlertDialog + 危险操作文案 + loading 态确认按钮」。抽 `apps/fe/src/pages/settings/components/danger-confirm-dialog.tsx`。注意 **改文案前先读 `/Users/konata/code/tmex-copy-guidelines.md`**。**角色**：前端。

### 3.9 weixin / telegram 平行实现（跨全栈）

| 层 | weixin | telegram | Jaccard |
|---|---|---|---:|
| 路由 | `api/weixin-routes.ts:74 handleCreateWeixinAccount`(30L) | `api/telegram-routes.ts:83 handleCreateTelegramBot`(28L) | 0.46 |
| DB | `db/weixin.ts:275 approveWeixinUser`(20L) | `db/telegram.ts:238 approveTelegramChat`(20L) | 0.46 |
| 面板 tab | `panels/settings/weixin-accounts-tab.tsx:16`(73L) | `panels/settings/telegram-bots-tab.tsx:16`(60L) | 0.42 |
| 表单弹窗 | `weixin-account-form-modal.tsx:31`(165L) | `telegram-bot-form-modal.tsx:24`(164L) | 0.51 |
| mutationFn | `weixin-account-form-modal.tsx:55 / :82` | `telegram-bot-form-modal.tsx:44 / :70` | 0.57 / 0.47 |

合计 weixin 侧 933 行、telegram 侧 861 行。**判定：只做前端表单层的统一，不动网关层。** 理由：两边的**审批语义不同**（weixin 是"用户"、telegram 是"chat"，权限模型与 ilink 登录态不同），网关/DB 层的相似只是 CRUD 形状相似；但前端的 `*-form-modal.tsx`（165/164 行，J=0.51）确实可以合成一个 `IntegrationAccountFormModal`，字段由 schema 描述驱动。
**风险**：中（两个集成的字段校验规则不同）。**角色**：前端。

### 3.10 其余中等价值对（逐条判定）

| Jaccard | 对 | 判定 |
|---:|---|---|
| 0.93 | `packages/panels/src/files/bulk-transfer.ts:339 prepareDownload`(44L) ↔ `packages/api-client/src/download-transfer.ts:88 prepareDownload`(45L) | **合并**：api-client 是正确落点，panels 侧改 import。`download-transfer.ts` 无单测，需补 |
| 0.81 | `become-hub-form.tsx:103 handleSubmit` ↔ `join-hub-form.tsx:73 handleSubmit`（父组件 208L/172L 也 J=0.44） | **合并 handleSubmit**，抽 `useHubSetupSubmit`；父组件不合（两个表单的字段确实不同） |
| 0.78 / 0.70 / 0.55 | `packages/ui/` 的 `dropdown-menu` ↔ `context-menu` ↔ `dialog`/`sheet`/`alert-dialog` overlay | **RETAIN**：shadcn/ui 上游生成物的形状，合并会与上游 diff 打架 |
| 0.76 | `hub/uplink-server.ts:1670 identicalHeadRecord` ↔ `hub/hub-runtime.ts:670 identicalForwardedKeyLog` | **合并**到 `packages/shared/src/auth/key-log.ts`（key-log 记录等值判定属于协议语义） |
| 0.76 | `api-client/src/local/tls-api.ts:22 readError` ↔ `local/local-api.ts:27 readError` | 合并（同目录，S） |
| 0.66 | `tmux-client/control-stream-metrics.ts:87 takeIfDue` ↔ `ws/terminal-output-metrics.ts:158 takeIfDue` | 合并到一个 `takeIfDue(now, lastAt, intervalMs)` 助手（这是 round-22 性能主题会碰的采样节流） |
| 0.65/0.52/0.51 | `sleep` 四份：`weixin/ilink/update-loop.ts:65`、`app/commands/enroll.ts:72`、`mesh/ctl.ts:52`、`mesh/forwarder.ts:913 defaultSleep` | **RETAIN**（二十一轮 §3.9 已判：跨包、各带 abort 语义微差，收益 < 依赖边成本） |
| 0.64 | `system/upgrade.ts:847 processCommandLine` ↔ `app/lib/upgrade-process.ts:48 processCommandLine` | 与 §3.1 的 `processStartIdentity` 一起合并 |
| 0.61 | `api/route-input.ts:25 decodeB64url` ↔ `shared/uplink/codec.ts:103 b64urlToBytes` | 合并到 `packages/shared/src/auth/encoding.ts`（已有 113 个编码导出） |
| 0.55 | `api/agent-{message,session,confirmation}-routes.ts` 的 `createXRoutes` 三份 | **RETAIN**：路由装配根，形状相似但每条路由不同 |
| 0.49 | `apps/fe/src/node/enrollment.ts:699 encodeJoinTokenZeroing`(35L) ↔ `packages/shared/src/auth/enrollment.ts:94 encodeJoinToken`(23L) | **谨慎**：fe 版多了"用后清零"（防止 join token 留在内存），语义分歧是刻意的。建议 shared 版加 `zeroing` 选项，fe 版删除 |
| 0.48 | `mesh/uplink-client.ts:104 waitSocketOpen` ↔ `mesh/peer-ws-race.ts:239 waitSocketOpen` | 见 §2.4 |
| 0.45 | `tunnel/spawn.ts:23 pickFreePort`(20L) ↔ `app/lib/upgrade-apply.ts:192 allocateEphemeralPort`(14L) | 合并到 `packages/shared`（但 shared 是浏览器安全的，`node:net` 不能进；改放 `apps/gateway/src/net/` 并让 app 侧 import，或各留 —— **低价值，可 RETAIN**） |
| 0.45 | `tmux-client/local-external-connection.ts:286 connect` ↔ `ssh-external-connection.ts:78 connect`；`:612 handleControlClientExit` ↔ `:441 handleControlChannelClose` | **RETAIN**（历轮已明确拒绝合并 SSH/local 外部连接重连流程） |
| 0.43 | `mesh/rtc/rtc-dial-breaker.ts:84 RtcDialBreaker` ↔ `ws-client/direct/direct-dial-breaker.ts:44 DirectDialBreaker` | **已处理**：二十一轮抽出 `packages/shared/src/net/dial-breaker.ts`（已确认存在），两侧剩下的是薄包装，0.43 是包装层的正常相似 |
| 0.43 | `mesh/mesh-runtime.ts:597 resolveUserId` ↔ `hub/hub-authorization.ts:119 resolveMeshUserId` | 合并（S） |
| 0.42 | `ws-client/websocket-transport.ts:69 cloneCommand` ↔ `canonical-state-helpers.ts:89 clonePendingCommand` | 见 §2.6 |

---

## 4. 结构性 smell

### 4.1 循环依赖（8 个，全部 2–3 节点）

自建检测（仅统计**值导入**，`import type` 不计）：

| 环 | 成因 | 修法 |
|---|---|---|
| `ws/borsh-dispatcher.ts` ↔ `ws/agent-kind-handlers.ts` | dispatcher 既导出 `schemaHandler`/`decoderHandler`/`BorshDispatchHost`（叶子工具），又导出 `createBorshKindHandlers`（装配根，import 三个 handler 工厂）；handler 反过来 import 那些工具 | **抽叶子模块** `ws/borsh-kind-types.ts`（`BorshDispatchHost` + `BorshKindHandler` + `schemaHandler` + `decoderHandler` + `decodeBorshKindPayload`），`borsh-dispatcher.ts` 只留装配与 `dispatchBorshKind` |
| `ws/borsh-dispatcher.ts` ↔ `ws/canonical-kind-handlers.ts` | 同上 | 同上 |
| `ws/borsh-dispatcher.ts` ↔ `ws/tmux-kind-handlers.ts` | 同上 | 同上 |
| `ws/borsh-dispatcher.ts` → `ws/tmux-kind-handlers.ts` → `ws/tmux-viewport-handlers.ts` → 回 | 同上（3 节点） | 同上，一次修完四个环 |
| `api/files.ts` ↔ `api/file-transfer-routes.ts` | `files.ts` 既装配路由，又持有传输会话状态（`cleanupDownload`/`cleanupUpload`/`rememberTransferUid`），被 `file-transfer-routes.ts` 反向 import | **抽** `api/file-transfer-sessions.ts`。**与 §3.3 的 `readBodyCapped` 是同一批文件，应合成一个任务** |
| `app/lib/dep-install.ts` ↔ `app/lib/dependency-install-runner.ts` | 两侧互相 import 类型 + 函数（`dep-install.ts:7,19` 两处 import runner；runner `:10` import 回 dep-install） | 抽 `app/lib/dep-install-types.ts` |
| `ghostty-terminal/terminal-pointer.ts` ↔ `terminal-pointer-handlers.ts` | handlers 需要 `PointerEventContext`（type）+ `mouseButtonFromButtons`/`mouseButtonFromEvent`（值） | 抽 `terminal-pointer-shared.ts`（把两个 `mouseButtonFrom*` 与 context 类型放进去） |
| `fe/.../management/use-node-detail-state.ts` ↔ `node-detail-dialog.tsx` | hook 从 `.tsx` 组件文件 import 类型（`:16`），组件又 import hook（`:43`）—— **hook 依赖组件文件是方向错的** | 把类型移到 `node-detail-types.ts` |

**八个环是同一种病**：模块同时扮演"叶子工具"和"装配根"。修法统一是**抽叶子**。**风险全部为低**（纯 import 重定向）。

### 4.2 导出数过多（god module / barrel）

| 导出数 | 行数 | 文件 | 判定 |
|---:|---:|---|---|
| 113 | 489 | `packages/shared/src/auth/encoding.ts` | **RETAIN**：编码原语的正规集合，导出多是本分。反倒应该**把散落各处的 base32/b64url 收进来**（§3.4、§3.10） |
| 95 | 653 | `packages/shared/src/ws-borsh/schema.ts` | RETAIN：协议 schema |
| 84 | 427 | `packages/shared/src/ws-borsh/canonical-state.ts` | RETAIN |
| 71 | 1473 | `packages/shared/src/uplink/codec.ts` | RETAIN（历轮已定） |
| 69 | 308 | `apps/gateway/src/mesh/mesh-deps.ts` | RETAIN：依赖注入契约（fan-in 32） |
| **60** | **1343** | `apps/fe/.../use-hub-role-switch.ts` | **可疑**：一个 hook 文件导出 60 个符号（阶段常量 + 内部函数 + 类型）。二十一轮判为"编排 hook 状态机内聚体"，但**导出面**没被审过 —— 60 个导出里多数应该是私有的 |
| **57** | **865** | `apps/gateway/src/db/schema.ts` | **可疑**：单文件承载全部表定义（fan-in 34）。按域拆（`schema/devices.ts`、`schema/mesh.ts`、`schema/agent.ts`…）+ 保留 barrel |
| 43 | 492 | `packages/api-client/src/auth/types.ts` | RETAIN：类型集合 |
| **41** | **776** | `apps/fe/src/node/enrollment.ts` | **可疑**：见 §2.7 |
| 41 | 521 | `apps/fe/.../remote-access/tunnel-model.ts` | 边界：模型 + 纯函数，可接受 |
| **40** | **1283** | `apps/fe/.../use-node-upgrade.ts` | 同 `use-hub-role-switch.ts` |
| 38 | 1597 | `apps/gateway/src/mesh/uplink-pool.ts` | RETAIN |
| **31** | **893** | `apps/gateway/src/ws/tmux-command-handlers.ts` | **见 §2.5** |

**barrel 检查**：`export *` 型 barrel 只有 7 个（`shared/ws-borsh/index.ts` 291L、`shared/index.ts` 159L、`stores/index.ts` 97L、`terminal-ui/index.ts` 57L、`api-client/index.ts` 16L 等），**规模合理，无"全量再导出"型 barrel**，不用处理。

**"utils.ts 倾倒场"检查**：全仓只有 `packages/ui/src/utils.ts`(6L) 和 `apps/gateway/src/tmux-client/external/helpers.ts`(15L)，**没有倾倒场**。这一项历轮治理得很好。

### 4.3 fan-out（导入数）过高

| 导入数 | 行数 | 文件 |
|---:|---:|---|
| 41 | 248 | `packages/panels/src/code-viewer/code-viewer.tsx` —— 248 行导入 41 个模块，大多是 shiki 语言包，**RETAIN** |
| 37 | 1559 | `apps/gateway/src/mesh/mesh-runtime.ts` —— 装配根，已入册 |
| 32 | 569 | `packages/app/src/runtime/assemble-routes.ts` —— 装配根 |
| 32 | 499 | `packages/app/src/runtime/assemble.ts` —— 装配根（已入册） |
| 30 | 348 | `apps/fe/src/main.tsx` —— 应用入口 |
| 29 | 837 | `apps/gateway/src/ws/index.ts` —— 二十一轮从 941 拆到 837，仍是 ws 门面 |

**没有"伪装成业务模块的装配根"**，fan-out 高的都确实是装配根。这一项无需处理。

### 4.4 层次倒挂

1. **`mesh` → `db`**：`apps/gateway/src/mesh/client-ip.ts:1` import `isLoopbackClientIp` from `../db/local-auth-settings`。见 §3.5。
2. **gateway → packages 的相对路径穿越**：`apps/gateway/src/api/http.ts:4` 用 `'../../../../packages/shared/src/http/read-body'` 而不是 `'@tmex/shared/...'`。这是二十一轮为规避浏览器 bundle 问题的刻意做法（`loadEnv` 那条约束的邻近效应），但**四级 `../` 是脆的**，任何文件移动都会断。建议在 `packages/shared` 的 `exports` 里补一个 `./http` 子路径，改成 `@tmex/shared/http`。同一问题在 `packages/app/src/runtime/http.ts:3` 和 `packages/app/src/lib/totp-uri.ts:1`（`'../../../shared/src/auth'`）也有。

### 4.5 网关路由文件里混 DB + 校验 + 业务

抽样 25 个 `apps/gateway/src/api/*.ts`：

| 行数 | 直接 import `../db` 的次数 | 文件 |
|---:|---:|---|
| 446 | 3 | `api/watch.ts` |
| 331 | 3 | `api/llm.ts` |
| 175 | 4 | `api/domain-access-routes.ts` |
| 316 | 1 | `api/weixin-routes.ts` |
| 267 | 2 | `api/agent-session-config.ts` |

**判定：这一项不构成本轮的活。** 路由文件普遍 < 450 行，DB import 数 ≤ 4，且校验部分已经通过 `api/route-input.ts`（有单测）与 `api/http.ts:readJsonObjectBody` 集中。相比之下 `packages/api-client` 的模板复制（§3.6）收益大得多。唯一值得记账的是 `api/watch.ts`(446L, 3 个 db import) 是最接近失控的一个，下轮如果继续长大再处理。

---

## 5. 测试 smell（简述）

全仓 **833 个测试文件、230 287 行测试代码**（生产代码 221 739 行，测试/生产 = 1.04）。

### 5.1 巨型测试文件（> 1500 行，共 18 个）

| 行数 | 文件 |
|---:|---|
| 3851 | `apps/gateway/src/mesh/peer-manager.test.ts` |
| 3676 | `apps/gateway/src/mesh/auth-routes.test.ts` |
| 2982 | `apps/gateway/src/hub/uplink-server.test.ts` |
| 2971 | `packages/ghostty-terminal/src/terminal.canvas.test.ts` |
| 2474 | `apps/gateway/src/mesh/uplink-client.test.ts` |
| 2339 | `apps/gateway/src/hub/hub-runtime.test.ts` |
| 2327 | `apps/gateway/src/mesh/uplink-pool.test.ts` |
| 2319 | `apps/gateway/src/mesh/mesh-routes.test.ts` |
| 2128 | `apps/gateway/src/tmux-client/local-external-connection.test.ts` |
| 2020 | `apps/gateway/src/mesh/mesh-runtime.test.ts` |
| 1993 | `apps/gateway/src/ws/index.test.ts` |
| 1979 | `apps/gateway/src/tunnel/manager.test.ts` |
| 1968 | `apps/gateway/src/mesh/forwarder.test.ts` |
| 1968 | `apps/fe/.../remote-access/remote-access-tab.test.tsx` |
| 1877 | `apps/fe/.../management/nodes-management.test.tsx` |
| 1842 | `packages/app/src/runtime/assemble.test.ts` |
| 1602 | `packages/ws-client/src/canonical-state-client.test.ts` |
| 1534 | `apps/fe/.../management/use-node-upgrade.test.ts` |

**沿用历轮结论：不拆测试文件**（拆了会损失定位性）。`peer-manager.test.ts` 从二十一轮的 3754 涨到 3851。

### 5.2 复制粘贴的夹具（**这个值得做**）

我的逐字克隆检测在测试里跑出 **41 组**跨文件逐字相同的夹具。最值得抽的四组：

| 行数 | 夹具 | 出现处 | 建议落点 |
|---:|---|---|---|
| 83 + 35 + 33 + 17 + 12 + 15 | `createEs256Authenticator` / `register` / `assert` / `makeAuthData` / `cborHead` / `cborValue`（**合计 195 行 × 3 份**） | `auth/passkey.test.ts:442+`、`mesh/auth-routes.test.ts:3481+`、`hub/hub-runtime.test.ts:2133+` | `apps/gateway/src/auth/passkey-test-fixtures.ts`（**净省 ~390 行**） |
| 45 + 15 | `loopbackSignaling` / `subscribe` | `mesh/integration/dc-http-bulk.integration.test.ts:271`、`mesh/rtc/rtc-peer-manager.test.ts:17`、`mesh/rtc/rtc-loopback.integration.ts:57` | `apps/gateway/src/mesh/rtc/rtc-test-fixtures.ts`（净省 ~120 行） |
| 27 + 20 | `dummyUplink` / `echoQuiesceCaps` | `peer-manager.test.ts:87/231`、`peer-manager.backoff.test.ts:29/57`、`peer-manager.upgrade.test.ts:40`、`rtc/rtc-dial-breaker.test.ts:215` | `apps/gateway/src/mesh/peer-test-fixtures.ts`（净省 ~110 行） |
| 20 | `fakeGateway` | `hub-contract.integration.test.ts:44`、`mesh-runtime.test.ts:46`、`mesh-runtime-node-presence.test.ts:22` | 并入 `apps/gateway/src/mesh/test-support.ts`（已存在） |

前端侧同类：`meshRow`(13L×3)、`meshNode`(13L×4)、`createMemoryStorage`(12L×2)、`installFakeTimers`(33L×2)、`makeSiteSettings`(19L×2)、`StubApiClient`(14–16L×4)。
e2e 侧：`readVisibleTerminalText`(15L×4)、`createDevice`(12L×3)、`waitFeButtonTracking`(12L×3)、`attachSiteThemeReceiver`(14L×2) —— 应进 `apps/fe/tests/fixtures/`。

### 5.3 裸 sleep（flaky 风险）

全仓 **170 处** `await new Promise(r => setTimeout(r, N))` 出现在测试里。集中度最高的：

| 处数 | 文件 |
|---:|---|
| 15 | `apps/gateway/src/mesh/uplink-client.test.ts` |
| 15 | `apps/gateway/src/hub/uplink-server.test.ts` |
| 12 | `packages/shared/src/link/mux.test.ts` |
| 12 | `apps/gateway/src/system/upgrade.test.ts` |
| 12 | `apps/gateway/src/mesh/peer-manager.upgrade.test.ts` |
| 12 | `apps/gateway/src/hub/hub-peer-poller.test.ts` |
| 11 | `apps/gateway/src/system/remote-upgrade-job.test.ts` |
| 10 | `apps/gateway/src/mesh/peer-manager.test.ts` |

`packages/stores/src/tmux-reselect-retry.test.ts:13` 已经有一份 33 行的 `installFakeTimers`（被 `tmux-selection-drop.test.ts` 逐字复制）—— **说明假时钟的做法在仓库里已存在**，只是没有推广到 gateway 侧。
**建议**：本轮**不**做全量替换（成本高、收益不明确），只在**已经因为 sleep 而抖过的用例**上换假时钟。记账即可。

---

## 6. Backlog（22 项，按角色分组，文件占用严格不相交）

规则同二十一轮：每个任务**只允许改自己列出的文件 + 自己新建的文件**；`scripts/complexity/allowlist.json` 任何任务都不得手改（本轮 `--tighten` 无 diff，见 §1.7，指挥官也不必跑）。
通用验收：涉及包的 `bun test` 相对基线只增不减；`bunx tsc --noEmit` 错误数不高于基线；`biome check .` 通过；`bun scripts/complexity/gate.ts` 仍为 ok。

### 后端（gateway / app / shared / ws-client）

| # | 任务 | 尺寸 | 拥有的文件 | 新建 |
|---|---|:--:|---|---|
| **B1** | **file-transfer 传输会话独立 + 消灭 `readBodyCapped` 第三份**（§3.3 + §4.1 第 5 环）：把 `cleanupDownload`/`cleanupUpload`/`rememberTransferUid` 移出 `files.ts` 破环；删掉 `file-transfer-routes.ts:57` 的私有副本，改用 shared（需给 shared 加 result 形态的返回） | **S** | `apps/gateway/src/api/files.ts`、`apps/gateway/src/api/file-transfer-routes.ts`、`packages/shared/src/http/read-body.ts` | `apps/gateway/src/api/file-transfer-sessions.ts` |
| **B2** | **`tmux-command-handlers.ts` 分三簇**（§2.5）：选择簇 / 视口尺寸簇 / 结构操作簇，主文件回到 ~330 行 | **M** | `apps/gateway/src/ws/tmux-command-handlers.ts` 及其 import 方（`ws/tmux-kind-handlers.ts`、`ws/index.ts` 的 import 行） | `apps/gateway/src/ws/tmux-selection-handlers.ts`、`apps/gateway/src/ws/tmux-geometry-handlers.ts` |
| **B3** | **borsh dispatcher 破环**（§4.1 前四环）：抽叶子类型/工具模块 | **S** | `apps/gateway/src/ws/borsh-dispatcher.ts`、`ws/agent-kind-handlers.ts`、`ws/canonical-kind-handlers.ts`、`ws/tmux-viewport-handlers.ts` | `apps/gateway/src/ws/borsh-kind-types.ts` |
| **B4** | **IP 判定收编 + 层次倒挂修正**（§3.5）：四份私有 IP 解析合一，`db/local-auth-settings.ts` 反向依赖消除 | **M** | `apps/gateway/src/mesh/address-class.ts`、`mesh/client-ip.ts`、`mesh/domain-access-policy.ts`、`apps/gateway/src/db/local-auth-settings.ts` | — |
| **B5** | **`uplink-client.ts` 减重 + `waitSocketOpen` 统一**（§2.4） | **M** | `apps/gateway/src/mesh/uplink-client.ts`、`apps/gateway/src/mesh/peer-ws-race.ts` | `packages/shared/src/net/wait-socket-open.ts` |
| **B6** | **升级器进程身份助手统一**（§3.1 第 2 行 + §3.10 `processCommandLine`） | **S** | `apps/gateway/src/system/upgrade.ts`、`packages/app/src/lib/upgrade-lock.ts`、`packages/app/src/lib/upgrade-process.ts` | — |
| **B7** | **`upgrade-apply.ts` 899→~700**（§2.3）：抽升级事务执行器 | **M** | `packages/app/src/lib/upgrade-apply.ts` | `packages/app/src/lib/upgrade-txn.ts` |
| **B8** | **`packages/app/src/commands` 的 `withAuth` 三份合一**（§3.1 第 3 行） | **S** | `packages/app/src/commands/hub.ts`、`commands/mesh.ts`、`commands/enroll.ts` | `packages/app/src/commands/with-auth.ts` |
| **B9** | **TOTP 重封装 + base32 收编**（§3.4）：`encodeBase32`/`base32Encode` 进 `shared/auth/encoding.ts`；`rewrapTotp*` 核心进 `shared/auth`；补 `packages/app/src/lib/totp-uri.ts` 缺失的单测 | **M** | `apps/fe/src/auth/totp-uri.ts`、`apps/fe/src/auth/account-security-actions.ts`、`packages/app/src/lib/totp-uri.ts`、`packages/app/src/lib/hub-user-passwd.ts`、`packages/shared/src/auth/encoding.ts` | `packages/shared/src/auth/rewrap-totp.ts`、`packages/app/src/lib/totp-uri.test.ts` |
| **B10** | **`decodeB64url` 收编 + `identicalKeyLog` 合并 + `resolveUserId` 合并**（§3.10 三条 S 项） | **S** | `apps/gateway/src/api/route-input.ts`、`apps/gateway/src/hub/uplink-server.ts`、`apps/gateway/src/hub/hub-runtime.ts`、`apps/gateway/src/mesh/mesh-runtime.ts`、`apps/gateway/src/hub/hub-authorization.ts`、`packages/shared/src/auth/key-log.ts` | — |
| **B11** | **`defaultRunSync` 合并 + `takeIfDue` 合并**（§3.1 第 4 行、§3.10） | **S** | `apps/gateway/src/tmux-client/ssh-auth-resolvers.ts`、`apps/gateway/src/tmux/local-shell-path.ts`、`apps/gateway/src/tmux-client/control-stream-metrics.ts`、`apps/gateway/src/ws/terminal-output-metrics.ts` | `apps/gateway/src/tmux/run-sync.ts` |
| **B12** | **`dep-install` 破环**（§4.1 第 6 环） | **S** | `packages/app/src/lib/dep-install.ts`、`packages/app/src/lib/dependency-install-runner.ts` | `packages/app/src/lib/dep-install-types.ts` |
| **B13** | **`db/schema.ts` 按域拆 + barrel**（§4.2）：865 行 / 57 导出 / fan-in 34 | **M** | `apps/gateway/src/db/schema.ts` | `apps/gateway/src/db/schema/*.ts` |
| **B14** | **`packages/shared` 补 `./http`、`./net` 子路径导出，消除四级 `../` 穿越**（§4.4 第 2 条） | **S** | `packages/shared/package.json`、`apps/gateway/src/api/http.ts`（仅 import 行）、`packages/app/src/runtime/http.ts`（仅 import 行） | — |
| **B15** | **`canonical-state-client.ts` 减重 + 命令克隆合一**（§2.6） | **M** | `packages/ws-client/src/canonical-state-client.ts`、`ws-client/src/canonical-state-helpers.ts`、`ws-client/src/websocket-transport.ts` | `packages/ws-client/src/canonical-metadata-identity.ts` |

### 前端（apps/fe / panels / terminal-ui / ui / stores / api-client）

| # | 任务 | 尺寸 | 拥有的文件 | 新建 |
|---|---|:--:|---|---|
| **F1** | **mesh 轮询 store 工厂**（§3.2）：`mesh-hubs`/`mesh-nodes` 的 store 脚手架 + 轮询 + 可见性合一，消 ~160 行 | **M** | `apps/fe/src/node/mesh-hubs.ts`、`apps/fe/src/node/mesh-nodes.ts` | `apps/fe/src/node/create-polling-store.ts` |
| **F2** | **api-client CRUD 模板收敛**（§3.6）：消 ~220 行（占该包生产代码 14%），并补 `json-mutation.test.ts` | **M** | `packages/api-client/src/{devices,device-folders,llm-providers,watch,agent,terminal-shortcuts,file-resources}.ts`、`packages/api-client/src/local/{tls-api,local-api}.ts` | `packages/api-client/src/json-mutation.ts` + 其测试 |
| **F3** | **设置页表单原语合一 + 危险确认框合一**（§3.7 + §3.8）：`Notice`/`Field`/`InfoRow`/`CopyableCode` 四对 + 四份确认框。**改文案前先读 `/Users/konata/code/tmex-copy-guidelines.md`** | **M** | `apps/fe/src/pages/settings/nodes/https/parts.tsx`、`nodes/setup/form-parts.tsx`、`nodes/copy-feedback.tsx`、`remote-access/step-shell.tsx`、`nodes/domain-access-row.tsx`、`nodes/direct-section.tsx`、`nodes/https/https-section.tsx`、`remote-access/status-card.tsx` | `apps/fe/src/pages/settings/components/form-primitives.tsx`、`.../danger-confirm-dialog.tsx` |
| **F4** | **`prepareDownload` 合一**（§3.10 J=0.93）+ 给 `download-transfer.ts` 补单测 | **S** | `packages/panels/src/files/bulk-transfer.ts`、`packages/api-client/src/download-transfer.ts` | `packages/api-client/src/download-transfer.test.ts` |
| **F5** | **`writeTextToClipboard` 合一**（§3.1 第 1 行，逐字 34 行 × 2） | **S** | `packages/ghostty-terminal/src/selection-clipboard.ts`、`packages/shared/src/browser-clipboard.ts` | — |
| **F6** | **hub setup 表单提交合一**（§3.10 J=0.81）：抽 `useHubSetupSubmit` | **S** | `apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx`、`.../join-hub-form.tsx` | `apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts` |
| **F7** | **`node-detail-dialog` 破环**（§4.1 末环）：类型下沉 | **S** | `apps/fe/.../management/use-node-detail-state.ts`、`apps/fe/.../management/node-detail-dialog.tsx` | `apps/fe/.../management/node-detail-types.ts` |
| **F8** | **`createTmuxStore` 再抽一层**（§2.8）：`tmux-window-actions.ts`，与已有三个 actions 模块同构，277→~180 行 | **S** | `packages/stores/src/tmux.ts` | `packages/stores/src/tmux-window-actions.ts` |
| **F9** | **weixin/telegram 表单弹窗合一**（§3.9，仅前端层，不动网关/DB） | **M** | `packages/panels/src/settings/weixin-account-form-modal.tsx`、`telegram-bot-form-modal.tsx`、`weixin-accounts-tab.tsx`、`telegram-bots-tab.tsx` | `packages/panels/src/settings/integration-account-form-modal.tsx` |
| **F10** | **`enrollment.ts` 导出面收敛 + `encodeJoinTokenZeroing` 归位**（§2.7 + §3.10）：41 个导出裁到必要面；shared 版加 `zeroing` 选项 | **M** | `apps/fe/src/node/enrollment.ts`、`apps/fe/src/node/enrollment-engine.ts`、`packages/shared/src/auth/enrollment.ts` | — |

### ghostty-terminal（前端）

| # | 任务 | 尺寸 | 拥有的文件 | 新建 |
|---|---|:--:|---|---|
| **G1** | **`canvas-renderer.ts` 898→~750，抽出颜色/样式纯函数与 block-element 绘制**（§2.2）。**这是 round-22 TUI 颜色主题的前置任务**：抽完之后取色规则可以脱离 canvas 单测 | **M** | `packages/ghostty-terminal/src/canvas-renderer.ts` | `packages/ghostty-terminal/src/canvas-cell-style.ts`、`packages/ghostty-terminal/src/canvas-block-elements.ts` + 各自单测 |
| **G2** | **`terminal-pointer` 破环**（§4.1 第 7 环） | **S** | `packages/ghostty-terminal/src/terminal-pointer.ts`、`terminal-pointer-handlers.ts` | `packages/ghostty-terminal/src/terminal-pointer-shared.ts` |

### 测试与治理（可由指挥官或单独 agent 承担）

| # | 任务 | 尺寸 | 拥有的文件 | 新建 |
|---|---|:--:|---|---|
| **T1** | **passkey / rtc / peer 三组夹具抽取**（§5.2）：净省 ~620 行测试代码 | **M** | `apps/gateway/src/auth/passkey.test.ts`、`mesh/auth-routes.test.ts`、`hub/hub-runtime.test.ts`、`mesh/integration/dc-http-bulk.integration.test.ts`、`mesh/rtc/rtc-peer-manager.test.ts`、`mesh/rtc/rtc-loopback.integration.ts`、`mesh/peer-manager{,.backoff,.upgrade}.test.ts`、`mesh/rtc/rtc-dial-breaker.test.ts`、`mesh/test-support.ts` | `apps/gateway/src/auth/passkey-test-fixtures.ts`、`mesh/rtc/rtc-test-fixtures.ts`、`mesh/peer-test-fixtures.ts` |
| **X1** | **allowlist 理由治理**（§1.7）：54 条模板句逐条按二十一轮 §5.1 的四类可接受理由重写，写不出来的就改成 `TODO(round-N): 什么条件下会被拆掉`。**纯 JSON 编辑，不改代码** | **M** | `scripts/complexity/allowlist.json` | — |

### 文件占用矩阵（确认零重叠）

按包/目录列出每个任务独占的路径前缀，交叉检查：

- `apps/gateway/src/api/` → B1（files/file-transfer-*）、B10（route-input.ts）— 不重叠
- `apps/gateway/src/ws/` → B2（tmux-command-handlers + 新建两个）、B3（borsh-* + *-kind-handlers）、B11（terminal-output-metrics.ts）— 不重叠（注意 B2 需要改 `ws/index.ts` 与 `ws/tmux-kind-handlers.ts` 的 import 行，B3 也碰 `ws/tmux-viewport-handlers.ts`；**B2 与 B3 必须串行或指定 B3 先做**，这是唯一一处需要排序的约束）
- `apps/gateway/src/mesh/` → B4（address-class/client-ip/domain-access-policy）、B5（uplink-client/peer-ws-race）、B10（mesh-runtime.ts）— 不重叠
- `apps/gateway/src/hub/` → B10（uplink-server/hub-runtime/hub-authorization）— 独占
- `apps/gateway/src/db/` → B4（local-auth-settings.ts）、B13（schema.ts）— 不重叠
- `apps/gateway/src/tmux*/` → B11 — 独占
- `apps/gateway/src/system/` → B6 — 独占
- `packages/app/src/lib/` → B6（upgrade-lock/upgrade-process）、B7（upgrade-apply）、B9（totp-uri/hub-user-passwd）、B12（dep-install*）— 不重叠
- `packages/app/src/commands/` → B8 — 独占
- `packages/shared/src/http/` → B1；`/net/` → B5；`/auth/` → B9（encoding/rewrap-totp）+ B10（key-log）+ F10（enrollment）— 不重叠
- `packages/shared/package.json` → B14 — 独占
- `packages/ws-client/` → B15 — 独占
- `apps/fe/src/node/` → F1（mesh-hubs/mesh-nodes/新建）、F10（enrollment*）— 不重叠
- `apps/fe/src/auth/` → B9 — 独占
- `apps/fe/src/pages/settings/nodes/` → F3（https/parts、setup/form-parts、copy-feedback、domain-access-row、direct-section、https-section）、F6（setup/become-hub-form、setup/join-hub-form）、F7（management/node-detail-*）— 不重叠
- `apps/fe/src/pages/settings/remote-access/` → F3（step-shell、status-card）— 独占
- `packages/api-client/` → F2（除 download-transfer）、F4（download-transfer）— 不重叠
- `packages/panels/src/files/` → F4；`packages/panels/src/settings/` → F9 — 不重叠
- `packages/stores/` → F8 — 独占
- `packages/ghostty-terminal/` → F5（selection-clipboard）、G1（canvas-renderer）、G2（terminal-pointer*）— 不重叠
- `*.test.ts` → T1 独占其列出的文件；其余任务只改自己模块的同名测试
- `scripts/complexity/allowlist.json` → X1 独占

**唯一的排序约束：B3 先于 B2**（都碰 `ws/tmux-viewport-handlers.ts` 的 import 行）。其余 22 项两两不相交，可完全并行。

### 优先级建议（若人手有限）

**必做（防止本轮功能改动踩雷）**：G1、B2、B7、B5、B15 —— 五个"离门禁 ≤12 行"的文件，round-22 的性能/颜色改动全在它们身上。
**高价值低风险**：B1（安全边界）、B3+F7+G2+B12（四个破环，各 S）、F2（-220 行）、F1（-160 行）、T1（-620 行测试）。
**安全敏感、需谨慎**：B4（本机免二次验证判定）、B9（TOTP 重封装）、B6（崩溃安全升级器）。
**可延后**：B13、F9、F10、X1。
