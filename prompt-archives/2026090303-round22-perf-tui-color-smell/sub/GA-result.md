# GA 结果：B1 + B14

## 结论

B1 传输会话抽到独立模块，`files.ts` ↔ `file-transfer-routes.ts` 值导入环已断。第三份私有 `readBodyCapped` 删除，分片上传改走 `packages/shared` 的 `readBodyCappedResult`。B14 补上 `@tmex/shared/http`、`@tmex/shared/net` 子路径，gateway/app 的四级 `../` 穿越已换成子路径。

## 改动文件

- `apps/gateway/src/api/file-transfer-sessions.ts`（新建）：`transferUids` + `rememberTransferUid` / `cleanupUpload` / `cleanupDownload` / bulk hooks
- `apps/gateway/src/api/file-transfer-sessions.test.ts`（新建）
- `apps/gateway/src/api/files.ts`：只留路由装配 + 对 sessions 的再导出（外部 `filesBulkHooks` / `filesRoutes` 入口不变）
- `apps/gateway/src/api/file-transfer-routes.ts`：改 import sessions；删除私有 `readBodyCapped`；`handleUploadChunk` 用 `@tmex/shared/http` 的 `readBodyCappedResult`
- `apps/gateway/src/api/file-transfer-routes.test.ts`：补 exactly-at-limit（200）与 over-limit（413 / `too_large`）
- `packages/shared/src/http/read-body.ts`：新增 `ReadBodyCappedResult` / `readBodyCappedResult`（旧 `readBodyCapped` / `readJsonObjectBody` 签名不变）
- `packages/shared/src/http/read-body.test.ts`：result 形态在 under / at / over limit 与 `readBodyCapped` 对齐
- `packages/shared/package.json`：`./http` → `src/http/read-body.ts`，`./net` → `src/net/dial-breaker.ts`（字符串映射，与现有 `./uplink` 相同）。并行任务已写入的 `./process` 未动
- `apps/gateway/src/api/http.ts`、`packages/app/src/runtime/http.ts`：import 改为 `@tmex/shared/http`
- `packages/app/tsconfig.json`：仅登记两个子路径（见下）

未改 vite / gateway / fe tsconfig：全仓没有任何 `@tmex/shared/uplink` 的 paths/alias 登记，子路径靠 `package.json` `exports` 解析。gateway 有 `workspace:*` 依赖，直接可用。`packages/app`（`tmex-cli`）未声明 `@tmex/shared`，bun 解析不到子路径，故只在其 tsconfig 加了：

```
@tmex/shared/http → ../shared/src/http/read-body.ts
@tmex/shared/net  → ../shared/src/net/dial-breaker.ts
```

不能改 `packages/app/package.json` 加 workspace 依赖（非本任务拥有文件）。

## 测量

| 项 | 改前 | 改后 |
|---|---:|---:|
| `cd apps/gateway && bun test src/api` | 450 pass / 34 files | **457** pass / 35 files（+7：sessions 5 + 上限 2） |
| `cd packages/shared && bun test` | 451 pass / 43 files | **472** pass / 46 files（本任务 +4；其余为并行任务增量） |
| `cd packages/app && bun test src/runtime` | 158 pass / 10 files | **158** pass / 10 files |
| gateway `tsc --noEmit` | 0 | **0** |
| shared `tsc --noEmit` | 0 | **0** |
| app `tsc --noEmit` | 1（预存：`types: ["node"]` 找不到） | **1**（同基线） |
| `bunx biome check`（本任务改动文件） | — | 通过 |

分片上传上限：`Content-Length` 超限仍 413/`too_large` 且不读 body；body 恰好等于 remaining → 200/`received=size`；body 比 remaining 多 1 字节（无 CL）→ 413/`too_large`。

## 未能完成

`bun scripts/complexity/gate.ts` **当前非 ok**，违规不在本任务文件：

- `apps/gateway/src/hub/uplink-server.ts:handleKeyLogAppend` 122 行 > 120（B10）
- `packages/ghostty-terminal/src/canvas-renderer.ts` 905 行 > 900（G1）

本任务生产文件均远低于门禁（`files.ts` 19 行、`file-transfer-sessions.ts` 100 行、`file-transfer-routes.ts` 232 行、`read-body.ts` 68 行）。未改 allowlist。
