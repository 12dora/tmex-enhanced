# Plan: bell-notification-redesign

## Context

当前 BELL 通知在浏览器内通过 sonner Toast 弹出，由 `enableBrowserBellToast` 开关控制。通知推送设置有 6 个 toggle（browser/telegram/weixin × bell/notification），但 Telegram 和微信各自已有 per-bot `enabled` 开关，全局层面的 per-channel toggle 没有实际意义。

目标：
1. 删除浏览器内 BELL Toast 及 `enableBrowserBellToast` 开关
2. BELL 触发时在 4 处闪烁 🔔 emoji 2 次（浏览器标题栏、终端上方标题栏、pane 标题栏、device 列表 window/pane），永远有效无开关
3. BELL 触发时通过 WebAudio 播放提示音，有独立开关可关闭
4. 通知系统改为：`enableNotificationPush`（全局通知推送总开关）+ `enableBellPush`（全局 BELL 推送开关），两者独立；删除 `enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush` 四个无意义配置项

## 用户确认的决策

- `enableNotificationPush` 和 `enableBellPush` 两者独立，互不影响
- `enableNotificationPush` 只控制外部推送（Telegram/微信），不控制浏览器 Toast
- BELL 提示音开关完全独立（默认开），不受 `enableBellPush` 控制
- BELL emoji 闪烁 2 次后消失（约 1-2 秒），不需用户交互清除
- `enableBrowserNotificationToast` 保留（非 BELL 的普通 OSC 通知 Toast 仍由它控制）

## Approach

### 步骤 1：DB schema + 迁移

**文件**：`apps/gateway/src/db/schema.ts`（siteSettings 表，L20-58）

修改 siteSettings 表列：
- **删除** 4 列：`enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush`
- **删除** 1 列：`enableBrowserBellToast`
- **新增** 3 列：

**生成迁移**：在 `apps/gateway/` 下运行 `bun run db:generate`（即 `drizzle-kit generate --config drizzle.config.ts`），生成 `0012_*.sql` 迁移文件 + snapshot。迁移 SQL 会是：
```sql
ALTER TABLE `site_settings` ADD `enable_notification_push` integer NOT NULL DEFAULT 1;
ALTER TABLE `site_settings` ADD `enable_bell_push` integer NOT NULL DEFAULT 1;
ALTER TABLE `site_settings` ADD `enable_bell_sound` integer NOT NULL DEFAULT 1;
-- SQLite 3.35+ 支持 DROP COLUMN，drizzle-kit 会生成对应 SQL
ALTER TABLE `site_settings` DROP `enable_browser_bell_toast`;
ALTER TABLE `site_settings` DROP `enable_telegram_bell_push`;
ALTER TABLE `site_settings` DROP `enable_telegram_notification_push`;
ALTER TABLE `site_settings` DROP `enable_weixin_bell_push`;
ALTER TABLE `site_settings` DROP `enable_weixin_notification_push`;
```

### 步骤 2：共享类型

**文件**：`packages/shared/src/index.ts`

`SiteSettings` 接口（L122-137）：
- 删除：`enableBrowserBellToast`、`enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush`
- 新增：`enableNotificationPush: boolean`、`enableBellPush: boolean`、`enableBellSound: boolean`

`UpdateSiteSettingsRequest` 接口（L606-620）：
- 删除上述 5 个可选字段
- 新增：`enableNotificationPush?: boolean`、`enableBellPush?: boolean`、`enableBellSound?: boolean`

### 步骤 3：DB 层适配

**文件**：`apps/gateway/src/db/index.ts`

`ensureSiteSettingsInitialized()`（L180-205）：
- 删除 `enableBrowserBellToast: true`、`enableTelegramBellPush: true`、`enableTelegramNotificationPush: true`、`enableWeixinBellPush: false`、`enableWeixinNotificationPush: false`
- 新增 `enableNotificationPush: true`、`enableBellPush: true`、`enableBellSound: true`

`toSiteSettings()`（L87-104）：
- 删除 5 个旧字段的映射
- 新增 3 个新字段的映射

`updateSiteSettings()`（L458-510）：
- 删除 5 个旧字段的合并 + set
- 新增 3 个新字段的合并 + set

### 步骤 4：API 层适配

**文件**：`apps/gateway/src/api/index.ts`（L117-157）

`validateSiteSettingsUpdate` 函数：
- 删除 `enableBrowserBellToast`、`enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush` 5 个验证块
- 新增 `enableNotificationPush`、`enableBellPush`、`enableBellSound` 3 个验证块（boolean 类型检查，同现有模式）

### 步骤 5：后端通知渠道适配

**文件**：`apps/gateway/src/events/channels/telegram.ts`（L19-42）

`notify()` 方法：
- `terminal_bell` 分支：将 `if (!settings.enableTelegramBellPush)` 改为 `if (!settings.enableBellPush)`
- `terminal_notification` 分支：将 `if (!settings.enableTelegramNotificationPush)` 改为 `if (!settings.enableNotificationPush)`
- 非 bell/notification 事件（generic events）：新增 `if (!settings.enableNotificationPush) return;` 前置检查

**文件**：`apps/gateway/src/events/channels/weixin.ts`（L33-53）

`notify()` 方法：
- `terminal_bell` 分支：将 `if (!settings.enableWeixinBellPush)` 改为 `if (!settings.enableBellPush)`
- 非 bell 分支：将 `if (!settings.enableWeixinNotificationPush)` 改为 `if (!settings.enableNotificationPush)`

**文件**：`apps/gateway/src/events/channels/webhook.ts`（L22-35）

webhook 渠道目前**没有**全局 gate——它只按 per-endpoint `eventMask` 过滤。需要新增全局 gate：
- 在 `notify()` 方法开头加入 `const settings = getSiteSettings();`
- `terminal_bell` 事件：`if (!settings.enableBellPush) return;`
- 其他事件（含 `terminal_notification`）：`if (!settings.enableNotificationPush) return;`
- 需要在文件顶部 `import { getSiteSettings } from '../../db';`

**文件**：`apps/gateway/src/agent/supervisor.ts`（L315-330）

`pushCredentialWarning()` 方法（L318）：将 `if (!settings.enableTelegramNotificationPush)` 改为 `if (!settings.enableNotificationPush)`。这个方法是 agent 凭证警告推送，走 Telegram 渠道，应受全局 `enableNotificationPush` gate 控制。

### 步骤 6：i18n 字符串

**文件**：`packages/shared/src/i18n/locales/en_US.json`、`zh_CN.json`、`ja_JP.json`

删除以下 key：
- `settings.enableBrowserBellToast`
- `settings.enableTelegramBellPush`
- `settings.enableTelegramNotificationPush`
- `settings.enableWeixinBellPush`
- `settings.enableWeixinNotificationPush`

新增以下 key（三语言对应翻译）：
- `settings.enableNotificationPush`：en="Enable notification push" / zh="开启通知推送" / ja="通知プッシュを有効化"
- `settings.enableBellPush`：en="Enable BELL notification push" / zh="开启BELL通知推送" / ja="ベル通知プッシュを有効化"
- `settings.enableBellSound`：en="Enable BELL sound" / zh="开启BELL提示音" / ja="ベル通知音を有効化"

保留：
- `settings.bellThrottle`、`settings.notificationThrottle`（节流设置不变）
- `settings.enableBrowserNotificationToast`（非 BELL 的普通通知 Toast 仍保留）
- `terminal.bellNotification`、`terminal.bellFallback`、`terminal.bellDescriptionWithTitle`（后端 push 消息仍需要这些文案）
- `notification.*` 相关 key（后端 push 用）

修改后运行 `bun run build:i18n`（即 `scripts/build-i18n.ts`）重新生成 `types.ts` 和 `resources.ts`。

### 步骤 7：前端 site store

**文件**：`apps/fe/src/stores/site.ts`

`DEFAULT_SETTINGS`（L12-27）：
- 删除 `enableBrowserBellToast`、`enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush`
- 新增 `enableNotificationPush: true`、`enableBellPush: true`、`enableBellSound: true`

### 步骤 8：SettingsPage UI

**文件**：`apps/fe/src/pages/SettingsPage.tsx`

State（L86-93）：
- 删除 6 个旧 useState：`enableBrowserBellToast`、`enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush`
- 保留 `enableBrowserNotificationToast`
- 新增 3 个 useState：`enableNotificationPush`（默认 true）、`enableBellPush`（默认 true）、`enableBellSound`（默认 true）

Hydration（L124-131）：
- 删除 5 个旧字段的 hydration
- 新增 3 个新字段的 hydration

saveSiteMutation payload（L138-152）：
- 删除 5 个旧字段
- 新增 3 个新字段

notifications tab UI（L357-441）：
- 删除 BrowserBellToast 行（L362-373）
- 删除 TelegramBellPush 行（L375-386）
- 删除 TelegramNotificationPush 行（L403-416）
- 删除 WeixinBellPush 行（L418-427）
- 删除 WeixinNotificationPush 行（L429-440）
- 保留 BrowserNotificationToast 行（L388-401）
- 新增 3 行（在 BrowserNotificationToast 行之前或之后，保持合理顺序）：
  - `enableNotificationPush` Switch（data-testid=`settings-enable-notification-push`）
  - `enableBellPush` Switch（data-testid=`settings-enable-bell-push`）
  - `enableBellSound` Switch（data-testid=`settings-enable-bell-sound`）
- 节流输入框（bellThrottle/notificationThrottle）保留不变

### 步骤 9：删除 BELL Toast 逻辑

**文件**：`apps/fe/src/stores/tmux.ts`

`handleTmuxEvent` bell 分支（L454-476）：
- 删除整个 bell toast 代码块（`if (payload.type === 'bell')` 内的 toast 调用）
- 替换为：调用新的 bell 状态管理 + WebAudio 播放逻辑

### 步骤 10：新增 BELL 状态管理（闪烁 emoji）

**新文件**：`apps/fe/src/stores/bell.ts`

创建 Zustand store 管理 bell 状态：

```typescript
import { create } from 'zustand';

interface BellState {
  // paneId -> 是否正在闪烁
  ringingPanes: Record<string, boolean>;
  triggerBell: (paneId: string) => void;
  clearBell: (paneId: string) => void;
}

export const useBellStore = create<BellState>((set) => ({
  ringingPanes: {},
  triggerBell: (paneId) => {
    set((state) => ({ ringingPanes: { ...state.ringingPanes, [paneId]: true } }));
    // 1.5 秒后自动清除（闪烁 2 次）
    setTimeout(() => {
      set((state) => {
        const next = { ...state.ringingPanes };
        delete next[paneId];
        return { ringingPanes: next };
      });
    }, 1500);
  },
  clearBell: (paneId) => set((state) => {
    const next = { ...state.ringingPanes };
    delete next[paneId];
    return { ringingPanes: next };
  }),
}));
```

在 `tmux.ts` 的 bell 分支中调用 `useBellStore.getState().triggerBell(paneId)`，其中 `paneId` 从 `payload.data.paneId` 获取（需处理 paneId 缺失的情况——缺失时用 windowId 或 deviceId 作 key）。

### 步骤 11：新增 WebAudio 提示音

**新文件**：`apps/fe/src/utils/bell-sound.ts`

创建一个播放简短提示音的函数。设计：
- 使用 `AudioContext`（首次调用时延迟创建，遵守浏览器 autoplay 策略——用户首次交互后可用）
- 播放一个短促的正弦波（sine wave），频率约 880Hz，持续约 150ms
- 用 GainNode 做 attack-decay 包络（快速上升 + 平滑下降），避免刺耳的咔哒声
- 音量适中（peak gain 约 0.15）

```typescript
let audioCtx: AudioContext | null = null;

export function playBellSound(): void {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;

  const now = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}
```

在 `tmux.ts` bell 分支中，检查 `useSiteStore.getState().settings?.enableBellSound !== false` 后调用 `playBellSound()`。

### 步骤 12：CSS 闪烁动画

**文件**：`apps/fe/src/index.css`

新增 `@keyframes bell-blink` 动画：
```css
@keyframes bell-blink {
  0%, 49% { opacity: 1; }
  50%, 99% { opacity: 0; }
  100% { opacity: 1; }
}
```
animation 设为 `bell-blink 0.75s ease-in-out 2`（2 次闪烁，总时长 1.5s）。

### 步骤 13：标题栏 / pane 标题 / device 列表闪烁 emoji 集成

所有 4 处渲染点读取 `useBellStore` 的 `ringingPanes` 状态，当对应 paneId 正在闪烁时，在标题前添加一个带 `bell-blink` 动画的 🔔 emoji span。

**13a. 浏览器标题栏（document.title）**

**文件**：`apps/fe/src/pages/DevicePage.tsx`（L218-227, L865-870）

`terminalTopbarLabel` 的 useMemo 需要订阅 `useBellStore`，当 active pane 的 paneId 在 `ringingPanes` 中时，在 label 前加 `🔔 `。由于 document.title 是纯文本，emoji 会直接显示。useEffect 设置 document.title 时自动带上前缀。

**13b. 终端上方标题栏（PageTitle）**

**文件**：`apps/fe/src/pages/DevicePage.tsx`（L1342-1377，PageTitle 组件）

PageTitle 组件内订阅 `useBellStore`，当 active pane 闪烁时在标题前渲染带动画的 `<span className="animate-[bell-blink_0.75s_ease-in-out_2]">🔔 </span>`。

**13c. pane 标题栏**

**文件**：`apps/fe/src/components/terminal/SplitTerminalArea.tsx`（L532-558）

split-pane-titlebar 渲染处，读取该 pane 对应的 paneId 是否在 `ringingPanes` 中，是则在 `paneDisplayName` 前添加闪烁 🔔 span。

**13d. device 列表 window/pane**

**文件**：`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`

`WindowItem`（L971-1083）：当该 window 下任何 pane 在 `ringingPanes` 中时，在 window 标题前加闪烁 🔔。
`PaneRow`（L1258-1330）：当该 pane 的 paneId 在 `ringingPanes` 中时，在 pane 标题前加闪烁 🔔。

由于 sidebar-device-list 渲染的是所有设备的所有 pane，`useBellStore` 的 `ringingPanes` 需要用 paneId 做 key（paneId 在全局唯一），各渲染点直接查 `ringingPanes[pane.id]` 即可。

### 步骤 14：更新后端测试

**文件**：`apps/gateway/src/events/index.test.ts`

- L23: `enableTelegramBellPush: false` → `enableBellPush: false`
- L48: `enableTelegramBellPush: true` → `enableBellPush: true`
- L63: `enableTelegramBellPush: true` → `enableBellPush: true`
- L107: `enableTelegramBellPush: false` → `enableBellPush: false`
- L150: `enableTelegramBellPush: true` → `enableBellPush: true`
- L165: `enableTelegramNotificationPush: false` → `enableNotificationPush: false`
- L195: `enableTelegramNotificationPush: true` → `enableNotificationPush: true`
- L210: `enableTelegramNotificationPush: true` → `enableNotificationPush: true`

**文件**：`apps/gateway/src/events/channels/weixin.test.ts`

- L40: `enableWeixinBellPush: false` → `enableBellPush: false`
- L48: `enableWeixinBellPush: true` → `enableBellPush: true`
- L57: `enableWeixinBellPush: false` → `enableBellPush: false`
- L63: `enableWeixinNotificationPush: false` → `enableNotificationPush: false`
- L78: `enableWeixinNotificationPush: true` → `enableNotificationPush: true`
- L90: `enableWeixinNotificationPush: false` → `enableNotificationPush: false`
- 测试描述 L38 'skips bell when enableWeixinBellPush is false' → 'skips bell when enableBellPush is false'

**文件**：`apps/gateway/src/push/connection-alerts.test.ts`（L26-35）和 `apps/gateway/src/push/supervisor.test.ts`（L26-35）

这两个测试文件的 mock SiteSettings 对象包含旧字段。更新为：
- 删除 `enableBrowserBellToast`、`enableTelegramBellPush`、`enableTelegramNotificationPush`、`enableWeixinBellPush`、`enableWeixinNotificationPush`
- 新增 `enableNotificationPush: true`、`enableBellPush: true`、`enableBellSound: true`

### 步骤 15：更新前端引用

前端没有独立的测试文件引用旧字段（SettingsPage 测试通过 E2E 跑）。确认 grep `enableBrowserBellToast|enableTelegramBellPush|enableWeixinBellPush` 在 `apps/fe/src/` 和 `apps/fe/tests/` 下无残留即可。

## Critical files & anchors

1. **`apps/gateway/src/db/schema.ts`** L20-58 — siteSettings 表定义，修改列
2. **`packages/shared/src/index.ts`** L122-137, L606-620 — SiteSettings 和 UpdateSiteSettingsRequest 类型
3. **`apps/gateway/src/events/channels/telegram.ts`** L19-42 — telegram notify() gate 逻辑
4. **`apps/fe/src/stores/tmux.ts`** L454-476 — bell toast 逻辑（删除 + 替换为 bell store + sound）
5. **`apps/fe/src/pages/SettingsPage.tsx`** L86-93, L357-441 — 通知设置 UI

## Verification

### 后端验证

1. **迁移**：`cd apps/gateway && bun run db:generate` 生成迁移文件后，`bun run db:migrate` 应用迁移
2. **单元测试**：`cd apps/gateway && bun test src/events/index.test.ts` — 验证 telegram bell/notification gate 使用新字段
3. **API 验证**：启动 gateway（`bun run dev`，worktree 内），`curl -X PATCH http://localhost:19663/api/settings/site -H 'Content-Type: application/json' -d '{"enableBellPush":false}'` 验证 API 接受新字段、拒绝旧字段

### 前端验证

1. **i18n 构建**：`bun run build:i18n` 无报错
2. **类型检查**：`cd apps/fe && bun run tsc --noEmit`（或项目现有 typecheck 命令）无类型错误
3. **Settings UI**：打开设置页 → 通知 tab，验证：
   - 显示 3 个新 toggle（enableNotificationPush、enableBellPush、enableBellSound）+ 1 个保留的 enableBrowserNotificationToast
   - 不显示旧的 5 个 toggle
   - 保存后刷新页面，设置值保持
4. **BELL 闪烁**：在终端中触发 bell（`printf '\a'`），验证：
   - 浏览器标题栏出现 🔔 闪烁 2 次后消失
   - 终端上方标题栏出现 🔔 闪烁 2 次后消失
   - pane 标题栏出现 🔔 闪烁 2 次后消失
   - device 列表对应 pane 出现 🔔 闪烁 2 次后消失
   - 不再有 sonner Toast 弹出
5. **BELL 提示音**：触发 bell 时听到短促提示音；关闭 enableBellSound 开关后再次触发，无声音
6. **E2E**（可选）：`cd apps/fe && bun test tests/` 跑现有 e2e 测试确认无回归

## Assumptions & contingencies

- **webhook.ts gate 逻辑**：已确认 webhook 渠道目前**没有**全局 gate，只按 per-endpoint `eventMask` 过滤。步骤 5 已包含新增全局 gate 的指令。
- **SQLite DROP COLUMN**：drizzle-kit 生成的迁移依赖 SQLite 3.35+ 的 `ALTER TABLE DROP COLUMN`。如果目标 SQLite 版本低于 3.35，drizzle-kit 会生成 "重建表" 方式的迁移（new table + copy + rename），不需要手动处理。
- **bell 状态 key 选择**：`TmuxBellEventData`（`packages/shared/src/index.ts:454-462`）字段：`windowId?`、`paneId?`、`windowIndex?`、`paneIndex?`、`paneUrl?`、`paneTitle?`、`paneCurrentCommand?`，均为 optional。`paneId` 缺失时用 `windowId` 作 key（window 级别闪烁）。注意 bell event payload 还包含 `event.device.id`（在 `WebhookEvent` 外层），但 `handleTmuxEvent` 收到的是 `payload.data`，deviceId 在 payload 外层结构中。实现时在 tmux.ts bell 分支中处理：`const paneId = (data.paneId as string | undefined) ?? (data.windowId as string | undefined); if (paneId) { useBellStore.getState().triggerBell(paneId); }`。paneId 为 undefined 时（极罕见，无 pane/window 信息的 bell）跳过闪烁。
- **AudioContext autoplay 策略**：浏览器要求用户交互后才允许 AudioContext 播放。首次 bell 可能无声（如果用户尚未与页面交互）。这是预期行为，不需要特殊处理——后续 bell 正常播放。
- **prompt-archives 存档**：实现前需先创建 `prompt-archives/2026070400-bell-notification-redesign/` 文件夹并存档 plan-prompt.md（因 plan mode 限制，存档在实现阶段第一步完成）。