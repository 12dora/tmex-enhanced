## BLOCKER

- [apps/fe/src/node/relay-pack.ts:114](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-pack.ts:114)：多中继密封包实际上只能刷新当前挂载中继。`refreshRelayPack()` 把 `join-material` 当作全部中继材料，但 [tenant-api.ts:128](/Users/konata/code/tmex-r24/packages/api-client/src/relay/tenant-api.ts:128) 与后端都明确只返回当前 attach 的一条。配置 A/B 两台中继后，根轮换会清空两边旧包，浏览器却只给 A 重封；使用 B 的租户编号进行密码加入会持续 404。建议新增专用 `/pack-material`，返回所有已授权中继各自的 URL、tenantId、token；不要改变加入码只绑定当前中继的语义，然后对 N 台中继生成 N 个包。

## MAJOR

- [apps/fe/src/node/relay-pack.ts:129](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-pack.ts:129)：忽略逐台上传结果，将“至少一台成功”误判为全部成功。后端会在 A 成功、B 离线时返回 HTTP 200 和 `results:[{A:true},{B:false}]`；当前代码仍返回 `true`，随后清除 pack debt，B 恢复后也不会再补包。建议核对每个请求包都有对应的 `ok:true`；任何一台失败都保留欠账并重试，最好把欠账细化到 URL。

- [apps/fe/src/node/relay-pack.ts:81](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-pack.ts:81)：K_log 存在失败路径未清零。先解码 `logKey`，随后解码畸形 token 时会在进入 `try/finally` 前抛出，已解码的 K_log 缓冲只能等待 GC。建议在拿到 `logKey` 后立即进入 `try`，把 `token` 声明为可空并在 `finally` 中分别清零；同时让 `normalizeJoinMaterial()`预先校验 logKey/token 的 base64url 长度。

- [apps/fe/src/auth/credential-prompt.tsx:514](/Users/konata/code/tmex-r24/apps/fe/src/auth/credential-prompt.tsx:514)、[relay-pack.ts:154](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-pack.ts:154)：根签 append 的覆盖并不完整。admit 流程使用 `request()` 返回的复用 signer，而密封包钩子只挂在 `withSigner()`；随后 admit-node 与 meta-key 成功都不会刷新 pack。另外 `WeakSet` 按 RootKey 对象永久去重，同一 signer 在五分钟窗口内处理第二个 admit 时也会被跳过。结果是 pack 长期钉在旧日志头。建议在 admit + meta-key 完成后显式刷新，并把去重改成“同一操作/同一 head 的在途去重”，不能按根钥对象终身去重。

- [apps/fe/src/pages/settings/nodes/setup/become-relay-form.tsx:54](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/become-relay-form.tsx:54)、[nodes-tab.tsx:91](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:91)：跨重启恢复的纯中继目标可能被初始 state 吞掉。若本机状态先于读取 intent 就绪，且 localStorage 记住的是中继 tab，`BecomeRelayForm` 会先以默认 `relay,node` 挂载；effect 随后恢复 `{role:'relay'}` 只改变 prop，不会重跑 `useState` 初始化。用户按原样提交会得到错误的 `relay,node`。建议按 intent/initialRole 给表单设置 `key` 强制重挂，或在表单未编辑前同步 `initialRole`。

- [apps/fe/src/pages/settings/nodes/membership/leave-dialog.tsx:43](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/leave-dialog.tsx:43)：`relay,node → relay` 会立即让网页消失，但确认框只说明“保留中继服务、删除节点身份”，没有说明之后只能通过 CLI 管理、网页无法改回。该路径也不会经过 `PureRelayConfirm`。建议为 `targetRole:'relay'` 使用专门的警告文案，明确列出网页消失、CLI 管理命令和恢复方式。

- [apps/fe/src/pages/settings/nodes/setup/standalone-relay-setup.tsx:40](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/standalone-relay-setup.tsx:40)、[use-hub-setup-submit.ts:49](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts:49)：同一中继 tab 同时挂载“加入中继”和“本机作为中继”两个独立提交控制器。一个表单成功并等待重启时，另一个仍可提交；后端虽会用 `setup_committed`/`setup_in_progress` 拦截，但界面允许互相冲突的操作，而且这些错误没有映射，会显示通用英文异常。建议把 setup transition 状态提升到共同父级，一旦任一路提交成功或进入重启，禁用所有角色选择和兄弟表单；同时补齐这两个错误码的本地化映射。

- [apps/fe/src/pages/settings/nodes/management/use-create-enrollment.ts:58](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/use-create-enrollment.ts:58)、[computer-join-guide.tsx:185](/Users/konata/code/tmex-r24/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx:185)：standalone 仍会请求 `/api/mesh/relay/status`。外层 `JoinSteps` 正确禁用了自己的 relay hook，但 `useJoinEnrollment → useCreateEnrollment` 内部又无条件调用一份 `useMeshRelay()`。从公网打开 standalone 的“接入设备”面板时，该请求会返回全局 401，session interceptor 可能直接把页面踢到登录页。建议把已解析的 relay 快照传入 `useCreateEnrollment`，或至少传 `enabled: mode?.mode === 'mesh'`。

- [apps/fe/src/node/relay-meta-key-retry.ts:67](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-meta-key-retry.ts:67)：宿主级重试只把欠账 ID 放进 `armKey`，既不检查链路 `online`，也不记录 attached URL。四档退避耗尽后，同一链路恢复在线或无缝切到另一中继时，`armKey` 不变，回路不会重新启动，安全敏感的 meta-key 欠账只能依赖用户手动处理。建议把 attached URL 和在线代次纳入武装键，并在 offline→online、attached URL 变化时重置退避并立即尝试。

- [apps/fe/src/pages/settings/relay/password-dialog.tsx:155](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/relay/password-dialog.tsx:155)：新增默认生成后，关闭对话框不会清空口令。`draft` 只在下一次打开时重置；取消或保存成功后，隐藏的 `PasswordDialog` 仍长期持有明文口令字符串。建议在 `open` 变为 false 时立即重置草稿，提交时传已经解析好的请求体，并在交给父级后马上丢弃本地密码引用。

## MINOR

- [apps/fe/src/pages/settings/nodes/setup/validation.ts:34](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/validation.ts:34)：Hub URL 前端校验只检查协议，允许用户名/密码、query 和 fragment；后端 `canonicalHubUrl()` 会拒绝这些值。用户会看到表单可提交，随后才收到后端错误，带凭据的 URL 还会被发送给本机网关。建议直接复用 `canonicalHubUrl()` 做校验和归一化，与 relay URL 保持同一套规则。

- [apps/fe/src/pages/settings/nodes/setup/validation.ts:105](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/validation.ts:105)：`BecomeRelayErrors` 没有 `relayPassword` 字段，也未执行服务端的“非空至少 8 位”规则。输入短口令只能得到表单级 `weak_password`，无法定位字段。建议允许空串，否则按 trim 后值校验至少 8 位，并在 `relayPassword` 字段旁展示错误。

- [packages/shared/src/i18n/locales/zh_CN.json:2446](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:2446)、[join-token.tsx:376](/Users/konata/code/tmex-r24/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:376)、[enrollment-engine.ts:601](/Users/konata/code/tmex-r24/apps/fe/src/node/enrollment-engine.ts:601)：若干中继路径仍使用 Hub 文案。密码加入中继失败显示“Hub 拒绝了本次加入请求”；侧滑面板缺地址或 append 未确认也固定显示 Hub。建议拆分 Hub/relay 的 setup 错误键，并把 `create.relayMode`/上级类型传给侧滑面板和 enrollment engine 选择正确文案。

- [packages/ws-client/src/websocket-transport.ts:60](/Users/konata/code/tmex-r24/packages/ws-client/src/websocket-transport.ts:60)、[websocket-transport.ts:169](/Users/konata/code/tmex-r24/packages/ws-client/src/websocket-transport.ts:169)：版本过低去重只有一个“最近 key”，而且入口 WS 每次恢复 canonical READY 都会清空。A、B 两个旧节点交替报错时会形成 A→B→A 重复 toast；入口网络重连后，同一旧节点也会再次弹。建议维护本 transport 生命周期内的 `Set<side:nodeId:version>`；gateway 成功升级时只清 gateway 项，节点项应在该节点实际成功协商或版本变化时清除。