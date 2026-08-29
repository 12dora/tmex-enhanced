# f5：apps/fe 采用共享动效基础（motion foundation）

任务：把 `packages/theme/src/motion.css` + `packages/ui/src/components/motion.tsx` 提供的动效基础落到应用外壳与各页面，
只改 `apps/fe/src/**`（`packages/panels`、`packages/terminal-ui` 由并行 agent 负责，未触碰）。

统一口径：时长只用 `--tmex-motion-fast|standard|layout` token，缓动一律 `ease-out`，
过渡场景补 `motion-reduce:transition-none`、`animate-*` 场景补 `motion-reduce:animate-none`，
入场动画一律用 `.tmex-reveal` / `.tmex-fade` / `.tmex-scale-in` / `<Reveal>` / `<Stagger>`。

## 一、按界面逐项落地

### 1. 路由页内容入场

| 文件 | 改动 |
| --- | --- |
| `apps/fe/src/page-wrapper.tsx` | 新增 `animateContent?: boolean`（默认 `true`）。内容容器加 `tmex-reveal`，并挂 `key={state.status}`——模块是懒加载的，不换 key 的话动画会跑在还没有内容的那一帧上；换 key 后 `loading → ready` 重挂一次，淡入正好落在页面真正出现的时刻（此前容器是空的，不存在状态丢失）。 |
| `apps/fe/src/main.tsx` | 两条终端路由（`devices/:deviceId`、`devices/:deviceId/windows/:windowId/panes/:paneId`）显式传 `animateContent={false}`。 |

终端页**完全不做**内容入场：`tmex-fade-up` 期间的 `transform` 会成为 xterm 内 `fixed` 后代
（iOS editor dock / 键盘避让）的 containing block，也可能扰动首帧几何测量。头部 chrome（`PageTitle` / `PageActions`）
本来就在 `PageWrapper` 的 header 里，不在动画容器内，无需另作处理。

### 2. 设置页

`apps/fe/src/pages/SettingsPage.tsx`：把六个 `activeTab === 'x' && <Tab/>` 收进一个 `<Reveal key={activeTab}>`，
只让**新挂载的面板**入场，标签条（`TabsList` / `pillTabTriggerClassName`）保持不动。

> 关键细节：`GeneralSettingsTab` / `DevicesAndFilesTab` / `NotificationSettingsTab` / `AISettingsTab` 返回的都是
> **Fragment**，多张卡片之间的间距原本由页面根容器的 `gap-4 sm:gap-6` 提供。包一层就必须在 `<Reveal>` 上
> 补回 `flex min-w-0 flex-col gap-4 sm:gap-6`，否则卡片会贴在一起。

### 3. 设置 → 节点

| 文件 | 改动 |
| --- | --- |
| `pages/settings/nodes/nodes-tab.tsx` | 本机卡片 `<Reveal>`、HTTPS 区块 `<Reveal delayMs={60}>`、节点管理卡片 `<Reveal delayMs={120}>`，三档手写延迟（只有 3 块，不值得上 `<Stagger>`）。加载态 spinner 补 `motion-reduce:animate-none`。 |
| `pages/settings/nodes/setup/hub-setup-wizard.tsx` | 选完路径后的表单收进 `<Reveal key={path}>`（两条路径互切也重放一次入场）；`PathCard` 的 `transition-colors` 补 `duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none`。 |
| `pages/settings/nodes/setup/become-hub-form.tsx`<br>`pages/settings/nodes/setup/join-hub-form.tsx` | 表单 → 结果卡片的替换：结果 `<Card>` 直接加 `tmex-reveal`（不新增包装层）。 |
| `pages/settings/nodes/membership/leave-dialog.tsx` | warning / error 块与 `LeaveProgress` 的进度条目加 `tmex-fade`；进度 `<p>` 挂 `key={phase}`，每换一个阶段重放一次淡入（比原地换字好读）；两处 `animate-spin` 补 `motion-reduce:animate-none`。 |
| `pages/settings/nodes/https/parts.tsx`（`CopyableCode`）<br>`pages/settings/nodes/local-machine-card.tsx`（`CopyableValue`）<br>`pages/settings/nodes/management/enrollment-section.tsx`（`CopyableCode`） | 复制反馈：换上来的图标（`Check` / `CircleCheck` / `Copy`）加 `tmex-scale-in`（图标是条件换组件，会真重挂，动画每次都放）；文案包一层 `<span aria-live="polite">`，i18n key 仍是 `nodes.actions.copy` / `nodes.actions.copied`，未改。 |
| `pages/settings/nodes/management/nodes-table.tsx` | 空态单元格加 `tmex-fade`。 |
| `pages/settings/nodes/management/nodes-management.tsx`<br>`pages/settings/nodes/https/https-section.tsx`<br>`pages/settings/nodes/local-machine-card.tsx` | 刷新按钮 / 区块级 loading spinner 补 `motion-reduce:animate-none`。 |

### 4. 设备管理页

| 文件 | 改动 |
| --- | --- |
| `pages/DevicesPage.tsx` | 节点分组容器换成 `<Stagger>`（`data-testid` / className 原样透传）。分组元素在后续 mesh 更新里按 `runtimeNodeId` 原地复用，入场只在各自首次挂载时跑一次，不会因为心跳刷新反复闪。加载 spinner 补 `motion-reduce:animate-none`。 |
| `pages/devices/node-device-group.tsx` | `CHIP_CLASS`（状态 / hub / 版本 chip）补 `transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none`——节点在 offline/signedOut/ready 之间切换时配色平滑过渡。 |

### 5. 登录与凭证弹层

| 文件 | 改动 |
| --- | --- |
| `pages/LoginPage.tsx` | 表单卡片 `tmex-reveal`；错误区改成**常驻 live region**：`<div aria-live="polite" className="empty:hidden">` 包住原来的 `<p data-testid="login-error">`，空的时候 `:empty` 收掉不占 flex gap，错误文案本身加 `tmex-fade`。两处 spinner 补 `motion-reduce:animate-none`。 |
| `auth/credential-prompt.tsx` | 遮罩 `tmex-fade`、卡片 `tmex-scale-in`；错误区同样换成 `empty:hidden` 的常驻 live region + `tmex-fade`；spinner 补 `motion-reduce:animate-none`。 |

用常驻容器而不是给条件渲染的 `<p>` 挂 `aria-live`，是因为动态插入的 live region 本身不保证被播报；
`empty:hidden` 保证空态不产生额外间距，`data-testid` 的存在/缺失语义与原来一致（现有测试全部照过）。

### 6. 侧边栏

| 文件 | 改动 |
| --- | --- |
| `components/page-layouts/components/app-sidebar.tsx` | 三个 tab 的内容收进 `<Reveal key={sidebarTab} className="flex min-h-0 flex-1 flex-col">`。**必须原样复刻 `SidebarContent` 的 flex 链**（它本身是 `flex min-h-0 flex-1 flex-col`），否则设备树（`SidebarGroup flex-1 min-h-0`）、文件树、`AgentTab` 的 `h-full` 会失去可滚动高度。 |
| `components/page-layouts/components/nav-main.tsx` | 折叠箭头：原来的 `data-[state=open]:rotate-90` 是**失效选择器**——Base UI 的 `CollapsibleTrigger` 挂的是 `data-panel-open`（见 `@base-ui/react/collapsible/trigger/CollapsibleTriggerDataAttributes.js`）。补上 `data-panel-open:rotate-90`，旧选择器保留不动；同时把 `transition-opacity`（`SidebarMenuAction` 基类里的）扩成 `transition-[opacity,transform]`，让旋转也吃到基类的 standard 时长与 `motion-reduce:transition-none`。 |
| `components/page-layouts/components/agent-session-row.tsx` | 运行中会话圆点 `animate-pulse` → `motion-safe:animate-pulse`；hover 才显形的操作按钮 `transition-opacity` 补 `duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none`；两种会话行的 `transition-colors` 补 fast token。 |
| `components/page-layouts/components/sidebar-agent-sessions.tsx` | 孤立会话区的 chevron `transition-transform` 补 standard token + `ease-out` + `motion-reduce:transition-none`。 |
| `components/page-layouts/components/sidebar-node-section.tsx` | 「登录此节点」展开按钮补 `transition-colors` + fast token；登录中 / 登录失败两个分支加 `tmex-fade`；`noKnownDevices` 与 `sidebar.noVisibleDevices` 两个空态提示加 `tmex-fade`；spinner 补 `motion-reduce:animate-none`。 |

### 7. 节点徽标浮层

`node/device-node-badges.tsx`：ICE 诊断浮层加 `animate-in fade-in-0 zoom-in-95 duration-(--tmex-motion-fast) ease-out motion-reduce:animate-none`；
两枚徽标本体补 `transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none`。

### 8. 其余 spinner / 空态

- `pages/FilePage.tsx`：`CenteredMessage`（loading / error / 空态共用）加 `tmex-fade`，两处 spinner 补 `motion-reduce:animate-none`。
- `node/node-runtime-boundary.tsx`、`pages/AccountSecurityPage.tsx` 的页面级 loading spinner 补 `motion-reduce:animate-none`。

## 二、改动文件清单（27 个，全在 `apps/fe/src/**`）

```
page-wrapper.tsx
main.tsx
auth/credential-prompt.tsx
components/page-layouts/components/app-sidebar.tsx
components/page-layouts/components/nav-main.tsx
components/page-layouts/components/agent-session-row.tsx
components/page-layouts/components/sidebar-agent-sessions.tsx
components/page-layouts/components/sidebar-node-section.tsx
node/device-node-badges.tsx
node/node-runtime-boundary.tsx
pages/SettingsPage.tsx
pages/DevicesPage.tsx
pages/LoginPage.tsx
pages/FilePage.tsx
pages/AccountSecurityPage.tsx
pages/devices/node-device-group.tsx
pages/settings/nodes/nodes-tab.tsx
pages/settings/nodes/local-machine-card.tsx
pages/settings/nodes/https/parts.tsx
pages/settings/nodes/https/https-section.tsx
pages/settings/nodes/management/enrollment-section.tsx
pages/settings/nodes/management/nodes-management.tsx
pages/settings/nodes/management/nodes-table.tsx
pages/settings/nodes/membership/leave-dialog.tsx
pages/settings/nodes/setup/hub-setup-wizard.tsx
pages/settings/nodes/setup/become-hub-form.tsx
pages/settings/nodes/setup/join-hub-form.tsx
```

## 三、验证

| 检查项 | 基线 | 结果 |
| --- | --- | --- |
| `cd apps/fe && bun test src/` | 551 pass / 0 fail | **551 pass / 0 fail**（1420 expect，44 文件） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `bunx biome check <27 个改动文件>` | — | **1 error**，即已知的 `main.tsx:81 useExhaustiveDependencies`（既有，未动） |

biome 首轮报了 2 处**本次引入**的格式问题（`https/parts.tsx`、`https/https-section.tsx`），
已对这两个文件跑 `biome check --write` 修掉；确认修改仅落在本次改动的行上（各 +2 行范围），未产生无关的全量格式化 diff。
生成文件（`i18n/resources.ts` 等）一律未碰。

**Tailwind 编译验证**：用真实的 `apps/fe/src/index.css` 跑了一次 `@tailwindcss/cli@4.1.18`（输出到 scratchpad，未写入仓库），
逐条确认新语法真的编译得出来：

- `.empty\:hidden { &:empty { display: none } }` ✓（登录页 / 凭证弹层的常驻 live region 靠它不占 gap）
- `.data-panel-open\:rotate-90 { &[data-panel-open] {...} }` ✓
- `.motion-safe\:animate-pulse` ✓
- `duration-(--tmex-motion-fast)` → `var(--tmex-motion-fast)` ✓
- `animate-in fade-in-0 zoom-in-95` ✓
- `.tmex-reveal` / `.tmex-fade` / `.tmex-scale-in` / `.tmex-stagger > *` 均在产物中 ✓

按要求未跑 Playwright / e2e。

## 四、刻意跳过的部分与原因

1. **设备终端页（`DevicePage` / `/devices/:deviceId`）不加任何动效**：连非终端 chrome 也没加。
   页头的 `PageTitle` / `PageActions` 挂在 `PageWrapper` 的 header 里，本来就在动画容器之外；
   页面主体全部是 `DeviceConsole`（xterm 舞台），加入场动画一定会碰几何/`fixed` 定位。
2. **不给 tmux 树 / 终端输出 / 传输进度加任何动效**：高频更新面，动画只会制造噪音。
3. **不给稳定的 online/offline 状态点加脉冲**：只保留了 agent 会话 running 这一处既有脉冲，并降级成 `motion-safe:`。
4. **节点表格行、pending 列表行没有加逐行入场**：这两处随心跳 / 轮询刷新，真正的进出场需要两阶段删除模型；
   只用 CSS 类会变成「每次刷新都闪一遍」。只给空态加了一次性淡入。
5. **没有对剩余约 25 处按钮内联 spinner 逐个补 `motion-reduce:animate-none`**：
   `motion.css` 的全局 `prefers-reduced-motion` 块带 `!important`，已经把 `animation-duration` 压到 `0.01ms`，
   视觉上等价于静止。只对本次真正改到的（页面级 / 区块级 loading、以及我动过的那几个文件里的）补了显式变体，
   避免制造与本任务无关的大面积 diff。
6. **没有做真实浏览器视觉验收**（无 Playwright、未起 dev server）。以下三处建议人工过一眼：
   - 设置页换标签时 `<Reveal>` 的 gap 复刻是否与改动前逐像素一致；
   - 侧边栏换 tab 时设备树 / 文件树的滚动高度是否正常（flex 链已按 `SidebarContent` 复刻，但没有运行时验证）；
   - `PageWrapper` 的 `key={state.status}` 在慢网下（module chunk 加载较久）的观感。

## 五、附带修掉的既有问题

`nav-main.tsx` 的折叠箭头旋转选择器 `data-[state=open]:rotate-90` 对 Base UI 的 `CollapsibleTrigger` 无效
（正确属性是 `data-panel-open`）。本次补上了正确选择器（旧的保留，两者命中同一条规则）。
注意当前 `navMainItems` 里唯一一项没有 `items`，这条折叠分支实际还没有消费方，属于提前修正。
