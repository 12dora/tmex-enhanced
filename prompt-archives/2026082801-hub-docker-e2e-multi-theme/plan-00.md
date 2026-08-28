# plan-00：hub 多容器端到端验证 + 多主题配色

## 背景

- hub/node mesh（原 `feat/hub-node`）已在 `2026082800-merge-hub-tabs` 任务中合并进 `chore/merge-hub-tabs`（worktree `../tmex-enhanced-wt-merge`），本任务在该分支继续。`plan-00-result.md` 的遗留项：真实多机验收 1–3（双机 LAN、hub 停机、直连中断不丢字）未做。
- 主题：服务端 `site_settings.theme` 只允许 `dark|light`，经 `/api/settings/theme`、Borsh `SITE_THEME_UPDATE`、DECSET 997 广播到 tmux 与各标签页；前端另有一套 `data-theme-preset`（`packages/theme/src/presets.ts` + `themes.css`，7 个设计稿预设）无任何 UI 入口。勘察见 `sub/explore-theme.md`。

## 任务 1：hub 多容器 e2e

- 远程 Ubuntu 26.04（8c/15G，公网 IP，Docker 29）。**该机跑着 aaPanel/nginx（80/443）、ufw 默认 DROP**，禁止占用 80/443、禁止改 nginx；不改防火墙，所有容器只在 docker 网络内互通，验证脚本在容器内 / 通过 `ssh -L` 执行。
- 拓扑：`hub`（`TMEX_ROLES=hub,node`，接 `net-a` + `net-b`）、`node-a`（`net-a`）、`node-b`（`net-b`）。A/B 不同 bridge 互不可达 → 模拟 NAT 后设备，node↔node 只能 hub relay。HTTPS 由自签 CA（Caddy `tls internal` 或 openssl）+ `NODE_EXTRA_CA_CERTS` 提供，具体以 `sub/explore-hub-e2e.md` 结论为准。
- 交付：`scripts/hub-e2e/`（Dockerfile、compose、`run.sh` 驱动脚本、断言），文档 `docs/hub/2026082801-hub-docker-e2e.md`，结果记入 `plan-00-result.md`。发现的 hub bug 派 grok 修，codex sol 审。

## 任务 2：多主题

### 设计决策（指挥官拍板）

1. **服务端 `theme` 继续只表示外观 `dark|light`**，不改 schema / Borsh / API。tmux DECSET 997、OSC 11、window-style 只需外观，保持现状。
2. **命名配色 = 本地 preset**：复用 `UIStore.themePreset`（localStorage 持久化）与 `data-theme-preset` 属性机制，把 7 个无人使用的设计稿预设替换为：`dracula`、`tokyo-night`、`tokyo-night-storm`、`tokyo-night-light`、`catppuccin-mocha`、`catppuccin-latte`、`nord`、`one-dark`、`solarized-dark`、`solarized-light`、`gruvbox-dark`、`gruvbox-light`、`github-dark`、`github-light`；`null` = 默认 seoul256 风格 light/dark。
3. 每个 preset 固定一个外观。选择 preset 时同时 `updateTheme(appearance)`（走既有服务端同步）；收到 S2C 外观变更且与当前 preset 外观不一致时，preset 重置为 `null`（跟随站点外观）。
4. 每个 preset 同时定义 UI token（`[data-theme-preset=…]` CSS 变量，含 `--code-*` 高亮）与终端 16 色 + fg/bg/cursor/selection（`TerminalThemeColors`），终端通过既有 `instance.setTheme()` 热切换。
5. 侧栏 Sun/Moon 按钮改为 DropdownMenu 主题选择器（Base UI `DropdownMenuRadioGroup`），项含配色预览；设置页删除深色开关；e2e 改用新 testid。

### 冻结接口（三个并行工作包共同依赖）

```ts
// @tmex/theme
export const THEME_PRESETS: readonly ThemePreset[];         // 上述 14 个 id
export type ThemePreset;                                    // 联合类型
export type ThemeAppearance = 'light' | 'dark';
export interface ThemePresetMeta {
  id: ThemePreset; label: string /* 英文品牌名，i18n 不翻译 */;
  appearance: ThemeAppearance;
  preview: { background: string; foreground: string; accent: string };
  terminal: TerminalThemeColors;                            // 来自 @tmex/shared
}
export const THEME_PRESET_META: Record<ThemePreset, ThemePresetMeta>;
export function isThemePreset(v: unknown): v is ThemePreset;
export function applyThemePreset(p: ThemePreset | null): void;   // 设/删 data-theme-preset（已有）
export function resolveTerminalTheme(appearance: ThemeAppearance, preset: ThemePreset | null): TerminalThemeColors;
// @tmex/stores  useSiteStore
selectThemePreset(preset: ThemePreset | null, fallbackAppearance?: ThemeAppearance): void
//   preset≠null → setThemePreset + updateTheme(meta.appearance)；preset=null → setThemePreset(null) + updateTheme(fallbackAppearance ?? 当前 theme)
// data-testid：sidebar 触发器 `theme-menu-trigger`，菜单项 `theme-option-light` / `theme-option-dark` / `theme-option-<preset>`
```

### 工作包（同一 worktree 并行，文件范围互斥）

| WP | 执行者 | 范围 |
|---|---|---|
| A1 theme 定义 | Opus 5 | `packages/theme/src/{presets.ts,themes.css,index.ts,presets.test.ts}`、新增 `packages/theme/src/preset-meta.ts`、`packages/panels/src/code-viewer/hljs-terminal-theme.css` |
| A2 终端/stores 接线 | Opus 5 | `packages/terminal-ui/src/components/**`、`packages/panels/src/device-console/device-console.tsx`、`packages/panels/src/markdown/mermaid-block.tsx`、`packages/stores/src/{site.ts,ui.ts}` 及其测试 |
| B 前端 UI | Opus 5 | `apps/fe/src/main.tsx`、`sidebar-title.tsx`、`general-settings-tab.tsx`、`apps/fe/tests/*theme*.spec.ts`、`settings.spec.ts`、`packages/shared/src/i18n/locales/*.json`（随后 `bun run build:i18n`） |
| hub e2e | grok 4.6 | `scripts/hub-e2e/**`、`docs/hub/2026082801-hub-docker-e2e.md` |

## 验收

- 各包 `bun test` 0 fail，tsc 错误数不高于基线（gateway 23、app 1、api-client 5、stores 1、theme 10，其余 0），biome 通过。
- 手动/Playwright：侧栏点击主题按钮弹出菜单，切换 Dracula 后 UI 与终端同时换色，刷新后保持；设置页无深色开关；另一标签页外观同步。
- hub e2e：`run.sh` 全绿并产出报告；hub 停机期间已登录入口仍可用；hub 恢复无需重登。

## 风险

- 14 套配色的 UI token 数量大，靠 A1 的 CSS 结构化生成（TS 定义 → 生成 CSS）降低出错率；`presets.test.ts` 校验注册表与 CSS 选择器一致。
- 远程机是别人的生产面板机，只用 docker 网络内互通，不动防火墙与 nginx。
