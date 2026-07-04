# Plan Prompt: bell-notification-redesign

## 背景

当前 BELL 通知在浏览器内通过 sonner Toast 弹出，由 `enableBrowserBellToast` 开关控制。通知推送设置有 6 个 toggle（browser/telegram/weixin × bell/notification），但 Telegram 和微信各自已有 per-bot `enabled` 开关，全局层面的 per-channel toggle 没有实际意义。

## 目标

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

## 执行要求

按 `plan-00.md` 中的 15 步顺序执行，每步验证后再进入下一步。严禁留 TODO、严禁先写简单版本。先存档再干活。