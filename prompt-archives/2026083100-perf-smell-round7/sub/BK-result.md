# BK 结果：remote-access（Cloudflare Tunnel/Access）探测与登录修复

## Claim 核实（改代码前对照源码）

三条用户可见 bug 的根因均成立，未发现需要否决修复的证据。

1. **Token 隧道被报「没有指向本机的主机名，无法接管」（成立）**
   - `parseIngressFromLog` 用 `"ingress"\s*:\s*(\[[^\]]*\])` 匹配**未转义** JSON。真实 token-tunnel 日志把 ingress 嵌在 `config` 字段的转义字符串里（`"config":"{\"ingress\":...}"`），正则永不命中。
   - `enrichCandidate` 会读 token 旁的 `tunnel-id`，**不读** sibling `hostname`。G8 报告写过「token 旁 hostname」，但当时测试明确写成「无 origin ingress 证据则忽略 sibling hostname」。本机 `~/Library/Application Support/tmex-cloudflared/hostname` 是旧版 tmex 托管布局（与 `token` / `tunnel-id` 同目录）；当前 manager 建 named 隧道写的是 `config.yml`，不再写该文件，语义仍是「此 hostname 指向本机 origin」。
   - `resolveHostnames` 的 API 路径只走 `getCredentials()`，manager 里原先只读 `accessStore`（本机 `tunnel_access` 0 行 → 永远 null）。`~/.cloudflared/cert.pem` 的 ARGO TUNNEL TOKEN 未被使用。

2. **应用内登录 Cloudflare 浏览器成功后报 process_failed（成立）**
   - `spawnLogin` 传 `--origincert <tunnelDir>/cert.pem` + `TUNNEL_ORIGIN_CERT`，但实测 `cloudflared tunnel login` 仍写默认 `~/.cloudflared/cert.pem`。
   - `jobLogin` 只 poll `originCertPath(this.tunnelDir)`；进程 exit 0 且 tunnelDir 无 cert 时抛 `process_failed: cloudflared login exited with code 0`。

3. **Access 已在 CF dashboard 配好，页面显示未配置（成立）**
   - `accessStatus()` 只读 DB。`access.configured` 需要本地 `appId/aud/hostname`。外部配置不会写入这些字段。

`adoptExternal`（manager ~1107）：只要求 `lastExternal.hostnames` 含目标主机名，**不依赖 config.yml**。token-mode 只要探测补上 hostname 即可接管，无需改 adopt 逻辑。

## 改动

### Bug 1：探测到 hostname

- `parseIngressFromLog`：尾部优先扫描，只看最后 256KB。含 `ingress` 的行先 `JSON.parse` 外层再 `JSON.parse(config)`（转义形式），失败再走原来的 raw `"ingress":[...]` 正则。
- sibling `hostname`：RFC 1123 校验通过则视为指向 origin（yml → API → 日志 都空时使用）。非法内容仍忽略。
- `detectionCredentials()`：`accessStore` 有 token+accountId 则用库；否则只读解析 `~/.cloudflared/cert.pem` 的 `BEGIN ARGO TUNNEL TOKEN`（`accountID`/`apiToken`/`zoneID`）。**不落库、不用于 create/update/delete**。API 403 已有 catch，回落到日志解析。
- 隧道 API 的 `accountId` 仍优先 token 文件里的 `a`（隧道所属账号），凭证只提供 `apiToken`。

### Bug 2：默认路径 cert

- 新模块 `origin-cert.ts`：`ensureManagedOriginCert` 在 tunnelDir 无 cert、默认路径有 cert 时 **copy + chmod 0600**，永不删用户默认 cert。
- `jobLogin` 轮询两条路径；进程 exit 0 后再尝试 copy。已存在默认 cert 时 login job 直接 `wait_cert`。
- `requireLogin` 同样 copy-on-detect（create 等动作可用）。
- `status().auth.loggedIn`：任一路径存在即为 true（getter 无副作用）。
- `TunnelManagerOptions.homeDir` 可注入；测试必须隔离，否则会读到本机真实 `~/.cloudflared/cert.pem`。

### Bug 3：外部 Access 只读探测

- 共享类型（additive、字段可选以保持旧夹具兼容）：

```ts
external.externalAccess?: {
  checked: boolean;       // false = 无法检测（无凭证或 API 失败）
  hostnameMatch: boolean; // 是否有 app.domain 匹配探测/已配置主机名
  appId: string | null;
  aud: string | null;
  teamDomain: string | null;
}
```

- 网关始终下发该对象（`toExternalStatus` 填默认「无法检测」）。
- 走 `listApps`（可选 `getOrganization` 取 teamDomain）。失败只 `warn`，`checked: false`，不抛。
- 与现有 30s 外部探测缓存一起缓存。
- **不写** `access.configured` / 本地 access 库——那是 JWT 强制校验的真相；外部探测只是只读观察。

### adopt

token-mode（escaped log + sibling hostname）的 `adopt_external` 测试已通过。adopt 本身未改。

### 复杂度

从 manager 抽出 `named-config.ts`（`writeNamedConfigYml`），`manager.ts` 1184 行（allowlist 1186，未改 allowlist）。`enrichCandidate` CC 25→19（降低，未改 allowlist）。`detectUncached` 拆成 `collectCandidates` / `attachAccessProbe` 以免超过 CC 15。

## 设计取舍

- sibling hostname 当作 origin-pointing：任务指定 tmex 自有约定；用 `normalizeTunnelHostname` 挡垃圾内容。
- Access 新字段放在 `external.externalAccess` 而不是改 `access.configured`，避免 JWT 门控把「仪表盘上有个 app」当成已托管配置。
- `listApps` 必须作为方法调用（保留 `this`），不能抽成裸函数——否则打到真 `CloudflareAccessClient` 会 `this.requestEnvelope` 崩。
- 凭证链：`externalDetectDeps.getCredentials` 仍可覆盖；默认 `accessStore → cert.pem`。

## 风险

- 他人在 token 旁放一个合法 hostname 文件会被当成指向本机（仅 tmex 布局约定；比完全探测不到更好）。
- 超大日志且最新 `Updated to new configuration` 不在最后 256KB 时可能漏检（token 隧道持续写最新配置，实际风险低）。
- ARGO token 的 Access 权限不足时 `listApps` 403 → `checked: false`（「无法检测」），不会误报未配置，但也不能显示「已在 dashboard 配置」。用户仍可用 `set_access_credentials` 提供 Access:Apps token。
- `loggedIn` 现在会把默认路径 cert 算进去；测试必须注入 `homeDir`。已改 `manager.test.ts` 与 `tunnel-routes.test.ts`。

## 前端文案（不改 i18n；后续 FE agent）

`access.configured` 仍表示**本机已托管**的 Access。外部配置请读 `external.externalAccess`：

| 状态 | 建议文案方向 |
|---|---|
| `checked === false` | 「无法检测 Cloudflare Access（缺少可用凭证）」——必须能和「未配置」区分 |
| `checked && hostnameMatch` | 「Cloudflare Access 已覆盖此主机名」（只读，来自 dashboard；未写入本机策略） |
| `checked && !hostnameMatch` | 「未检测到匹配当前主机名的 Access 应用」 |

可选展示 `teamDomain`（有则显示）。接管后若要用 JWT 强制校验，仍需走现有 `set_access_credentials` / `sync_access` / `configure_access`。

## 测试

| 套件 | 基线 | 本次 |
|---|---|---|
| `apps/gateway && bun test` | 2861 pass / 0 fail | **2880 pass / 0 fail** |
| `apps/gateway bunx tsc --noEmit -p .` | 21 个既有错误 | **21**（无 tunnel 文件；未新增） |
| `packages/shared && bun test` | 392 / 0 | **392 pass / 0 fail** |
| `packages/shared tsc` | 0 | **0** |
| biome（全部改动文件） | — | 通过 |

新增/扩展：escaped log 解析、sibling hostname、cert.pem ARGO 解析与 copy、凭证顺序、login 默认路径、Access 四态（无凭证 / 匹配 / 不匹配 / API 错）、token-mode adopt、routes 契约含 `externalAccess`。

## 文件

- `packages/shared/src/contracts/tunnel.ts`
- `apps/gateway/src/tunnel/external-detect.ts` + `.test.ts`
- `apps/gateway/src/tunnel/origin-cert.ts` + `.test.ts`（新）
- `apps/gateway/src/tunnel/named-config.ts`（从 manager 抽出）
- `apps/gateway/src/tunnel/manager.ts` + `.test.ts`
- `apps/gateway/src/api/tunnel-routes.test.ts`（隔离 `homeDir` + 契约断言）

未改：i18n、fe/panels、`tunnel-routes.ts`（`status()` 已经 `toExternalStatus` 带出新字段）。
