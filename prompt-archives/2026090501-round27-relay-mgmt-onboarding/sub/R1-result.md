1. **高 — `packages/api-client/src/relay/tenant-api.ts:410` / `apps/gateway/src/mesh/relay-routes.ts:111`**  
   `switchRelay()` 调用 `POST /api/mesh/relay/switch`，但 R1 对应版本的网关路由表没有注册该端点，因此调用必然返回 405，切换中继功能无法工作。现有客户端测试也完全没有调用 `switchRelay()`，隐藏了这个跨层断点。  
   最小修复：同时注册并实现 `/switch`，并补客户端请求体测试及网关路由测试。

2. **中 — `packages/api-client/src/relay/tenant-api.ts:51`**  
   `RelayQuotaUsage` 漏掉了协议真实下发的 `bandwidthBytesPerSec`。共享 wire 类型中该字段是可选的，旧中继可以不下发；当前 API 类型迫使消费者用类型断言读取实际存在的字段，也失去了类型检查。  
   最小修复：增加 `bandwidthBytesPerSec?: number`，并补一个包含该字段的 `normalizeRelayStatus()` 往返测试；不能定义为必填。

3. **中 — `apps/fe/src/pages/settings/relay/relay-tab.tsx:133`**  
   租户消失后只把派生的 `selectedTenant` 变成 `null`，没有清除 `selectedTenantId`。界面暂时显示“未选择”，但同一租户 ID 再出现时会无操作地恢复过滤；此时第一次点击该行还会因为旧 ID 相同而执行“取消”，表现为点击无效。静态渲染测试无法发现这个状态错误。  
   最小修复：在租户列表不再包含选中 ID 时显式清空状态，并补“选中 → 刷新删除 → 同 ID 重新出现”的挂载/重渲染测试。

4. **中 — `apps/fe/src/pages/settings/relay/tenant-table.tsx:104`**  
   可选择行为直接挂在仍然保持静态 `row` 语义的 `<tr>` 上；`tabIndex`、键盘监听和 `title` 没有把“这是一个可切换的筛选控件”暴露为原生交互语义。可选择行应采用完整的 grid 交互模型，或提供实际的按钮/复选控件；当前测试只检查 `tabindex`，会把该回归误判为可访问。[WAI-ARIA Grid Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)  
   最小修复：在单元格内加入带 `aria-pressed` 的选择按钮，移除行本身的 tab stop/键盘处理；整行点击仍可作为鼠标快捷方式。

5. **低 — `apps/fe/src/pages/settings/relay/relay-metrics-members.tsx:149`**  
   所有七个列头都获得 `aria-sort`，非当前列为 `"none"`。排序表模式要求只在当前排序列上设置该属性，切列时从旧列移除；现在辅助技术会接收到多个排序状态。新增测试还明确断言 `"none"`，固化了错误行为。[WAI-ARIA Sortable Table Example](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/)  
   最小修复：非当前列返回 `undefined`，并断言渲染结果中只有一个 `aria-sort`。

6. **低 — `apps/fe/src/pages/settings/remote-access/tunnel-model.ts:52`**  
   `degradedError()` 在清理空白前使用 `??` 选择错误源。若 `process.lastError` 是空字符串或空白，而 `connector.lastError` 有有效诊断，前者会阻断回退，最终整个错误明细消失。当前测试只覆盖“空白且没有连接器错误”。  
   最小修复：分别 `trim()` 两个候选值后选第一个非空值，并补“空白进程错误 + 有效连接器错误”测试。