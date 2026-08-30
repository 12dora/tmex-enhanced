# 代码审查报告

## MAJOR

1. 在线节点删除最后一台可见设备时，设备行仍会在分节淡出前消失。

   位置：[sidebar-device-list-runtime.tsx:78](/Users/konata/code/tmex-enhanced-wt-r4/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:78)、[sidebar-device-list-runtime.tsx:91](/Users/konata/code/tmex-enhanced-wt-r4/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:91)、[sidebar-device-list.tsx:164](/Users/konata/code/tmex-enhanced-wt-r4/packages/panels/src/device-tree/sidebar-device-list.tsx:164)

   触发条件：在线节点只有一台可见设备，用户从设备管理页删除它。设备查询刷新为 `[]` 后，presence 虽然锁存了旧设备 ID，但 `visibleDevices` 会用这些 ID 过滤当前已经为空的 `devices`，结果仍是空数组。外层分节继续执行退场动画，但设备行和高度立即消失，只剩分节头淡出。

   `pinnedDeviceIds` 只能应对可见性设置变化，无法应对设备从数据源中被移除。这里需要锁存实际的可见设备记录或完整渲染快照，而不是只锁存 ID。

## 验证

相关测试共 192 项通过；TLS Service 的 14 项测试因只读沙箱禁止创建临时目录而未能执行，并非断言失败。前端、panels、shared 和 ws-client 的 TypeScript 检查通过。

总体结论：未发现 BLOCKER，但仍有一个确定的 MAJOR presence 缺陷，导致删除最后一台设备时出现内容跳变；建议修复并补充动态退场回归测试后再合并。