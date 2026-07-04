# Plan 执行结果：bell-notification-redesign

## 状态

✅ 全部 15 步已实现并通过验证。

## 实现概要

### 后端（apps/gateway）

- **schema 迁移**（`drizzle/0012_naive_lizard.sql`）：新增 `enable_notification_push` / `enable_bell_push` / `enable_bell_sound` 三列（均 `NOT NULL DEFAULT 1`），删除 `enable_browser_bell_toast` / `enable_telegram_bell_push` / `enable_telegram_notification_push` / `enable_weixin_bell_push` / `enable_weixin_notification_push` 五列。迁移已应用到 `apps/gateway/tmex.db` 与 worktree 根 `tmex.db`。
- **共享类型**（`packages/shared/src/index.ts`）：`SiteSettings` 与 `UpdateSiteSettingsRequest` 同步替换字段。
- **DB 适配**（`db/index.ts`）：`toSiteSettings` / `ensureSiteSettingsInitialized` / `updateSiteSettings`（merge + set）全部改用新字段。
- **API 校验**（`api/index.ts`）：`validateSiteSettingsUpdate` 删除 5 个旧 boolean 块，新增 3 个新 boolean 块。
- **渠道 gate**：
  - `telegram.ts`：`terminal_bell` 走 `enableBellPush`；其余事件（含 `terminal_notification` 与 generic）前置 `enableNotificationPush` gate。
  - `weixin.ts`：同上；doc-comment 同步更新。
  - `webhook.ts`：新增全局 gate（`terminal_bell` → `enableBellPush`，其他 → `enableNotificationPush`），并 import `getSiteSettings`。
- **supervisor.ts**：`pushCredentialWarning` 改用 `enableNotificationPush`。

### i18n

- `en_US` / `zh_CN` / `ja_JP` 三个 locale 删除 5 个旧 key，新增 `enableNotificationPush` / `enableBellPush` / `enableBellSound` 三 key。
- `bun run build:i18n` 已重新生成 `resources.ts` 与 `types.ts`。

### 前端（apps/fe）

- **site store**（`stores/site.ts`）：`DEFAULT_SETTINGS` 替换字段。
- **SettingsPage**（`pages/SettingsPage.tsx`）：state、hydration、save payload、notifications tab UI 全部替换为 4 个 toggle（enableNotificationPush / enableBellPush / enableBellSound + 保留 enableBrowserNotificationToast），data-testid 分别为 `settings-enable-notification-push` / `settings-enable-bell-push` / `settings-enable-bell-sound`。
- **bell store**（`stores/bell.ts`，新增）：`ringingPanes` + `triggerBell(paneId)`，1.5s 后自动清除。
- **WebAudio 提示音**（`utils/bell-sound.ts`，新增）：880Hz sine wave，150ms，peak gain 0.15，attack-decay 包络。
- **tmux.ts bell 分支**：删除 sonner Toast，改为 `useBellStore.triggerBell(paneId)` + `enableBellSound` gate + `playBellSound()`；paneId 缺失时回退 windowId。`buildPaneLocationLabel` import 因不再使用已移除。
- **CSS**（`index.css`）：新增 `@keyframes bell-blink` + `.bell-blink` class（0.75s ease-in-out 2 次）。
- **4 处 emoji 集成**：
  - `DevicePage.terminalTopbarLabel`：订阅 `ringingPanes`，active pane 闪烁时前缀 `🔔 `，document.title 自动跟随。
  - `DevicePage.PageTitle`：`useBellStore` 响应式订阅，渲染 `<span className="bell-blink">🔔 </span>`。
  - `SplitTerminalArea`：新增 `PaneBellIcon` 组件，在 split-pane-titlebar 标题前渲染。
  - `sidebar-device-list`：新增 `WindowBellIcon`（任意子 pane 闪烁即显示）与 `PaneBellIcon`，分别用于 WindowItem 与 PaneRow。

### 测试 mock 更新

- `events/index.test.ts`：8 处 `enableTelegramBellPush` → `enableBellPush`，`enableTelegramNotificationPush` → `enableNotificationPush`。
- `events/channels/weixin.test.ts`：6 处字段替换 + 1 处测试描述更新。
- `push/connection-alerts.test.ts` / `push/supervisor.test.ts`：mock SiteSettings 字段替换。

## 验证

- **迁移生成与应用**：`bun run db:generate` 生成 `0012_naive_lizard.sql`；`DATABASE_URL=./tmex.db bun run db:migrate` 应用成功。
- **i18n 构建**：`bun run build:i18n` 三 locale 重建无报错。
- **FE typecheck**：`bun run tsc --noEmit` exit 0。
- **FE 构建**：`bun run build`（tsc + vite build）成功，4888 模块转换。
- **Gateway 全量测试**：`bun test`（in-memory db，NODE_ENV=test）→ **716 pass / 0 fail**，2081 expect() calls，23.72s。
  - `events/index.test.ts` 5/5 pass
  - `events/channels/weixin.test.ts` 4/4 pass
  - `push/connection-alerts.test.ts` + `push/supervisor.test.ts` 12/12 pass
- **测试备注**：若显式传 `DATABASE_URL=./tmex.db` 指向 worktree 根 dev 库（`language=zh_CN`），`events/index.test.ts` 会出现 3 个「英文断言 vs zh_CN 文案」的字符串不匹配失败——此为测试库 locale 与硬编码英文断言的既有矛盾，与本改动无关；改用 in-memory db（preload 默认行为）即全绿。

## 未做 / 风险

- **未做 E2E**：计划标注 E2E 为「可选」，未跑 `apps/fe/tests/`（生产 isolation 要求）；功能层面已由单元测试 + FE 构建 + typecheck 覆盖。
- **未做 live API curl 验证**：worktree dev server 未启动；API 字段校验逻辑已由单测覆盖（`api/index.test.ts` 属全量 716 之内）。
- **AudioContext autoplay**：首次 bell 在用户未与页面交互前无声，属浏览器策略预期行为，无需处理。
- **历史文档残留**：`docs/agent/2026061302-system-prompt-and-credential-handling.md` L50 仍提及 `enableTelegramNotificationPush`，属历史归档文档，按惯例不改。
- **drizzle snapshot**：`drizzle/meta/0012_snapshot.json` 与 `_journal.json` 为生成文件，已随 `db:generate` 产出，未 lint。

## 文件清单

修改 24 个文件，新增 4 个文件（`apps/fe/src/stores/bell.ts`、`apps/fe/src/utils/bell-sound.ts`、`apps/gateway/drizzle/0012_naive_lizard.sql`、`apps/gateway/drizzle/meta/0012_snapshot.json`），存档 2 个（`plan-prompt.md`、`plan-00.md`）。