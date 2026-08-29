# f7 结果：远端 runtime 主题守卫 + 隐藏设备重排顺序合并

修复 `review-fe-devices.md` 的第 1、2 条（第 3 条由他人处理）。

## 变更文件

- `packages/stores/src/site.ts`
- `packages/stores/src/site-theme.test.ts`
- `packages/panels/src/device-tree/device-tree-selectors.ts`
- `packages/panels/src/device-tree/device-tree-selectors.test.ts`
- `packages/panels/src/device-tree/sidebar-device-list.tsx`

## 1. `site.ts`：`controlsBrowserPrefs=false` 时不得触碰浏览器级状态

- `selectThemePreset`：把 `uiStore.getState().setThemePreset(preset)` 收进 `if (core.controlsBrowserPrefs)`。
  远端 node 的 runtime 仍然按预设自带的 appearance 调 `updateTheme`——自己的 `settings` 照常更新、
  C2S `SITE_THEME_UPDATE` 照常发给那台 node，只跳过共享 UI store 与 `<html>` 副作用。
  预设为 null 时的 fallback 仍读（只读，不写）共享 UI store 的当前外观。
- `writeThemeToLocalStorage`：新增同款守卫。离线 fallback（`<prefix>tmex-ui`）决定首屏亮/暗，
  远端 node 的外观不得写入。此前 `updateTheme` / `setThemeFromS2C` 会在 node 前缀下留一份脏值。
- 审计结论：`syncThemeToUIStore`（`<html>.dark` + 共享 UI store）与 `commitSettings` 里的
  `i18next.changeLanguage` 原本已有守卫；加上以上两处后，`fetchSettings` / `refreshSettings` /
  `handleSettingsUpdate` / `updateTheme` / `setThemeFromS2C` / `selectThemePreset` 六条路径
  在 `controlsBrowserPrefs=false` 时均不再触碰共享 UI store、localStorage theme 与 i18next。

新增测试（`site-theme.test.ts` 末尾 `describe('createSiteStore controlsBrowserPrefs=false 的主题写入')`，
用 `createAppRuntime({ storagePrefix, uiStore: useUIStore, controlsBrowserPrefs: false })` 构造远端 runtime）：
`selectThemePreset` / `updateTheme` / `setThemeFromS2C` / `fetchSettings` 四例，断言共享 UI store 的
`theme`/`themePreset` 与 `tmex-ui` 的 localStorage 原文不变、node 前缀下无任何 localStorage key，
同时断言该 store 自己的 `settings.theme` 已更新、`updateTheme`/`selectThemePreset` 仍发 1 次 C2S、
`setThemeFromS2C` 不回送。

反证：临时去掉两处守卫后，新增用例 3 fail（`fetchSettings` 那例本就被旧守卫覆盖，属回归保护）。

## 2. 设备重排：把可见 id 的拖拽结果合并回完整顺序

纯函数（`device-tree-selectors.ts`）：

```ts
export function mergeReorderedVisibleIds(
  allSortedIds: readonly string[],
  visibleIdsBefore: readonly string[],
  visibleIdsAfter: readonly string[]
): string[]
```

隐藏设备留在 `allSortedIds` 中的原槽位，重排后的可见 id 依次填回可见槽位；
`visibleIdsAfter` 中不在 `visibleIdsBefore` 的 id 被忽略，`allSortedIds` 尚未收录的可见 id 补到末尾
（设备列表刚变动时不丢设备）。

`sidebar-device-list.tsx`：新增 `allSortedDevices`（对**全部** `devices` 排序，比较器与原先一致）与
`allSortedDeviceIds`；`sortedDevices` 改为从 `allSortedDevices` 过滤可见集合得到（顺序与原实现等价）；
`handleReorderDevices` 提交 `mergeReorderedVisibleIds(allSortedDeviceIds, sortedDeviceIds, nextIds)`。
副作用收益：mutation 的乐观更新现在拿到完整 id 列表，`rest` 为空，本地 `sortOrder` 也不再残留旧值。

新增单测（`device-tree-selectors.test.ts`，7 例）：无隐藏设备、隐藏夹在中间、隐藏在首尾、
首个可见拖到最后、最后一个可见拖到最前、结果恒为完整集合的排列（不丢不重）、
可见 id 未出现在完整顺序时补末尾。

## 验证

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `packages/stores` `bun test` | 271 pass / 0 fail | 275 pass / 0 fail |
| `packages/stores` `bunx tsc --noEmit -p .` | 1 error（`host-services.test.ts:93` 既有） | 同 1 error，无新增 |
| `packages/panels` `bun test` | 381 pass / 0 fail | 388 pass / 0 fail |
| `packages/panels` `bunx tsc --noEmit -p .` | 0 | 0 |
| `apps/fe` `bunx tsc --noEmit -p .` | 0 | 0 |
| `bunx biome check <5 个改动文件>` | — | 通过（`sidebar-device-list.tsx` 跑过一次 `--write` 格式化） |
