# 多主题预设 review 修复结果（review-theme.md 的 #1 / #3 / #5 / #6 / #7）

分支：`chore/merge-hub-tabs`，worktree：`/Users/konata/code/tmex-enhanced-wt-merge`。
未触碰 `packages/app/**` 与 `scripts/hub-e2e/**`，无 git 操作。

## #1 在途 settings 响应覆盖刚选中的预设

- **根因**：`fetchSettings()` 在途时用户切外观/选预设，`updateTheme()` 不动 `settingsGeneration`，
  旧响应回来仍被判为「最新」，`commitSettings()` 把旧 `theme` 写回并顺带清掉新预设。
- **改动**：`packages/stores/src/site.ts` 新增 `invalidateSettingsRequests()`（递增
  `settingsGeneration`），`updateTheme()`（含 `selectThemePreset` 走的路径）进入即调用，
  使全部在途 settings 请求作废；同时把 `loading` 一并落回 `false`——在途请求已作废，
  不会再有人复位它。`setThemeFromS2C` 刻意不作废：它与 `handleSettingsUpdate('site')`
  触发的重拉常常同时在途，作废会连带丢掉 siteName 等非主题字段。
- **测试**：`packages/stores/src/site-theme.test.ts` 新增「在途 fetchSettings 的旧 theme
  不覆盖期间选中的预设」——fetch 用可控 gate 挂起，期间 `selectThemePreset(LIGHT_PRESET)`，
  放行后断言外观/预设/`loading` 均为本地新值。回归验证：注释掉修复后该用例失败。

## #3 多标签页互相擦除 localStorage 里的预设

- **根因**：`themePreset` 持久化在同源共享的 localStorage，但第二个标签页的内存 store
  从不监听 `storage` 事件；A 页改成浅色预设后，B 页收到 light S2C 时仍拿旧的深色预设判失配，
  于是清成 `null` 并回写，覆盖 A 刚写入的值。
- **改动**：
  - `packages/stores/src/ui.ts`：新增 `readPersistedThemeState()`（解析持久化 JSON，
    `theme` 只认 `light|dark`，`themePreset` 仅在字段存在时按 `isThemePreset` 规范化——
    site store 的离线 fallback 只写 `theme`，不能被读成「预设已清空」）、store action
    `syncThemeFromStorage()`（有差异才 `set`，避免同值回写与另一标签页互相触发），
    以及 `subscribeThemeStorageSync()`：`typeof window` 与 `addEventListener` 双重守卫，
    只处理 `event.key === <persist key>` 的事件。
  - `packages/stores/src/site.ts`：`syncThemeToUIStore()` 在做失配清理前先调用
    `syncThemeFromStorage()`，使 S2C 失配判定基于「刚同步过的值」，不依赖 storage 事件
    与 S2C 帧的到达顺序。
- **测试**：
  - `packages/stores/src/ui.test.ts` 新增 `cross-tab theme sync` 四个用例（临时接管
    `window.addEventListener` 收集监听器后手工投递事件）：跨页同步外观+预设、无关 key
    不生效、非法预设按无预设处理、持久化缺字段时不误清预设。
  - `site-theme.test.ts` 新增「S2C 失配清理前先同步另一标签页写入的预设」。
  - 回归验证：去掉两处 `syncThemeFromStorage()` 调用后，相关 3 个用例失败。

## #5 TerminalPreview 在控制器创建期间切主题会丢更新

- **根因**：`createTerminalController()` 是异步的，await 期间的主题变更使增量 effect 空跑
  （`termRef.current === null`），控制器返回后只赋值 ref，不补发最新配色。
- **改动**：`packages/terminal-ui/src/components/theme.ts` 新增
  `attachTerminalWithLatestTheme(ref, terminal, latestTheme)`——写 ref 的同时按
  `latestTheme.current` 再下发一次；`TerminalPreview.tsx` 用它替换裸的
  `termRef.current = term`。抽成函数是因为 terminal-ui 的 bun test 无 DOM
  （全仓 React 组件测试只能 `react-dom/server` 静态渲染），无法驱动 effect 时序。
- **测试**：`theme.test.ts` 新增两个用例，其一用可控 Promise 复现时序（挂起期间换配色 +
  断言此刻增量下发返回 `false`，resolve 后断言实例收到的是新配色）。

## #6 Tokyo Night Light 的 bright ANSI 槽复制了 normal 槽

- **改动**：`packages/theme/src/preset-palettes.ts` 按上游
  `tokyonight.nvim/extras/kitty/tokyonight_day.conf`（已联网核对）修正六个值：
  brightRed `#ff4774`、brightGreen `#5c8524`、brightYellow `#a27629`、brightBlue `#358aff`、
  brightMagenta `#a463ff`、brightCyan `#007ea8`。
  跑 `bun run build:theme-presets` 后两份生成 CSS 均报 up to date（浅底方案的
  `pickReadable` 本就取 normal 色，代码高亮 token 不受影响），故无 CSS 变更。
- **测试**：`presets.test.ts` 新增两个用例：全预设「bright 六色不整体复制 normal 槽」，
  以及 tokyo-night-light 六个 bright 值的固定值断言。
- **注意（与任务书的偏差）**：`catppuccin-mocha` / `catppuccin-latte` 的上游官方 kitty 配色
  本就令 color1-6 与 color9-14 同色（已核对 catppuccin/kitty 仓库），所以「全预设 bright
  不得整体等于 normal」无法无条件成立；测试对这两个预设显式放行并写明原因。
  `nord` 只有 5 个槽重合（cyan 不同，与上游一致），仍在规则内。

## #7 e2e 未覆盖命名预设

- **新增**：`apps/fe/tests/theme-presets.spec.ts`（两个用例，helper 沿用 theme-broadcast /
  theme-propagation 的写法）：
  1. 设备页选 `dracula`：断言 `html[data-theme-preset="dracula"]`、`.dark` 存在、
     trigger `data-theme-appearance="dark"`、body 计算背景（`var(--background)`）与
     `[data-terminal-engine]` 终端底色均为 `rgb(40, 42, 54)`；reload 后预设与终端配色仍在。
  2. 设置页选 `solarized-light`：`.dark` 消失、body 背景 `rgb(253, 246, 227)`；
     再选 `theme-option-dark`：`html` 上 `data-theme-preset` 属性被移除、trigger 的
     `data-theme-preset` 为空串、`.dark` 回来、背景不再是浅色预设色。

## 验收数据（before → after）

| 范围 | 命令 | before | after |
|---|---|---|---|
| stores | `bun test` | 251 pass / 0 fail | 257 pass / 0 fail |
| terminal-ui | `bun test` | 313 pass / 0 fail | 315 pass / 0 fail |
| theme | `bun test` | 50 pass / 0 fail | 52 pass / 0 fail |
| panels | `bun test` | — | 368 pass / 0 fail |
| apps/fe | `bun test src/` | — | 330 pass / 0 fail |
| tsc | `bunx tsc --noEmit -p .` | stores 1 / theme 9 / 其余 0 | 完全一致（stores 1、theme 9、terminal-ui 0、panels 0、fe 0） |
| biome | `bunx biome check <改动文件>` | — | 全部通过（`apps/fe/tests` 下未使用 `--write`） |

e2e：`TMEX_E2E_GATEWAY_PORT=9765 TMEX_E2E_FE_PORT=9985 bun run scripts/run-e2e.ts
tests/theme-presets.spec.ts tests/theme-broadcast.spec.ts tests/theme-propagation.spec.ts`
→ **9 passed (44.1s)**（新增 2 个 + 既有 7 个，无 flaky 重试）。
