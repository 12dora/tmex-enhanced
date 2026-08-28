# messaging-routes 结果

## 改了什么

1. **JSON body 校验**：Telegram / Weixin 的 POST、PATCH 以及 Webhook 的 POST 不再直接 `await req.json()` 后当对象用。改为 `readJsonObjectBody()`；非对象（`null`、数组、非法 JSON）返回 `{ error }` 400（`apiError.invalidRequest`）。字符串字段 `typeof === 'string'` 后再 trim；boolean / `eventMask` 用现有 `config-field` 解析器。
2. **文件拆分**：实现迁到 `telegram-routes.ts`、`weixin-routes.ts`、`webhook-routes.ts`。`messaging-routes.ts` 只 re-export `telegramRoutes` / `weixinRoutes` / `webhookRoutes`，`api/index.ts` 与现有测试的 import 路径不变。路由 path / method / 成功响应保持原样。

## 文件

- `apps/gateway/src/api/messaging-routes.ts`（仅聚合导出）
- `apps/gateway/src/api/telegram-routes.ts`（新建）
- `apps/gateway/src/api/weixin-routes.ts`（新建）
- `apps/gateway/src/api/webhook-routes.ts`（新建）
- `apps/gateway/src/api/messaging-routes.test.ts`（新建：telegram POST/PATCH、webhook POST 的 null / 错类型）
- `apps/gateway/src/api/weixin.test.ts`（补 POST/PATCH 的 null / 错类型；`req()` 改为 `body !== undefined` 才能发出 `null`）

未改：`api/http.ts`、`api/index.ts`、`api/files.ts`、`api/agent.ts`。

## 修的 bug

`null` 或 `{ name: 42 }` 原先在 `body.name?.trim()` / `body.url` 上抛 TypeError（未捕获 → 500）；webhook `{ url: 42, secret: 's' }` 因 `42` 为 truthy 还会 201 入库。现在一律 400 + 现有 error envelope。

回归测试先红后绿：TypeError / 201 → 400。

错误码约定（与 llm 路由一致）：

- 非对象 body → `apiError.invalidRequest`
- name/token/url/secret 非字符串或 trim 后为空 → 原业务 required 文案
- boolean / `eventMask` 类型错误 → `apiError.invalidRequest`

## 测试 / tsc

- `bunx biome check --write`：上述 6 个文件通过
- `bun test src/api/messaging-routes.test.ts src/api/weixin.test.ts src/api/index.routing.test.ts`：17 pass / 0 fail
- `bun test`（整个 gateway）：**1501 pass / 0 fail**（基线 1473；本任务新增约 9 条，其余增量来自并行 agent）
- `bunx tsc --noEmit -p .`：**27 errors**，与基线一致，均不在本次文件

## 没做的 / 原因

- 路由表是 **PATCH** 不是 PUT，测试覆盖 POST + PATCH；没有 PUT handler。
- `eventMask` 只校验「字符串数组」，不收紧为 `EventType` 枚举，避免拒绝以前能存进去的未知事件名。
- webhook `url`/`secret` 现在会 trim（空白串变为 400）。这是任务要求的字段类型校验，不是额外格式校验（未做 URL 语法检查）。
