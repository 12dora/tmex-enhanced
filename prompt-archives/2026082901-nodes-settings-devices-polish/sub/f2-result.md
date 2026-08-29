# f2 结果：角色切换 / 换 hub / HTTPS 分档

## 改动文件

新增 `apps/fe/src/pages/settings/nodes/membership/`：

- `intent.ts` — 跨重启的 `sessionStorage['tmex.setup.intent']` 记号（write / take-and-clear / clear，storage 可注入，无 storage 与抛异常都不影响调用方）
- `role-transition.ts` — 角色切换分类：`none` / `setup`（standalone → mesh，只展开向导） / `leave`（mesh → standalone） / `switch`（mesh → 另一个 mesh 角色）
- `leave-api.ts` — 退出接口的窄边界；实现直接用 api-client 的 `LocalApi.leave()`
- `self-revoke.ts` — 尽力而为的自吊销（签 `revoke-node` → `POST /api/auth/keylog?hub=sync`），五种结局收敛成 `revoked / cancelled / failed`，绝不抛
- `use-leave-mesh.ts` — 退出编排（记号 → 读 `/healthz.startedAt` → 自吊销 → `leave` → `waitForRestart` → 硬跳转 `/settings?tab=nodes`），含 `describeLeaveError`
- `leave-dialog.tsx` — 三种确认文案（退出 / 换角色 / 换 hub）+ 进度（leaving / restarting / restartTimeout）
- 测试：`intent.test.ts`、`role-transition.test.ts`、`self-revoke.test.ts`、`use-leave-mesh.test.ts`

修改：

- `local-machine-card.tsx` — 角色行由只读 Badge 换成 `Select`（三个角色）；纯 node 的 hub 地址行加「更换 Hub」；删掉 `/nodes` 入口（保留账号安全）；挂上 `LeaveDialog` 与凭据对话框；新增 prop `onSelectSetupPath`
- `nodes-tab.tsx` — 持有 `wizardPath` 状态传给 `HubSetupWizard`（换 `key` 重新挂载，`initialPath` 只在首挂生效）；standalone 挂载时读取并清掉 intent 记号；切到向导时 `scrollIntoView`；mesh 下 `HttpsSection disabled={role === 'node'}`（**未触碰** f1 拥有的 `NodesManagement` import 与 JSX 两行）
- `https/https-section.tsx` — 新增 `disabled` prop：`CardContent` 加 `pointer-events-none opacity-60` + `aria-disabled`，正文只留一句 `nodes.https.nodeRoleHint`，卡片头保留
- `https/use-tls-status.ts` — `useTlsStatus(api, { enabled })`，关掉时不发 `GET /api/tls`，`loading` 也不再恒为 true
- `setup/browser-location.ts` — 抽出 `assignLocation`，新增 `navigateToSettingsNodes()`（硬跳 `/settings?tab=nodes`）
- 测试：`local-machine-card.test.tsx`、`nodes-tab.test.tsx` 扩充；三处 `tls: { mode: 'none' }` fixture 补上后端刚加的 `listenerRunning` / `tlsPort`（`local-machine-card.test.tsx`、`nodes-tab.test.tsx`、`setup/hub-setup-wizard.test.tsx`）

## 实现的流程

1. **standalone → node / hub,node**：不调任何接口，`NodesTab` 把对应向导路径展开并滚动到位。
2. **mesh → standalone**：确认框讲清后果 → 纯 node 先尽力自吊销（失败/取消只出警告，不阻塞）→ `POST /api/local/leave { expectedRole }` → 等 `/healthz.startedAt` 变化 → 整页跳 `/settings?tab=nodes`。
3. **mesh → 另一个 mesh 角色**：先写 `tmex.setup.intent = become-hub | join-hub`，再走同一条退出流程；重启刷新后 standalone 的 `NodesTab` 读取并清掉记号，向导直接开在那条路径上。
4. **换 hub（纯 node）**：hub 地址行的「更换 Hub」→ 确认框说明「先退出再用新的加入码加入」→ intent `join-hub` + 退出流程；不预填任何秘密。
5. **hub,node**：hub 公开地址保持只读，角色下拉照常可用。

## i18n

三个语言文件（zh_CN / en_US / ja_JP）同步：

- 新增 `nodes.membership.*`（16 个顶层键）：`changeHub`、`confirm`、`cancel`、`consequences`、`leaveConfirm.{title,description}`、`switchConfirm.{title,description}`、`changeHubConfirm.{title,description}`、`leaving`、`restarting`、`restarted`、`restartTimeout`、`revokeFailed`、`revokeSkipped`、`leaveFailed`、`errorDetail`、`errors.{notMember,roleMismatch,setupInProgress,envWriteFailed,unauthorized}`
- 新增 `nodes.https.nodeRoleHint`
- 删除 `nodes.machine.openNodesPage`（`/nodes` 整页由 f1 移除）

按要求**没有**跑 `build:i18n`：`packages/shared/src/i18n/resources.ts` / `types.ts` 仍是旧的生成产物，新键要等谁在收尾时重新生成一次才会真正显示（`types.ts` 里还留着 `nodes.machine.openNodesPage`）。

## leave 接口

用的是 **api-client 的 `LocalApi.leave()`**（写代码时后端 agent 已经落地 `packages/api-client/src/local/local-api.ts` 的 `leave()` 与 `LocalLeaveRequest/Response`，同时补齐了 `LocalTlsStatus.listenerRunning/tlsPort`）。本地 `membership/leave-api.ts` 只保留一个窄接口 + `defaultLeaveApi = defaultLocalApi`，方便注入替换。

自吊销走的是**现有的签名路径**（`buildRevokeNodeRecord` + `api.appendKeyLog(..., { hubSync: true })`，即 `POST /api/auth/keylog?hub=sync`），与原 `nodes-table.tsx` 的吊销一致；没有 `POST /api/hub/nodes/:id/revoke` 这条前端路径，也没有从 f1 的 `management/` 里 import 任何东西。

## 验证

- `cd apps/fe && bun test src/` → **551 pass / 0 fail**（44 文件；含本批新增 22 个用例）
- `bunx tsc --noEmit -p .` → **0 error**
- `bunx biome check <改动文件>` → 干净
- 未跑 Playwright e2e；未跑 `build:i18n`；未执行任何 git 命令

## 遗留 / 注意

- **需要有人跑一次 `bun run build:i18n`**，否则新增文案在运行时取不到（键名会原样显示）。
- 退出成功后是硬跳转 `/settings?tab=nodes`；`SettingsPage` 目前不解析 `?tab=`（探索文档 §1 已记录），落地页会回到 general 标签，需要另一个 agent 补 query 解析才算完整。
- 用户在凭据对话框里取消自吊销时按「跳过」处理，退出继续（提示 `nodes.membership.revokeSkipped`）；若产品希望取消即中止退出，改 `use-leave-mesh.ts` 里 `cancelled` 分支即可。
