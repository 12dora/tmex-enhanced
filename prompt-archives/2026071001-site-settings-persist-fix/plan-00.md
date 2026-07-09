# updateSiteSettings 落库缺列修复

## 背景

`apps/gateway/src/db/index.ts` 的 `updateSiteSettings`：`next` 对象把全部字段
算好（含 `language` 归一化、`updatedAt` 时间戳），但 drizzle `.set()` 只写了
10 列，漏了 `sshReconnectMaxRetries`、`sshReconnectDelaySeconds`、`language`、
`updatedAt`（schema 中真实存在：`schema.ts:38-40,46`）。

隐蔽性：写完 DB 后用完整 `next` 重置了 30s 内存缓存，响应体与缓存期内的
GET 都返回新值；`i18next.changeLanguage(next.language)` 也被调用（内存里语言
已切换）。只有缓存过期后的回读或进程重启才暴露回退。

注意与 api 层 `normalizeSiteSettingsInput`（`api/index.ts`）区分：那里没有
theme 分支是设计如此（theme 走 `POST /api/settings/theme`），不属本修复。

## 修复

`.set()` 补齐 4 列。缓存逻辑不动。

## 测试

`apps/gateway/src/db/site-settings-persist.test.ts` 新建，仿
`api/theme.test.ts` 的 `migrate + ensureSiteSettingsInitialized` 范式：
改 `language` / `sshReconnect*` → 强制缓存失效（把 `siteSettingsCache`
过期或直接查库）→ 断言 DB 行落了新值且 `updated_at` 被推进。

## 验收

- 新测试红→绿（先跑旧实现确认红，再修复确认绿）；
- `bun test apps/gateway/src/db` 全绿；
- 现有 theme / events / ws 相关测试不受影响。
