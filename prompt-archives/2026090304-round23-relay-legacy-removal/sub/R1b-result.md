# R1b 结果：canonical v1.1 客户端/shared 复审修复 + 定向 e2e

## 一、复审项逐条结论

### 1. 树顺序被 Unset 后退不回 tmux 顺序 —— **真 bug，已修**

**验证**：`ingestMetadataPatch` 把增量 diff apply 在 **已排序** 的 `state.snapshot` 上，再拿
`sortSnapshotByCanonicalTreeOrder` 排一次。顺序表被全量 `Unset` 后 `order.windows.size === 0`，
排序函数原样返回入参——而入参正是上一次排好的自定义顺序，于是顺序永久粘住；部分改动时未带序号的实体
也会继承上一次的自定义位置而不是 tmux index 位置。

**修法**（采用任务书首选方案「保留未排序底稿」）：
`DeviceMetadataState` 新增 `baseSnapshot`（未排序的 canonical 投影，tmux index 顺序），
diff 只作用在 `baseSnapshot` 上，`snapshot` 每次由 `baseSnapshot + treeOrder` 重算。
顺序表为空时 `snapshot === baseSnapshot`（同引用，下游仍可跳过重算）。

- `packages/ws-client/src/canonical-state-helpers.ts`：`DeviceMetadataState` 加 `baseSnapshot`
- `packages/ws-client/src/canonical-metadata-identity.ts`：`assembleDeviceMetadata` / `ingestMetadataPatch`

**测试**：新增 `packages/ws-client/src/canonical-tree-order-state.test.ts`（4 例）——
「首帧按 tmux index 顺序」「设顺序 → 部分 Unset → 全量 Unset 回到 tmux 顺序」「pane 顺序同样可完整退回」
「底稿保持 tmux 顺序、展示视图才带自定义顺序」。已用「临时改回旧写法」验证过这组用例确实会红
（旧写法下 2/4 失败，正是 Unset 两例）。

### 2. 老对端被拒没有变成 `server-too-old` —— **真 bug，已修**

**验证**：网关 `apps/gateway/src/ws/index.ts:handleHello` 对低版本对端回
`ERROR_UNSUPPORTED_PROTOCOL` + message 前缀 `canonical-state-v1.1 required` 后直接 close(1002)。
客户端这条 ERROR 只被翻成 `transport-error`（stores 里没有对应 toast），且 close 后照常按退避重连，
每次都被同样拒绝。**未改任何 gateway 文件**，前缀契约保持不变。

**修法**：

- `packages/shared/src/ws-borsh/canonical-version.ts` 新增共享契约（网关侧后续可直接复用）：
  `CANONICAL_V11_REQUIRED_ERROR_PREFIX`、`isCanonicalV11RequiredError(code, message)`；barrel 已导出。
- `packages/ws-client/src/transport-message-decoder.ts`：KIND_ERROR 命中该匹配器时发
  `{ type: 'server-too-old', minVersion: CANONICAL_V11_MIN_PEER_VERSION, serverVersion: null }`，
  其余 ERROR 行为不变。
- `packages/ws-client/src/websocket-transport.ts`：`serverVersion` 为 null 时用本连接协商到的版本补齐
  （被门槛拒时通常还没收到 HELLO_S2C，仍是 null）。
- `packages/ws-client/src/client.ts` + 新文件 `protocol-fatal.ts`：收到该 ERROR 置 `protocolFatal`
  并 `reconnector.cancel()`；`handleClose` 直接进 `CLOSED` 不排重连；visibilitychange 的
  「CLOSED 时自动重连」也被该标记挡住；只有调用方显式 `connect()` / `reconnect()` 才清标记。

**测试**：
- shared `canonical-version.test.ts` +2 例（前缀值、只认 UNSUPPORTED_PROTOCOL + 前缀开头）；
- ws-client `transport-message-decoder.test.ts` +2 例（翻成 server-too-old / 同码不同 message 仍是 transport-error）；
- ws-client `client.test.ts` +2 例（门槛拒绝后不再自动重连、显式 connect 仍放行；普通 ERROR 不影响重连）。

### 3. shared 仍导出已删除的 legacy wire contract —— **属实，已删**

删除的 kind（编号**永久作废**，`isValidKind` 不再认，网关对它们与任何未知 kind 一样回 `ERROR_UNKNOWN_KIND`）：

`0x0208 STATE_SNAPSHOT`、`0x0209 STATE_SNAPSHOT_DIFF`、`0x020D TMUX_SUBSCRIBE_PANES`、
`0x020E TMUX_FETCH_PANE_HISTORY`、`0x0303 TERM_RESIZE`、`0x0304 TERM_SYNC_SIZE`、
`0x0305 TERM_OUTPUT`、`0x0306 TERM_HISTORY`、`0x0401 SWITCH_ACK`、`0x0402 LIVE_RESUME`。

连带删除的 schema / 编解码：`StateSnapshotSchema`、`StateSnapshotDiffSchema`、`PaneWireSchema`、
`WindowWireSchema`、`SessionWireSchema`、`TermOutputSchema`、`TermHistorySchema`、`TermResizeSchema`、
`TermSyncSizeSchema`、`SwitchAckSchema`、`LiveResumeSchema`、`TmuxSubscribePanesSchema`、
`TmuxFetchPaneHistorySchema` / `...LegacySchema` / `TmuxFetchPaneHistory` / `decodeTmuxFetchPaneHistory`、
`encodeTermOutputFrame`、`decodeTermOutputView` / `TermOutputView`、`encodeStateSnapshot` / `decodeStateSnapshot`
及 convert.ts 里的 session/window/pane wire 转换。**保留**：`StateSnapshotPayload` 类型与
`applyLegacyStateSnapshotDiff` / `sourceMetadataPatchToLegacyDiff` 等 canonical 客户端仍在用的投影助手。
`KIND_TMUX_RESIZE_PANE`(0x020F) 是 splitter 拖拽用的布局命令，**不属于本次删除范围，保留**。

`kind.ts` 头部加了作废号段清单注释，防止将来复用。

全仓引用修复：
- `packages/ws-client/src/transport-message-decoder.test.ts`、`websocket-canonical-gate.test.ts`：常量没了，改按裸数字断言（并把断言扩到全部 10 个作废号）。
- `packages/shared/src/ws-borsh/codec-view.test.ts`：envelope 视图用例改用 `ClipboardWriteSchema` 构造 payload（本组只验帧头解析）；删 TERM_OUTPUT 视图解码用例。
- `packages/shared/src/ws-borsh/codec-fused.test.ts`：删 fused TERM_OUTPUT 编码对拍，保留 canonical PaneData 部分。
- `packages/shared/src/ws-borsh/convert.test.ts`：删 StateSnapshot round-trip 组。
- 删除 `packages/shared/src/ws-borsh/tmux-fetch-pane-history.test.ts`（整文件都是已删 schema）。
- `packages/shared/bench/ws-wire-path.bench.ts`：删 legacy TERM_OUTPUT 对比段，1 MiB 入站解码改用 CANONICAL_EVENT 裸帧。跑通（canonical 编码 83.7x、解码 55.3x、入站 47.7x）。
- `apps/gateway/bench/envelope-view.bench.ts`：改用 CANONICAL_EVENT 裸帧。跑通（207x）。
- `scripts/hub-e2e/driver/terminal.ts`：见第三节（改成 canonical 通路）。
- **`apps/gateway/src/**` 一行未改**——`bunx tsc --noEmit -p apps/gateway` 0 error，网关侧没有残留引用，不需要做「最小 import 删除」。

文档：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`
- kind 编号表删掉这 10 行（「切换屏障」小节整节移除），表头加一句指向作废清单；
- 新增 `## 1.1.23 移除的 kind（号段作废）` 小节，逐条给出替代通路（metadata / SetPaneSubscriptions /
  RequestScreen·RequestHistory / ResizePaneV11 / PaneData·Screen·History 事务 / SubscriptionApplied 游标），
  并写明版本门槛与 `canonical-state-v1.1 required` 前缀契约；v1 其余正文未动。
- 仓库自带的 `kind-doc-drift.test.ts`（代码 kind 表 ↔ 文档 kind 表双向对账）已重新变绿。

### 4. pane 移除时 `sizeEpoch` 条目不回收 —— **真 bug，已修**

`applyPaneRemoval` 只清 `paneEpochs`，`realizeIdentityAction` 的 `pane-removed` 分支只清
`terminalCursors` / `blockedPanes` / pending，`CanonicalSizeEpochs` 只有整设备清理（`clearPaneStateForDevice`）
和整体 `clear()`。同一设备上反复开关 pane，账本会随会话寿命单调增长。

修法：`MetadataLiveCaches` 加 `dropSizeEpoch(deviceId, paneId)`，`pane-removed` 分支调用；
`CanonicalSizeEpochs.dropPane()` 删条目但**不回退 `next` 计数器**（同名 pane 重现时仍拿更大的 epoch，
网关的单调过滤不会误丢）。

测试：新增 `packages/ws-client/src/canonical-size-epochs.test.ts`（4 例，含 dropPane 后计数器不回退）；
`canonical-metadata-identity.test.ts` 的 patch 用例补断言 `droppedSizeEpochs === ['device-a:%gone']`。

## 二、e2e 逐条结论

统一命令（`apps/fe` 目录下）：
`TMEX_E2E_GATEWAY_PORT=9765 TMEX_E2E_FE_PORT=9985 bun run scripts/run-e2e.ts <specs>`

### 5. 主题 10 例 + `ws-borsh-theme-resize:89` —— **已修，11/11 通过**

真因如复审所述：`apps/fe/tests/helpers/site-theme.ts` 的裸 WS HELLO 报 `clientVersion: '0.0.0'`，
被网关 fail-closed 版本门直接拒绝并关连接，`setSiteTheme()` 永远等不到广播 → 所有依赖它做
setup/cleanup 的主题用例超时。改成 `wsBorsh.CANONICAL_V11_MIN_PEER_VERSION`。

```
theme-broadcast theme-notify-2031 theme-presets theme-propagation ws-borsh-theme-resize
→ 11 passed (55.1s)
```

### 6. `viewport-policy.spec.ts:77 / :128` —— **既有失败，不是本轮回归；真因已定位，需产品决策**

**证据**：写了一次性调试 spec 抓两端 WS 帧（已删除）。两个客户端 A(1600×1000)、B(640×480)
连同一设备，最终下发的 `TERM_VIEWPORT_POLICY`：

```
A < POLICY ... owner=00 cols=0x004b(75) rows=0x0017(23)
B < POLICY ... owner=01 cols=0x004b(75) rows=0x0017(23)
tmux pane 实际尺寸 = 75x23
```

即**小客户端 B 拿到 owner**，整窗被缩到 B 的几何，A 变 follower。这与 spec 的断言
（「小客户端不缩窗、自己本地平移」）正好相反：`readPanState(pageB).enabled` 恒为 false
（`viewportPan = visible && !owner`），:98 / :142 必然超时。`:93` 之所以先过，是因为
`sizeA` 是在 B 已经赢下之后读的 A 终端尺寸，两边都已是 75×23。

**根因**：`apps/gateway/src/ws/viewport-policy.ts` 的 `resolveWinner` 明确按
「可见客户端中**列数最小**者持有整窗尺寸」仲裁（注释也是这么写的），与 spec 期望的
「最大者持窗、小的平移」是两套语义。二者只能改一边，属产品/设计取舍。

**与本轮无关的佐证**：`resolveWinner` / `viewport-policy.ts` / `terminal-stage.tsx` /
`packages/stores/src/viewport-policy.ts` 相对 `main` **零改动**（`git diff main...HEAD` 确认）；
round21 的 `sub/E2E2-result.md` 已记录「`viewport-policy:77/128` 仍失败（main 上同样失败）」。
也**不是** R1a 正在修的 `distrustLive` 问题——失败发生在策略归属，不在几何下发。

**遗留给指挥官**（我未改，gateway 不在我的 scope，且这是语义取舍不是 bug 修复）：
二选一 —— (a) 把 `resolveWinner` 改成「列数最大者持窗」（会影响窄屏溢出行为，需回归
`single-pane-window-switch-resize`、`ws-borsh-theme-resize`、移动端拼接布局）；
(b) 按现行「最小者持窗」重写 `viewport-policy.spec.ts` 的两例（A/B 角色对调）。

### 7. `terminal-mouse-recovery.spec.ts:411` —— **负载敏感 flake，非回归，未改代码**

- 定向单跑（改动前）：2/2 通过；整文件单跑：7/7 通过。
- 8 个 spec 合跑（高负载）：该例失败一次。
- 改动后再定向单跑 5 次：**1 失败 / 4 通过**（隔离下也会偶发）。

断言是 `readCanvasInkRatio(page) > baseline * 0.8`，依赖 opencode TUI 在 5s 内重绘完；
与 L1d 删 legacy 首屏恢复无关（canonical 首屏事务在同文件其余 6 例里全绿，
含 `opencode refresh should not render pre-launch normal screen` 等专门验证首屏的用例）。
维持 round21 的既有 flake 归类。

### 8. 两个改写 spec 的加固 —— **已做，通过**

- `ws-borsh-switch-barrier.spec.ts:91`：原来只断言最终订阅集合含第一个 pane——第一个 pane 在
  60s 保活期内本就一直在订阅里，第二次点击失效也照样通过。补上
  `page.waitForURL(包含 firstPane)` + `window-item-<firstWindow>` 有 `data-active="true"` +
  `window-item-<secondWindow>` 没有，选中态真的落回第一个窗口才算过。
- `ws-borsh-resize.spec.ts:263`：原来只断言补发的 `sizeEpoch > 0n`。改为先做一次**受控的真实尺寸变化**
  （`page.setViewportSize`）并抓下它用掉的 epoch，再制造「本地模拟器变小但容器没变」的陈旧态，
  focus 后断言**每一条 reason=RESEND 的命令 sizeEpoch 严格等于**那个 change 的 epoch。
  （原写法把 `term.resize()` 当成受控 change 是不成立的：直接改模拟器不触发上报，
   这正是该用例要构造的「尺寸没变但画面陈旧」场景。）

## 三、附带修复（在 scope 内、不修就会断的）

### `scripts/hub-e2e/driver/terminal.ts` 改走 canonical

该 docker hub e2e driver 整条链路建在 legacy 上（STATE_SNAPSHOT → TMUX_SUBSCRIBE_PANES →
TERM_OUTPUT/TERM_HISTORY），且 HELLO 报 `clientVersion: '1.0.2'`——**在本轮 L1b 落地版本门之后它已经跑不通**，
再加上符号被删会让 `scripts/hub-e2e/build-driver.sh` 直接打包失败。已整体改成 canonical：

- HELLO 用 `wsBorsh.CANONICAL_V11_MIN_PEER_VERSION`；
- HELLO 后先发一条空 `SetPaneSubscriptions` 打开状态流（与前端一致），再 DEVICE_CONNECT；
- 从 `SourceMetadataSnapshot` / `SourceMetadataPatch` 的记录里挑第一个带 pane 的 window（记录顺序即 tmux index 顺序），同时留下 `serverEpoch`；
- 订阅目标 pane（`SetPaneSubscriptions`，generation 单调递增），并发 `RequestScreen` 取首屏；
- `PaneData` → `outputChunks`，`ScreenBegin/Chunk/Commit` 组装出的首屏 → `historyChunks`
  （`seq.ts` 的 history/output 归因语义因此保持不变）；
- TMUX_SELECT / TERM_INPUT / TERM_PASTE 三个 kind 网关仍支持，原样保留。

`bash scripts/hub-e2e/build-driver.sh` 打包通过（terminal.js 104.88 KB）。**无法在本机实测**（要 docker 多容器 harness），
请指挥官在下次跑 hub e2e 时留意。

### 复杂度门禁：`client.ts` 拆分

`packages/ws-client/src/client.ts` 在我接手前已是 **839 行 > allowlist 826**（本轮 L1c 的 +13 造成，
门禁当时就在红），我又要加 protocolFatal 逻辑。按「不新增 allowlist 条目、只降不升」的规矩做了三处等价抽取：

- 新 `heartbeat-cadence.ts`：`resolveHeartbeatCadence()` 抽成纯函数（前后台基准 + 协商间隔合成）；
- 新 `handler-fanout.ts`：`notifyHandlers()` 统一 4 处「逐个回调 + 吞异常 + 打点」循环；
- 新 `client-version.ts`：宿主注入的默认 clientVersion（client.ts 原样再导出，外部 import 路径不变）；
- 另把 4 处重复的「清空协商结果」收敛成 `resetNegotiatedServerState()`。

结果 `client.ts` 839 → 804 行（< 826，**门禁这一条彻底清掉**）。
`canonical-state-client.ts` 因 `dropSizeEpoch` +1 行会顶破 741，用
`CanonicalSizeEpochs.forGeometry(deviceId, paneId, change)` 把发送侧的三行三元表达式收成一行，回到 739。

## 四、验证

| 检查 | 结果 |
|---|---|
| `packages/shared && bun test` | **616 pass / 0 fail**（61 文件） |
| `packages/ws-client && bun test` | **392 pass / 0 fail**（32 文件） |
| `packages/stores && bun test` | **411 pass / 0 fail** |
| `packages/terminal-ui && bun test` | **394 pass / 0 fail** |
| `packages/panels && bun test` | 911 pass / 0 fail |
| `apps/fe && bun test src/` | **1864 pass / 0 fail** |
| `tsc --noEmit` shared / ws-client / terminal-ui / apps/fe / **apps/gateway** | 0 error |
| `tsc --noEmit` stores | 1 error（`host-services.test.ts:93`，来自并发 agent 改的 `packages/api-client/src/local/types.ts`，非本任务） |
| `bunx biome check` 本任务全部改动文件 | 干净（含 `apps/fe/tests` 三个文件，未跑 --write） |
| `bun run lint`（biome 全仓） | 14 处 format/organizeImports，**全部在他人文件**：`apps/fe/src/main.tsx`、`apps/gateway/src/{auth,mesh,relay}/*`、`packages/app/src/*`、`packages/shared/src/relay/join-token.test.ts` |
| `bun scripts/complexity/gate.ts` | 5 violation，**全部他人文件**（`mesh/relay-uplink-client.ts`、`relay/integration/relay-mesh-harness.ts`、`packages/app` ×3）；本任务两文件已清掉，未加 allowlist |
| `bun packages/shared/bench/ws-wire-path.bench.ts` / `bun apps/gateway/bench/envelope-view.bench.ts` | 均跑通 |
| `bash scripts/hub-e2e/build-driver.sh` | 打包通过（产物已删，driver-dist 本就 gitignore） |

定向 e2e（`apps/fe`，`TMEX_E2E_GATEWAY_PORT=9765 TMEX_E2E_FE_PORT=9985 bun run scripts/run-e2e.ts …`）：

```
theme-broadcast theme-notify-2031 theme-presets theme-propagation ws-borsh-theme-resize
  → 11 passed (55.1s)

ws-borsh-resize                       → 6 passed (23.0s)
ws-borsh-switch-barrier + ws-borsh-resize → 8 passed (35.5s)
terminal-mouse-recovery（整文件）      → 7 passed (22.0s)

八 spec 合跑（theme×5 + ws-borsh-resize + ws-borsh-switch-barrier + terminal-mouse-recovery）
  → 25 passed / 1 failed (1.8m)，唯一失败 = terminal-mouse-recovery:411（既有 flake，见第 7 条）

viewport-policy                       → 0 passed / 2 failed（既有失败，见第 6 条）
```

未跑全量（按任务书要求）。未碰生产 tmex（9883 / `~/Library/Application Support/tmex`），
未碰默认 socket 上名为 `tmex` 的 session；e2e 全部走 `tmux -L tmex-e2e` 隔离 socket。

## 五、需要指挥官处理

1. **`viewport-policy.spec.ts:77/128` 的语义取舍**（第 6 条）：改网关 `resolveWinner` 还是改 spec，
   二选一。我已把证据（两端 POLICY 帧 owner 位）留在上面，未动任何一边。
2. **hub docker e2e driver 未实测**：`scripts/hub-e2e/driver/terminal.ts` 已按 canonical 重写并打包通过，
   但本机无法跑 docker harness，下次跑 hub e2e 时请留意 `--capture-seq` 的 history/output 归因是否符合预期。
3. **spec 文档的 payload schemas 小节**：已删 kind 对应的 payload 结构描述仍留在
   `## payload schemas（完整）` 里（任务书要求 v1 正文冻结，我只在其前面加了「1.1.23 移除的 kind」小节点明作废）。
   如果希望把这些段落也清掉，请明确，我不擅自改冻结正文。
4. **`packages/stores` 的 1 个 tsc error** 与 **lint/复杂度门禁的 19 条违规** 全部来自并发 agent
   （relay / packages/app / apps/fe main.tsx），合并前需要他们各自清掉。
5. `apps/fe/tests` 目录我只跑了 `biome check`（不 write），保持既有 lint 现状。
