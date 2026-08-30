# 代码审查报告

## MAJOR

### 在线节点退场时设备内容会先消失，实际没有实现“整节淡出”

位置：[sidebar-device-list-runtime.tsx:75](/Users/konata/code/tmex-enhanced-wt-r4/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:75)、[sidebar-device-list-runtime.tsx:88](/Users/konata/code/tmex-enhanced-wt-r4/apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx:88)

`useSectionPresence` 只锁存了 `null`，退场期间仍渲染实时的 `DeviceTree`。当节点唯一可见的设备仅因“当前选中设备无条件显示”而出现时，切换到另一节点会同时发生：

1. `visible` 变为 `false`，presence 保留外层 150ms；
2. `DeviceTree` 根据新路由立即过滤掉该设备；
3. 设备行和对应高度瞬间消失，随后只剩节点标题淡出。

用户取消最后一台设备的侧边栏显示时也会触发相同行为。因此本次改动的核心“整节淡出”效果在在线节点上仍表现为内容先跳变、空壳再淡出。离线实现已经通过 `presence.value` 锁存设备列表，在线实现需要同等地保留退场前的实际内容或把 presence 放到不会立即重算为空的边界上。

## 总体结论

存在 1 个应在合并前修复的 MAJOR 动画回归，当前不建议合并。针对 diff 的 6 个测试文件共 105 项测试全部通过，`tsc --noEmit --incremental false -p apps/fe/tsconfig.json` 也通过，但新增测试只覆盖首屏静态结构，没有覆盖上述“最后一台可见设备消失”退场路径。