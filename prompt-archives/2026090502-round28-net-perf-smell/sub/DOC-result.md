# DOC：`docs/` 审计与重整结果

范围仅 `docs/`（不动 `prompt-archives/`、代码、`AGENTS.md`、包内 README）。逐篇读过 63 个 md，
按「是否仍描述当前架构 / 行为 / 运维流程」分类，并对声称的代码锚点做了 grep 抽查。

## 一、分类表（文件 → 处置 → 理由）

### 删除 / 合并

| 文件 | 处置 | 理由 |
| --- | --- | --- |
| `product/2026062400-prd.md` | DELETE | v1.0.2 快照，与现状冲突：写着「不内置鉴权，依赖 Cloudflare Access / Tailscale」「monorepo 只有 shared + ghostty-terminal 两个包」，而 1.1.x 已是用户自持根钥 + passkey + mesh、11 个包。产品面由仓库根 `README.md` 承担，功能细节由各模块文档承担，重写这份快照没有收益 |
| `product/2026062400-mindmap.md` | DELETE | 产品能力脑图，无 mesh / 中继 / 账号安全分支，且与根 `README.md` 的 Highlights 重复；对工程读者无信息量 |
| `terminal/2026021404-terminal-switch-barrier-design.md` | MERGE → `ws-protocol/2026021403-ws-state-machines.md` | 屏障机制 1.1.23 已删；文中「为什么被替换 + 新旧机制对应表」有价值，但 canonical 切换流程在状态机文档、borsh 规范里各写了一遍。已把背景 / 局限 / 对应表 / e2e 覆盖并入状态机文档的附录，原文件删除，两处引用改指附录 |

### 重写 / 订正（内容与代码对不上，按现行代码改）

| 文件 | 处置 | 订正内容 |
| --- | --- | --- |
| `README.md` | REWRITE | 旧索引漏列 9 篇（relay ×3、messaging、hub ×2、operations / performance / update 各 1），且含已删文档。改为按「上手与部署 → 架构（mesh / 协议 / 终端 / agent）→ 功能模块 → 运维 / 性能 / 测试 / 发版更新 → 已知问题」分组，每篇一行且只出现一次 |
| `known-issues.md` | REWRITE | 旧文只有一条「KI-3 已全部修复、清单为空」的历史记录。改为 KI-1 e2e 抖动基线（1.1.32：108 pass / 3 fail，三条隔离复跑 16/16 通过）+ 第二十八轮遗留 6 项（下载无持续进度、ICE 网卡过滤、TURN 三 env、`MAX_LINK_UNACKED` 代价、待现网实测两项、两处上帝类待立项） |
| `ws-protocol/2026021402-ws-borsh-v1-spec.md` | REWRITE-LIGHT | ①删掉 9 个 1.1.23 已作废 kind 的 payload 小节（`STATE_SNAPSHOT(_DIFF)`、`TMUX_SUBSCRIBE_PANES`、`TMUX_FETCH_PANE_HISTORY`、`TERM_RESIZE/SYNC_SIZE`、`TERM_OUTPUT/HISTORY`、`SWITCH_ACK`、`LIVE_RESUME`）——号段作废表已单列，schema 在 `packages/shared` 里已不存在（已核对 `kind.ts`）；②「兼容与迁移」还写着「迁移期同时支持 JSON 文本帧 + feature flag 回退」，改为当前的 version/capability 演进与 fail-closed；③关键时序「选择屏障」改成 canonical 首屏事务 |
| `ws-protocol/2026021403-ws-state-machines.md` | REWRITE-LIGHT | 吸收屏障文档为附录；头部引用改为「见文末附录」 |
| `ws-protocol/2026070402-site-theme-update.md` | REWRITE-LIGHT | 把「验收标准」勾选清单（过程残留，含一条未打勾的人工实证）换成一句覆盖说明，指向 `theme-propagation.spec.ts` |
| `terminal/2026041600-ghostty-wasm-runtime.md` | REWRITE-LIGHT | 全篇按 HTML formatter 渲染写（`.xterm-screen.innerHTML`、`htmlFormatterHandle`、`__tmexE2eXterm`），实际早已是 canvas：`createRenderState` + `TerminalRenderCoordinator` + `CanvasRenderer` 行级重绘，兼容 buffer 由 `TerminalBuffer` 提供。已改分层（补 `packages/terminal-ui`）、初始化句柄、输出链路（canonical `PaneSink` 而非 `onApplyHistory/onFlushBuffer`）、xterm 兼容面清单与关键文件表 |
| `update/2026061406-self-update.md` | REWRITE-LIGHT | 「检查更新」还写 `registry.npmjs.org` + jsdelivr CHANGELOG，「升级」还写 `bun add tmex-cli@x`；实际 `update-check.ts` 读 GitHub `releases/latest`、changelog 取 release body，`upgrade.ts` 下载 tarball 校验 sha256 后解包。已按代码改写，并链到崩溃安全与远程推包续传两篇 |
| `device-tree/2026061400-reorder.md` | REWRITE-LIGHT | 「显示层 overlay」一节引用的 `ws/overlay-utils.ts`、`applyDeviceTreeOverlay`、`encodeSnapshotWithOverlays` 均已随 `STATE_SNAPSHOT` 删除。改写为：DB 表不变（`device_tree_order`），重排走 `ws/tmux-command-handlers.ts` 写库 + `SETTINGS_UPDATE('tree-order')`，顺序随 canonical metadata 的 `SOURCE_FIELD_TREE_ORDER` 下发、客户端 `sortSnapshotByCanonicalTreeOrder` 排序；关键文件与测试清单同步 |
| `hub/2026082800-hub-node-operations.md` | REWRITE-LIGHT | 删 `TMEX_FAILOVER_HISTORY_BYTES_PER_PANE`（全仓已无该 env，属 legacy failover 残留）；补 `TMEX_RTC_PORT_RANGE`（1.1.31 新增，`config.ts` 有校验）；参考链接跟随目录调整 |
| `hub/2026082700-hub-node-architecture.md` | REWRITE-LIGHT | 「风险与待验证项」里「存量部署文档 JWT 内容已过时，实现后重写」改成指向已重写的部署文档 |
| `agent/2026061303-run-command-headless-ghostty.md` | REWRITE-LIGHT | 引用的 `known-issues.md KI-2` 已不存在，改为直接写「端到端 integration 未补」 |
| `terminal/2026061501-mobile-keyboard-behavior.md` | REWRITE-LIGHT | 同上，去掉悬空的 `known-issues` 引用 |

### 保留（仍与代码一致，抽查通过）

`deployment/2026021000-production-install.md`（原 bootstrap）、`deployment/2026061400-process-survival.md`、
`env/2026061301-three-tier-env.md`、`onboarding/2026083101-connect-devices-panel.md`、
`hub/2026082801-hub-docker-e2e.md`、`hub/2026090104-multi-hub-standby.md`、`hub/2026090301-site-settings-node-linkage.md`、
`hub/2026090305-peer-endpoint-backoff.md`、`hub/2026090306-rtc-dial-breaker.md`、`hub/2026090402-docker-node.md`、
`hub/2026090502-rtc-signaling-epoch-link-liveness.md`、`relay/2026090304-relay-role.md`、`relay/2026090403-relay-metrics.md`、
`relay/2026090501-relay-mgmt-switch-usage.md`、`terminal/2026090101-viewport-policy.md`、`terminal/2026090304-ws-latency-measurement.md`、
`terminal/2026061101-claude-code-osc-notification.md`、`terminal/2026070501-tui-theme-notify-2031.md`（原 appearance/）、
`agent/2026061300-terminal-agent-overview.md`、`agent/2026061302-system-prompt-and-credential-handling.md`、
`files/2026061500-transfer-progress-chunked.md`、`files/2026090101-files-sidebar-visibility-default.md`、
`watch/2026061300-watch-monitor-overview.md`、`notify/2026062000-weixin-clawbot-channel.md`、
`messaging/2026090402-messaging-command-template.md`、`frontend/2026070800-workspace-packages.md`（原 `packages.md`）、
`frontend/2026090307-app-error-boundary.md`、`fonts/2026061501-font-pipeline.md`、
`operations/` 全部 9 篇、`performance/` 全部 4 篇、`testing/2026061302-live-integration-tests.md`、
`release/` 全部 4 篇、`update/2026061502-bun-path-resolution.md`、`update/2026090502-resumable-remote-upgrade-push.md`。

抽查方式：对文中点名的实现文件逐个 `ls`/`grep`（`agent/supervisor.ts`、`watch/evaluator.ts`、
`files/{rsync,device-storage,transfer-session}.ts`、`weixin/ilink/*`、`mesh/{client-source,effective-site-url,relay-link-error}.ts`、
`relay/relay-metrics.ts`、`tunnel/edge-resolver.ts`、`system/{install-info,upgrade-staging}.ts`、
`packages/app/src/lib/{bun,cli-shim}.ts`、`shared/release/source.ts`、`stores/ui.ts` 的 `keyboardBehaviorMode` 等）全部命中。

保留但**有意不改**的两点，供后续判断：`operations/2026090101-public-login-hardening.md` 与
`…-security-review.md` 有重叠，但一篇写机制、一篇写「明确不做的事」的取舍理由，后者正是「为什么这么做」的记录，
未合并；`hub/2026082801-hub-docker-e2e.md` 里的 tarball 版本号（1.0.2）只是示例命令，未逐个升版。

## 二、目录调整

只做语义上确实更清楚的移动，其余按 AGENTS 的「按模块建目录」原样保留（单文件模块目录本身符合规范）：

| 变更 | 说明 |
| --- | --- |
| `2026021000-tmex-bootstrap/deployment.md` → `deployment/2026021000-production-install.md` | 原目录名像文档名不像模块；文件名补齐 `<日期><编号>-<英文短语>` 约定 |
| `service/2026061400-process-survival.md` → `deployment/2026061400-process-survival.md` | 讲的就是安装后 unit / plist 的 kill 策略，与部署同一模块；`service/` 目录消失 |
| `appearance/2026070501-tui-theme-notify-2031.md` → `terminal/` | 主题通知是注入 pane 内 TUI 的终端行为，与 `terminal/` 的 OSC 通知文档同族；`appearance/` 目录消失 |
| `frontend/packages.md` → `frontend/2026070800-workspace-packages.md` | 唯一不符合命名约定的文件，日期取该文件的首次提交日（2026-07-08） |
| `product/` 目录删除 | 两篇均删（见上） |

最终目录顺序（README 的分组顺序）：deployment / env / onboarding → hub / relay → ws-protocol → terminal →
agent → device-tree / files / watch / notify / messaging / frontend / fonts → operations / performance /
testing / release / update → known-issues。

## 三、`docs/` 之外需要指挥官处理的引用

1. **不需要改**：所有指向本次移动 / 删除文件的仓库内引用都不存在——已 grep `apps` / `packages` / `scripts` /
   `AGENTS.md` / `CLAUDE.md` / 根 README，无 `tmex-bootstrap`、`process-survival`、`tui-theme-notify`、
   `product/2026062400-*`、`frontend/packages.md`、`switch-barrier-design` 命中。
2. **仍然有效**（未动这些文件，勿在后续重命名）：
   - `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`：`packages/shared/src/ws-borsh/{codec,kind,errors,index,convert,schema,chunk}.ts` 头注释（7 处）
   - `docs/ws-protocol/2026021403-ws-state-machines.md`：`apps/gateway/src/ws/borsh/session-state.ts`
   - `docs/hub/2026082700-hub-node-architecture.md`：`apps/fe/src/auth/session-key-{persistence,store}.ts`、`packages/panels/src/files/bulk-transfer.ts`、`packages/api-client/src/auth/types.ts`
   - `docs/hub/2026082800-hub-node-operations.md`：`apps/fe/src/pages/settings/nodes/setup/{become-hub-form,join-hub-form}.tsx`
   - `docs/relay/2026090304-relay-role.md`：`apps/fe/src/node/relay-pack.ts`、`apps/fe/src/auth/account-security-actions.ts`（后者写作 `docs/relay §5b`）
   - `docs/release/2026061406-release-changelog-flow.md`：`scripts/release.ts`（3 处）
   - `docs/env/2026061301-three-tier-env.md`、`docs/testing/2026061302-live-integration-tests.md`：`AGENTS.md`
   - `docs/images/screenshot.png`：根 `README.md`
3. **本来就断的引用（非本次造成，建议顺手修）**：
   `apps/fe/src/pages/settings/nodes/setup/validation.ts:3` 注释引用 `docs/2026082900-hub-ui-tls`，
   该路径在 `docs/` 下从不存在（实际是 `prompt-archives/2026082900-hub-ui-tls…` 那一轮的档案）。

## 四、体量对比

| 指标 | 之前 | 之后 |
| --- | ---: | ---: |
| md 文件数 | 63 | 60 |
| md 总行数 | 7657 | 6935（−722，−9.4%） |
| 目录数（含 `images/`） | 22 | 21 |
| README 未收录的文档 | 9 | 0 |

主要变动文件行数：`ws-borsh-v1-spec` 1011 → 873；`ws-state-machines` 262 → 308（吸收屏障文档 103 行的精华）；
`README` 168 → 123；`known-issues` 10 → 47；`ghostty-wasm-runtime` 181 → 193；`self-update` 72 → 85；
`device-tree/reorder` 65 → 76；删除 `prd`(459) + `mindmap`(93) + `switch-barrier-design`(103)。

## 五、校验

- `find docs -type f | sort`：60 个 md + `images/screenshot.png`。
- README 里 60 个 `.md` 路径全部存在，**每篇恰好出现一次**，且 `docs/` 下没有未被收录的 md（脚本核对）。
- `docs/` 内所有 markdown 相对链接与 `docs/xxx.md` 形式的绝对引用：0 条断链（脚本核对）。
- 未触碰 `prompt-archives/`、代码、`AGENTS.md`、包内 README；未运行任何 git 状态变更命令。
