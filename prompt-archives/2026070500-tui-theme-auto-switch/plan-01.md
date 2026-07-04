# TUI 亮暗主题自动切换：实现 plan（mode 2031 注入）

## Context

tmex 前端切换颜色模式后，pane 内正在运行的 TUI 不跟随。可行性已全量实测闭环（`prompt-archives/2026070500-tui-theme-auto-switch/research-02-live-behavior-matrix.md`）：claude(theme=auto)/opencode/omp 订阅 mode 2031 并在收到 `CSI ?997;{1|2}n` 后热切换（**1=dark、2=light**，实测+contour 规范；注意有一轮代码精读报告写反了，勿采）；codex 无通道、重启生效。方案：**gateway 从 `%output` 跟踪 pane 的 `?2031h/l` 订阅声明，主题切换时先等 window-style 全量落地、再只对订阅 pane 注入 997**。全 tmux 3.0+ 一套代码（%output 透传、send-keys -H 保真、pane 用户选项均全版本实测通过；3.6+ 原生双发同值幂等无害）。

已定决策：不做 focus 注入与 1004 跟踪、不做 OSC 10/11 代答（window-style 已覆盖全版本含 3.2a）、不做盲 push、不做 996/DECRQM 代答；DCS passthrough 解包内容不入订阅状态；kill switch env 必配。

本实现全部在 worktree `theme-spike` 进行（spike 脚本已在其 `scripts/spike-theme/`，可复用于测试）。

## 数据流

```
%output → pane-stream-parser（新增 CSI 收集态，原样回填）
            └─ onThemeSubscription(paneId, subscribed)   ← 识别 ?2031h/l（含多参数如 ?1004;2031h）
control-mode-subscription（转发回调，同现有 onPromptMarker 模式）
connection（local/ssh 共享逻辑）
  ├─ ThemeSubscriptionTracker（内存 Map + @tmex_2031 pane 选项持久化 + 重连恢复）
  ├─ 清位：?2031l / prompt-marker(133;A) / prunePanes / dispose
  └─ signalThemeChange(paneId, theme)（复活）：guard 订阅 + kill switch → sendInput 注入 997
ws/index.ts 编排：主题切换 → await 全设备 setWindowStyle → broadcastThemeChange（latest-wins）
```

## 改动清单

### 1. `apps/gateway/src/tmux-client/pane-stream-parser.ts` — CSI 收集态

- Phase 联合类型（:3-17）加 `'csi'`；`esc` 分支（:253-272）加 `byte === 0x5b` → 进入 csi 态。
- csi 态：缓冲参数字节（0x30-0x3f）与中间字节（0x20-0x2f）至终止字节（0x40-0x7e）；上限 64 字节，溢出或非法字节则把已缓冲内容**原样回填** output 并回 normal。
- 与 OSC 的"吞掉"相反：**CSI 序列无论是否识别都完整回填 output**（前端渲染依赖，F1 已证渲染零残渣）。
- 终止字节为 `h`/`l` 且参数以 `?` 开头时，按 `;` 拆 mode 列表，含 `2031` 则回调新增可选 `onThemeSubscription?: (subscribed: boolean) => void`。
- DCS passthrough 打标：`flushTmuxPassthrough`（:215-223）重新 processByte 期间置闭包 flag `inTmuxPassthrough`，csi 识别时若置位则**不回调**（解包内容照常回填）。
- 单测 `pane-stream-parser.test.ts`（沿用 `bytes()`/collect 数组风格）：订阅/清除、多参数 `?1004;2031h`、跨 push 分片、DCS 包裹不上报、溢出回填、CSI 字节透传完整性（push 返回值逐字节等于输入）。

### 2. `apps/gateway/src/tmux-client/control-mode-subscription.ts` — 回调转发

- `ControlModeSubscriptionCallbacks`（:30-42）加 `onThemeSubscription?: (paneId, subscribed) => void`；`getPaneParser`（:59-73）加一条转发（照抄 onPromptMarker 模式）。

### 3. 新文件 `apps/gateway/src/tmux-client/theme-subscriptions.ts` — 订阅状态（纯逻辑，无 IO）

- `createThemeSubscriptionTracker()`：`note(paneId, subscribed)`、`clear(paneId)`、`prune(validPaneIds)`、`restore(paneIds)`（重连恢复，同等对待）、`list(): string[]`、`has(paneId)`。
- 单测：状态转换、prune、restore。

### 4. 两个 connection（`local-external-connection.ts` / `ssh-external-connection.ts`）— 接线与注入

两边对称改（local 行号为准，ssh 照搬）：

- 持有 tracker 实例；`createControlModeSubscription` 调用点（local `spawnControlClientProcess` :790-824 / ssh `openControlChannel` :807-843）接 `onThemeSubscription`：`tracker.note` + 持久化 `runTmuxAllowFailure(['set-option','-p','-t',paneId,'@tmex_2031', on?'on':'off'])`（fire-and-forget，失败仅日志）。
- `onPromptMarker` 转发处：`kind === 'A'` 时先 `tracker.clear(paneId)` + 清 pane 选项，再照常上抛。
- 快照 prune 处（local :1269 / ssh :1231 的 `prunePanes` 调用点）：同步 `tracker.prune(expectedPaneIds)`。
- 重连恢复：首次快照完成后跑一次 `runTmuxAllowFailure(['list-panes','-a','-F','#{pane_id}|#{@tmex_2031}'])`，值为 `on` 的 `tracker.restore`。**用 `|` 分隔，勿用 `\t`**（cant-find-window 历史坑：LANG=C 下 tmux 把 -F 里的 tab 渲染成 `_`）。
- **复活 `signalThemeChange(paneId, theme)`**（local :526-530 / ssh :187-191 的 no-op）：guard `config.themeNotify2031Enabled` + `this.connected` + `tracker.has(paneId)` → `this.sendInput(paneId, '\x1b[?997;' + (theme === 'dark' ? '1' : '2') + 'n')`——走现有 sendInput 序列化链（local `inputTransition` :278 / ssh 命令队列），不另开旁路。
- `setWindowStyle`（local :508-519 / ssh :416-427）从 `void` fire-and-forget 改为 `async` 返回 `Promise<void>`（`configureWindowStyle` 本就 async，去掉 `void ...catch` 吞掉，错误仍内部 catch 上报 onError 后 resolve，不 reject 阻塞编排）。

### 5. `apps/gateway/src/tmux-client/device-session-runtime.ts` — 接口同步

- 接口 `DeviceSessionRuntimeConnection`（:11-41）：`setWindowStyle` 返回类型改 `Promise<void>`；`signalThemeChange`（:38）签名不变。
- class `DeviceSessionRuntime` 委托方法（:242-248）同步改。

### 6. `apps/gateway/src/config.ts` — kill switch

- 照抄 :34 样板：`themeNotify2031Enabled: getBooleanEnv('TMEX_THEME_NOTIFY_2031', true)`。

### 7. `apps/gateway/src/ws/index.ts` — 编排

- `handleSiteThemeChange`（:1004-1017）改 async：`await Promise.allSettled(所有 entry.runtime.setWindowStyle(style))`。
- `handleSiteThemeUpdate`（:956-976）与 `runtime.ts` 的 `registerThemeBroadcaster`（:61-69）：改为 `await handleSiteThemeChange(theme)` **之后**再 `broadcastThemeChange(theme)`（时序铁律，实测反例：先注 997 TUI 重查拿旧色会拒切）。
- **latest-wins 合并**：类字段 `pendingTheme: ThemeMode | null` + `themeApplyInFlight: boolean`——编排进行中新值到来只更新 pendingTheme，当前轮结束后若 pendingTheme 与已应用值不同再跑一轮。防快速连切乱序。
- `broadcastThemeChange`（:1039-1058）：遍历逻辑与 1s 同值去重（`themeSignalLast`）保留不动——订阅 guard 已内聚在 connection 的 signalThemeChange 里，非订阅 pane 零注入。

### 8. 测试

- 单测：见 1、3。
- 集成（`local-external-connection.integration.test.ts` 追加，真实 tmux 独立 socket，仿 :128 的 OSC 用例结构）：pane 内 `printf '\033[?2031h'` → waitFor tracker 生效 → `signalThemeChange` → 断言 pane 收到 997 字节（pane 跑 `cat > file` 或 dump 脚本）；再 `printf '\033[?2031l'` / 模拟 prompt-marker 后注入不再发生；重连恢复用例（kill connection 重建 → @tmex_2031 恢复）。
- e2e（`apps/fe/tests/` 新 spec，仿 `theme-broadcast.spec.ts` + `helpers/tmux.ts`）：pane 里跑 `scripts/spike-theme/dump-tui.py --emit 1b5b3f3230333168 --log <tmp>`（spike 已验证的 fake TUI），前端 UI 切主题 → 断言 log 出现 `1b5b3f3939373b326e`；对照 pane（idle shell）capture-pane 断言屏幕无污染。
- 全量回归：`bun test`（注意不碰生成文件；e2e 走 test.env，独立 socket `tmex-e2e`）。

### 9. 文档与存档

- `docs/appearance/2026070501-tui-theme-notify-2031.md`：机制、行为分档（三家热切换 / codex 重启生效 / theme 固定的 claude 收 997 无操作）、kill switch `TMEX_THEME_NOTIFY_2031`、已知限制（TUI 挂起 + shell 无 OSC 133 集成 + gateway 期间切主题 → 可能一次性污染 shell 行，prompt-marker 出现即自愈；codex 需重启）。
- 实现完成后：`prompt-archives/2026070500-tui-theme-auto-switch/plan-01-result.md` 存档执行结果（plan-01 即本 plan，同步存档该目录）。

## 关键复用

- `unescapeControlModeData`、pane-stream-parser 既有状态机风格与测试基建
- `sendInput` → `send-keys -H`（`input-encoder.ts`）、`runTmuxAllowFailure`
- `getTmuxWindowStyle`（`packages/shared/src/appearance.ts:83`）、`ThemeMode` 类型
- ws 层 `themeSignalLast` 1s 去重、`theme-broadcaster.ts` 注册链
- `scripts/spike-theme/dump-tui.py`（e2e fake TUI）

## 明确不做（防实现漂移）

focus 注入、1004 跟踪、OSC 10/11/996/DECRQM 代答、盲 push 应答、tmux 版本分支（统一注入，幂等兜底 3.6+ 原生双发）、997-on-subscribe、污染检测器（v1 以 prompt-marker 清位 + kill switch 覆盖）。

## 验收

1. `bun test`（含新增单测/集成测试）全绿；生成文件零改动。
2. e2e 新 spec：订阅 pane 收到 997、idle shell pane 无污染、前端主题正常切换（既有 theme spec 回归）。
3. 真机验证（仓库内临时实例 + 独立 socket，显式覆盖 `GATEWAY_PORT`/`TMEX_FE_DIST_DIR` 等）：pane 跑真实 opencode（未登录即可），浏览器切主题，opencode 换肤；`TMEX_THEME_NOTIFY_2031=0` 时不注入。
4. 红线自查：全程未触碰 `tmex` session/默认 socket/9883 生产服务。
