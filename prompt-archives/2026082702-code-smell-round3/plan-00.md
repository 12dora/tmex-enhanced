# Plan 00：第三阶段 code smell / bug / 性能 / 文档整理

## 背景

- 分支 `feat/sidebar-tabs-ui`（worktree `../tmex-enhanced-wt-tabs`），已包含前两阶段全部清理（`../2026082700-code-smell-cleanup/plan-0{0,1}-result.md`）。
- 基线（本阶段起点）：函数 CC>15 共 52 个、CC>30 共 3 个、>80 行函数 110 个（脚本见 `sub/cc.ts`）；tsc 错误 gateway 27 / api-client 5 / app 1 / stores 1 / theme 10，其余 0；单测 gateway 1473 / panels 239 / terminal-ui 205 / shared 141 / ghostty 138 / stores 108 / app 90 / ws-client 75 / api-client 34 / ui 16 / notifications 15 / theme 6，全部 0 fail（`apps/fe` 的 `bun test` 会误拾 Playwright spec，只看 e2e）。
- 探索报告：`research-gateway.md`、`research-frontend.md`、`research-libs.md`、`research-perf.md`、`research-docs.md`（codex gpt-5.6-luna xhigh）。

## 角色与并行方式

grok-4.6(high) 后端 / Opus 5 前端与 lib / codex sol(high) 审查 / 指挥官分批 commit。同一 worktree 并行，每个 agent 只碰指定文件集（+ 新建文件与对应测试），不做 git 操作。

## 任务清单

### 后端（grok）

第一波（bug + 性能热路径，先写基准再改）：
- B1 `runtime-cancel`：`device-session-runtime.ts` disconnect 未取消进行中 connect（代次守卫）+ 回归测试。
- B2 `weixin-loop`：`weixin/ilink/client.ts` start 失败后 `running` 残留；抽 `update-loop.ts`。
- B3a `messaging-routes`：`api/messaging-routes.ts` 强转 `req.json()` → `readJsonObjectBody`；按 telegram/weixin/webhook 拆文件。
- B3b `files-routes`：`api/files.ts` `parseInt` → 严格整数；null body；按 root/browser/transfer/http 拆。
- B3c `agent-routes`：`api/agent.ts` 按 session/message/confirmation/dto 拆。
- B12 `parser-perf`：control-mode unescape 零拷贝、pane-stream-parser 区间扫描、passthrough 去递归；`bun bench` 基准前后对比。
- B13 `frame-sizer-perf`：canonical frame sizing 由二分重编码改为精确计算；基准。
- B9 `retention-perf`：retention `ingest()` 去掉每段全局 sweep/sort，改增量计数；基准。

第二波（拆分高 CC 函数 + 其余性能项）：
- B4 `screen-capture`、B5 `history-reader`、B6 `metadata-plan`、B7 `supervisor-approval`、B8 `subscription-plan`、B10 `legacy-broadcaster`（含订阅计数索引）、B11 `watch-evaluator`、B14 `session-state`（切换门控字节上限、ws 入站 Buffer 零拷贝、bellDedup/throttle TTL）、B15 `db-indexes`、B16 `dep-install`。

### 前端 / lib（Opus）

第一波：
- F1 `files-tab`：查询错误态 + 拆分。
- F2 `watch-dialog`：错误态、N+1 状态请求、拆分。
- F3 `agent-session-actions`：刷新覆盖本地写入的竞态 + 按域拆分。
- F4 `page-loader`：`main.tsx` 动态 import 失败/旧 Promise 回写；`page-actions.tsx` 拆分 + 硬编码英文 i18n。
- F10 `terminal-history`：history page 增量写入（O(P²)→O(P)）+ `validateHistoryPage` 提取。

第二波：
- F5 `shortcuts-editor`、F7 `device-dialog`、F8 `agent-message-parser`、F9 `device-tree-rows`（memo + 按 device selector）、F6 `terminal-resize`、F11 `boot-surface`、F12 `global-device-provider`；ghostty 渲染桥接（dirty rows / palette 缓存 / canvas 层脏矩形 / writeVt 合批）视 `research-libs.md` 定。

### 性能与 Rust 结论

按 `research-perf.md`：先补 `bun bench` 基准，JS 侧做零拷贝 / 增量 / 精确 sizing；只有基准证明单一热点稳定占 CPU 且原型 >2x 才引入 Rust（napi-rs / WASM ABI）。结论写入 result。

### 文档整理

按 `research-docs.md`：删除 DELETE-ROTTEN / DELETE-PROCESS；FIX 项修正路径与状态；`prompt-archives/` 中历史归档全部删除，仅保留本阶段目录（含各阶段 result 的合并摘要）；`docs/` 补索引 `docs/README.md`。

## 验收

- 每批：相关包 `bun test` 0 fail；`bunx tsc --noEmit -p .` 错误数 ≤ 基线；`bunx biome check` 改动文件通过。
- 全部完成后：CC>15 数量明显下降、无新增 >80 行函数；`bun run build:fe` 成功；e2e 与基线逐条比对无回归；codex sol 审查遗留项处理完毕；push。

## 注意事项

- 严禁触碰生产 tmex 服务与名为 `tmex` 的 tmux session；测试只用 test env。
- 不要对生成文件（i18n resources/types、fe-dist）跑 lint；i18n 改源文件后 `bun run build:i18n`。
