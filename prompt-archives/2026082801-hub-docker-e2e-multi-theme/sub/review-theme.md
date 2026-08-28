发现 7 个问题，建议修改后再合并。

1. major — 延迟的 settings 请求会覆盖刚选中的预设  
   [packages/stores/src/site.ts:164](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/site.ts:164)

   场景：首屏 `fetchSettings()` 尚未返回时，用户选择浅色预设；本地已经切到浅色并上行，但先前请求返回旧的 `dark`，`commitSettings()` 会再次写入暗色并清掉新预设。`updateTheme()` 没有递增 `settingsGeneration`，所以旧请求仍被视为有效。

   建议：本地主题更新时使所有在途 settings 请求失效，或统一引入 mutation generation；补一个 deferred-fetch 回归测试。

2. major — 在途旧 S2C 会永久吞掉刚选择的预设  
   [packages/stores/src/site.ts:190](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/site.ts:190)  
   [packages/ws-client/src/transport-message-decoder.ts:143](/Users/konata/code/tmex-enhanced-wt-merge/packages/ws-client/src/transport-message-decoder.ts:143)

   场景：用户从暗色选择浅色预设时，一条已排队的旧 `dark` S2C 在点击后到达。它会清除浅色预设；随后本次操作对应的 `light` 回声只更新 appearance，不会恢复预设，最终服务端是浅色，但命名预设丢失。wire 中已有 `serverTimestamp`，解码层却直接丢弃。

   建议：把预设选择建模为待确认的原子事务；匹配的 S2C 到达前不要让较早的失配帧清除该预设，匹配后再解除 pending。保留并传递 `serverTimestamp`，补乱序 S2C 测试。

3. major — 同源多标签页会互相擦除 localStorage 中的预设  
   [packages/stores/src/site.ts:55](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/site.ts:55)  
   [packages/stores/src/ui.ts:125](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/ui.ts:125)

   场景：两个标签页都持有旧暗色预设。A 选择浅色预设并写入共享 localStorage；B 的内存 store 不监听 `storage` 事件，收到浅色 S2C 后仍认为自己持有暗色预设，于是清除预设并把 `null` 持久化，覆盖 A 刚写入的值。A 当前界面看似正常，但刷新后预设消失。

   建议：同步同源标签页的 UI store，并把 appearance/preset 作为一个状态对原子持久化；S2C 清理前不得用陈旧内存覆盖更新的持久化值。测试必须使用同一 BrowserContext 的两个页面。

4. minor — 首屏 appearance 与 preset 不是从同一个快照恢复  
   [apps/fe/src/main.tsx:31](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:31)

   `applyInitialTheme()` 和 `applyInitialThemePreset()` 分别读取 localStorage；store rehydrate 后又只有 preset 的 DOM 同步，没有对应的 `.dark` 同步。跨标签页恰好在这些读取间更新时，可得到 store 为 light、DOM 仍为 `.dark` 的状态；不挂载 `SidebarTitle` 的顶层页面不会通过 settings fetch 自动纠正。

   建议：一次读取并规范化 `{theme, themePreset}`，失配时清预设；rehydrate 后用 layout effect 同步 `.dark` 和 `data-theme-preset` 两个 DOM 状态。

5. minor — TerminalPreview 在控制器创建期间切主题会丢更新  
   [packages/terminal-ui/src/components/TerminalPreview.tsx:95](/Users/konata/code/tmex-enhanced-wt-merge/packages/terminal-ui/src/components/TerminalPreview.tsx:95)

   `createTerminalController()` 以主题 A 开始；Promise 未完成时切到 B，增量 effect 因 `termRef.current === null` 而空跑；控制器返回后只赋值 `termRef`，没有再次应用最新主题，因此预览会一直显示 A，直到下一次主题或字体变化。

   建议：在 `termRef.current = term` 后立即调用 `applyTerminalTheme(term, terminalThemeRef.current)`；用可控 Promise 覆盖该时序。主终端的 `useTerminalBootSurface` 会因 `instance` 变化再次执行 effect，没有同样问题。

6. minor — Tokyo Night Light 的 bright ANSI 槽复制了 normal 槽  
   [packages/theme/src/preset-palettes.ts:222](/Users/konata/code/tmex-enhanced-wt-merge/packages/theme/src/preset-palettes.ts:222)

   上游 Day 配置的 bright red/green/yellow/blue/magenta/cyan 分别是 `#ff4774/#5c8524/#a27629/#358aff/#a463ff/#007ea8`，当前实现却全部重复 normal 色，导致 ANSI 90–97 中六个槽位错误。[Tokyo Night Day 官方配置](https://raw.githubusercontent.com/folke/tokyonight.nvim/main/extras/kitty/tokyonight_day.conf)

   建议：按上游修正六个 bright 值，并增加固定值断言；当前测试只验证字段完整和格式合法，无法发现槽位复制错误。

7. minor — 没有任何 e2e 真正选择命名预设  
   [apps/fe/tests/settings.spec.ts:134](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/settings.spec.ts:134)

   新 e2e 只点击默认 Light/Dark；静态菜单测试也不执行 Base UI 交互。因此 `data-theme-preset`、固定 appearance、刷新持久化、终端实时换色和失配 S2C 清理均没有端到端覆盖。

   建议：至少覆盖一个浅色和一个深色预设，断言根属性、`.dark`、计算后的 CSS token、终端背景、刷新持久化及失配 S2C 重置。

总体结论：CSS 源顺序/特异性、`data-theme-radius`、Base UI 键盘行为和现有 e2e selector 未发现明确缺陷；但预设状态存在多条可复现的异步与跨标签页丢失路径，建议 request changes。定向验证为 97 个测试通过，前端 TypeScript 检查通过；未运行完整 e2e。