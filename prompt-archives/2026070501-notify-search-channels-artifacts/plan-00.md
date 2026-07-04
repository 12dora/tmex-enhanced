# Plan 00：通知 channel 注册制 / 搜索 provider registry / 纯构建产物目标

## 背景

三项彼此独立的机制性改造，均为「把硬编码扩展点改为注册制 + 提供纯产物构建目标」：

- 通知：`apps/gateway/src/events/index.ts` EventNotifier 目前把 webhook/telegram/weixin 三个 channel 硬编码在私有数组里，无法从外部注册新 channel，也无法按 channel 禁用。
- 搜索：`apps/gateway/src/agent/tools/web.ts` 的 tavily/brave 是两个硬编码函数，`createWebSearchTool` 用 if/else 分发；DB CHECK 与 API 白名单把 provider 集合钉死为 'none'|'tavily'|'brave'；前端 `search-tab.tsx` 也硬编码了选项数组。
- 构建：现有 `build` 目标产出面向 npm 安装器的包（resources/ + dist/），没有一个「纯运行产物」输出目标（runtime + fe-dist + drizzle + manifest）。

并行分支约束：不动 `config.ts`、`ws/`、`api/index.ts` 的路由结构（A3 只在 normalizeSiteSettingsInput 内加字段处理）；A4 允许改 `api/llm.ts` 校验逻辑。

## 关键决策（按最佳实践先行）

1. **registerChannel / registerSearchProvider 重复 id 一律抛错**（不静默替换）：扩展点的重复注册几乎总是编程错误，fail-fast 更安全；测试覆盖。
2. **disabledNotificationChannels 校验取宽松策略**：只要求 string[]（元素 trim 后非空、去重），不绑定「已注册 channel id」集合——外部 channel 的注册发生在运行时（进程内扩展点），设置写入时可能尚未注册；绑定已注册集合会造成先后次序耦合。
3. **`AgentSearchProvider` 类型放宽为 `'none' | 'tavily' | 'brave' | (string & {})`**：保留字面量补全，同时允许注册制的任意 provider id 通过类型检查。
4. **GET /api/llm/settings 响应新增顶层 `searchProviders` 数组**（`{id,label,isConfigured}`），'none' 不算 provider、由前端固定渲染在首位。
5. **build-artifacts.ts 直接 spawn 现有 `scripts/build-runtime.ts` 与 `scripts/bundle-resources.sh`**（不复制其逻辑），再从 `dist/runtime`、`resources/fe-dist`、`resources/gateway-drizzle` 拷入 outdir，避免漂移；manifest 版本号与 build-runtime 同源（`packages/app/package.json` 的 version）。
6. manifest 纯函数放 `packages/app/src/artifacts/manifest.ts`（`bun test src` 可发现其单测）。
7. 冒烟走 `NODE_ENV=production` 契约（loadEnv 生产分支只校验注入变量，不读仓库 env 文件）：随机高位端口（20000–59999，显式避开 9663/9883/19663/19883）、mktemp 临时 DATABASE_URL、test.env 公开 master key、TMEX_FE_DIST_DIR/TMEX_MIGRATIONS_DIR 指向产物目录。

## 任务清单

### A3 通知 channel 扩展点（commit 1）
- `packages/shared/src/index.ts`：SiteSettings、UpdateSiteSettingsRequest 加 `disabledNotificationChannels`。
- `apps/gateway/src/db/schema.ts`：site_settings 加 `disabled_notification_channels`（json，notNull，default []）。
- `bun run db:generate` 生成迁移 0015。
- `apps/gateway/src/db/index.ts`：toSiteSettings / ensureSiteSettingsInitialized / updateSiteSettings 带上新字段。
- `apps/gateway/src/events/index.ts`：channels 改 Map 注册制；`registerChannel()` 重复 id 抛错；notify() 前按禁用列表过滤。
- `apps/gateway/src/api/index.ts`：normalizeSiteSettingsInput 接受该字段（宽松校验）。
- 测试（events/index.test.ts）：注册可达、禁用过滤、重复 id 抛错、REST PATCH 生效。

### A4 搜索 provider Channel 制（commit 2）
- `apps/gateway/src/agent/tools/web.ts`：SearchProvider 接口 + 模块级 registry + `registerSearchProvider()`/`getSearchProviders()`；tavily/brave 改造成 provider 对象；createWebSearchTool 从 registry 查找（保留 fetchImpl/tavilyEndpoint/braveEndpoint 注入，新增通用 endpointOverrides）。
- `apps/gateway/src/db/schema.ts`：去掉 agent_settings_search_provider_check；`bun run db:generate` 生成迁移 0016（重建表）。
- `packages/shared/src/index.ts`：AgentSearchProvider 放宽；AgentLlmSettingsDto 响应侧新增 SearchProviderInfoDto 与 GetAgentLlmSettingsResponse.searchProviders。
- `apps/gateway/src/api/llm.ts`：白名单改 registry 驱动；GET settings 返回 searchProviders。
- `apps/fe/src/components/settings/search-tab.tsx`：选项列表消费 API 返回（'none' 固定 + searchProviders）。
- 测试：web.test.ts（registry、注册自定义 provider、none/未配置不回归）、llm.test.ts（GET 返回列表、PATCH 校验 registry 驱动）。
- 边界记录：外部 provider 的 key 存储本轮不扩展。

### A8 纯构建产物输出（commit 3）
- `packages/app/src/artifacts/manifest.ts` + `manifest.test.ts`：纯函数（sha256、manifest 组装）。
- `packages/app/scripts/build-artifacts.ts`：--outdir 必填、--smoke 可选；调 build-runtime / bundle-resources → 拷贝三块产物 → 写 manifest.json → 可选冒烟（起 server、poll /healthz、kill）。
- `packages/app/package.json` 加 `build:artifacts`；根 package.json 加转发。
- 用 `mktemp -d` 实跑一次 `--smoke`，摘要进 plan-00-result.md。

## 验收标准
- 三个独立中性 commit；`bun test` 相关包全绿；biome 对改动源码无告警；迁移文件由 drizzle-kit 生成；plan 档案齐全。

## 风险
- 0016 重建 agent_settings 表：drizzle-kit 生成的 recreate 语句需人工核对数据保留（INSERT INTO ... SELECT）。
- 前端 search-tab 改造需保持现有 e2e/测试选择器（data-testid）不变。
