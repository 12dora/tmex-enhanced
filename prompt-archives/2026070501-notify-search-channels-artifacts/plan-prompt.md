# Prompt 存档

任务来源：上游三项改造需求（A3 / A4 / A8），在 worktree `feat/channels-and-artifacts` 内完成，三个独立中性 commit，不 push。

## 原始任务要点

安全红线：
- 严禁触碰本机生产 tmex（launchd、9883、`~/Library/Application Support/tmex/`）。
- 严禁触碰名为 `tmex` 的 tmux session；本任务原则上不需要 tmux 操作。
- 严禁 push 远端；只在本地分支 commit。

工作方式：
- worktree：`.worktrees/channels-artifacts`，分支 `feat/channels-and-artifacts`，基于 main。
- 另一个并行分支正在改 api/index.ts 路由表、api/llm.ts（设置写路径加广播调用）、config.ts、ws/。本任务不动 config.ts、ws/、api/index.ts 路由结构（A4 允许动 api/llm.ts 的 provider 校验逻辑）。
- commit message 中性开源语气。三项改造三个独立 commit。
- 测试 `bun test`；生成文件不 lint。

### A3：通知 channel 扩展点
1. EventNotifier 改注册制：构造时默认注册三个内建 channel；新增 `registerChannel(channel)`（重复 id 抛错或替换，二选一并写测试）；保留单例用法兼容。
2. channel 可由配置禁用：site_settings 新增 `disabledNotificationChannels`（JSON 字符串数组，默认 []；drizzle 迁移用 `bun run db:generate` 生成）。notify() 广播前过滤禁用 id。REST：normalizeSiteSettingsInput 接受该字段（string[] 校验，值宽松接受任意 string 并写明）；GET/PATCH /api/settings/site 自然携带。@tmex/shared SiteSettings 同步加字段。
3. 单测：注册新 channel 后 notify 能到达；禁用列表命中的 channel 不被调用；REST PATCH 写入禁用列表生效。

### A4：搜索 provider Channel 制
1. web.ts 重构：`SearchProvider` 接口 {id, label, isConfigured(settings), search(query, settings)}；内建 tavily/brave 实现该接口注册进模块级 registry（Map，插入序）；导出 `registerSearchProvider()`；createWebSearchTool 从 registry 按 settings.searchProvider 查找。
2. DB：searchProvider 列 CHECK 约束放宽为任意文本（迁移），'none' 语义保留。API：SEARCH_PROVIDERS 白名单改 registry 驱动（'none' + registry keys）；GET /api/llm/settings 返回可用 provider 列表（id/label/isConfigured）。前端硬编码的 provider 选项改为消费该列表（保持 UI 行为不变）。
3. api key 存储：保留 tavilyApiKeyEnc/braveApiKeyEnc 列；provider 接口拿完整 settings 自行取 key；外部 provider 的 key 存储本轮不扩展（记录边界）。
4. 单测：registry 注册/查找；createWebSearchTool 对自定义 provider 生效；'none' 与未配置行为不回归。

### A8：纯构建产物输出
1. packages/app 加 `build:artifacts`（scripts/build-artifacts.ts），根 package.json 转发。`--outdir <dir>` 必填：runtime bundle → `<outdir>/runtime/`（server.js + assets/ghostty-vt.wasm）；fe dist → `<outdir>/fe-dist/`；gateway drizzle → `<outdir>/gateway-drizzle/`；生成 `<outdir>/manifest.json`（version/builtAt/files 相对路径+sha256）。不含安装器/服务注册逻辑。复用 build-runtime.ts 与 bundle-resources.sh。
2. `--smoke` 可选参数：随机高位端口 + 临时 DATABASE_URL + 测试 master key + TMEX_BIND_HOST=127.0.0.1 + FE_DIST/MIGRATIONS 指向产物，起实例 curl /healthz 200 后杀掉。绝不碰 9883/9663。
3. 完整跑一次 `build:artifacts --outdir <mktemp -d> --smoke`，输出摘要写进 plan-00-result.md。manifest 生成逻辑抽纯函数带单测。

验收：三个独立中性 commit；相关包 bun test 全绿；biome 无告警（生成文件除外）；不升级依赖；drizzle 迁移按正规流程生成；plan 档案齐全。
