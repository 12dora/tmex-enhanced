# WP-A2 结果：主题预设接入 terminal / panels / stores

## 一、改动清单

### packages/stores

**`src/ui.ts`**
- 新增 `normalizeThemePreset(value)`：`isThemePreset(value) ? value : null`。
- `persist.merge` 里把 `themePreset` 从 `rest` 中解构出来单独归一，localStorage 残留的下线 id（`underground` 等）与非法值一律回落 `null`。
- `setThemePreset` 运行期也走同一归一，防止宿主传入名单外的 id。

**`src/site.ts`**
- `SiteState` 新增 `selectThemePreset(preset: ThemePreset | null, fallbackAppearance?: ThemeAppearance): void`。
- `syncThemeToUIStore(theme)` 改成一次 `setState` 同时提交 `theme` 与预设失配清理：当前 `themePreset` 非空且 `THEME_PRESET_META[themePreset].appearance !== theme` 时置 `null`。该函数是 `commitSettings`（fetchSettings / refreshSettings）、`updateTheme`、`setThemeFromS2C` 三条路径的唯一收口，所以「服务端下发外观变化」与「用户直接切亮/暗」都会清预设。
- `selectThemePreset` 实现：先 `uiStore.setThemePreset(preset)`，再 `updateTheme(preset ? META[preset].appearance : (fallbackAppearance ?? 当前 theme))`。**顺序是刻意的**——先落预设，`syncThemeToUIStore` 看到的就是新预设，外观与之一致故不会被自己清掉；不需要额外的抑制标志位。

DOM 侧不动：`data-theme-preset` 仍由 `apps/fe/src/main.tsx` 的 `ThemePresetSync` 订阅 `useUIStore().themePreset` 后 `applyThemePreset` 施加（已确认存在，无需改动）。

### packages/terminal-ui

**`src/components/types.ts`**
- `TerminalTheme` 由 `'light' | 'dark'` 放宽为 `'light' | 'dark' | TerminalThemeColors`。向后兼容：`SplitTerminalArea` / `SplitPaneView` 已用该类型别名，自动跟随，调用点无需改。

**`src/components/theme.ts`**（新增两个导出，均已接进 `src/index.ts`）
- `resolveTerminalThemeProp(theme: TerminalTheme): TerminalThemeColors`——字面量映射到 seoul256 双主题，色板对象原样透传（保持引用，避免 effect 空转）。
- `applyTerminalTheme(terminal, theme): boolean`——把解析后的色板下发给已挂载实例，实例缺失或引擎无 `setTheme` 时返回 `false`。

**`src/components/Terminal.tsx`**
- `terminalTheme` 的 switch 换成 `useMemo(() => resolveTerminalThemeProp(theme), [theme])`。

**`src/components/hooks/useTerminalBootSurface.ts`**
- `UseTerminalBootSurfaceOptions.terminalTheme` / `BootRefs.terminalTheme` 的类型由 `typeof XTERM_THEME_DARK` 改为显式 `TerminalThemeColors`。
- 运行期主题 effect 改用 `applyTerminalTheme(instance, terminalTheme)`（原本已有 `instance?.setTheme?.()`，现在走同一收口）。预设切换只改色板对象引用 → effect 命中 → 增量下发，不重建终端。`ghostty-terminal` 的 `setTheme` 内部会 `renderCoordinator.setTheme` + `loop.schedule()`，重绘有保证。

**`src/components/TerminalPreview.tsx`**（改为实时更新，不再重建控制器）
- 订阅 `themePreset`，`terminalTheme = useMemo(resolveTerminalTheme(theme, themePreset))`。
- 新增 `termRef` 持有控制器、`terminalThemeRef = useLatestRef(terminalTheme)`；创建时读 `terminalThemeRef.current`（建控制器是异步的，await 期间主题可能又变）。
- 创建 effect 的依赖里去掉 `theme`，新增独立 effect `applyTerminalTheme(termRef.current, terminalTheme)`——换主题/预设时预览内容与滚动位置都保留。
- 容器背景色由 `terminalTheme.background` 提供。
- 注：该文件在 HEAD 上就不满足 biome 格式（见下「注意事项」），`biome check --fix` 顺带修了若干与本次无关的换行，diff 因此偏大。

**`src/components/theme.test.ts`**（新增，6 例）
- `resolveTerminalThemeProp`：字面量映射、色板透传保持引用、同字面量多次解析同引用。
- `applyTerminalTheme`：预设色板原样下发、字面量先解析再下发、实例缺失/无 `setTheme` 时静默返回 `false`。

### packages/panels

**`src/device-console/device-console.tsx`**
- 与 `theme` 并排读 `themePreset`，`terminalTheme = useMemo(() => resolveTerminalTheme(uiTheme, themePreset), [uiTheme, themePreset])`（`THEME_PRESET_META[x].terminal` 与 `TERMINAL_THEME_*` 都是模块常量，引用稳定，`Terminal` 内的 setTheme effect 不会空转）。
- 传给 `TerminalStage` 的 `uiTheme` + `terminalBackground` 两个 prop 合并为单个 `terminalTheme`。
- 不再 import `XTERM_THEME_DARK/LIGHT`。

**`src/device-console/terminal-stage.tsx`**
- `TerminalStageProps`：`uiTheme: 'light'|'dark'` + `terminalBackground: string` → `terminalTheme: TerminalThemeColors`。
- 三处消费点改写：`TerminalShortcutsSlot` 的 `background`、外层容器 `backgroundColor`、`SplitTerminalArea` / `Terminal` 的 `theme`。
- `TerminalStage` 不在 `packages/panels` 公开导出中（仅 `device-console.tsx` 内部使用），此 prop 变更不外溢，`apps/fe` tsc 已验证为 0 错。

**`src/markdown/mermaid-block.tsx`**
- 不再探测 `document.documentElement.classList.contains('dark')`（读一次、主题变了不重绘），改为订阅 `useUIStore` 的 `theme` + `themePreset`。
- `appearance = themePreset ? THEME_PRESET_META[themePreset].appearance : theme`，mermaid `theme: appearance === 'dark' ? 'dark' : 'default'`；effect 依赖 `[code, renderId, appearance]`。
  （最初把 `themePreset` 直接放进依赖数组，被 biome `useExhaustiveDependencies` 判为冗余；改成派生 `appearance` 后既真实消费了 preset，也满足了 lint。）

### 测试新增

- `packages/stores/src/ui.test.ts` +5 例：默认无预设、合法预设跨实例持久化、下线 id（`underground`）rehydrate 归零、非字符串 rehydrate 归零、`setThemePreset` 运行期拒绝未注册 id。预设常量取 `THEME_PRESETS[0]`，不写死 id。
- `packages/stores/src/site-theme.test.ts` +8 例（新 describe `useSiteStore theme preset`）：`selectThemePreset` 落预设并同步外观 + 上行 C2S；同外观预设不会自清；`selectThemePreset(null, 'light')`；`selectThemePreset(null)` 保持当前外观；`setThemeFromS2C` 失配清预设 / 一致保留；直接 `updateTheme` 失配清预设；`fetchSettings` 结果失配清预设。预设按 `appearance` 动态挑选，不写死 id。原 `useSiteStore theme` 的 `beforeEach` 补 `themePreset: null` 防串测。

## 二、验证数据（改动前 → 改动后，均在 A1 真实代码落地后复测）

| 包 | `bun test` 基线 | `bun test` 现状 | `tsc --noEmit` 基线 | `tsc --noEmit` 现状 |
|---|---|---|---|---|
| `packages/stores` | 238 pass / 0 fail | **251 pass / 0 fail** | 1 error | **1 error**（同一条，`host-services.test.ts(93,23)`，与本次无关） |
| `packages/terminal-ui` | 307 pass / 0 fail | **313 pass / 0 fail** | 0 | **0** |
| `packages/panels` | 368 pass / 0 fail | **368 pass / 0 fail** | 0 | **0** |
| `apps/fe`（回归确认） | — | — | — | **0** |

- 新增用例 13（stores）+ 6（terminal-ui）= 19，与数字增量一致。
- `bunx biome check` 覆盖全部 14 个改动文件：`Checked 14 files. No fixes applied.`
- 按约定未跑 Playwright e2e。

## 三、跨范围变更请求 / 待办

1. **主题选择器 UI（WP-A3）必须走 `useSiteStore().selectThemePreset(...)`**，不要直接调 `useUIStore().setThemePreset()`。后者只改本地预设，不会同步站点外观（`.dark` class / 服务端 `theme`），深色预设会缺 `.dark` 而 token 失效。清预设回到普通亮/暗时用 `selectThemePreset(null, 'light' | 'dark')`。
2. **gateway 侧 tmux window-style 与 OSC 11 应答仍只认亮/暗 seoul256**（`packages/shared/src/appearance.ts` 的 `getTmuxWindowStyle` / `getOsc11ResponseColor`，消费方 `apps/gateway/src/ws/theme-settings-broadcaster.ts`、`device-connection-registry.ts`、`packages/stores/src/tmux.ts`）。预设启用后，前端 xterm 背景是预设色，但 tmux 内 TUI 查询到的背景仍是 seoul256 —— 三路强一致的约定被打破，会出现 TUI 边框/填充色与终端底色不搭。修复需要把 preset 一路带到 gateway（S2C theme 帧扩展 preset 字段 + `getTmuxWindowStyle(preset ?? appearance)`），属于 shared/gateway 范围，本 WP 未动。**建议单开一个 WP。**
3. `packages/terminal-ui/src/components/TerminalPreview.tsx` 在 HEAD 上就不通过 `biome check`（格式漂移，非本次引入）。我用 `biome check --fix` 一并修了，如果 commander 想让该文件的 diff 更干净，可以自行取舍。

## 四、注意事项

- `selectThemePreset` 里「先 setThemePreset 再 updateTheme」的顺序是正确性依赖，不要调换；调换后 `syncThemeToUIStore` 会看到旧预设并把它清掉。
- `selectThemePreset(null)` 不带 `fallbackAppearance` 时会用当前外观调用 `updateTheme`，即使外观没变也会发一次 C2S。这是按冻结接口原文实现的；如果不希望有冗余上行，需要冻结接口层面另行拍板。
- `Terminal` / `SplitTerminalArea` 的 `theme` prop 现在既接受 `'light'|'dark'` 也接受整套色板，旧调用点无需改动；宿主若要预设生效，必须传 `resolveTerminalTheme(appearance, preset)` 的结果（`device-console` 已如此）。
- 传给 `Terminal` 的色板务必保持引用稳定（用 `useMemo` 或模块常量），否则每次渲染都会触发一次 `setTheme` + 重绘。
