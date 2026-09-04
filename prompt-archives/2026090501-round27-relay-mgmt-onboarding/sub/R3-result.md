## 缺陷

1. **高：自建中继流程缺少“接入本机中继”步骤，最终无法得到租户编号**

   - 位置：[relay-host-steps.tsx:85](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/relay-host-steps.tsx:85)、[computer-guide.tsx:105](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx:105)、[zh_CN.json:172](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:172)
   - 问题：完成中继与密码设置后直接切到 `JoinSteps`，后者只给出 `tmex relay join ... --tenant <id>`。但新建中继尚未建立租户，实际需要先执行设置页已有的“接入本机中继”操作（其实现走 relay enroll）。三语文案还错误地声称租户编号由运营者在“中继管理”中创建；该页面没有创建租户的操作。
   - 影响：用户拿不到必填租户编号，只能复制带占位符的无效命令，自建中继指引成为死路。
   - 最小修复：在密码之后增加“接入本机中继”步骤，链接到多节点互联中的现有 `SelfRelayEntry`，或明确给出 `tmex relay enroll <url>`；仅当 `relayMode && tenantId` 后才进入“让新机器加入”。同步修正三语 `tenantMissing`。当前 [computer-join-guide.test.tsx:217](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.test.tsx:217) 只验证“缺少租户编号”的静态提示，没有验证流程存在可执行的下一步。

2. **中：SSH 跳转等待器会在正常关闭侧栏时被提前取消**

   - 位置：[ssh-steps.tsx:23](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/ssh-steps.tsx:23)、[ssh-steps.tsx:27](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/ssh-steps.tsx:27)
   - 问题：跳转 `/devices` 会移除 `?panel=connect`，侧栏退场后卸载 `SshSteps`；卸载清理随即取消刚创建的 `openSelfAddDevice` 等待器。等待器声明的 15 秒实际最多只存活约 200ms；开启“减少动态效果”时可能立即取消。
   - 影响：设备页 chunk 或首次状态加载稍慢时，只完成导航，不会打开添加设备对话框。
   - 最小修复：让打开意图独立于侧栏组件生命周期；由超时和成功回调自行清理，不要在此次预期卸载时取消。最好先注册等待器再导航。补充“导航后侧栏已卸载、设备页延迟注册”的组件级测试；现有 [open-add-device.test.ts:54](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/open-add-device.test.ts:54) 只测试辅助函数，没有覆盖调用方卸载。

3. **中：中继二级默认项使用了错误的状态字段**

   - 位置：[connect-path.ts:37](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-path.ts:37)
   - 问题：中继侧根据 `isRelayRole || relayAttached` 选择“加入已有”。这会产生两个相反错误：
     - `relay,node` 刚建好服务、尚未把自身租户接入中继时，因为角色命中而直接跳到“加入已有”，绕过仍未完成的自建流程。
     - 已配置中继租户但当前暂时没有 attached 链路时，反而跳到“本机自建中继”。
   - 影响：断线恢复和自建中继的关键状态都会显示错误指引。
   - 最小修复：以稳定的租户接入模式 `relayMode`（必要时再结合 `tenantId`）决定是否已有中继，而不是服务角色或瞬时 attached 状态。补测 `relayMode=true/relayAttached=false` 及 `role=relay,node/relayMode=false`；当前 [connect-path.test.ts:54](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-path.test.ts:54) 没覆盖这两种状态。

4. **中：选择 Hub 路径时可能生成实际属于中继的加入码**

   - 位置：[computer-join-guide.tsx:185](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx:185)
   - 问题：`canIssueJoinToken('hub', machine)` 无条件返回 `true`。如果本机当前经中继连接，而用户手动选择“经 Hub”，`useJoinEnrollment()` 仍按本机真实的 `relayMode` 选择中继 enrollment 通道，最终在 Hub 指引中生成中继加入码和中继地址。
   - 影响：界面选择、说明与生成的凭据指向不同网络路径，新机器会加入错误的上级。
   - 最小修复：加入码区域必须要求所选 variant 与当前 uplink 模式一致；或把 variant 传入 enrollment 层并拒绝无法由本机签发的路径。补测 `variant='hub' + relayMode=true`；当前测试只覆盖 standalone Hub 情况。

5. **中：普通节点的上级 Hub 地址被误判为本机公网入口**

   - 位置：[hub-host-steps.tsx:15](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/hub-host-steps.tsx:15)
   - 问题：任何 mesh 节点都会把 `mode.hubPublicUrl` 传给 `entryStatus()`。当本机只是普通节点时，该字段是上级 Hub 的地址，不是本机公网入口；代码因此把“配置公网入口”标为完成，并显示上级地址。
   - 影响：用户手动查看“本机设为 Hub”时会看到错误完成态和错误地址。
   - 最小修复：只有 `mode.hubNodeId === mode.nodeId` 时才能用 `mode.hubPublicUrl` 作为本机直连入口；普通节点只能依据本机隧道状态。补测普通节点、无本机隧道时入口步骤仍为 todo；现有 [connect-devices-panel.test.tsx:393](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx:393) 没断言入口状态。

6. **中：中继接入信息缺少租户编号时仍显示已完成**

   - 位置：[computer-join-guide.tsx:57](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx:57)
   - 问题：步骤完成态只检查 `uplink.url`，但 `tmex relay join` 同时强制要求租户编号。
   - 影响：界面打勾表示信息齐全，下一步却只能生成带 `<租户编号>` 占位符的不可执行命令。
   - 最小修复：中继路径的完成条件改为 `url && tenantId`；Hub 路径仍只要求 URL。缺租户编号的测试应明确断言 todo。

7. **低：预期的 `/api/local/status` 404 仍按查询错误处理**

   - 位置：[use-connect-machine.ts:27](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/use-connect-machine.ts:27)、[use-local-status.ts:23](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/use-local-status.ts:23)
   - 问题：注释声称 401、404 都已被摘除，但 `useLocalStatus` 只识别 401。开发网关返回 404 时会按普通失败重试两次，并把错误写入共享 React Query 缓存。
   - 影响：每次打开指引会产生三次预期失败请求；同一查询缓存的其他消费者还可能短暂读到错误态。
   - 最小修复：为指引增加允许缺失的查询模式，将 404 映射为 `status=null`、禁止重试且不产生 error；不要简单把 404 当成 `loginRequired`。

## 文案问题

以下中文提示超过约 40 字，英文、日文对应项也同样冗长，建议各拆成一句操作和一句必要说明：

- [zh_CN.json:141](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:141)：`path.tip.relay`
- [zh_CN.json:142](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:142)：`path.tip.hub`
- [zh_CN.json:177](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:177)：`join.password.relayDescription`
- [zh_CN.json:178](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:178)：`join.password.hubDescription`
- [zh_CN.json:188](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:188)：`join.token.description`
- [zh_CN.json:211](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:211)：`relayHost.setup.description`
- [zh_CN.json:231](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:231)：`host.entry.description`
- [zh_CN.json:241](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:241)：`host.hub.description`

另有一处表达不清：[zh_CN.json:138](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:138) 的“新机器可直接 SSH 到达”缺少施动者，建议改为“本机可通过 SSH 访问新机器，无需安装 tmex”。