# F4 结果 — 收尾清理（meta-key 欠账提到宿主级、中继文案、死壳、注释、健康探测自拨、fixtures）

## 1. meta-key 欠账重试提到宿主级

原先 `useAutoRetryMetaKey` 只活在设置页-节点标签里，页面一关就不再重发。现在拆成两块：

| 文件 | 作用 |
| --- | --- |
| `apps/fe/src/node/relay-meta-key-retry.ts`（新，162 行） | 回路本体 `startRelayMetaKeyRetry(options)` + 外壳入口 `startRelayMetaKeyRetryForMode(mode)` |
| `apps/fe/src/node/relay-meta-key-resident.tsx`（新，44 行） | 外壳组件 `RelayMetaKeyResident`，`relayFlowModeOf()` 把 `AuthModeResponse` 收成 `RelayFlowMode` |
| `apps/fe/src/main.tsx` | `MeshNodesResident` 旁多挂一行 `<RelayMetaKeyResident />` |
| `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts` | 删掉本地 `useAutoRetryMetaKey`，`metaPending` 改为直接 `useSyncExternalStore` 订阅欠账 store；清掉随之无用的 `mesh-relay` / `useEffect` / `useRef` 引入。手动重试按钮与告警条逻辑不动 |

回路语义：

- **武装条件**：挂上中继（`attachedRelay() !== null`）**且**存在带已签字节的欠账。没有字节的那条必须重新签，需要凭据 —— 宿主级不弹窗，继续留给设置页的告警条（这也是 `armKey` 只由带 `record` 的 id 集合组成的原因）。
- **触发**：挂上中继的那一刻，以及欠账集合变化时；同一批 id 不重开退避，避免每次 store 通知都把计时器往前拽。
- **退避有上限**：`[1s, 5s, 20s, 60s]`，走完停手，等下一次「挂上中继」或欠账变化再来一轮，不会打进死循环。
- **中继链路轮询**：欠账存在期间取用 `acquireMeshRelayPolling()`（引用计数的宿主级单例，与设置页共用一条回路），否则设置页不开时根本看不到「挂上了」；欠账清空即归还，稳态零额外轮询。
- **锁**：仍用 `enrollment-engine` 的 `withKeyLogLock`，与 admit / revoke 抢同一个 key log 头。

**注意（踩到过的坑）**：回路必须走**动态** `import()`。第一版把 `relay-meta-key-retry` 静态挂进 `main.tsx`，`enrollment-engine.ts` 就进了首屏静态 import 图，`src/i18n/core-coverage.test.tsx` 两个守卫用例当场失败（`nodes.enrollment.*` 属于 rest 包，首屏会渲染出裸 key）。现在组件里是 `void import('./relay-meta-key-retry')`，effect 里带 `cancelled` 标记与 `stop?.()` 清理。

测试：`apps/fe/src/node/relay-meta-key-retry.test.ts`（6 例，注入假 `delay` / `retry` / `acquirePolling`，无真实等待）——按退避重发并在落账后收工、未挂中继不动手、无字节的欠账不自动重发、退避上限恰为 `backoff.length` 次、欠账期间取用轮询并在清空后归还、`stop()` 后不再排新的重试。

## 2. 接入区块的中继文案

- `use-create-enrollment.ts` 的 `CreateEnrollmentState` 多出 `relayMode: boolean`（它本来就在读 `useMeshRelay()`，不必再加一个 hook / prop）。
- `enrollment-section.tsx` 据此选 key：`missingHubUrl` → `missingRelayUrl`、`hubNotConfirmed` → `relayNotConfirmed`。`retryHub`（「重试」）文案本身与角色无关，未动。
- 新增三语 `nodes.enrollment.relayNotConfirmed` / `nodes.enrollment.missingRelayUrl`；zh 为「中继未确认，本次没有写入任何内容，可直接重试。」「中继地址不可用，无法生成加入命令。」已跑 `bun run build:i18n`。
- 顺带：为过复杂度门禁把待确认行抽成同文件内的 `PendingRow`（`EnrollmentSection` 从 155 行降回 129 行；allowlist 上限 152，未加新条目）。
- 测试：`apps/fe/src/pages/settings/nodes/management/enrollment-section.test.tsx`（2 例，静态渲染断言 hub / 中继两套 key）。

## 3. 删死壳

`apps/gateway/src/ws/index.ts` 的 `WebSocketServer.scheduleTmuxThemeApply` / `broadcastSiteThemeUpdateS2C` 两个纯转发方法，全仓 grep 只有 `theme-settings-broadcaster.ts` 里的**实现**（其内部自调用，保留），没有任何生产调用方，也没有测试打它们 —— 已删（823 → 815 行）。

## 4. spec 改名

`apps/fe/tests/ws-borsh-switch-barrier.spec.ts` → `ws-borsh-pane-switch.spec.ts`（内容逐字不变）。文档引用同步：`docs/known-issues.md:10`、`docs/terminal/2026021404-terminal-switch-barrier-design.md:12,95`。`playwright.config.ts` 只用正则匹配（`mesh-*`），无需改。`prompt-archives/` 里的历史记录未动。

## 5. 过时注释 —— 无需改动（已被上一轮修掉）

- `packages/ghostty-terminal/src/terminal.ts:400` 现为「用于 canonical 首屏快照写入等需要内容立即可见的场景」，全文件 grep 不到 `onApplyHistory`/`history`。
- `packages/panels/src/device-console/use-pane-size-sync.ts:48` 现为「不得发普通的 ResizePane 尺寸声明」，全文件 grep 不到 `TERM_RESIZE`。该文件头部注释里的 `fetchPaneHistory` / `TMUX_SELECT` 两个符号**仍然存在**（`packages/stores/src/tmux-window-actions.ts`、网关仍接受 `TMUX_SELECT`），不是死引用。

两个文件都未修改。

## 6. 健康探测自拨

`apps/gateway/src/mesh/relay-uplink-http.ts` 的 `probeRelayHealth` 增加第 4 个参数 `dial: RelayDialContext = relayDialContextFromEnv()`，内部先 `resolveRelayDialUrl(publicUrl, dial)` 再拼 `/api/relay/health`，TLS CA 走 `relayTlsCaForDial(dialUrl, tlsCa)`（回环不带自签 CA）—— 与 `RelayUplinkClient.connectOnce` 完全同一条改写。

**与任务书的出入**：调用方不是 `uplink-pool.ts`，而是 `apps/gateway/src/mesh/relay-wiring.ts:145`（`probeHealthz` 钩子）。因为新参数带默认值且不改签名形状，`relay-wiring.ts` / `uplink-pool.ts` **一个字都不用动**（两者也都不在我的 scope 里），`relay,node` 机器现在探自己的中继会自动走 `http://127.0.0.1:<port>`。

测试：`apps/gateway/src/mesh/relay-uplink-http.test.ts`（5 例：自拨走回环、回环不带 CA、别人的中继照旧走公网并保留 CA、非 2xx 与网络错误判不健康、`relayUplinkWsUrl` 协议/路径改写）。

## 7. fixtures 与「节点占用」

- `relay-status-store.test.ts` / `relay-tab.test.tsx` 的 `RelayTotals` fixture 补 `nodes`（tsc 的两个 TS2741 已消）。
- `relay-cards.tsx` 的总量卡在「租户」与「在线节点」之间插入一行「节点占用」（`relay.admin.totals.nodes`，testId `relay-totals-nodes-used`；在线节点原 testId `relay-totals-nodes` 保持不变）。三语新 key：节点占用 / Nodes in use / 使用中ノード。
- `relay-tab.test.tsx` 增加对两行 testId 的断言。`relay-format.ts` 无需改动。

## 验证

| 项 | 结果 |
| --- | --- |
| `bunx tsc --noEmit -p apps/fe` | **0 错**（基线 2 错，即第 7 项的 fixture，已修） |
| `bun test src/`（apps/fe） | **1976 pass / 0 fail**（113 文件；基线 1968，本次 +8） |
| `bun test`（apps/gateway） | **4198 pass / 0 fail / 2 errors**（378 文件，207 s） |
| `bun test src/mesh src/ws`（apps/gateway，定向） | 1450 pass / 0 fail / 0 error |
| `bunx biome check <18 个改动文件>` | 干净 |
| `bun scripts/complexity/gate.ts` | 我这边 0 违例（`EnrollmentSection` 已拆回 129 行） |

未跑 Playwright e2e（按规则由指挥官跑）。

## 需要指挥官处理

1. **`bunx tsc --noEmit -p apps/gateway` 有 2 个错，都不是我的改动**（在途的 P1/P2 文件）：
   - `apps/gateway/src/relay/relay-pack-http.ts:208` — `member.op` 是 `string`，目标要 `RelayKeylogMemberOp`（P1）。
   - `packages/app/src/lib/native-datachannel.ts:135` — import 路径以 `.ts` 结尾，需开 `allowImportingTsExtensions` 或改写（P2）。
2. **复杂度门禁还有 5 条违例，全在 P1 的文件**：`apps/gateway/src/mesh/relay-pack-routes.ts:70 handleMeshRelayPack` CC 16、`apps/gateway/src/relay/relay-runtime.ts:208 routePublic` CC 23、`packages/app/src/lib/relay-password-join.ts:256 performRelayPasswordJoin` CC 24 且 175 行、`packages/shared/src/relay/relay-pack.ts:261 kdfParamsFromWire` CC 19。
3. **网关全量的那 2 个 “Unhandled error between tests”**：`LinkError: relay-rst`，栈在 `packages/shared/src/link/mux.ts:247 abort` ←`handleRst`，由 `apps/gateway/src/relay/**` 的用例触发（定向跑 `src/mesh src/ws` 为 0 error）。0 fail，但属于 P1 区域的未捕获拒绝，值得让 P1 看一眼。
4. **仍用 Hub 口径的两处文案在我的 scope 之外**，建议后续（或 F3）顺手接上新 key：
   - `apps/fe/src/node/enrollment-engine.ts:601` — admit 失败的 toast 固定用 `nodes.enrollment.hubNotConfirmed`。
   - `apps/fe/src/components/side-panels/connect-devices/join-token.tsx:376,461` — 「接入更多设备」面板同样固定 hub 口径。它已经在用 `useCreateEnrollment`，现在只要读 `create.relayMode` 就能切 key，两行改动。
5. **i18n 三语 key 集合有 5 处历史差异**（en 有 `_one`/`_other` 复数形式而 zh/ja 只有单形：`devices.folders.itemCount`、`nodes.revoke.bulkConfirm`、`nodes.revoke.bulkDone`、`nodes.uninstall.summary`、`nodes.upgrade.confirmAll`）。是既有状态，本次未碰。
6. 三个 locale JSON 我是**整文件重写**（python 读 JSON → 加 key → 写回，`indent=2`、`ensure_ascii=False`，biome 检查干净）。如果同期有别的 agent 也在改这三个文件，请在合并时确认没有互相覆盖。
