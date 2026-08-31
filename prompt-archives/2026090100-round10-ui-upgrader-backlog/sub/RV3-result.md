发现 1 个 Blocker、2 个 Should-fix；无 Nit。

## Blocker

- [use-node-upgrade.ts:202–215](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:202)：POST 响应丢失会被错误判定为升级失败。目标可能已经处理 POST 并开始重启，但链路在响应返回前断开；后端已用 [mesh-routes.test.ts:1290](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/mesh/mesh-routes.test.ts:1290) 固定了这种情况会返回 `503 NODE_UNREACHABLE` 且不会重试。前端当前立即进入 `failed`、显示失败 toast 并重新启用按钮，用户可能再次触发一个实际仍在进行的升级。网络异常及 `NODE_UNREACHABLE` 应进入“结果未确认”的轮询路径；由于此时 `sawActive=false`，还需要允许通过目标版本变化确认成功，而不能只等待观察到 downloading/executing。

## Should-fix

- [use-node-upgrade.ts:42–43](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:42)、[use-node-upgrade.ts:117–118](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:117)、[use-node-upgrade.ts:228–241](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:228)：卸载没有真正取消 timer 或在途请求，而且把“组件已卸载”伪装成普通 timeout。用户启动升级后离开设置页，下一次 `delay` 结束会返回 `timeout`，随后仍显示“结果未确认”toast 并调用 `onChanged()`；若卸载发生在 GET 期间，请求返回后还可能继续产生成功或失败 toast。应使用可取消 timer/`AbortController`，增加独立的 `cancelled` 结果，并保证卸载后不再 toast、刷新或继续轮询。

- [use-node-upgrade.ts:82–89](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:82)：状态轮询把所有非 2xx 响应都当作重启中的暂时不可达。由于升级 busy 与 revoke 独立，用户可以在升级中移除节点；之后的 404 会被吞掉并继续轮询六分钟，最终才显示无关的超时警告。401 会话失效、403、明确的 `UPGRADE_UNSUPPORTED` 也有同样问题。应区分网络错误/502/503/504 等可重试结果与明确的业务错误，并将后者立即映射为失败或取消。

## 其余核查结果

- DnD 半径逻辑、无指针键盘回退均成立；远拖返回 `over=active` 会被 [use-device-management-state.ts:126](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-management/use-device-management-state.ts:126) 安全忽略，不会提交重排。
- SelectionToolbar 的 capture handler 不拦截工具条、触摸或非左键；`clearSelection()` 同步执行在 ghostty 的后续 `mousedown` 前，可以清掉旧选区并开始新选区。
- 三个 locale 的 20 个 `translation.nodes.upgrade` 键完全一致，生成资源中也已存在对应键。
- 五个 e2e 修订及 hub-e2e 的 `windowId` 修订与 `EX4-result.md` 描述一致，未发现额外问题。
- 定向结果：33 个相关单测全部通过；`apps/fe`、`packages/panels`、`packages/terminal-ui` TypeScript 检查全部通过。