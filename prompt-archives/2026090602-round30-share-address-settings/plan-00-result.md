# Round 30 执行结果

分支 `feat/round30-share-address-settings`，worktree `/Users/konata/code/tmex-r30`。版本 1.1.35。

## 交付
| 任务 | 结果 | 提交 |
|---|---|---|
| T1 分享地址 | 中继上联时产出「中继 · <relay>/n/<self>」候选（`RelayEntryProbe` 探测中继主机可转发，ok 10 min / bad 2 min，启动后 10 s 预热 + attach 变化作废重探）；前缀与探测状态解耦；site_url 等于隧道或被 Hub 托管时不当作自建域名；custom 匹配中继主机继承前缀；候选带 `accessUrl` | b428b6b0、e9987971、cf8cec2d |
| T2 站点访问 URL | `siteUrlManaged` 与 `linked` 拆分：仅 Hub 角色或 hub 上联托管；中继上联可编辑，非公网存储值回落到中继入口；`/api/settings/site` 返回 `siteAccessOrigins`；通用设置显示「可用地址」列表（填入/复制）；分享地址标签带种类 | 80463fd3、87b06c8c |
| T3 分享设置一行 | `sm:grid-cols-2 lg:grid-cols-3` | 0eab323f |
| T4 AI 默认模型 | `LlmModelSelect` 分组选择器（默认模型 + watch 规则）；删 provider 清默认模型；`llm-defaults-state` 过门禁；键迁 `common.llmModel.*` | 3062e2ae、8fab335e |
| T5 升级缓存 | 真因：网络层早已按版本缓存单飞，问题是缓存从不清理（本机积 10 版 ≈220 MB）、在途 .part 被误删、每任务重复整包哈希、每次 start 打 GitHub。新增 `sweepReleaseCache`（启动清空、每次升级前只保留 latest、租约保护在途/推送中的版本、清扫前复核对侧文件）、校验记忆（size/mtime/ino/ctime）、latest 查询 60 s 缓存 | b9f74329、9181dc32 |
| T5 应用内弹窗 | 升级确认（异步 confirm 端口 + 确认后复核运行态）、移除节点带原因对话框；全应用无浏览器 confirm/prompt | 37db8833、7f09e92f |
| T6 通知多节点 | 审计结论：按节点各自通知、无汇聚（`sub/EX6`）。与用户拍板 A 汇聚 + C 加固，转 round31（`prompt-archives/2026090603-round31-mesh-notifications/`） | — |

## 审查
codex gpt-6-astra high 三片（`sub/R1-*`）：前端 3 条（批量确认复核、watch 清模型保留 provider、移除对话框限高）+ 测试隔离；分享后端 3 条（前缀与探测解耦、中继上联回环站点 URL 兜底、预热时机）；升级缓存 3 条（版本租约、快照复核、记忆键身份）。全部修复（RF1–RF3）。

## 验证
- tsc 四包 0；fe 单测 2618/0；panels 1023/0；shared/app 全绿；gateway 4833/8（mesh phase-2 integration 环境性）；根 lint + 复杂度门禁通过。
- 定向 e2e：settings-llm / settings / watch / mobile-settings / mobile-agent-watch 8/8；mesh 项目（重建 FE）14/14 含 mesh-share 两条。
- 实测：`https://tmexhub-sh.jiefakj.com/n/<本机id>/api/auth/mode` 返回本机 nodeId，确认 `relay,node` 主机可作分享入口。

## 踩坑
- 全局设 `TMEX_TMUX_SOCKET` 跑 gateway 单测会多出 47 个失败（LocalExternalTmuxConnection 等），基线要不带该变量。
- `llm-model-select` 被 watch 表单静态引用后，其 i18n 键必须在 core 包（core-coverage 单测）。
- `FilePage.test.tsx` 全局 mock `react-i18next`，跨包合跑时其它渲染测试不能断言原始 key。
- 60 s latest-release 缓存会泄漏到 mesh-routes 测试，需 `resetLatestReleaseCache()`。
