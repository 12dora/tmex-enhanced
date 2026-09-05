发现 4 项问题，未发现 P0。

1. **P1 should-fix：拆分改变 effect 顺序，批量续跑抢在状态恢复之前。**  
   位置：[use-node-upgrade-controller.ts:78](/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/nodes/management/use-node-upgrade-controller.ts:78)。

   刷新存在未完成批量计划的页面，若 latest 请求先完成、节点列表随后返回，`useUpgradeBatch` 会在 `useUpgradeRestore` 登记回读之前启动。此时 `restoreActive` 为 0、`inFlight` 为空，因此对仍在升级的节点重发 POST；随后回读又因该行已被标记 running 而跳过。收到 `UPGRADE_IN_PROGRESS` 后，该节点被记为失败，批量可能提前升级下一组 Hub，打断尚未完成的传输。时序探针已复现“先 POST，跳过该节点 GET”。

   **建议修复：**将计划读取与续跑 effect 分开，恢复原有“先登记回读，回读收尾后再续跑”的顺序，并补测 latest 先于节点列表返回的场景。

2. **P1 should-fix：缓存于 render 和 effect 之间填充时，页面永久停在 loading。**  
   位置：[use-page-module.ts:106](/Users/konata/code/tmex-r28/apps/fe/src/use-page-module.ts:106)。

   首次打开页面 A，模块尚未下载完便切走，再返回 A。第二次 render 时缓存仍为空，状态初始化为 loading；若第一次已取消的请求随后完成，它仍会写入缓存，却不会更新组件状态。第二次 effect 看到缓存后直接 return，页面便始终没有内容。隔离时序探针确认了 `cache=true`、组件状态仍为 `loading`。

   **建议修复：**effect 命中缓存时也应校准当前状态为 ready；仅在当前状态已对应同一模块时跳过更新。补测取消请求在重新挂载后、effect 前完成的情况。

3. **P1 should-fix：真实慢速推包仍会在六分钟后被误判超时。**  
   位置：[use-node-upgrade.ts:349](/Users/konata/code/tmex-r28/apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:349)，关联 [remote-upgrade-job.ts:357](/Users/konata/code/tmex-r28/apps/gateway/src/system/remote-upgrade-job.ts:357)。

   向 1.1.30 节点推送一个需要八分钟才能传完的升级包时，后端只在尝试开始和成功结束时更新 `pushedBytes`，传输过程中一直是 `push:0:1`。前端因此不会延长 deadline，在 **362 秒**返回 timeout，而后端仍正常传输。下载阶段超过六分钟也存在同样问题。现有测试每轮增加字节数，与实际后端行为不符。

   **建议修复：**让远程任务的等待预算覆盖后端阶段超时，或提供真实、持续更新的传输进度后再采用停滞预算；补测一次 PUT 持续八分钟、期间快照不变的场景。

4. **P2 nice：错误解析重构丢失 JSON `null` 的兜底。**  
   位置：[json-mutation.ts:93](/Users/konata/code/tmex-r28/packages/api-client/src/json-mutation.ts:93)。

   非成功响应体为合法 JSON `null` 时，`res.json()` 成功，但后续访问 `body.error` 抛出 `TypeError`。原实现会捕获该异常并通过错误工厂返回 fallback；现在调用方丢失约定的异常类型、错误码和 HTTP status。已用 HTTP 502、响应体 `null` 直接复现。

   **建议修复：**读取 `error` 前检查 body 非空且为对象，否则走原有 fallback，并补充该输入的回归测试。

验证：382 个定向测试通过，现有构建产物的 JS/CSS 预算通过；聊天与文件树滚动未做浏览器实测。

无问题的部分：SSH 预选传递链、旧节点缺省 edge/progress 字段处理、字节与不限配额格式、确认框 testid 保留、Hub 切换及账户安全拆分、vendor 分包与预算计数、文件树事件委托与缩进。