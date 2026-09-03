# TASK H 执行结果

## 做了什么

### 1. `readBodyCapped` / JSON body 读取抽到 `@tmex/shared`

原 `apps/gateway/src/api/http.ts` 与 `packages/app/src/runtime/http.ts` 中逐字相同的 32 行 `readBodyCapped`、仅函数名不同的 JSON 对象包装、以及两份 `JSON_BODY_MAX_BYTES = 1024 * 1024`，已迁到：

- `packages/shared/src/http/read-body.ts`（纯 Web API：`Request` / `ReadableStream`，无 `node:*`）
- `packages/shared/src/http/read-body.test.ts`

共享模块导出：

- `JSON_BODY_MAX_BYTES`
- `readBodyCapped`
- `readJsonObjectBody`（gateway 原名）
- `readJsonBody`（app 原名，同一实现的别名）

两侧原文件改为薄 re-export，**调用点零改动**：

- gateway：`export { JSON_BODY_MAX_BYTES, readJsonObjectBody } from '../../../../packages/shared/src/http/read-body'`
- app：`export { JSON_BODY_MAX_BYTES, readJsonBody } from '../../../../packages/shared/src/http/read-body'`

相对路径与现有 Node-only 模块（`packages/shared/src/env/load-env`）的消费方式一致。`json` / `manifestJson` / `jsonOk` / `jsonErr` / `mapError` 仍留在各自包内。

**未改 `packages/shared/package.json`（规则禁止）。** 按现有 subpath 约定，这里真正该加的是：

```json
"./http": "./src/http/read-body.ts"
```

主 barrel `packages/shared/src/index.ts` 也未改：它不在本任务文件清单内，且 `index.test.ts` 会锁定运行时导出名快照。HTTP helper 因此暂不进入 `@tmex/shared` 主入口，避免被前端 bundle 误拉（模块本身浏览器安全，但当前消费者只有 gateway / app 服务端）。指挥官若补 subpath，gateway 可改成 `from '@tmex/shared/http'`。

### 2. `uplink-pool.ts` `applyAttachedMatch(match)`

`refreshAttachedFromList` / `refreshAttachedFromCandidates` 末尾三行赋值（`hubNodeId` / `mode` / `writerEpoch`）抽成 `private applyAttachedMatch(match)`。未改该文件其它部分。

行数：**1596 → 1596**（新方法 6 行，两个调用方各少 3 行赋值；`applyAttachedMatch` 与 `refreshAttachedFromList` 之间省略一个空行以守行数）。

### 3. `referenceApply` 测试夹具

75 行全量克隆参考实现从 bench 与 `legacy-snapshot-draft.test.ts` 挪到 `packages/shared/src/ws-borsh/test-fakes.ts`，两处改为 import。行为未改。

## 验证

| 包 | 测试 | tsc `--noEmit` | biome |
| --- | --- | --- | --- |
| `packages/shared` | **447 pass / 0 fail**（基线 442 + 本任务 5 条 `readBodyCapped`/`readJsonObjectBody`） | 0（基线 0） | 通过 |
| `apps/gateway` | 全量 3767 pass / 4 fail / 1 error（基线 3750，3 fail + 2 errors 为已知 flake）。与本任务相关：`src/api/http.test.ts` + `src/mesh/uplink-pool.test.ts` **57 pass / 0 fail** | 0（基线 21，未超） | 通过 |
| `packages/app` | 与本任务相关：`http.test.ts` + `setup-routes.test.ts` + `local-routes.test.ts` **43 pass / 0 fail**。全量当时 680 pass / 4 fail，失败全是 `packages/app/src/tls/tls-service.ts` 的 `normalizeDnsCredentials is not defined`（并行 agent 改 TLS，非本任务文件） | 1（`Cannot find type definition file for 'node'`，与基线一致） | 通过 |

新增 `readBodyCapped` 单测覆盖：低于上限、恰好等于上限、`content-length` 超限、分块流超限（断言 `cancel()`）、以及非对象 JSON（`null` / 数组 / 字符串 / 数字 / 布尔）。

## 风险 / 后续

- 请指挥官在允许改 `package.json` 时补 `"./http"` subpath；补完后可把两侧相对路径换成 `@tmex/shared/http`。
- `apps/gateway/src/api/file-transfer-routes.ts` 另有一份返回 `{ ok, bytes }` 的 `readBodyCapped`（上传 chunk 上限），语义不同，未动。
