# Plan 00 执行结果：第三阶段 code smell / bug / 性能 / 文档

分支 `feat/sidebar-tabs-ui`（worktree `../tmex-enhanced-wt-tabs`），自 `3bc0746` 起 42 个 commit（含文档）。

## 流程

探索（codex gpt-5.6-luna xhigh，5 份报告：gateway / frontend / libs / perf / docs）→ 三波并行编码（grok-4.6 后端 24 个任务、Opus 5 前端与 lib 22 个任务，同一 worktree 按文件范围隔离，指挥官分批 commit）→ codex gpt-5.6-sol 两轮审查（`reviews/round{1,2}-*.md`，共 9 条 finding，8 条确认修复，1 条在审查前已由接线任务修复）→ 文档整理。

## 指标（before → after）

| 指标 | before | after |
|---|---:|---:|
| 函数 CC>15（`sub/cc.ts`，不含 scripts/bench） | 52 | 7（其中 4 个为刻意保留的协议分派 switch：`emitOsc`、`encodeMouseEvent`、`classifySshError`、control-mode `parse`） |
| 函数 CC>30 | 3 | 3（同上，未拆） |
| >80 行函数 | 110 | 85 |
| 单测 | 2400+ / 0 fail | 3514 / 0 fail（gateway 1873、panels 347、terminal-ui 301、stores 214、ghostty 188、shared 183、app 128、fe 109、ws-client 100、api-client 34、ui 16、notifications 15、theme 6） |
| tsc 错误 | gateway 27 / api-client 5 / app 1 / stores 1 / theme 10 | gateway 25，其余不变，fe/panels/shared/ghostty/terminal-ui/ui/ws-client/notifications 0 |
| `bun run build:fe` | — | 成功 |

## 拆分 / 重构

- gateway API：`files.ts`、`messaging-routes.ts`、`agent.ts` 按资源拆为 `file-*`、`telegram/weixin/webhook-routes`、`agent-*-routes` + dtos；device/llm/watch-rule PATCH 改声明式字段解析（`device-patch.ts`、`llm-settings-fields.ts`、`watch-defaults`）。
- gateway tmux-client：`canonical-screen-capture` → `screen-frame-source` + `screen-checkpoint-builder`；`pane-history-reader` → `pane-history-session` + `pane-history-page`；`metadata-projection.reconcile` → `metadata/reconcile-plan`（纯函数）；retention `subscription-coordinator.apply` → `subscription-plan`；`snapshot-format` → tokenizer + 列表；`bell-context`、`pane-emulator-create`、`hierarchy-fields`、`history-range`。
- gateway 其他：`agent/approval-response-reconciler`、`weixin/ilink/update-loop`、`watch/evaluator-{match,unchanged}`（按规则缓存正则）、`ws/legacy-event-delivery`、agent `environment-fields` / `ipv6-parse` / `run-command-{args,spawn,buffer,text}`、push `connection-bridge` / `tmux-push-events`。
- packages/app：`dependency-install-runner`、`sanitizeBunPath` 三段、表驱动 `runDoctor`；shared：`tmux-layout` tokenizer、`legacy-pane-fields` 表、`legacy-snapshot-draft` 写时复制。
- 前端：`files-tab` → `file-root-*`；`watch-dialog` → `use-watch-rules` / `watch-rule-{list,row,state-view}`；`agent-session-actions` → crud/message/draft/confirmation；`page-actions` → `use-device-console-actions` + toolbar/sheet/dialog；`TerminalShortcutsEditor`、`DeviceDialog`、`GlobalDeviceProvider`、`agent-thread` 解析器、device-tree 行组件（shell/header/list/content + memo + 按 device selector）；terminal-ui `useTerminalResize` → reporter/scheduler/viewport-restore，`useTerminalBootSurface` → `terminal-render-target` + `terminal-surface-lifecycle`，`TerminalSurface` → `terminal-history-validation`；ghostty `terminal-pointer-handlers`、`wheel-delta`。
- stores：`tmux-device-events` / `runtime` 表驱动；panels `watch-rule-draft` 默认值表。

## 顺手修复的 bug（均有回归测试）

后端：
- disconnect 未取消进行中的 connect，设备"复活"（连接代次守卫，含初始快照阶段）。
- 微信 ilink `start()` 游标加载失败后 `running` 永久残留。
- files/messaging 路由对 `null`/错类型 JSON body 抛 TypeError → 500；upload `offset` 用 `parseInt` 接受 `12garbage`、`12.5`、空白、十六进制、指数。
- 选择切换输出门控无字节上限（可积压 ~64 MiB/设备），溢出静默丢帧；现在 8 MiB 硬上限 + `SourceGap(resource_exhausted)`，legacy 客户端解码为 `rebase-required`。
- 通知节流 map 只在设备清理时释放；bellDedup map 无 TTL。
- legacy 观察者计数未接线 / 手动重连后不重新同步 → 输出丢失。
- LLM provider 变更在模型缓存刷新前广播，其它客户端缓存空模型列表。
- `agent_queued_messages` / `agent_confirmations` 缺复合索引（EXPLAIN 验证）；消息 seq 分配三条语句 → 一条 `INSERT … RETURNING`。

前端 / lib：
- `KIND_SETTINGS_UPDATE` 客户端从未解码，跨端设置缓存永不失效（含 react-query 命名空间失效 `SettingsEventsInit`）；并发重拉乱序覆盖（代次守卫）。
- 会话列表刷新整体覆盖在途本地写入（按会话合并）。
- 动态 import 失败页面永久空白且旧 Promise 回写；文件根 / watch 查询失败伪装成空列表；终端设置兜底条硬编码英文。
- ghostty：`#zzzzzz` 颜色被写成黑色；横向滚轮余量未清；**`max_scrollback` 单位错误**——wrapper 把行数当字节传给 ghostty，10000/100000/1000000 都被夹成 ~1129 行，修复后按 `13*cols+16` 字节/行换算并整页对齐，客户端历史预算对齐到 10000 行；选择自动滚动 `setInterval` 在 begin/dispose/窗口外松开时泄漏。
- ws-client：history 门控丢弃 `paneEpoch`/`seq` 元数据；`SelectCallbacks` 允许半套回调导致 deferred history 永不提交；溢出后事务提交覆盖恢复快照、回调晚注册丢失 rebase。
- shared：PaneData `seqEnd` 只在编码端校验；`chunk.cleanup(force)` 死参数。
- 用户报告：双击选词 / 拖选后出现两条"已复制"toast——gateway OSC 52 解析忽略 Pc 目标参数，编辑器一次复制发出的 `p`（primary）+ `c`（clipboard）两条都被当成系统剪贴板写入（自 OSC 52 落地起即存在）；现只放行 `c`/`s`/空目标。
- e2e 探针：`__tmexE2eTerminalSelectionText` 为页面全局，分屏时空闲 pane 的任意一帧会把它抹成 null（`terminal-selection-canvas:131` 全量运行必挂的原因），改为按归属者写入。

## 性能（基准脚本：apps/gateway `bun run bench:parser|bench:retention|bench:frame-sizer`；`packages/{ghostty-terminal,terminal-ui,shared}/bench/`）

| 热点 | before → after |
|---|---|
| pane 流解析 plain ASCII | 76 → 1640 MB/s（21.6×）；escape 密集 +1–13% |
| retention `ingest()`（500 pane / 1 KiB） | 36.4 → 0.64 µs（57×） |
| canonical frame sizing `maxPaneDataBytes` | 357 µs–5.5 ms → <1 µs；`sendPaneData` 50–500× |
| canonical decode 规范性校验 | 重编码比对 → 单遍扫描，7–3000× |
| legacy metadata diff（40×16） | 19.4 → 4.9 µs |
| ghostty 渲染桥（120×40） | 6.75 → 1.07 ms/帧；脏行 40 → 1（wasm 恒报全脏，改为逐 cell 比对推导） |
| history 分页写入（64 页） | 4288 → 64 次 write，−84% CPU |
| `writeVt` | 常驻 scratch 缓冲，−5%；同 pane 微任务合批 |
| 侧栏 | 按 device selector + memo，patch 只重渲染被触碰的行 |
| DB | 两个复合索引消除 SCAN + 临时 B-tree |

### Rust / WASM 结论

不引入。实测 wasm 单次导出调用 ≈ 8.3 ns，`get_multi(3)` 23.5 ns vs 3×`single_get` 24.9 ns——成本在 wasm 内部 key 分派而非 JS↔wasm 边界，打包行 ABI 上限仅 2–2.5×，且需长期维护 `vendor/ghostty` fork patch；gateway 解析器 JS 零拷贝后已 1.6 GB/s，napi-rs 需要多平台 prebuild 且 `--compile` 已需 externalize `cpu-features`。回头条件：上游 ghostty 提供 damage API、视口 ≥240×80、profile 显示 parser 占 gateway CPU >20%。详见 `docs/performance/2026082700-hot-path-optimizations.md`。

## 文档

删除 6 篇腐朽/过程文档，修正 19 篇路径与状态，新增 `docs/README.md` 索引与性能文档；`prompt-archives/` 只保留本阶段目录（历史 141 个目录压缩为 `history.md`）。

## e2e

见文末「验证」。

## 未做 / 后续

- 4 个协议分派 switch（`emitOsc` 52、`encodeMouseEvent` 33、`classifySshError` 32、control-mode `parse` 26）与 `runInit`、`dispatchPaneStreamByte`、`reconnectControlClient` 未拆（扁平表 / 线性编排，拆分只增转发）。
- `KIND_NOTIFY_EVENT` 客户端刻意不接线（每种事件已有专用到达路径，接上会双重通知）。
- `Terminal.tsx` 里的 ResizeObserver 合帧与新 `RafCoalescer` 同构，可复用；`device-tree-navigation.ts` 仍订阅整张 snapshots。
- `setThemeFromS2C`/`updateTheme` 与在途重拉的窄竞态未处理。
- ghostty scrollback 预算按创建时 cols 定档（无运行时 setter），200 列时约 4300 行。

## 验证

- 单测 / tsc / `build:fe`：见指标表。
- e2e（Playwright 104 用例，全量两轮 + 定向复跑）：最终 95 pass / 8 fail / 1 skip。8 个失败中 7 个与 main 基线逐条一致（mobile-settings:5、mobile-terminal-interactions:79/140/221/303、settings-llm:42、ws-borsh-theme-resize:39；基线中的 terminal-mouse-recovery:384 本轮通过）。首轮多出的 3 个失败：`agent-session:534`、`terminal-selection-canvas:131` 为运行中 vite HMR 污染（隔离复跑通过）；`terminal-mouse-drag-recovery:173` 为真实回归——legacy TERM_HISTORY 首屏恢复未按 tmux pane 几何 resize，此前靠 `use-pane-size-sync` 回灌抢先掩盖，boot/resize 重构后竞态稳定输，已修（`9a1ffad`）。`terminal-selection-canvas:131`（双击选词）在全量运行中失败、隔离与相邻 spec 组合运行均通过，诊断见 `sub/dblclick-selection-result.md`。
