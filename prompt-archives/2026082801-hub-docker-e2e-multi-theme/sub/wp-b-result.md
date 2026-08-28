# WP-B 结果 — 前端主题菜单（侧边栏）、移除深色开关、i18n、e2e 选择器

## 变更清单

### 新增：`apps/fe/src/components/page-layouts/components/theme-menu.tsx`
侧边栏主题菜单。结构：

- `ThemeMenuView`（纯展示，props：`appearance` / `preset` / `onSelect`）与 `ThemeMenu`（接 store 的容器）拆开，
  便于无 DOM 环境下用 `react-dom/server` 做单测。
- Trigger：沿用原 8×8 图标按钮样式（`h-8 w-8 … hover:bg-sidebar-accent`，加 `data-popup-open:` 态），
  图标 `Palette`，`aria-label`/`title` = `t('settings.theme')`；
  契约属性 `data-testid="theme-menu-trigger"`、`data-theme-preset`（当前预设 id，未选为 `""`）、
  `data-theme-appearance`（`light|dark`）。
- 菜单：复用 `@tmex/ui/dropdown-menu`（Base UI Menu，未改动该文件）的
  `DropdownMenuContent`（`align="end" backdrop min-w-56 max-w-[80vw]`，`data-testid="theme-menu"`）+
  `DropdownMenuRadioGroup`。项：Light（`theme-option-light`，Sun 图标）、Dark（`theme-option-dark`，Moon 图标）、
  分隔线、然后按 `THEME_PRESETS` 注册顺序渲染全部 14 个预设（`theme-option-<id>`），
  每行 = 三色圆形色块（`THEME_PRESET_META[id].preview` 的 background/foreground/accent）+ 品牌名（不翻译）+
  右侧小号 light/dark 提示。所有项 `closeOnClick`，触摸设备加大行高（`[@media(any-pointer:coarse)]:py-2.5`，
  与 `PaneSwitcherMenu` 一致），移动端侧边栏 Sheet 内同样可用（Base UI Portal 定位）。
- 取值编码：radio group 单一取值空间里，预设项用预设 id，默认外观项用 `appearance:light` / `appearance:dark`。
  导出纯函数 `themeMenuValue(preset, appearance)` / `parseThemeMenuValue(value)` 承载这层编码，非法取值返回 `null`。
- 选择行为：Light/Dark → `selectThemePreset(null, 'light'|'dark')`；预设 → `selectThemePreset(id)`
  （冻结接口，`packages/stores/src/site.ts` 由 WP-A 实现，签名已核对一致）。
- 当前选中项：有预设时为预设，否则为当前站点外观。

### 新增：`apps/fe/src/components/page-layouts/components/theme-menu.test.tsx`
6 个用例：取值编码/解析（含非法取值与全部预设 id 往返）、`ThemeMenuView` 静态渲染出的 trigger
契约属性（含未选预设时 `data-theme-preset=""`）。沿用 `sidebar-device-list.test.tsx` 的
`renderToStaticMarkup` 做法（仓库无 DOM 测试环境）。

### 修改：`apps/fe/src/components/page-layouts/components/sidebar-title.tsx`
删除 Sun/Moon 切换按钮及其 `theme` / `updateTheme` / `toggleTheme` 局部逻辑与 `useUIStore` 引入，
原位置改渲染 `<ThemeMenu />`。

### 修改：`apps/fe/src/main.tsx`
`StatusBarSync`（`<meta name="theme-color">` 同步）新增订阅 `themePreset` 并加入 effect 依赖——
预设会改写 `--background` / `--sidebar`，仅依赖 `theme` 时切预设不会重算状态栏颜色。
`applyInitialTheme` / `applyInitialThemePreset`（React 挂载前执行，后者已用 `isThemePreset` 校验）保持不变。

### 修改：`apps/fe/src/pages/settings/general-settings-tab.tsx`
删除深色模式 Switch 区块及随之无用的 `useUIStore` / `useSiteStore` / `Switch` 引入、`isDark`、
`handleThemeChange`。未在设置页新增任何主题选择器。

### 修改：i18n（`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`）
`settings.theme`：`Dark Mode` → `Theme` / `深色模式` → `主题` / `ダークモード` → `テーマ`。
`settings.themeLight` / `settings.themeDark` **保留**：菜单的两个默认外观项与预设行的 light/dark 提示都用它们
（三种语言下文案与新增的 `themeMenuAppearance*` 完全同义，故不新增重复 key）。三语同步后跑
`bun run build:i18n`，`resources.ts` 已重新生成（3 行变更，`types.ts` 无变化——key 集合未变）；生成文件未手改、未 lint。

### 修改：e2e specs（未运行 Playwright）
- `apps/fe/tests/theme-broadcast.spec.ts`、`theme-propagation.spec.ts`、`theme-notify-2031.spec.ts`：
  `setThemeViaUI` 改为在**当前页面**点 `theme-menu-trigger` → `theme-option-<theme>`，
  不再 `goto('/settings')` + 点 `settings-tab-general` + `settings-theme-toggle`。
  `.dark` 断言、背景色/WS 帧/tmux window-style 等断言与各用例流程一律未动
  （调用方原有的 `goto('/devices/…')` 保留，如今只是同页刷新，不影响断言）。文件头注释同步更新为「侧边栏主题菜单」。
- `apps/fe/tests/settings.spec.ts`：用例名 `theme toggle` → `theme menu`；主题片段改为在 `/settings` 页
  用侧边栏菜单点 Light → 断言 `html` 无 `.dark`，再点 Dark → 断言有 `.dark`（原先靠 general tab 里的 Switch）。
- `apps/fe/tests/ws-borsh-theme-resize.spec.ts`：**无需改动**——它全程走 HTTP `POST /api/settings/theme`，
  不依赖任何主题 UI 选择器（已 grep 确认无 `settings-theme-toggle`）。
- 全仓已无 `settings-theme-toggle` 引用（生成文件与 prompt 存档除外）。
- `apps/fe/src/pages/settings/site-settings-form.test.ts` 未受影响（只测 draft 映射，不涉及主题 UI），未改。

## 验证数据（改动前 → 改动后）

| 项目 | 基线 | 现在 |
| --- | --- | --- |
| `apps/fe`：`bun test src/` | 324 pass / 0 fail（23 文件） | 330 pass / 0 fail（24 文件，新增 6 个用例） |
| `apps/fe`：`bunx tsc --noEmit -p .` | 0 error | 0 error |
| `packages/shared`：`bun test` | —（改动仅 locale JSON + 生成文件） | 325 pass / 0 fail |
| `packages/shared`：`bunx tsc --noEmit -p .` | — | 0 error |
| `biome check`（12 个改动文件） | 14 error（全部先于本次改动存在） | 14 error（同一批） |

biome 的 14 个 error 全部是**既有**问题，已用 `git show HEAD:<file>` 取基线版本 + 同一份 `biome.json`
在临时目录逐文件比对，计数完全一致：`theme-broadcast.spec.ts` 7、`theme-propagation.spec.ts` 5、
`theme-notify-2031.spec.ts` 1（`noEmptyCharacterClassInRegex`，是原有的 `/^[^]*$(?<!\bdark\b)/`）、
`main.tsx` 1（`useExhaustiveDependencies` 对 `theme`/`themePreset` 的误报——effect 读的是 CSS 变量算出的
computed style，依赖是必须的）。本次新增/修改的代码自身 0 error（`theme-menu.tsx` 的 import 排序问题已修）。

fe 的 tsc/test 在 WP-A 的 `THEME_PRESET_META` / `resolveTerminalTheme` / `selectThemePreset` 落地**之后**重跑，
均基于真实实现，不是对着冻结接口的空跑。

## 跨 scope 变更请求

无。`packages/ui/src/components/dropdown-menu.tsx` 按要求原样复用；`packages/theme` / `packages/stores` 未触碰。

## 备注与待确认

- 未按建议新增 `settings.themeMenuAppearanceLight/Dark`：三语文案与既有 `themeLight/themeDark` 完全相同，
  复用可避免重复 key。若后续想让「预设行的 light/dark 提示」和「默认外观项」文案分化，再拆 key 即可。
- 菜单共 16 项（2 外观 + 14 预设），高度由 Base UI 的 `max-h-(--available-height)` 约束并内部滚动，
  未额外写死 `max-h`。
- e2e 未运行（按 ground rule）。新流程的前提是被测页面存在可见侧边栏：
  受影响用例都跑在 1280×800/桌面 Chrome 视口、全新 context（`sidebarCollapsed` 默认展开），符合前提。
- 主题菜单不再在 DOM 上手动 `classList.toggle('dark')`——`.dark` 由 store 侧 `syncThemeToUIStore` 统一维护，
  与原 Switch/按钮各自 toggle 的做法相比少了一处重复真值源。
