# 审查结果

## 1. Blocker：运行中的隧道可在无暴露确认的情况下移除最后一道 Access 保护

位置：[access-step.tsx:418](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/pages/settings/remote-access/access-step.tsx:418)、[tunnel.ts:183](/Users/konata/code/tmex-enhanced-wt-r5/packages/shared/src/contracts/tunnel.ts:183)、[manager.ts:420](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tunnel/manager.ts:420)

问题：`set_access_enforce(false)` 和 `remove_access` 都不接受或检查 `acknowledgeExposure`。当 `loginEnforced=false` 且命名隧道正在运行时，用户可以直接关闭令牌校验，或删除 Access 应用；隧道继续运行，但立即变成无保护公网入口。

证据：

- `setAccessEnforce()` 直接保存 `enforceJwt=false`。
- `jobRemoveAccess()` 清空应用并设为 `enforceJwt=false`，但不停止隧道。
- Access guard 每个请求读取最新状态，状态翻转后立即停止校验。
- 前端开关没有事前确认；删除确认只描述删除应用，没有走统一暴露确认契约。
- 直接调用 API 同样可以绕过前端提示。

最小修复：把关闭强制校验和移除 Access 纳入后端暴露状态转换。在“隧道正在运行、登录未启用、该动作会移除最后一道保护”时，要求 `acknowledgeExposure=true`，或原子地先停止隧道。同步扩展 shared 契约，并让前端复用 `ExposureWarning`/`withExposureAck`。

## 2. Should-fix：关闭非焦点 pane 时，焦点捕获会绕过新加的关闭回落逻辑

位置：[SplitPaneView.tsx:114](/Users/konata/code/tmex-enhanced-wt-r5/packages/terminal-ui/src/components/split/SplitPaneView.tsx:114)、[use-pane-selection-dispatch.ts:160](/Users/konata/code/tmex-enhanced-wt-r5/packages/panels/src/device-console/use-pane-selection-dispatch.ts:160)

问题：点击非焦点 pane 的关闭按钮时，pane 根元素的 `onPointerDownCapture` 会先执行 `onUserSelectPane()`，把路由导航到即将关闭的 pane。关闭按钮的 `stopPropagation()` 位于冒泡阶段，无法阻止祖先捕获处理器。

随后同一点击事件中的 `handleClosePane()` 仍闭包捕获旧的 `resolvedPaneId`，因此 `resolveCloseFallback()` 判断“关闭的不是路由 pane”，返回 `none`。结果是 URL 可能最终指向刚被删除的 pane，重新出现本次修复要消除的“连接设备中”问题。

现有 e2e 只覆盖关闭焦点 pane，没有覆盖此路径。

最小修复：让 pane 根元素的捕获处理器显式忽略关闭按钮，例如根据 `event.target.closest('[data-pane-close]')` 返回；或把选择处理移到关闭按钮能够阻止的冒泡阶段。补充“直接关闭非焦点 pane”的回归测试。

## 3. Should-fix：Access 向导顺序和主机名推导均与后端动作契约不一致

位置：[tunnel-model.ts:55](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:55)、[access-model.ts:52](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/pages/settings/remote-access/access-model.ts:52)、[access-step.tsx:199](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/pages/settings/remote-access/access-step.tsx:199)

问题包含三部分：

- 向导把 Access 放在“创建并启动”之前，但 `configure_access` 只读取服务端已保存的 `config.hostname`。本地主机名草稿没有传给 Access，因此用户第一次走到该步骤时，它必然不可用。
- `accessTargetHostname()` 优先返回旧的 `access.hostname`，但后端配置动作完全忽略它。移除隧道后 Access 记录仍保留，此时前端会错误启用“应用”，后端却返回 `not_configured`。
- `sync_access` 后端使用 `config.hostname ?? external.hostnames[0]`；前端却把 `access.hostname` 算作同步目标。外部隧道是唯一目标时，按钮可用，但同步提示中的 `hostname` 仍为 `null`。

最小修复：

- 将 Access 步骤移到创建之后；或者修改契约，让配置动作显式接收并校验已确认的主机名。
- 分开定义目标：配置只能用 `config.hostname`；同步只能用 `config.hostname ?? external.hostnames[0]`；`access.hostname` 仅表示已有应用当前覆盖的地址。

## 4. Should-fix：已开启侧栏显示的远端节点一旦离线，仍会整节消失

位置：[sidebar-node-section.tsx:225](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:225)、[mesh-runtime.ts:714](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-runtime.ts:714)

问题：新规则声称在线、未登录、离线三种形态都以 `sidebarDeviceVisibility` 为显示门槛，但离线分支仍只过滤 `inventoryDevices(node.inventory)`。

实际 mesh `statusProvider` 的 inventory 只有 `{ version }`，没有设备列表。因此即使 UI store 中存在该节点设备的显式 `true`，`knownDevices.length` 仍为零，远端节点会被 `shouldHideSidebarNodeSection()` 隐藏。用户刚开启的节点在断线后从侧栏消失，和新规则不一致。

最小修复：离线时也从该节点前缀下的显式 `true` 键推导可见设备，至少保留节点分节并用 device ID 回退显示；更完整的方案是持久化最近设备的 ID/名称，供离线展示。补充“已开启设备后节点掉线”的测试。

## 5. Should-fix：Access 徽标和暴露警告错误描述实际保护状态

位置：[tunnel-model.ts:31](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/pages/settings/remote-access/tunnel-model.ts:31)、[exposure.tsx:32](/Users/konata/code/tmex-enhanced-wt-r5/apps/fe/src/pages/settings/remote-access/exposure.tsx:32)、[zh_CN.json:472](/Users/konata/code/tmex-enhanced-wt-r5/packages/shared/src/i18n/locales/zh_CN.json:472)

问题：

- `accessPill()` 只检查 `configured && enforceJwt`，没有检查 Access 主机名是否与当前隧道主机名一致。正常的“移除旧隧道、Access 记录仍保留”状态会同时显示“Access 已保护”和未保护警告。
- 暴露警告固定声称“未配置 Cloudflare Access”，但 `exposureProtected=false` 还可能表示 Access 已配置但未强制，或绑定了旧主机名。
- 三语完整版警告都暗示“可信网络/纯局域网”可以降低风险；Cloudflare Tunnel 地址仍是公网入口，本地网络是否可信并不能限制互联网访问。

最小修复：用与后端完全相同的谓词统一推导 Access 保护状态：`configured && enforceJwt && access.hostname === config.hostname`。为已配置但未生效/主机名不匹配提供准确状态；警告改为“当前没有生效的 Access 保护”，并删除“可信网络/纯局域网即可继续”的表述。

## 验证备注

三份 `settings.remoteAccess` locale 均为 203 个叶子键，键集合一致；生成的 `resources.ts` 和 `types.ts` 也包含新增键，未发现 i18n key 缺失。

## Verdict

需要修改后再合入。核心功能基本接通，但当前仍存在一个可绕过暴露确认的真实安全状态转换，以及分屏关闭和 Access 向导的确定性契约错误。

最重要的三项：

1. 修复运行中移除/关闭 Access 时绕过暴露确认。
2. 修复关闭非焦点 pane 时捕获阶段先导航到死 pane。
3. 统一 Access 主机名目标与后端契约，并调整向导步骤顺序。