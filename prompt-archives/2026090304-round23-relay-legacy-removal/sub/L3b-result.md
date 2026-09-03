# L3b 结果：清理 L3 删路由后的三处遗留

L3（提交 `2c6ecb8e`）删掉了 `GET /api/tmux/tree`、driver 的 `tmux-tree` 子命令和
`apps/gateway/src/api/theme.ts`，本任务收尾其外部遗留。

## 1. 改动清单

| 文件 | 改动 |
| --- | --- |
| `scripts/hub-e2e/driver/terminal.ts` | `--pane-id` 由必填改为可选（`requireArg` → 可选读取，缺省空串）；快照与兜底都拿不到 pane 时显式抛错，不静默用空 pane 订阅 |
| `scripts/hub-e2e/run.sh` | 删 `driver files.ts tmux-tree` 调用、`/out/tmux-tree-b.json`、`TREE_PANE` 覆盖，以及「3e tmux tree lists device」检查 |
| `scripts/hub-e2e/split/run.sh` | 删 3 处 `tmux-tree` 取 pane 的循环（`tree_a`/`tree_h`/`tree_b`）、`refresh_pane()` 函数及其 2 处调用、`run_direct_scenarios` 里的 `tree_json`/`pane_id` 局部与 case 赋值、全部 `--pane-id` 传参（A7/B6/C2/C3/E2/D3/seq-capture）、以及「B5 tmux tree on hub via node-a」检查 |
| `apps/gateway/src/tmux/theme-broadcaster.ts` | **删除**（33 行） |
| `apps/gateway/src/runtime.ts` | 去掉 `registerThemeBroadcaster` import、启动时的两回调注册（原 163-170）、`stop()` 里的注销（原 253） |
| `apps/gateway/src/settings/broadcaster.ts` | 首行注释里指向已删模块的「仿 tmux/theme-broadcaster 的注册模式」改为「用注册表解耦」 |
| `scripts/complexity/allowlist.json` | `apps/gateway/src/hub/hub-runtime.ts` 的 `fileLines` 1368 → **1317** |

## 2. 两个 run.sh 现在怎么拿 pane id

`terminal.ts` 本来就是「快照优先」：连上设备后等 `KIND_STATE_SNAPSHOT`（最长 8 s），
从中取第一个有 pane 的 window 及其首个 pane（`terminal.ts:162-171`），
`--pane-id` 只是 `snapshotPane || paneId` 的兜底种子（`:214`）。tmux-tree 那条路由被删后，
兜底种子的唯一来源没了，所以把 `--pane-id` 改成可选，并在两者都为空时抛错（原先空串会被
静默塞进 `TmuxSubscribePanesSchema`，症状难查）。

- **`scripts/hub-e2e/run.sh`**：仍保留一个**真实**兜底——第 387 行
  `docker exec tmex-e2e-node-b tmux -L tmex-node-b display-message -p -t e2e-b '#{pane_id}'`
  直接问容器内 tmux 要活动 pane，与被删路由无关。原先 tmux-tree 只是把这个值覆盖掉，
  现在直接用它，日志由 `using pane` 改成 `seed pane`（语义上它只是种子）。
  3g/4x/5x 三处 `--pane-id "${PANE_B}"` 原样保留。
- **`scripts/hub-e2e/split/run.sh`**：这里从来没有 docker/ssh 侧的 pane 来源
  （hub 在远端、要走 `rssh_docker`），全部 pane 都是 tmux-tree 猜出来的。
  所以**不再传 `--pane-id`**，一律让 `terminal.ts` 从快照解析。
  受影响的用例：A7、B6、C2、C3、E2、D3/L3（`run_direct_scenarios` 的 marker 往返）、
  H2/L5（seq capture）。语义上更准：D/L 场景里 `docker restart` + `target_ensure_tmux`
  会重建 session、pane id 会变，原来的 `refresh_pane` 是为了这个才存在，
  现在快照本身就是实时的，反而少一次竞态。

### 删掉的两条断言

| 断言 | 处置 | 理由 |
| --- | --- | --- |
| `run.sh` 「3e tmux tree lists device」 | **删除**，无等价替换 | 它断言的就是被删的 `GET /api/tmux/tree` 本身；不依赖该路由的等价断言只能重造（新 driver 子命令走 WS 快照），超出本任务范围。紧随其后的 3g「terminal marker round-trip via hub」是严格更强的断言——它要求同一设备的 tmux 会话真的能连上、能收发字节，否则必挂 |
| `split/run.sh` 「B5 tmux tree on hub via node-a」 | **删除**，无等价替换 | 同上；下一条 B6「terminal marker node-a → remote hub node」覆盖同一链路且更强 |

副作用：两个 harness 的 report.md 各少一行（`REPORT_ROWS` 只是累加，脚本里没有总数断言，
`FAILS` 计数逻辑不受影响）。另外 `run.sh` 里原先那个「等 20 s 直到 tree 出现 `"id":`」的
就绪等待也一并没了；等待改由 `terminal.ts` 自己的 8 s 快照等待 + 25 s 总超时承担，
中间还夹着 3f 的 `wait-reach --timeout 30000`。

## 3. theme 转发器

`apps/gateway/src/tmux/theme-broadcaster.ts` 是「api 层拿不到 runtime 局部创建的 wsServer」
的注册表垫片，唯一注册方 `runtime.ts`、唯一消费方 `api/theme.ts`（L3 已删）。全仓 grep 确认
无其它引用（无同名测试文件），已整体删除并摘掉 `runtime.ts` 的注册/注销。

**`apps/gateway/src/ws/**` 未动**（属另一个 agent）。因此以下方法现在成了无人调用的转发壳，
留待 ws 侧 owner 处置：

- `apps/gateway/src/ws/index.ts:761` `WebSocketServer.scheduleTmuxThemeApply` —— 原唯一调用方是
  `runtime.ts` 的注册回调，现已无生产调用方（`ThemeSettingsBroadcaster` 内部走的是
  `this.scheduleTmuxThemeApply`，即 `ws/theme-settings-broadcaster.ts:59` 上的同名方法，不经这层）
- `apps/gateway/src/ws/index.ts:765` `WebSocketServer.broadcastSiteThemeUpdateS2C` —— 同上

仍在用、不能删的：`ws/theme-settings-broadcaster.ts` 上的 `handleSiteThemeUpdate` /
`scheduleTmuxThemeApply` / `broadcastSiteThemeUpdateS2C` / `broadcastThemeChange`（WS C2S 主链路），
以及 `WebSocketServer.broadcastThemeChange`（`ws/tmux-command-handlers.ts:37,188` 的 host 接口 +
`ws/index.test.ts` 5 处用例）。

`docs/ws-protocol/2026070402-site-theme-update.md:65` 提到的 `broadcastThemeChange` 指的是
ws 层那条链路（仍存在），无需改动。全仓无其它文档/README 提及 `tmux-tree` 或 `theme-broadcaster`
（`prompt-archives/` 里的历史存档按惯例不改）。

## 4. allowlist

`scripts/complexity/gate.ts:117` 的行数口径是 `text.split('\n').length`，比 `wc -l` 多 1
（文件末尾换行），所以 `hub-runtime.ts`（`wc -l` = 1316）在门禁里算 **1317**，
条目写 1316 会直接判违规。已按门禁口径填 1317，跑 `gate.ts` 确认该文件既不违规也不是 stale。
未新增任何条目。

> 注：这处改动已被并发的别的提交（`50e2f718`，ws-client legacy 清理）连带提交进去了，
> 工作区里已看不到 diff，内容以文件现状为准（1317）。

## 5. 验证

| 项 | 结果 |
| --- | --- |
| `bash -n scripts/hub-e2e/run.sh` | 通过（`set -euo pipefail` 语义未动，被删块内的 `set +e/-e` 成对移除） |
| `bash -n scripts/hub-e2e/split/run.sh` | 通过 |
| `bun build --no-bundle scripts/hub-e2e/driver/terminal.ts` | 通过 |
| `bun test scripts/hub-e2e/driver` | 38 pass / 0 fail |
| `bunx tsc --noEmit -p apps/gateway` | 53 error，**无一条**落在 `runtime.ts` / `settings/broadcaster.ts`；全部是在途的 `TmexRoles.relay`（`{hub,node}` 里没有 `relay`）与 `relay/relay-password.ts` 缺 `hash-wasm` 依赖 |
| `bun test src/tmux src/settings`（gateway，含 `src/tmux-client`） | 706 pass / 0 fail（70 文件） |
| `bun test src/runtime.preflight.test.ts` | 1 pass / 0 fail |
| `bunx biome check`（4 个改动的 TS/JSON 文件） | 通过 |
| `bun run lint`（仓库根） | biome 22 error + 门禁 3 违规，**全部**在别的 agent 在途的文件上（`mesh/forwarder.ts`、`auth/user-key-service.ts`、`ws/canonical-feed-session.ts`、`relay/*`、`packages/app/src/commands/relay-*` 等），我的文件无一上榜；门禁报 `0 stale allowlist entries` |

未运行 docker harness（按要求）；未触碰生产 tmex 与名为 `tmex` 的 tmux session。

## 6. 遗留 / 提示

- 两个 harness 的 pane 兜底能力不对等：`run.sh` 还有 tmux 直查兜底，`split/run.sh` 完全依赖快照。
  若后续发现 split 场景偶发「no pane in STATE_SNAPSHOT」，正确修法是给 driver 加一个走 WS 快照的
  `pane-id` 子命令（或延长 `terminal.ts` 的 8 s 快照等待），而不是恢复被删的路由。
- ws 侧两个已无调用方的转发壳见 §3，需由 ws owner 决定是否一并清掉。
