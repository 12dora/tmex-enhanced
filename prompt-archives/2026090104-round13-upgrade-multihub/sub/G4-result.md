# G4 result — remote upgrade via staged package

## 做了什么

入口节点下载并校验 GitHub Release tarball，经 peer link 把包 `PUT` 到目标；目标从暂存文件升级。旧目标（`GET /api/system/info` 无 `upgradeCapabilities` 或不含 `staged-package`）仍走原路径：入口转发 `POST /api/system/upgrade {version}`，目标自己下载。

## 契约 / 新端点

`packages/shared/src/contracts/system.ts`：

- `SystemInfo.upgradeCapabilities?: string[]`（旧节点无此字段，向后兼容）
- `StartUpgradeRequest.source?: 'release' | 'staged'`（缺省 `'release'`）
- `StartUpgradeRequest.sha256?: string`（`staged` 时可选）
- `StagedUpgradePackageResponse`：`{ version, sha256, bytes }`

目标侧：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/system/info` | 增加 `upgradeCapabilities: ['staged-package']`（其余字段不变） |
| PUT | `/api/system/upgrade/package?version=<semver>&sha256=<64 hex>` | raw tarball（`application/octet-stream`），上限 256 MiB |
| POST | `/api/system/upgrade` | 可选 `{ source: 'staged', sha256 }`，跳过下载，从暂存包解压并 spawn |

PUT 错误：`403`（`canSelfUpdate=false`）、`400`（参数）、`409 { code: 'UPGRADE_IN_PROGRESS' }`、`413 { code: 'PACKAGE_TOO_LARGE' }`、`400 { code: 'PACKAGE_SHA256_MISMATCH' }`。  
POST `source=staged` 且暂存无效：`409 { code: 'PACKAGE_NOT_STAGED' }`。

暂存布局（与现有 `installDir/staging/<txnId>` 同根）：

- `<installDir>/staging/staged/tmex-cli-<v>.tgz` + `.json` sidecar
- 内存 map + sidecar，重启可恢复；超过 24h 过期；最多保留 2 份

入口侧：

- `release-download.ts`：下载 + SHA256SUMS 校验 + 磁盘缓存 `<stageRoot>/release-cache/`（或 `TMEX_RELEASE_CACHE_DIR`）+ 同版本 in-flight promise
- `remote-upgrade-job.ts`：每 node 一个 job。`startRemoteMeshUpgrade` 在目标声明 `staged-package` 后立刻 `200 { state:'downloading', ... }`，后台：download → PUT raw body → POST `{ source:'staged', sha256 }`。失败文案带步骤（`download` / `push` / `start`）和上游 status/code。
- `GET` 状态：running → `downloading`；failed（保留至下次 start 或 10 min）→ `idle` + `error`；handed-off → 删 job，转发 `GET /api/system/upgrade`

Forwarder：`forwardAuthorizedHttp` input 增加可选 `rawBody` / `headers` / `query`（`rawBody` 优先于 JSON `body`）。未改 `mesh-routes.ts`；可选字段运行时透传。

## 环境变量

| 变量 | 缺省 | 用途 |
|---|---|---|
| `TMEX_RELEASE_BASE_URL` | `https://github.com/12dora/tmex-enhanced` | 覆盖 tarball / SHA256SUMS 根。路径布局保持 `/releases/download/v<ver>/tmex-cli-<ver>.tgz` 与 `.../SHA256SUMS` |
| `TMEX_RELEASE_CACHE_DIR` | `<installDir>/staging/release-cache`，无 installDir 时为 `$TMPDIR/tmex-release-cache` | 入口下载缓存目录 |

最新版本查询仍走 GitHub Releases API（`requireLatestUpgradeRelease`），本任务未改。

## 指挥官双临时实例实测

**禁止**碰生产（`~/Library/Application Support/tmex/`、端口 9883、tmux session `tmex`）。

推荐：入口能访问 GitHub（或本地静态站），目标假装不能。两个仓库内实例、独立端口、独立 db、独立 `TMEX_INSTALL_DIR`。

```bash
# 目标（被升级节点）— 需 canSelfUpdate=true，所以用 production + 假 CLI 安装目录
mkdir -p /tmp/tmex-g4-target/{current/runtime,resources/fe-dist,staging}
printf '%s\n' '{"cliVersion":"1.0.0","serviceName":"tmex-g4-target","platform":"darwin","serviceMode":"none","installDir":"/tmp/tmex-g4-target"}' \
  > /tmp/tmex-g4-target/install-meta.json
# 入口同理，installDir=/tmp/tmex-g4-entry

# 每边显式覆盖端口，避开生产 9663/9883 与主仓 dev 19663/19883
NODE_ENV=production \
  GATEWAY_PORT=19101 FE_PORT=19102 \
  TMEX_BIND_HOST=127.0.0.1 \
  TMEX_INSTALL_DIR=/tmp/tmex-g4-target \
  TMEX_FE_DIST_DIR=/tmp/tmex-g4-target/resources/fe-dist \
  DATABASE_URL=/tmp/tmex-g4-target/tmex.db \
  bun run --cwd apps/gateway src/index.ts
```

入口再换一套端口（如 19201/19202）和 `TMEX_INSTALL_DIR=/tmp/tmex-g4-entry`。

**假 release（可选）**：本地静态站按 GitHub 布局提供包。

```bash
# 目录：./fake-rel/releases/download/v9.9.9/{tmex-cli-9.9.9.tgz,SHA256SUMS}
# SHA256SUMS 一行：<64hex>  tmex-cli-9.9.9.tgz
python3 -m http.server 19991 --directory ./fake-rel
```

入口：`TMEX_RELEASE_BASE_URL=http://127.0.0.1:19991`。  
注意：`POST /api/mesh/nodes/:id/upgrade` 的目标版本仍来自 GitHub `releases/latest`；本地包的 version 必须等于 API 返回的 latest，或先把 latest 指到你要推的 tag。只测「推包」也可对目标直接：

```
PUT /api/system/upgrade/package?version=9.9.9&sha256=<hex>  (octet-stream body)
POST /api/system/upgrade  {"version":"9.9.9","source":"staged","sha256":"<hex>"}
```

Mesh 路径：入口登录目标节点后 `POST /api/mesh/nodes/<targetId>/upgrade`，应立刻 `200 downloading`，随后 `GET` 同一 URL 先 overlay downloading，handoff 后转发目标的 `executing`。

## 测试 / tsc / biome

G4 相关 7 个文件：**177 pass / 0 fail**（含新测约 33 条：PUT 成功/sha 错/413/in-progress、POST staged 成功/未暂存、job 成功且两节点下一次、download/push 失败、handoff 后 status 转发、legacy 目标不变、forwarder raw body + 3 MiB in-memory link）。

- `cd apps/gateway && bunx tsc --noEmit -p .` → **0 errors**
- `cd packages/shared && bun test && bunx tsc --noEmit -p .` → **409 pass / 0 fail**，tsc 0
- biome check（G4 14 个文件）→ 干净
- 全量 `cd apps/gateway && bun test`：3196 pass / **1 fail**（`UplinkServer multi-hub > 同等 epoch 的另一个 active...`，属 G3 `hub/uplink-server.test.ts`，非本任务文件）。基线 3134；总数上升来自并发 agent 加测。

## 指挥官需要知道的缺口

1. **未改** `apps/gateway/src/system/info-public.ts`（非本任务文件）。`upgradeCapabilities` 加在 `handleSystemApiRequest` 的 GET `/api/system/info` 响应上；`getSystemInfo()` 本身没有该字段（类型上为 optional）。
2. **未改** `apps/gateway/src/api/system-managed.ts`。managed build 下 `PUT /api/system/upgrade/package` 会 404 而非 403。若要 managed 面拒绝该路由，请在该文件把 `/api/system/upgrade/package` 与 upgrade 一并 403。
3. 未改 `mesh-routes.ts` / `mesh-runtime.ts` / `apps/fe/**` / `packages/app/**`。

## 风险

- 大包（~20–30 MiB）走 1 MiB window / 1 MiB frame 的 link 流控；已用 3 MiB in-memory 测通。relay 路径带宽仍紧，入口侧同版本下载只发生一次。
- Job 使用 detached Request（只拷 cookie/origin），避免入口 HTTP 返回后 `req.signal` abort 把后台 PUT 掐掉。
- 混合版本：无 capability 的旧目标行为与改前一致。
