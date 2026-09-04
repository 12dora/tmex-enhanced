# T4 结果 — Remote Access：让「无边缘连接」可操作

## 改动文件

- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts`
  - `connectorState`：`reachable === true` 时不再用 `readyConnections ?? 0` 兜底。只有拿到确凿的有限数字才分档——`> 0` → `connected`，`=== 0` → `noConnections`；`null` / `undefined` / `NaN` / 负数一律 `unknown`。端点应答但没给出连接数不再被误判成断线。
  - 新增 `degradedError(status)`：`process.lastError ?? connector.lastError`，去空白、空串归 `null`、超过 200 字符截断并补 `…`。纯函数，便于直接测。
- `apps/fe/src/pages/settings/remote-access/status-card.tsx`
  - `DegradedNotice` 三行结构：结论（`degradedNotice`）→ 排查指引（`degradedHint`，仅当 `connectorState === 'noConnections'`，`data-testid="remote-access-degraded-hint"`）→ 错误明细（`degradedError` 的结果，`break-all font-mono text-muted-foreground`，`data-testid="remote-access-degraded-error"`）。
  - 进程自报 `degraded` 但连接器探不到连接数时只出结论，不指向 7844——避免在没有证据时误导。
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`
  - 仅在 `settings.remoteAccess` 下 `degradedNotice` 之后插入一行 `degradedHint`，未改动任何其他 key、未重排、未重新格式化。
  - zh：`cloudflared 连不上 Cloudflare 边缘（TCP/UDP 7844）。请检查代理或防火墙是否放行 *.argotunnel.com 与 *.cftunnel.com。`
  - en：`cloudflared cannot reach the Cloudflare edge (TCP/UDP 7844). Check that the proxy or firewall allows *.argotunnel.com and *.cftunnel.com.`
  - ja：`cloudflared が Cloudflare エッジ（TCP/UDP 7844）に到達できません。プロキシまたはファイアウォールが *.argotunnel.com と *.cftunnel.com を許可しているか確認してください。`
  - 已从仓库根跑 `bun run build:i18n`，`resources.ts` / `types.ts` / `locales/generated/*` 随之重建（预期内的生成物变更）。
- `apps/fe/src/pages/settings/remote-access/tunnel-model.test.ts`
  - `connectorState`：新增「端点应答但没给出连接数」用例，覆盖 `null` / `undefined` / `NaN` / `-1` 四种输入均判 `unknown`。
  - 新增 `describe('degradedError')`：进程错误优先于连接器错误、都没有为 `null`、纯空白当没有、400 字符截断成 200 + `…`。
- `apps/fe/src/pages/settings/remote-access/remote-access-tab.test.tsx`
  - 原「警示第二行给出进程或连接器的最近一次错误」补断言 `data-testid="remote-access-degraded-error"`。
  - 新增「确证零连接时补一条排查指引；探不到连接数时不给」：零连接渲染出 `remote-access-degraded-hint` + `settings.remoteAccess.degradedHint`；进程 `degraded` 且连接器未探测时不出现 hint。

## 验证

- `cd apps/fe && bun test src/pages/settings/remote-access`：**271 pass / 0 fail**，860 expect，6 个文件（原 268 → 新增 3 个用例）。
- `bunx tsc --noEmit -p apps/fe`：无输出，0 错误。
- `bunx biome check`（仅本任务四个文件）：`No fixes applied`，clean。
- 未跑 e2e，未起 dev server，未碰生产 tmex / `tmex` tmux session，未执行任何改变 git 状态的命令。

## 遗留与说明

- `bun test packages/shared/src/i18n/locale-consistency.test.ts` 目前 3 个失败，**与本任务无关**：差异全部落在 `relay.tenant.*`（`switch.*`、`linkErrors.*`、`strip.*`、`metaKey.rotate*`、`actions.rotate`）与 `nodes.*` / `devices.*` 的复数形式，是其他 agent 正在并行编辑的 sub-object。已逐 key 核对，`settings.remoteAccess.degradedHint` 在 zh_CN / en_US / ja_JP 三份文件里都存在且拼写一致。该测试需等其他 agent 的 locale 收敛后再统一跑一次。
- 错误明细行放在 hint 之下（需求 3 的顺序），并沿用了原先「进程错误优先于连接器错误」的取值口径：进程 `lastError` 更贴近失败原因，连接器 `lastError` 作为兜底。若后续希望在 `noConnections` 时强制显示 `connector.lastError`（而非被进程错误盖掉），改 `degradedError` 一行即可。
- `degradedHint` 的中文按任务原文保留了「请检查……」的祈使句式；虽然带「请」，但不含第二人称，符合文案规范。
