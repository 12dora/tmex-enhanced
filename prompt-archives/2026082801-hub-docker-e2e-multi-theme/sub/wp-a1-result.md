# WP-A1 执行结果 — theme 包：预设注册表、CSS token、终端配色

## 一、交付概览

用 14 套社区配色方案替换了原有的 7 套无用设计预设，并把「调色板 TS 真源 → 生成 CSS」的链路补齐：
`preset-palettes.ts` 是唯一手改入口，`themes.css` 与 `hljs-terminal-theme.css` 的
`[data-theme-preset="…"]` 区块由 `scripts/theme/build-theme-presets.ts` 生成，测试断言产物未过期。

预设名单（顺序即 `THEME_PRESETS`，与冻结接口一致）：
dracula / tokyo-night / tokyo-night-storm / tokyo-night-light / catppuccin-mocha /
catppuccin-latte / nord / one-dark / solarized-dark / solarized-light /
gruvbox-dark / gruvbox-light / github-dark / github-light。

## 二、逐文件改动

### 新增

| 文件 | 说明 |
| --- | --- |
| `packages/theme/src/preset-palettes.ts` (707 行) | **调色板真源**。每个预设导出 `label` / `appearance` / `ui`（17 个语义取色 + 5 个 chart 色）/ `terminal`（16 ANSI + fg/bg/cursor/selection）。终端色严格取各方案官方发布的终端调色板；UI 色以各方案自有的 surface 台阶为基础，仅在对比度不达标时按同色相微调（见第四节）。导出 `ThemeAppearance`、`PresetPalette`、`PresetUiPalette`、`PRESET_PALETTES`。 |
| `packages/theme/src/preset-meta.ts` (46 行) | 冻结接口的 `ThemePresetMeta` / `THEME_PRESET_META` / `resolveTerminalTheme`，从 `PRESET_PALETTES` 派生。`preview = { background: ui.background, foreground: ui.foreground, accent: ui.primary }`。`resolveTerminalTheme` 有预设取预设终端色，无预设按 appearance 回落 `TERMINAL_THEME_LIGHT/DARK`（`@tmex/shared`）。 |
| `packages/theme/src/preset-css.ts` (155 行) | 由真源渲染两处 CSS 区块；导出 `PRESET_SECTION_MARKER`、`renderPresetCssSections`、`extractPresetSection`、`replacePresetSection`，供生成脚本与测试共用。语法高亮取色规则：优先方案常规 ANSI 色，常规色对代码底色 < AA 时改用对比更高的 bright 变体，两者都不够再保色相压暗/提亮到 4.0。 |
| `packages/theme/src/color-utils.ts` (74 行) | WCAG 相对亮度 / 对比度、sRGB 混色、`ensureContrast`。生成脚本与测试共用。 |
| `scripts/theme/build-theme-presets.ts` | 生成器（仿 `build-shortcut-tokens.ts`）。用法：`bun scripts/theme/build-theme-presets.ts`，就地替换两个 `/* Theme presets */` 标记之间的内容，其余部分不动。 |

### 修改

| 文件 | 说明 |
| --- | --- |
| `packages/theme/src/presets.ts` | `THEME_PRESETS` 换成 14 个新 id；`isThemePreset` / `applyThemePreset` 逻辑不变，仅补注释说明「预设自带外观，宿主须同步站点亮/暗」。 |
| `packages/theme/src/index.ts` | 新增导出 `THEME_PRESET_META`、`ThemePresetMeta`、`ThemeAppearance`、`resolveTerminalTheme`（冻结接口全量）。 |
| `packages/theme/src/themes.css` | 删除 7 套旧预设（原 8–763 行，含 `@variant dark` 嵌套块），改为 14 个扁平 `[data-theme-preset="<id>"]` 块（生成产物）。每块定义 `tokens.css` `:root` 里全部语义 token：`--background … --sidebar-ring`、`--chat-surface`、11 个 `--fc-*`。文件尾部 `data-theme-chart-preset` / `data-theme-radius` / `data-theme-scale` / `data-theme-font` 与开头 `body{}` 原样保留。791 行（原 876）。 |
| `packages/panels/src/code-viewer/hljs-terminal-theme.css` | 在 `.dark` 之后、`.hljs` 之前插入一对 `/* Theme presets */` 标记，内含 14 个 `[data-theme-preset]` 块，覆盖 `:root` 里全部 22 个 `--code-*`。原 `:root` / `.dark`（seoul256）与所有 `.hljs-*` 规则未动。499 行（原 145）。 |
| `packages/theme/src/presets.test.ts` | 重写，见第三节。247 行（原 33）。 |

未改动：`tokens.css`、`tokens.generated.css`、`terminal-shortcut-tokens.ts`、`fonts/*`。

## 三、测试覆盖（`presets.test.ts`，50 个用例）

- 注册表 ↔ `themes.css` / `hljs-terminal-theme.css` 的 `data-theme-preset` 名单三方一致；id 无重复；`isThemePreset` 判定（含旧 id `underground` 现在为 false）。
- **生成产物未过期**：`extractPresetSection(css)` 与 `renderPresetCssSections()` 逐字符相等（两个文件各一条断言）。改了调色板忘了跑生成脚本会直接红。
- 每个预设覆盖 `tokens.css` `:root` 的全部语义 token（从 `:root` 正则抽名单，剔除 `--base-*` / `--tmex-*` / `--radius` / `--display-weight`）；每个预设覆盖 `:root` 的全部 `--code-*`。
- `THEME_PRESET_META`：键集合 == `THEME_PRESETS`，`meta.id` 自洽；`label` 为英文品牌名；`appearance` 合法且与背景明暗自洽；`preview` 三色为 hex 且 **等于 CSS 里该预设的 `--background` / `--foreground` / `--primary`**；`terminal` 字段集合与 `TerminalThemeColors` 一致且除 selection 外均为 hex。
- `resolveTerminalTheme`：无预设按 appearance 回落 seoul256；有预设时预设优先且与 appearance 参数无关。
- 可读性（14 × 多组断言）：fg 对 background/card/sidebar/muted/accent/chat-surface ≥ 4.5；muted-foreground 对 background ≥ 4.5、对 muted/sidebar ≥ 4.0；primary/secondary 能承载各自前景 ≥ 4.5；border ≥ 1.2、input ≥ 1.5、primary/destructive ≥ 3.0、chart ≥ 2.2（均对 background）；**每个 `--code-*` 对 `--code-bg` ≥ 4.0**。

## 四、配色取舍（需要知情的偏离）

终端 16 色一律取官方发布值，不做任何调整。UI 语义色以官方 surface 台阶为基础，以下几处为满足 AA 做了同色相微调，均在注释中标明：

| 预设 | 调整 | 原因 |
| --- | --- | --- |
| tokyo-night-light | 表层抬亮（muted `#dcdde3`、accent `#d5d6db`、sidebar/card `#e9e9ec`），fg `#3760bf`→`#3359b2`，subtle `#526196`，primary `#2e7de9`→`#2667bf` | day 变体本身 fg/bg 只有 4.86，原取值在 muted/accent 上跌到 3.5–4.0 |
| catppuccin-latte | subtle 用 subtext1 `#5c5f77`（原 subtext0 4.37），primary 前景改纯白（4.34→4.91） | AA |
| nord | border 提到 nord2 `#434c5e`（nord1 对 bg 仅 1.24 不可见），accent 回落 nord1，subtle `#a9b4c6` | 边框可见 + subtle 在 accent 上够读 |
| solarized-dark | muted/accent 收敛到 base02 `#073642`，border `#0e4a58`，primary 前景 `#002b36`→`#00222b` | base01 级表层上 fg 只有 3.95；蓝色 primary 白字/base03 字都不到 4.5 |
| solarized-light | fg `#586e75`→`#556b72`，subtle `#657b83`→`#5e727a`，muted 抬到 `#f2ecd9`，primary `#268bd2`→`#2075b0` | Solarized Light 原生对比极低（官方 fg/bg 本身只有 4.13） |
| gruvbox-light | subtle 用 dark3 `#665c54`（原 gray `#7c6f64` 只有 4.29） | AA |
| github-dark | primary 用 Primer `accent.emphasis` `#1f6feb`（原 `accent.fg` `#2f81f7` 白字仅 3.75） | AA；chart-1 同步 |

**已知未达 AA 且刻意保留**：solarized-light 的**终端** fg/bg = 4.13（base00 on base3），这是 Ethan Schoonover 官方定义，终端保真优先于 AA。代码高亮不受影响——`--code-fg` 走终端 fg，但 `--code-comment` 等取 UI subtle，全部 ≥ 4.0。

其余设计要点：
- 深色预设的 token 是扁平的，依赖 `<html>.dark` 提供 Tailwind `dark:` 变体（由 store 侧的「预设 appearance 同步站点 theme」规则保证），符合冻结接口的 DOM 契约。
- `--fc-*` 每个预设全量声明：颜色项引 `var(--primary)` / `var(--border)` / `var(--muted)`（自动跟随预设），仅 `--fc-event-text-color` 写死为该预设的 primary-foreground（`:root` 原值是硬编码白色，浅色预设会不可读）。
- `--radius` / `--display-weight` / 字体族刻意不在预设里声明：radius 归 `data-theme-radius` 管，字体归 `data-theme-font` 管，避免同特异性互相打架。

## 五、验证数据（改动前 → 改动后）

| 检查 | 基线 | 改动后 |
| --- | --- | --- |
| `packages/theme` `bun test` | 6 pass / 0 fail | **50 pass / 0 fail**（1991 断言） |
| `packages/theme` `bunx tsc --noEmit -p .` | 10 errors | **9 errors**（全部为既有的 `bun:test` / `node:fs` / `import.meta.dir` 类型缺失，非新增） |
| `packages/panels` `bun test` | 218 pass / 12 fail / 12 errors | **368 pass / 0 fail** |
| `packages/panels` `bunx tsc --noEmit -p .` | 3 errors | **0 errors** |
| `bunx biome check <10 个改动文件>` | — | **clean** |

panels 的 12 个 fail / 3 个 tsc error 是基线时 `@tmex/theme` 尚未导出 `THEME_PRESET_META` / `ThemeAppearance` / `resolveTerminalTheme` 造成的（其他 WP 已按冻结接口写好消费方），本 WP 落地后自动消失。

旁证（未纳入包内测试，用临时脚本验证）：
- 邻近包未受影响：`stores` 251 pass / 0 fail、tsc 1 error（= 已知基线）；`terminal-ui` 313 pass / 0 fail、tsc 0；`apps/fe` `bun test src/` 330 pass / 0 fail。
- **Tailwind v4 实编译**：用仓库内 `tailwindcss@4.1.18` 的 `compile()` 跑通 `apps/fe/src/index.css` 全链（含我改的 `themes.css`），产物 36959 字节，14 个预设选择器全部保留，`--background: #282a36` 等值正常出现在输出里。说明 `@theme inline` 的 `--color-*` 映射未被破坏。
- 未跑 Playwright e2e（按 ground rules）。

## 六、跨范围事项 / 待办

1. **建议在根 `package.json` 加脚本**（未改，`package.json` 不在本 WP 范围）：
   ```json
   "build:theme-presets": "bun scripts/theme/build-theme-presets.ts"
   ```
   与既有 `build:fonts` 同级。不加也能用，直接 `bun scripts/theme/build-theme-presets.ts`。
2. `packages/stores/src/ui.test.ts:155,175` 仍出现字符串 `'underground'`，**这是刻意的**（用作「已下线的 id 应被丢弃」的样本），无需改；已确认 stores 测试全绿。
3. 无其他需要他人代改的文件。

## 七、给下游 WP 的接口确认

以下已按冻结接口实现并从 `@tmex/theme` 主入口导出，可直接使用：
`THEME_PRESETS`、`ThemePreset`、`isThemePreset`、`applyThemePreset`、
`THEME_PRESET_META`、`ThemePresetMeta`、`ThemeAppearance`、`resolveTerminalTheme`。

`data-testid` 契约（`theme-menu-trigger` / `theme-option-*`）属于 UI 层，本 WP 不涉及。
