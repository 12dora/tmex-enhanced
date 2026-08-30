# O13 结果 — 审查修复：远程访问标签、侧栏离线规则、分屏关闭捕获（前端）

按 `review-fe-3-report.md` 的 1–5 项逐条修复，全部落在指定文件范围内，未动 `apps/gateway`、`packages/app`。

## 1. 拿掉最后一道保护要走同一套暴露确认（review §1）

- `tunnel-model.ts` 新增三个纯函数：
  - `accessEffective(status)`：**后端 `access.effective` 为唯一真相**；旧后端没有该字段时用同一条谓词兜底
    （`configured && enforceJwt && access.hostname && access.hostname === config.hostname`，两边都为空不算匹配）。
  - `isTunnelRunning(status)`：走 `tunnelPill`，接管来的隧道按 `external.running` 判定。
  - `wouldDropLastProtection(status)` = `!loginEnforced && isTunnelRunning && accessEffective`。
- `isExposingAction` 扩到 `remove_access` 与 `set_access_enforce(enforceJwt=false)`（打开校验是收敛动作，不算）。
  于是标签层原有的 `withExposureAck(req, acknowledged)` 包装自动给这两个动作带上 `acknowledgeExposure`。
- `access-step.tsx`：`wouldDropLastProtection` 为真时
  - 「网关校验 Access 令牌」开关上方渲染 `ExposureWarning`（新 `drop` 档）并**锁住开关**直到勾选确认；
  - 「移除 Access 应用」的 AlertDialog 里同样渲染这条警示，确认按钮在未勾选时禁用。
- `exposure.tsx`：`variant` 增加 `'drop'`（文案键 `exposure.dropWarning`）。这一档**无条件渲染**——
  此刻保护还在（`unprotected` 为假），但动作本身会把它拿掉。
- 409 的处理与 start 完全一致：`actions.error` 是共用控制器上的状态，`isExposureAckError` 同时认动作错误与 job 错误，
  状态卡照常把通用错误换成带勾选框的 `ExposureWarning`；`drop` 档自身也会渲染 `-required` 那行提示。

## 2. 关闭非焦点 pane 不再先导航到死 pane（review §2）

- 新增 `packages/terminal-ui/src/components/split/paneCloseTarget.ts`：`PANE_CLOSE_ATTR = 'data-pane-close'` 与
  纯谓词 `isPaneCloseTarget(target)`（只按 `target.closest('[data-pane-close]')` 判定；没有 `closest` 的
  目标——document、文本节点等——一律 false，因此在无 DOM 的 bun test 里可直接单测）。
- `SplitPaneView.tsx`：关闭按钮加 `data-pane-close=""`；pane 根元素的
  `onPointerDownCapture` 改为 `if (!isFocused && !isPaneCloseTarget(event.target))` 才切焦点。
- `use-pane-selection-dispatch.ts`：新增 `routePaneRef`——每次渲染同步成入参，**并在 `navigateToPane` 里立刻更新**；
  `handleClosePane` 改读这个 ref 而不是闭包里的 `windowId/resolvedPaneId`，所以即便同一次点击里已经先发生过一次导航，
  回落判定用的也是当时真正的路由 pane（依赖数组相应去掉 `windowId`/`resolvedPaneId`）。
- 测试：`paneCloseTarget.test.ts`（4 例）覆盖命中 / 未命中 / 无 `closest` 的目标；
  `apps/fe/tests/split-close-pane.spec.ts` 新增
  `desktop: closing a non-focused pane keeps the URL on the focused pane`（四 pane 会话，关非焦点 pane，
  断言 tmux 只剩 3 个 pane、URL 始终停在原焦点 pane、全程无「连接设备中」遮罩）。**按要求未跑 e2e。**

## 3. Access 目标主机名与后端动作契约对齐（review §3）

- `access-model.ts` 把「目标」拆成两个，`access.hostname` 不再参与推导（它只代表已有应用**当前覆盖**的地址）：
  - `accessConfigureHostname(status, draftHostname)` = `config.hostname ?? 向导已确认的草稿`；
  - `accessSyncHostname(status)` = `config.hostname ?? external.hostnames[0]`（与后端一致）。
  - `canApplyAccess(status, drafts, draftHostname)` / `canSyncAccess(status)` 随之改口径：
    **只要存在配置目标主机名（含草稿）就允许「应用」**。
  - 新增 `configureAccessRequest(status, rules, draftHostname)`：`config.mode === 'off'` 且有目标时显式带 `hostname`，
    否则不带（交给服务端用 `config.hostname`）。
- `access-step.tsx` 接收 `draftHostname`（由 `wizard.tsx` 从 `draft.hostname` 传入），应用按钮改用
  `configureAccessRequest`；「先同步」提示里的主机名改用同步目标。
- 访问控制步**仍在创建之前**（后端已支持先为确认的主机名配 Access）。
- 「覆盖主机名」那行只作展示；新增就地提示 `access.app.hostnameMismatch`：`enforceJwt && config.hostname !== null && !effective` 时
  说明「校验不会生效」。隧道还没建（`config.hostname === null`）时**不报不匹配**，避免先配 Access 的正常流程被误伤。

## 4. 侧栏离线规则（review §4）

- `sidebar-node-section.tsx`：
  - `hasSidebarVisibleDeviceForNode` 拆出底层的 `sidebarVisibleDeviceIdsForNode(visibility, runtimeNodeId)`
    （按 `"<nodeId>:"` 前缀取显式 `true` 的 device id；分隔符参与比较，`node-a` / `node-ab` 不互相带出）。
  - 新增纯函数 `offlineSidebarDevices(visibility, runtimeNodeId, knownDevices, selectedDeviceId)`：
    已知设备按可见性过滤，**外加显式打开过显示但已知列表里没有的设备**（名字取不到就用 device id），
    选中的那台无条件保留且不重复。
  - 离线分节的已知设备来源改为 `offlineDevices(runtimeNodeId, inventory)`（本地设备快照优先，其次 node inventory），
    用 `useMemo` 按 node + inventory 记一次（避免每帧读 localStorage 解 JSON）；空态判定改用实际要渲染的行数。
- 效果：mesh 的 inventory 只带版本号也不再让整节消失——已开启显示的远端设备在节点掉线后仍留一行（有快照就显示名字）。
- 测试（`sidebar-device-list.test.tsx`）：`offlineSidebarDevices` 4 例 + `sidebarVisibleDeviceIdsForNode` 1 例；
  渲染用例「已开启显示的设备：node 掉线后分节仍在，拿不到名字就用 device id」（inventory 只有 `{version:3}`）与
  「有本地设备快照时离线行用快照里的名字」。

## 5. Access 徽标与暴露警示（review §5）

- `accessPill` 改为四态：`notConfigured` / `notEnforced` / `hostnameMismatch` / `protected`，
  `protected` 只在 `accessEffective` 为真时出现（`status-card.tsx` 补上新态的 Badge 变体，用 `secondary`）。
- 三语文案（只在 `settings.remoteAccess` 子对象内定点改写 / 新增，未删除任何键）：
  - 新增 `accessState.hostnameMismatch`：「Access 已配置（主机名不匹配）」/「Access configured (hostname mismatch)」/「Access 設定済み（ホスト名不一致）」。
  - 重写 `exposure.warning` / `exposure.warningShort`：改为「当前没有生效的访问保护：隧道地址是公网入口，任何人都可以访问 tmex……」，
    **删掉了「仅在纯局域网 / 可信网络时继续」的表述**（三语都已核对，无残留的局域网/trusted network 说法）。
  - 新增 `exposure.dropWarning`、`access.app.hostnameMismatch`。
- **未跑 `bun run build:i18n`**（生成文件由 commander 统一重建；`t()` 无类型增强，tsc 与本轮测试都不依赖它——
  这批测试断言的是 key 本身）。

## 文件清单

新增：
- `packages/terminal-ui/src/components/split/paneCloseTarget.ts`
- `packages/terminal-ui/src/components/split/paneCloseTarget.test.ts`

改动：
- `apps/fe/src/pages/settings/remote-access/{tunnel-model.ts,access-model.ts,access-step.tsx,exposure.tsx,wizard.tsx,status-card.tsx}`
- `apps/fe/src/pages/settings/remote-access/{tunnel-model.test.ts,access-model.test.ts,remote-access-tab.test.tsx,tunnel-actions.test.ts}`
- `apps/fe/src/components/page-layouts/components/{sidebar-node-section.tsx,sidebar-device-list.test.tsx}`
- `apps/fe/tests/split-close-pane.spec.ts`
- `packages/terminal-ui/src/components/split/SplitPaneView.tsx`
- `packages/panels/src/device-console/use-pane-selection-dispatch.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `settings.remoteAccess` 内定点改写/新增）

（`device-snapshot-store.ts` 只被引用，未修改。）

## 验证

| 项 | 结果 | 基线 |
|---|---|---|
| `apps/fe`：`bun test src/` | **866 pass / 0 fail** | 671（其余为本轮其他 agent 新增） |
| `apps/fe`：`bunx tsc --noEmit -p .` | **0 error** | 0（修复前有 4 个：四份 fixture 缺 `effective` / `bypassAppId`，已补齐） |
| `apps/fe`：`bun test src/pages/settings/remote-access/` | 146 pass / 0 fail | — |
| `packages/panels`：`bun test` / `tsc` | **580 pass / 0 fail**，0 error | 507 / 0 |
| `packages/terminal-ui`：`bun test` / `tsc` | **318 pass / 0 fail**，0 error | — |
| `packages/shared`：`bun test` | 365 pass / 0 fail | 365 |
| `bunx biome check`（全部改动文件 + 三份 locale JSON） | clean | — |

未跑 e2e（按要求），未跑仓库级 formatter，未执行任何改变 git 状态的命令。

## 遗留 / 风险

1. **移除 Access 的确认框内容没有单测**：本目录是 `react-dom/server` 静态渲染，`confirmRemove` 需要点击才进 DOM。
   已覆盖的是同一份 `blocked` 判据在强制开关上的效果（警示在场 + 开关锁住 + 勾选后解锁），
   对话框里的警示与禁用按钮用的是同一个 `dropsProtection` / `blocked` 变量。
2. **`handleClosePane` 的 route ref 没有独立单测**：它是 hook 内的 ref 接线，无 DOM 环境下没法驱动
   「同一次事件里先导航再关闭」；回落算法本身由 `close-pane-fallback.test.ts` 覆盖，端到端行为由新增的
   e2e 用例覆盖（需要 commander 跑 `--project chromium`）。
3. **`accessPill` 在「隧道未建 + Access 已配置」时显示 `hostnameMismatch`**（后端 `effective=false`）。
   为避免误导，步骤里的醒目提示已限定 `config.hostname !== null` 才出现；徽标沿用指挥方指定的文案。
   若希望这种中间态另有一档文案，需要再加一个 key。
4. **后端契约依赖**：前端已按新契约发 `configure_access.hostname`、`remove_access.acknowledgeExposure`、
   `set_access_enforce.acknowledgeExposure`。G9 若把 `remove_access` / `set_access_enforce` 的 ack 判据
   定得比 `!loginEnforced && 隧道运行中 && Access 生效` 更宽，前端会在没渲染确认框的情况下吃到 409——
   此时状态卡仍会把它换成带勾选框的暴露警示，用户勾一次即可继续，不会卡死。
5. 三语 `settings.remoteAccess` 现为各 206 个叶子键（+3），键集合一致；`resources.ts` / `types.ts` 待 commander
   统一 `bun run build:i18n` 重建。
