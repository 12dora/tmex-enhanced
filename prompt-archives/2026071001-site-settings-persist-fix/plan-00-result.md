# 实施结果

## 修复

`apps/gateway/src/db/index.ts` `updateSiteSettings` 的 `.set()` 补齐 4 列：
`sshReconnectMaxRetries`、`sshReconnectDelaySeconds`、`language`、`updatedAt`。
缓存逻辑未动。

## 验证

- 新建 `apps/gateway/src/db/site-settings-persist.test.ts`（3 例，断言直接查
  DB 行、绕开内存缓存）：修复前 0 pass / 3 fail（bug 实证），修复后 3 pass。
- 关联面回归：`bun test apps/gateway/src/db apps/gateway/src/api/theme.test.ts
  apps/gateway/src/ws/site-theme-update.test.ts` → 48 pass / 0 fail。

## 与计划的偏差

无。
