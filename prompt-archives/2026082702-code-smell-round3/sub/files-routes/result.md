# files-routes 执行结果

## 改了什么

`apps/gateway/src/api/files.ts`（原 516 行）按域拆成四个模块，原文件只保留聚合路由表，`filesRoutes` 导出路径不变（`api/index.ts` 无需改动）。

| 文件 | 职责 |
| --- | --- |
| `api/file-root-routes.ts` | file-root CRUD |
| `api/file-browser-routes.ts` | list / content / stat / raw |
| `api/file-transfer-routes.ts` | 分块上传 + 下载 prepare/content/一次性下载 |
| `api/file-http.ts` | `codeError`、`parseNonNegativeSafeInt`、`attachmentHeaders`、`streamTempFile`、`ndjsonResponse` |
| `api/files.ts` | `filesRoutes = [...fileRootRoutes, ...fileBrowserRoutes, ...fileTransferRoutes]` |

流式语义保持原样：

- upload commit：`start` 不 await rsync；`finally` 里 `close()` + `removeUploadSession`；`cancel` 再清一次会话（idempotent）。
- download prepare：客户端断开走 `abort?.abort()`，由 `pullFileFromDevice` 内部清临时文件。
- `streamTempFile`：`done` / `error` / `cancel` / 打不开文件 四条路径都调用 `cleanupAfter`。

## Bug 修复

1. **upload chunk `offset` 解析过宽**  
   `Number.parseInt('12garbage', 10) === 12`，随后按 12 去对 `appendUploadChunk`（要求 offset 严格等于已收字节）。现改为 `Number()` + `Number.isSafeInteger()` 且非负；空串 / 缺失也拒绝（避免 `Number('') === 0`）。非法 → 400 `{ error: invalidRequest }`。

2. **JSON `null` / 非对象 body 解引用**  
   `handleCreateRoot` / `handleUploadInit`（以及顺手的 `handleUpdateRoot`、`handleDownloadPrepare`）改用 `readJsonObjectBody()`：`null`、数组、非对象、非法 JSON → 400（download prepare 仍走 NDJSON `{ type: 'error', code: 'invalid' }`，不改流式协议）。

## 回归测试（先红后绿）

`api/files.test.ts` 新增：

- `PUT .../upload/:id?offset=12garbage`：修复前 404（parseInt 成功后 session 不存在），修复后 400。
- `offset=12.5`：同因 parseInt 截断，修复前 404，修复后 400。
- 缺失 offset：仍 400（防止 `Number('')` 变成 0）。
- 合法 `offset=0` + 不存在 session：仍 404。
- `POST /api/files/roots` JSON `null`：修复前 TypeError，修复后 400。
- `POST /api/files/roots` JSON 数组：现统一 400 `invalidRequest`（`readJsonObjectBody` 拒非对象）。
- `POST /api/files/upload/init` JSON `null`：修复前 TypeError，修复后 400。
- `POST /api/files/download/prepare` JSON `null`：NDJSON `invalid`，不再在 stream `start` 里抛。

## 文件清单

- 修改：`apps/gateway/src/api/files.ts`、`apps/gateway/src/api/files.test.ts`
- 新建：`apps/gateway/src/api/file-http.ts`、`file-root-routes.ts`、`file-browser-routes.ts`、`file-transfer-routes.ts`
- 未改（按 scope）：`api/http.ts`、`api/index.ts`、`api/messaging-routes.ts`、`api/agent.ts`、`files/*`

## 验证

- `bunx biome check --write` 上述 6 个文件：通过。
- `bun test src/api/files.test.ts src/files/*.test.ts`：81 pass / 0 fail。
- `cd apps/gateway && bun test`：1501 pass / 0 fail（基线 1473；增量来自并行任务新增用例，非本任务失败）。
- `bunx tsc --noEmit -p .`：28 个 error，**均不在本任务文件**。基线 27；多出来的 1 条是并行任务 `src/weixin/ilink/update-loop.test.ts`（`fetch` 断言），未动。

## 未做 / 为何

- **PATCH `/api/files/roots/:id` 的 null body 没有单独用例**：handler 在读 body 前先查 root，不存在即 404；补这条需要往测试库插 root，超出本任务最小回归面。实现上已用 `readJsonObjectBody`。
- **`sortOrder` 未改成 `Number.isSafeInteger`**：它是 JSON number，不是 query `parseInt`；收紧会把 `1.5` 从“接受”变成 400，属于行为变化。`size` 原本已是 `isSafeInteger`。
- **create root 的 `enabled`**：从 `body.enabled ?? true` 改为 `typeof === 'boolean' ? enabled : true`，避免把非 boolean 传进 DB；缺省 / `false` / `true` 行为不变。
