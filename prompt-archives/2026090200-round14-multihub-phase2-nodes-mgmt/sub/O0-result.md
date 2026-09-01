# O0 — Tunnel robustness（前端）执行结果

## 结论

按 `packages/shared/src/contracts/tunnel.ts` 已落地的契约，把「连接器健康 / degraded 态 / 精确检查结论 / 外部日志」四件事接到前端。契约文件与 `apps/gateway` 未触碰。

- `cd apps/fe && bunx tsc --noEmit -p .` → **0 error**（基线是 5 个 `connector` 缺失错误）
- `bun test src/pages/settings/remote-access` → **215 pass / 0 fail**（基线 188，新增 27）
- `bun test src/components/side-panels/connect-devices` → **50 pass / 0 fail**（新增 4）
- `bun test src/`（apps/fe 全量）→ **1275 pass / 0 fail，77 files**
- `packages/shared` i18n 用例 → 2 pass / 0 fail
- `bunx biome check` 覆盖两个改动目录 + locales JSON → clean（生成文件 `resources.ts` / `types.ts` 只由 `build:i18n` 重建，未 lint）

## 改动文件

### 逻辑

- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts`
  - `TunnelPill` 新增 `'degraded'`。
  - 新增 `ConnectorState`（`connected` / `noConnections` / `unknown` / `unprobed`）与 `connectorState()`：`reachable === null` 时按 `checkedAt` 分「探过了没找到端点（unknown）」与「从未探测（unprobed）」；`reachable === false` 与「应答但零连接」一并算 `noConnections`；旧后端没有 `connector` 字段时退回 `unprobed`（不冤枉判无连接）。
  - 新增 `tunnelDegraded()`：进程/系统服务活着 且（后端给 `process.state === 'degraded'` 或连接器零连接）。`tunnelPill()` 据此在托管与接管两条路径上都能给出 `degraded`——用户遇到的正是「外部 launchd cloudflared 进程在、边缘连接 0」，光看 `external.running` 永远是「运行中」。
  - `isTunnelRunning()` 把 `degraded` 也算「在跑」：进程还在、连接随时可能恢复，拿掉最后一道 Access 保护同样危险（`wouldDropLastProtection` 的语义保持不变）。
  - `ERROR_CODES` / `ERROR_CODES_WITH_MESSAGE` 收入 `connector_down`（带 `{{message}}`）。
  - 新增 `checkNotice(check)`：把检查结论折成 `tone` / `testId` / 文案键 / 插值 / 附加行，四个分支——`ok`（success）、`access_protected`（success）、`access_protected_unverified`（**warning**，testId `remote-access-check-warning`）、`connector_down`（error，用 `errors.connector_down` 插值），其余失败沿用 `check.unreachable` + 服务端原文。
- `apps/fe/src/pages/settings/remote-access/tunnel-actions.ts`
  - `TunnelCheckResult` 增加 `step: string | null` 与 `code: TunnelErrorCode | null`，`checkResultOf()` 从 `job.step` / `job.error.code` 读取。
- `apps/fe/src/pages/settings/remote-access/status-card.tsx`
  - `PILL_VARIANT.degraded = 'destructive'`；`stoppable` 纳入 `degraded`（degraded 时仍能点停止）。
  - 新增 `DegradedNotice`（`SetupNotice tone="warning"`，testId `remote-access-degraded`）：主文案 + 第二行 `process.lastError ?? connector.lastError`。
  - 新增 `ConnectorRow`（testId `remote-access-connector`）：`configured` 时恒显示一行，四态各自文案，`noConnections` 用 `text-destructive`、`unknown`/`unprobed` 用 `text-muted-foreground`，`metricsAddr` 只进 `title`。
  - 检查结论改由 `CheckResultNotice` 渲染 `checkNotice()` 的结果。
  - 检查按钮条件由 `process.state === 'running'` 改为 `adopted || pill === 'running' || pill === 'degraded'`。
  - 日志空态：`externallyManaged` 时改用 `log.emptyExternal`。
- `apps/fe/src/components/side-panels/connect-devices/host-status.ts`
  - `EntryStatus` 增加 `degraded`；`tunnelRunning` 拆成 `tunnelAlive` + `tunnelDegraded`，`running` 现在等于「活着且不 degraded」——degraded 不再被当成可用入口。这里刻意不 import 远程访问模块（会把它的 lazy chunk 拽进侧滑面板），判据是同一套的本地副本。
- `apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx`（scope 之外的一行，但需求 3 的「面板状态行加降级说法」只能落在这里）
  - 状态行文案 `entry.degraded ? 'degraded' : entry.running ? 'running' : 'stopped'`。

### i18n（只动 `translation.settings.remoteAccess`，三语同步，已跑 `build:i18n`）

`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（+ 生成的 `resources.ts` / `types.ts`）

新增：`state.degraded`（无连接）、`degradedNotice`、`connector.{label,connected,noConnections,unknown,unprobed}`、`check.accessProtected`、`check.accessProtectedUnverified`、`log.emptyExternal`、`errors.connector_down`。
修改：`check.reachable` 由「公网地址可以访问。」改为「本机经公网地址可达。」——旧键留用，避免多出一条同义的死文案。
`connector.connected` 用 `{{n}}` 而不是 `{{count}}`，避开 i18next 的复数键；英文写成 `Edge connections: {{n}}` 以免单数不通。

### 测试

- `tunnel-model.test.ts`：`connectorState` 四态 + 旧后端兜底；`tunnelDegraded`/`tunnelPill` 的 degraded（托管、接管、停止/启动中不受影响）；degraded 下 `wouldDropLastProtection` 仍为真；`checkNotice` 六个分支；`connector_down` 错误映射。
- `remote-access-tab.test.tsx`：新增 `无边缘连接（degraded）`（徽标、警示、第二行错误、接管态、连接器行四态、未配置不显示）与 `检查结论`（ok / access_protected / unverified 警示 / connector_down）两个 describe；日志空态补外部 cloudflared 分支。
- `host-status.test.ts`：零连接、后端 degraded、接管态零连接、已停止不算 degraded 四个用例，并给已有断言补 `degraded` 字段。
- 五个夹具（`host-status.test.ts` / `access-model.test.ts` / `remote-access-tab.test.tsx` / `tunnel-actions.test.ts` / `tunnel-model.test.ts`）补上 `connector`，缺省 `reachable: null, checkedAt: null`（= 未探测），不影响既有断言。

## 有意未改

- `apps/fe/src/components/side-panels/connect-devices/access-addresses.ts`：通读后确认它**没有**任何 `process.state === 'running'` 之类的可达性门槛——公网地址只按 `config.mode` / `process.publicUrl` 取，隧道停了也照给。要让 degraded 影响这里，等于顺带改掉「停止时也列地址」的既有行为，超出「改动最小」的范围，故未动。
- `jobStepKey` 未收 `access_protected*`：`JobProgress` 只用于 install / named / access 三处进行中的 job，check 的终态步骤走的是 `checkNotice`，不会漏成裸字符串。
- 未做开发实例截图（文案规范里的换行核对）——本任务未起临时实例；新增文案均为一行短句（zh 最长 25 字），但如需严格按规范核对换行，可在合并后的开发实例里补看一眼「设置 → 远程访问」状态卡。
