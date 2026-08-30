# G3 result — `GET /api/files/browse`

## 做了什么

图形化路径选择器后端：列出设备上任意目录的子目录（不受 `file_roots` 白名单约束）。

- 鉴权与其它 `/api/files/*` 相同；走 `/n/:id` 时由现有 mesh forwarder 自动代理。
- `path` 空：本机 `os.homedir()`，SSH `${HOME:-/}`。非空必须是绝对路径（`~` / 相对路径 → `invalid`），用 `path.posix.resolve` 规范化。
- 只返回目录及「指向目录的符号链接」（`symlink: true`）；点前缀隐藏项仅 `hidden=1`；按名称大小写不敏感排序；上限 2000（`truncated`）；无法 stat 的条目跳过。
- 错误走既有 `FileErrorCode` + `codeError`（`invalid` 400、`device_not_found` 404、`not_a_directory` 400、`permission_denied` 403、`timeout` 504、`connection_failed` 502 等）。
- SSH：每请求一条远端命令（存在性检查 + GNU `find -maxdepth 1 -mindepth 1 ( -type d -o ( -type l -xtype d ) ) -printf '%y\\0%f\\0'`），20s 超时；路径用 `quoteShellArg` 包裹。

未改 `device-storage.ts` 的既有导出行为。

## 文件

| 路径 | 说明 |
|---|---|
| `apps/gateway/src/files/directory-browse.ts` | 本机 fs / SSH find 实现；`browseDirectory`；测试接缝 `directoryBrowseIo.execSsh` |
| `apps/gateway/src/files/directory-browse.test.ts` | 本机临时目录 + SSH fake exec |
| `apps/gateway/src/api/file-browser-routes.ts` | 注册 `GET /api/files/browse` |
| `apps/gateway/src/api/files.test.ts` | HTTP：缺 `deviceId` / 相对路径 / 未知设备 / 本机 temp dir / mock SSH exec |

未改 `apps/gateway/src/api/files.ts`（browse 挂在已有 `fileBrowserRoutes` 上）。

## 验证

| 项 | 结果 |
|---|---|
| `bun test src/files/directory-browse.test.ts src/api/files.test.ts` | **46 pass / 0 fail** |
| `cd apps/gateway && bun test` | **2581 pass / 0 fail**（基线 2500；本任务 + 其它并行 agent 增补了用例） |
| `bunx tsc --noEmit -p .`（gateway） | **24 errors**（基线 21）。G3 文件 **0**。多出的 3 条在其它任务：`src/agent/run-finish.test.ts`、`src/tunnel/manager.test.ts`、以及既有/并行改动的测试夹具（`nodeId` 等） |
| `bunx biome check`（上述 4 个文件） | **clean** |

## 风险 / 未做

- **远端需 GNU find**（`-xtype`、`-printf`）。BSD find（macOS 当 SSH 对端）会失败并映射为 `unknown` / find stderr。任务示例即 GNU find；本机浏览走 `fs`，不受影响。
- 刻意不做 root containment：登录用户本就可以把任意绝对路径加成 file root。
- `directoryBrowseIo.execSsh` 仅供单测 `spyOn`；生产默认仍是 `execSshCommand`。
- 未改契约、`api-client`、i18n。
