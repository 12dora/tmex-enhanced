# BL 结果：设置-远程访问 文案重写 + 新探测三态接线

## Part 1：三态接线

后端新增 `external.externalAccess`（`packages/shared/src/contracts/tunnel.ts`，字段可选以兼容旧夹具）。前端把它收敛成一个纯函数三态，再分三处渲染。

### 推导层

`access-model.ts` 新增（Access 相关的推导都在这个文件，`tunnel-model.ts` 反向 import，无环）：

```ts
export type ExternalAccessState = 'unknown' | 'covered' | 'absent';

export function externalAccessState(status: TunnelStatusResponse): ExternalAccessState {
  const probe = status.external.externalAccess;
  if (!probe?.checked) return 'unknown';
  return probe.hostnameMatch ? 'covered' : 'absent';
}
```

字段缺失（旧网关 / 旧夹具）与 `checked: false` 一并归入 `unknown`——两者都是「查不了」，都不能说成未配置。

### 徽标（`tunnel-model.ts: accessPill` + `status-card.tsx` 的 variant 表）

`AccessPill` 从 4 态扩到 6 态：

```ts
export function accessPill(status: TunnelStatusResponse): AccessPill {
  if (status.access.configured) {
    if (!status.access.enforceJwt) return 'notEnforced';
    return accessEffective(status) ? 'protected' : 'hostnameMismatch';
  }
  const probed = externalAccessState(status);
  if (probed === 'covered') return 'dashboardCovered';
  return probed === 'unknown' && hasCoverableHostname(status) ? 'unknown' : 'notConfigured';
}
```

三条关键取舍：

1. **`access.configured`（tmex 托管）永远优先**：控制台上有应用不会顶掉 tmex 自己的 JWT 强制校验状态，只读探测只在 tmex 没托管时才出现在徽标上。
2. **`unknown` 需要「有主机名」才出现**（`config.hostname` 或探测到的系统隧道主机名）。什么都没配的新机器上没什么可查的，此时「未配置 Access」才是准确说法；否则一台干净机器会长期挂一个「无法检测」的告警徽标。
3. 徽标 variant：`unknown` 与 `dashboardCovered` 都用 `secondary`（中性），与 `notConfigured` 的 `outline`（空态）在视觉上分开。`TunnelStatusCard` 函数体一行没动（allowlist 锁 cc 34 / 216 行，实测仍为 34 / 216）。

### Access 步骤内的说明（`access-step.tsx`，新组件 `ExternalAccessNotice`）

只在 `!access.configured` 时渲染，`testId` 为 `remote-access-access-probe-{covered|absent|unknown}`：

- `unknown` → warning 提示，明说「这不代表未配置」，并指向保存凭证；
- `covered` → info 提示，写明是只读检测、**不由 tmex 管理、网关不会校验它签发的令牌**，指向「从 Cloudflare 同步」；有 `teamDomain` 时补一行；
- `absent` → info 提示，写明「Cloudflare 上确实没有覆盖该主机名的应用」，指向下方规则表单。

额外一条精度修正：按 BK 的凭证链，探测可能走 `~/.cloudflared/cert.pem` 的 ARGO token，此时 `access.hasCredentials` 仍是 false，**同步 / 应用按钮并不在页面上**。所以 `covered` / `absent` 且未存凭证时追加 `probe.needCredentials`：「要交给 tmex 托管并在网关校验令牌，请先在下方保存 API 令牌与账户 ID。」否则文案会指向一个不存在的按钮。

### 接管卡（`external-card.tsx`）

- 新增 `Cloudflare Access` 明细行（`remote-access-external-access`），值为 covered / absent / unknown 三态文案；有 `teamDomain` 时多一行。
- 新增接管说明段 `external.adoptHint`（见下）。
- 为腾出行数（allowlist 锁 124 行），把明细行整体抽成 `ExternalDetails` 子组件；`ExternalTunnelCard` 现在约 104 行，已低于默认阈值 120，不再出现在复杂度报告里（allowlist 未改，gate 报 0 stale）。

## Part 2：文案重写

三语全量重写 `settings.remoteAccess`。**删除 0 个 key**，新增 14 个（`accessState.unknown` / `accessState.dashboardCovered`、`access.probe.*` 5 个、`external.accessLabel`、`external.accessValue.*` 3 个、`external.adoptHint`），其余只改 value，代码零改名成本；三语 key 集合脚本校验完全一致。未跑 `build:i18n`，未碰 `resources.ts` / `types.ts`（commander 重新生成后新 key 才会在运行时生效）。

写作原则：每条文案回答「这是什么 / 现在是什么状态 / 下一步做什么」；错误必须给可执行动作；不泄漏内部术语。

### 关键 before/after（zh_CN）

| key | before | after |
|---|---|---|
| `errors.process_failed` | cloudflared 进程启动失败，详见日志。 | cloudflared 没能正常启动。请展开下方的 cloudflared 日志查看最后几行输出，处理后重试。 |
| `errors.download_failed` | 下载 cloudflared 失败，请检查网络后重试。 | 下载 cloudflared 失败。请检查这台机器的网络是否能访问 github.com，然后重试。 |
| `errors.dns_route_failed` | 配置 DNS 记录失败，请确认该域名已托管在 Cloudflare。 | 在 Cloudflare 添加 DNS 记录失败。请确认该域名托管在同一个 Cloudflare 账号下，且没有同名记录冲突。 |
| `errors.access_api_failed` | Cloudflare API 调用失败：{{message}} | 调用 Cloudflare API 失败：{{message}}。请确认 API 令牌的权限与账户 ID 无误后重试。 |
| `errors.busy` | 另一项操作正在进行。 | 上一项操作还没结束，请稍候再试。 |
| `errors.invalid_request` | 请求无效。 | 请求无效，页面数据可能已过期。请刷新页面后重试。 |
| `accessState.notConfigured` | Access 未配置 | 未配置 Access |
| `accessState.unknown` | （无，被并进「未配置」） | Access 无法检测 |
| `accessState.dashboardCovered` | （无，被并进「未配置」） | Access 由控制台管理 |
| `accessState.notEnforced` | Access 已配置但未强制 | Access 未强制校验 |
| `external.noHostname` | 该隧道的配置里没有指向本机 tmex 的主机名，无法接管。 | 这条隧道的配置里没有指向本机 tmex（127.0.0.1:{{port}}）的主机名，因此无法接管。请检查它的 ingress 配置，或让 tmex 另建一条隧道。（新增 `{{port}}` 插值，取 `config.originPort`） |
| `external.adoptHint` | （无） | 接管后，tmex 把该主机名记为自己的公网地址，并在这里显示隧道状态与访问控制。隧道进程仍由系统服务运行——tmex 不会启动、停止或改写它的配置。随时可以取消接管，系统服务不受影响。 |
| `access.app.title` | Access 应用 | Access 应用（由 tmex 托管）——与只读探测在措辞上彻底分开 |
| `steps.named.login.description` | 在打开的授权页面中选择域名并授权，完成后回到本页。 | 在弹出的 Cloudflare 页面里选择要授权的域名，完成后回到本页，tmex 会自动继续。（呼应 BK 的登录修复：cert 落默认路径也能被接上） |
| `jobStep.*` | 下载 / 解压 / 校验… | 正在下载 / 正在解压 / 正在校验…（进度行统一成进行时） |
| `state.error` | 错误 | 异常 |

新增三态文案（zh_CN）：

- `access.probe.unknown`：无法检测 {{hostname}} 的 Cloudflare Access 状态：当前没有可用的 Cloudflare 凭证，或查询 API 失败。**这不代表未配置。**保存下方的 API 令牌与账户 ID 后会自动重新检测。
- `access.probe.covered`：只读检测：Cloudflare 控制台上已有一个 Access 应用覆盖 {{hostname}}。该应用**不由 tmex 管理**，网关也不会校验它签发的令牌；点「从 Cloudflare 同步」可以把它接入 tmex。
- `access.probe.absent`：只读检测：Cloudflare 上没有覆盖 {{hostname}} 的 Access 应用。在下方填写允许访问的用户并应用，即可创建一个。
- `external.accessValue.{covered,absent,unknown}`：已有应用覆盖该主机名（控制台）/ 未检测到覆盖该主机名的应用 / 无法检测（缺少可用凭证）。

en_US 按地道英文重写（不是直译），例如 `exposure.warning`：「Nothing is protecting this machine right now: the tunnel URL is a public entrance, and anyone who has it can use tmex.」；`errors.auth_required`：「Sign-in isn't enabled on this machine. Enable it before going public, or anyone could walk straight into tmex.」。ja_JP 同理（「読み取り専用の検出結果：…」「未設定という意味ではありません。」）。

## 文件

- `apps/fe/src/pages/settings/remote-access/access-model.ts`（+`ExternalAccessState` / `externalAccessState`）
- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts`（`AccessPill` 6 态 + `hasCoverableHostname`）
- `apps/fe/src/pages/settings/remote-access/status-card.tsx`（只加 variant 表两项，函数体未动）
- `apps/fe/src/pages/settings/remote-access/access-step.tsx`（+`ExternalAccessNotice`）
- `apps/fe/src/pages/settings/remote-access/external-card.tsx`（抽 `ExternalDetails`、+Access 行、+接管说明）
- `apps/fe/src/pages/settings/remote-access/tunnel-model.test.ts`、`remote-access-tab.test.tsx`（+9 用例）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`

未碰：`resources.ts` / `types.ts`、`scripts/complexity/allowlist.json`、gateway、panels。

## 验证

| 项 | 基线 | 本次 |
|---|---|---|
| `apps/fe bun test src/` | 917 pass / 0 fail | **926 pass / 0 fail**（+9 新用例） |
| `apps/fe bunx tsc --noEmit -p .` | 0 | **0** |
| `packages/shared bun test` | 392 / 0 | **392 pass / 0 fail** |
| biome（全部改动文件，含三个 locale JSON） | — | 通过 |
| `bun scripts/complexity/gate.ts` | — | 我方文件 0 违规、0 stale；**仍有一条既存违规见下** |

新增用例：`accessPill` 的 covered / unknown（含字段缺失）/ absent / 托管优先；页面级四态渲染（徽标 + 提示 testid）、未存凭证时的补充说明、接管卡的 Access 行与接管说明。

## 需要注意

**复杂度门禁当前不通过，但不是本次改动引入的**：`apps/gateway/src/tunnel/manager.ts: 1189 lines > 1186`。该文件属于 BK 的改动且已提交（不在我的工作区 diff 里），allowlist 锁的是 1186 行。按任务约定我没有改 `scripts/complexity/allowlist.json`——需要 BK 或 commander 决定是收行数还是抬锁值。除这一条外，gate 无其它违规、无 stale 条目。

其余提示：

- 新增的 14 个 i18n key 在 `bun run build:i18n` 重新生成 `resources.ts` 之前，运行时会退化成 key 原文；页面测试断言的就是 key 名，因此不受影响。
- `external.noHostname` 现在需要 `{{port}}` 插值，调用点已传 `status.config.originPort`；若将来有别的调用点复用该 key，别忘了带上。
- 只读探测**不参与** `exposureProtected` / `wouldDropLastProtection` 的判断——控制台上有应用不等于 tmex 能验证它，暴露风险仍以后端下发的 `exposureProtected` 为准。
