# Device Console 路由所有权修复计划

## 目标

window-only 路由只解析目标 window 内的 active/first pane；只有 device-only 路由才选择设备的全局默认
window，避免两个 effect 竞争和二次导航。

## 实施

1. 在 `selection-recovery.ts` 增加 device-only 初始选择解析规则，并复用现有 window/pane snapshot 类型。
2. `device-console.tsx` 的 auto-select effect 调用该规则；只要 URL 已有 `windowId` 就不产生全局默认目标。
3. 增加真实回归测试：device-only 选择 active/first；window-only（无 pane）返回 `null`，交给目标窗口
   effect 解析；空窗口不导航。
4. 运行 panels 定点测试、Gateway 全量测试和前端 build。
5. 在 canonical device metadata record 中写入设备显示名；runtime registry 从既有 device 配置传入，
   缺失时以 device ID 兼容兜底，并增加 metadata projection 回归断言。

## 验收

- 点击任意非首项 window 后 URL 最终属于该 window。
- 不改变 pane move/close settle、active event 跟随和 device-only 首次进入行为。
- canonical metadata 的 device record 同时包含 connected 与 name，下游无需额外 REST 查询即可展示设备。
- commit message 使用中性开源语气，只推 `vibex/*` 任务分支。
