# docs-cleanup 结果

改动范围严格限制在 `docs/**`、`README.md`、`README.zh-CN.md`、`AGENTS.md`、`prompt-archives/**`。`git status` 已核验：无任何代码文件变化，未执行任何改变 git 状态的命令。

## 1. 删除的文件

### docs/（6 项）

| 路径 | 判定 |
| --- | --- |
| `docs/2026021000-tmex-bootstrap/architecture.md`（整目录） | DELETE-ROTTEN |
| `docs/files/2026061409-context-menu-and-transfer.md` | DELETE-ROTTEN（安全要点已并入分块传输文档） |
| `docs/operations/2026061100-known-issue-dual-gateway-pipe-pane-conflict.md` | DELETE-ROTTEN |
| `docs/terminal/2026021400-terminal-react-xtermjs-refactor.md` | DELETE-PROCESS |
| `docs/terminal/2026041400-tmux-external-cli-architecture.md` | DELETE-ROTTEN |
| `docs/testing/2026070800-e2e-known-issues.md` | DELETE-PROCESS（开放项已移入 known-issues.md） |

`docs/images/` **保留**：`screenshot.png` 被 `README.md:17` 与 `README.zh-CN.md:17` 引用（已核验）。

### prompt-archives/（141 个目录 + 内部过程文件）

- 删除了 `prompt-archives/` 下除 `2026082702-code-smell-round3/` 外的**全部 141 个归档目录**。删除前已把每个目录的主题与结果提炼进 `prompt-archives/2026082702-code-smell-round3/history.md`（81 行，按时期分组，141 个目录名逐一覆盖，脚本核验无遗漏）。
- `2026082702-code-smell-round3/` 内删除：`reviews/*.patch`（5 个）、`sub/*/grok.log`（21 个）、`sub/*/prompt.md`（21 个）、`*.log`（5 个）、`reviews/*.log`（5 个）、`explore-*.md`（7 个）。
- 额外删除（超出明确列表，**理由需确认**）：`reviews/*.prompt.md`（5 个）、`reviews/review-common.md`、`sub/grok-common.md`。这些是与 `sub/*/prompt.md` 同类的 agent 提示词脚手架，且 review prompt 引用的 `.patch` 已删；keep 清单未包含它们。若判定应保留，需从 git 恢复。
- 目录体积 18 MB → 408 KB。

## 2. 新增的文件

| 路径 | 内容 |
| --- | --- |
| `docs/README.md` | 稳定文档索引：按目录一表，路径 → 一句话用途。脚本双向核验（每个 md 都在索引里，索引里每个路径都存在） |
| `docs/performance/2026082700-hot-path-optimizations.md` | 本轮性能工作汇总（见下） |
| `prompt-archives/2026082702-code-smell-round3/history.md` | 141 个历史归档的摘要 |

## 3. 修改的文件

### 路径迁移（批量核验后替换，替换后全库扫描确认引用的文件都真实存在）

`docs/agent/2026061300`、`docs/device-tree/2026061400`、`docs/fonts/2026061501`、`docs/notify/2026062000`、`docs/terminal/2026041600`、`docs/terminal/2026061501`、`docs/update/2026061406`、`docs/watch/2026061300`、`docs/ws-protocol/2026070402`：

`apps/fe/src/...` → `packages/panels|stores|ws-client|terminal-ui|theme|ui/...`。字体产物 `apps/fe/public/fonts` → `packages/theme/resources/fonts`，并补了 `apps/fe/public/fonts → packages/theme/resources/fonts` 的 symlink 说明。保留了两处仍然正确的 `apps/fe/src` 引用（`main.tsx`、`lib/fonts/useAppMonoFont.ts`）。

### 实现状态与内容订正

| 文件 | 修改 |
| --- | --- |
| `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` | 去掉「设计稿/未实现」标题与横幅；capabilities 改为指向 `packages/shared/src/capabilities.ts`，补齐 `tmex-split-v1` / `canonical-state-v1`；删掉不存在的 `TERM_CHUNK`，改为 `TERM_OUTPUT(0x0305)` / `TERM_HISTORY(0x0306)` |
| `docs/ws-protocol/2026021403-ws-state-machines.md` | 横幅改为「已实现」+ 六行代码索引表；`apps/gateway/src/ws/index.ts` → `device-connection-registry.ts`；xterm → Ghostty；补 resize 实现路径与缓冲字节上限 |
| `docs/terminal/2026021404-terminal-switch-barrier-design.md` | 横幅改为「已实现」+ 代码索引（`SwitchBarrier`、`SelectStateMachine`、e2e spec）；与状态机文档**双向交叉链接**（未合并，见下） |
| `docs/known-issues.md` | 新增 KI-3：fe e2e 固定失败基线 8 例 + 抖动清单 |
| `docs/files/2026061500-transfer-progress-chunked.md` | 新增「路径安全（上传）」小节（`sanitizeUploadName`、destDir 先行校验、不创建父目录、`enqueueDeviceJob` 串行、上传不加 `-L`）；`files-panel/api.ts` → `packages/api-client/src/{upload,download}-transfer.ts`；transfer-toast / progress 组件路径 |
| `docs/agent/2026061300-terminal-agent-overview.md` | 「运行中 409」改为「运行中入队 + 201 queued + steer + queue REST」，并列出仍返回 409 的真实冲突态 |
| `docs/agent/2026061302` / `2026061303` | 删掉过时的绝对测试计数（473/495/49），改为「gateway 与 shared 的 `bun test` 全绿」 |
| `docs/notify/2026062000-weixin-clawbot-channel.md` | 说明 `0012_naive_lizard.sql` 已 DROP `enable_weixin_*`，现无微信专属开关；路由改为 `api/weixin-routes.ts`（经 `messaging-routes.ts` 汇出） |
| `docs/update/2026061406-self-update.md` | `canSelfUpdate` 补上 `!isManagedExternally() && getManagementMode()==='none'` 的外部托管限制 |
| `docs/product/2026062400-prd.md` | `v0.13.0` → `v1.0.2`（读 `packages/app/package.json`）；`send_keys` → `send_input`（两处） |
| `docs/terminal/2026061101-claude-code-osc-notification.md` | `auto` 行由「⚠️ 不会发通知」改为「✅ 依赖 `TERM=xterm-ghostty` 注入」，与同文下节一致 |
| `docs/terminal/2026061501-mobile-keyboard-behavior.md` | follow clamp 上界由 `inset` 改为 `inset + 快捷键栏高度`（核对 `maxOffset: inset + barHeight`），补 `--tmex-shortcut-lift` 机制；标记点行号改为实际文件 |
| `docs/ws-protocol/2026070402-site-theme-update.md` | `useUIStore.setTheme()` → `useSiteStore.setThemeFromS2C()`（`packages/stores/src/site.ts`），解码/分发路径，gateway handler 改为 `theme-settings-broadcaster.ts` |
| `docs/frontend/packages.md` | 包表重写：11 个包、目录、真实 exports（读根 `package.json` workspaces + 每个 `packages/*/package.json`）；补 `ghostty-terminal`（非 `@tmex/` 作用域，独立发布）与 `packages/app`；`@tmex/panels` 子路径补 `device-tree` / `device-console` / `device-management` |
| `README.md` / `README.zh-CN.md` | FAQ 改写：不再是每 pane 一条远程通道，改为共享 tmux control-mode 通道 + 常驻命令通道 + 短生命周期通道，`MaxSessions=10` 通常够用 |
| `AGENTS.md` | 首条 bullet 限定为「应用运行时（gateway/fe/测试）只跑 Bun」，明确 `packages/app` 的 CLI 刻意保持 Node 兼容（`bun build --target node`）。其余内容零改动 |

### 合并决策

`ws-protocol/2026021403-ws-state-machines.md` 与 `terminal/2026021404-terminal-switch-barrier-design.md` **未合并，改为交叉链接**。理由：前者是覆盖 7 类状态机（连接/设备/选择/门控/resize/bell/canonical feed）的规范总表，后者是单一机制的深度设计（时序图、Gateway 执行顺序、超时降级、验收用例）。合并会得到一篇 400 余行、把「全局规范」和「单机制细节」混在一起的文档，不构成 clearly better。现在两篇各自在顶部指向对方的对应章节。

## 4. 新性能文档要点

`docs/performance/2026082700-hot-path-optimizations.md` 汇总了 `research-perf.md` 与 `sub/*/result.md` 的实测数据：

- 解析器零拷贝（plain ASCII 75.8 → 1639.6 MB/s，21.6×；unescape 29.1×）
- retention 增量记账（500 panes / 1 KiB：36.44 → 0.64 µs，57×）
- canonical 帧精确尺寸（sizing 400×–20,000×，fitChecks 归零）
- 输出门控 8 MiB 字节上限 + `SourceGap`
- DB 两条索引（EXPLAIN 前后对照）+ `INSERT … RETURNING` 收 seq 分配
- ghostty 渲染桥缓存（6.75 → 1.37 ms；判脏行数 40/40 → 0.8/40；每 cell wasm 调用 −64%）
- history 分页单次写入（write 4288 → 64，133 → 21 ms）
- shared 校验（PaneData 31 KiB：355.61 → 0.12 µs）与 legacy diff（4.0×）
- react-query 失效面补全与设备树 selector/memo 收敛
- bench 命令表：`bun run bench:parser|bench:retention|bench:frame-sizer`（`apps/gateway`），以及 `packages/{ghostty-terminal,terminal-ui,shared}/bench/` 下的 5 个脚本
- Rust/WASM 决策：单次 wasm 调用 ≈8.3 ns，`get_multi(3)` 23.5 ns vs 3×`single_get` 24.9 ns → 成本在 wasm 内部 key 分发而非边界穿越，打包行 ABI 上限仅 2–2.5×，napi-rs 移植同样不划算。**回头条件**：上游补 damage API（优先级最高）/ 视口 ≥240×80 / profile 显示 parser 稳定占 gateway CPU >20% 且原型实测 >2×

## 5. 核验过的事实

- `packages/ws-client/src/state-machine.ts`、`apps/gateway/src/ws/borsh/switch-barrier.ts` 均存在且有测试 → 「未实现」横幅确属过时。
- `GATEWAY_CAPABILITIES = ['tmex-ws-borsh-v1','tmex-agent-v1','tmex-split-v1','canonical-state-v1']`（`packages/shared/src/capabilities.ts`）。
- `TERM_CHUNK` 全库仅存在于被修的那句文档里，代码中无此常量。
- `send_input` 是当前工具名（`apps/gateway/src/agent/tools/terminal.ts:34`），`send_keys` 已不存在于源码。
- `tmex-cli` 版本 `1.0.2`。
- 5 个 e2e spec 文件与行号**全部存在且对应真实 `test(` 声明**：`mobile-settings.spec.ts:5`、`mobile-terminal-interactions.spec.ts:79/140/221/303`、`settings-llm.spec.ts:42`、`terminal-mouse-recovery.spec.ts:384`、`ws-borsh-theme-resize.spec.ts:39`。注：任务描述写作「mobile-settings:5 cases」，实际 `:5` 是行号（该文件只有 1 个 test），mobile-terminal-interactions 确为 4 例，已按行号记入。
- `ssh-external-connection.ts`：单条 tmux control-mode channel + 常驻 `/bin/sh -s` 命令 channel + 一次性命令 channel，无逐 pane reader。
- 全库扫描 docs 中所有反引号包裹的 `apps|packages|scripts` 路径，除三个合理例外（历史语境的 `agent/prompts.ts`、JSON 字段记法 `package.json.version`、gitignore 的 `scripts/fonts/.cache/`）外全部存在。

## 6. 无法核验 / 需要确认

1. **测试计数**：`docs/agent/2026061302`、`2026061303` 的绝对计数（473/495/49）无法给出当前准确值——其它 agent 正在并发改代码，跑全量测试得到的数字立刻会过期，且各 result 文件给出的基线互相不一致（1473/1533/1537/1599/1615）。已改为不写死数字。
2. **`reviews/*.prompt.md`、`reviews/review-common.md`、`sub/grok-common.md` 的删除**：不在明确的删除清单里，但也不在 keep 清单里，按「与 `sub/*/prompt.md` 同类」处理。若判断有误需恢复。
3. **history.md 行数**：任务要求 30–60 行且「一条 bullet 一个目录」；141 个目录逐条至少 141 行，两者不可兼得。选择了按时期分组、每条 bullet 覆盖 1–4 个同主题目录，最终 81 行，141 个目录名全部出现（脚本核验）。
4. **ghostty scrollback 探针结论**（实际保留约 1129 行，与 `TERMINAL_SCROLLBACK = 10000` 无关）未独立复现，按原报告口径记为「只报告不下结论」，并注明 `MAX_SURFACE_HISTORY_BYTES` 现已被另一 agent 改为 `10_000 × 200` / 22 页。
5. `docs/product/2026062400-mindmap.md`、`docs/agent/2026061302` 的「验收数量是历史快照」等审计条目中，凡涉及需要跑测试才能确证的部分，均未跑测试。
