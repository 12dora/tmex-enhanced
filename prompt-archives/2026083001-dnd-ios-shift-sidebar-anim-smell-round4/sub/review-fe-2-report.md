# 代码审查报告

## MAJOR

### 在线节点因可见性设置退场时，设备行仍会提前消失

位置：[sidebar-device-list-runtime.tsx:80](/Users/konata/code/tmex-enhanced-wt-r4/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:80)、[sidebar-device-list-runtime.tsx:93](/Users/konata/code/tmex-enhanced-wt-r4/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:93)、[sidebar-device-list.tsx:169](/Users/konata/code/tmex-enhanced-wt-r4/packages/panels/src/device-tree/sidebar-device-list.tsx:169)

触发条件：

1. 在线节点只有一台通过“显示在侧栏”开关显式显示的设备；
2. 当前路由没有选中该设备，例如停留在节点设置页；
3. 用户关闭该设备的“显示在侧栏”开关。

此时 `selectedDeviceId` 是 `undefined`，所以 presence 锁存的也是 `undefined`。分节进入退场阶段后，内部设备树立即使用新的可见性设置重新过滤，得到空列表；外层仍保留到淡出结束，最终表现为设备行和高度瞬间消失，只剩分节标题淡出。

本次修复只覆盖了“切换选中节点”分支，没有覆盖取消最后一台显式可见设备这一同类退场路径。应锁存退场前实际可见的设备 ID/内容，而不能只锁存路由选中的设备 ID。

## 总体结论

当前仍有 1 个应在合并前修复的 MAJOR 动画缺陷，不建议直接合并。其余排序抽取、admit 公共处理、复制按钮复用、角色文案去重及直连清理重构未发现确定性回归。相关 6 个测试文件共 150 项通过，前端和 `ws-client` 的 TypeScript 检查通过，但现有测试未覆盖上述动态退场场景。