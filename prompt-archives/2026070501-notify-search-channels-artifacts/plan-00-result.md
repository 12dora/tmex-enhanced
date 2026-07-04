# Plan 00 执行结果

分支 `feat/channels-and-artifacts`（worktree `.worktrees/channels-artifacts`，base `4994805`），三个独立 commit，未 push。

## Commits

1. `feat(events): pluggable notification channels with per-channel disable`
   - EventNotifier 改 Map 注册制，构造时注册内建 webhook/telegram/weixin；`registerChannel()` 重复 id 抛错。
   - site_settings 新增 `disabled_notification_channels`（json string[]，default []，迁移 0015）；notify() 广播前过滤禁用 id。
   - REST GET/PATCH `/api/settings/site` 携带该字段；校验宽松（string[]，trim 去空去重，不绑定已注册 id 集合）。
   - shared `SiteSettings`/`UpdateSiteSettingsRequest` 同步；fe `stores/site.ts` 默认对象与 `site-theme.test.ts` fixture 补字段。
   - **附带修复（进入本 commit）**：`drizzle/meta` 快照链在 main 上已断裂——0013 与 0014 都指向 0012 为 parent，且 0014 快照缺 0013 引入的 `allow_control_chars` 列，`drizzle-kit generate` 直接报 collision 无法生成任何新迁移。修复：0014 快照 prevId 指向 0013、并把缺失列并入，随后正常 generate 出 0015。
2. `feat(agent): pluggable web search providers`
   - `web.ts`：`SearchProvider` 接口（id/label/isConfigured(settings)/search(query, settings, deps?)）+ 模块级插入序 registry；内建 tavily/brave 改 provider 对象注册；`registerSearchProvider()`（重复 id 抛错）/`getSearchProviders()`/`getSearchProvider()` 导出；`createWebSearchTool` 从 registry 查找（保留 fetchImpl/tavilyEndpoint/braveEndpoint 注入，新增通用 `endpointOverrides`）。
   - DB：去掉 `agent_settings_search_provider_check`，迁移 0016 重建表保数据。**手工修正**：drizzle-kit 生成的 CHECK 带 `__new_agent_settings.` 表名限定，RENAME 后 SQLite 报 `no such column`，已改为不限定列引用（`CHECK("id" = 1)`），迁移在内存库实测通过。
   - API：白名单 registry 驱动（'none' + 已注册 id）；GET `/api/llm/settings` 新增顶层 `searchProviders`（id/label/isConfigured）。
   - FE：`search-tab.tsx` 选项由 API 数据驱动（'none' 固定首位 + searchProviders；label 取 API，回退 id），UI 行为与 testid 不变。
   - shared：`AgentSearchProvider` 放宽为 `'none' | 'tavily' | 'brave' | (string & {})`；新增 `SearchProviderInfoDto`。
   - **边界（记录在案）**：外部 provider 的 API key 存储本轮不扩展——registry provider 拿完整 AgentSettingsRecord 自行取凭证，内建两列 `tavilyApiKeyEnc`/`braveApiKeyEnc` 保持不动；自定义 provider 需自带凭证来源。
3. `build: standalone build artifacts target`
   - `packages/app/scripts/build-artifacts.ts` + `build:artifacts` script（包内 + 根转发 `bun packages/app/scripts/build-artifacts.ts`，避免 `--filter` 传参问题）。
   - `--outdir` 必填：runtime/（server.js + assets/ghostty-vt.wasm + ssh native assets）、fe-dist/、gateway-drizzle/、manifest.json（version 与 build-runtime 同源自 packages/app/package.json，builtAt，files 相对路径+sha256）。直接 spawn `bundle-resources.sh` 与 `build-runtime.ts` 复用逻辑。
   - `--smoke`：NODE_ENV=production 契约，随机高位端口（20000–59999，显式排除 9663/9883/19663/19883，最多 3 次尝试）、mktemp 临时 DATABASE_URL、随机生成 base64 master key、FE_DIST/MIGRATIONS 指向产物，poll `/healthz` 200 后 kill。
   - manifest 组装为纯函数 `src/lib/artifacts-manifest.ts`，含单测（已知 sha256 向量、排序稳定性）。

## 测试摘要

- apps/gateway `bun test`：800 pass / 0 fail（73 文件，含新增 events registry 5 例、web registry 5 例、llm api 2 例）。
- packages/shared：88 pass / 0 fail。
- packages/app `bun test src`：72 pass / 0 fail（含 artifacts-manifest 4 例）。
- apps/fe：`tsc` 通过（该包无单测，test=e2e，未跑）。
- packages/ghostty-terminal：3 fail / 1 error——main 上同样失败（wasm 相关既有问题），与本任务无关。

## build:artifacts 冒烟输出（实跑）

```
OUTDIR=/tmp/tmex-artifacts.Gf2TYg （mktemp -d）
[build:artifacts] bundling fe dist + gateway drizzle → [tmex build] resources bundled
[build:artifacts] building runtime bundle → server.js 4.35 MB（TMEX_MONOREPO_VERSION="0.16.5" 注入）
[build:artifacts] wrote 175 entries to manifest.json
[build:artifacts] smoke attempt 1: 127.0.0.1:58237
[build:artifacts] smoke ok: GET /healthz -> 200 (port 58237)
[build:artifacts] done
manifest.json: version=0.16.5, files=175
产物树：runtime/{server.js,assets/ghostty-vt.wasm,*.node} fe-dist/ gateway-drizzle/ manifest.json
```

## 既有技术债（未动，非本任务范围）

- `apps/gateway/src/api/index.ts` 约 453 行（main 行号）`defaultWorkingDir` 一行超宽，biome format 在 main 上即报；未改以免与并行分支冲突。
- `web.test.ts` 8 处既有 lint 告警（noDelete/noNonNullAssertion），与 main 持平，新增代码零告警。
- `updateSiteSettings` 的 UPDATE set 子句缺 `sshReconnectMaxRetries`/`sshReconnectDelaySeconds`/`language` 持久化（缓存里生效、DB 不落盘），疑似既有 bug，未动。

## 未尽事项

无。
