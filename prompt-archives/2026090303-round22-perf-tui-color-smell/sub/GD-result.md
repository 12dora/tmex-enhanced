# GD 结果：B6 进程身份助手合一 + B8 `withAuth` 三份合一

## 结论

B6 / B8 均已落地。gateway **不能**依赖 `packages/app`（`tmex-cli`，无此依赖；方向是 app → gateway），助手使用 `node:fs` / `node:child_process`，不能进 `@tmex/shared` 浏览器主入口。规范实现放到 `packages/shared/src/process/process-identity.ts`，经 `package.json` 子路径 `@tmex/shared/process` 注册（与 `./auth` / `./link` / `./uplink` 同模式）。macOS `ps -o lstart=` / `ps -o command=` 行为与原 app 侧一致。

## 改动文件

**新建**
- `packages/shared/src/process/process-identity.ts`（`processCommandLine` + `processStartIdentity`）
- `packages/shared/src/process/process-identity.test.ts`
- `packages/app/src/commands/with-auth.ts`
- `packages/app/src/commands/with-auth.test.ts`

**修改**
- `packages/shared/package.json`：仅追加 `"./process": "./src/process/process-identity.ts"`（`./http` / `./net` 为 B14 已有条目，未改其指向）
- `apps/gateway/src/system/upgrade.ts`：改 import `@tmex/shared/process`，保留同名再导出
- `packages/app/src/lib/upgrade-lock.ts`：删除本地 `processStartIdentity`，改从 shared 引入并再导出
- `packages/app/src/lib/upgrade-process.ts`：删除本地 `processCommandLine`，改从 shared 引入并再导出
- `packages/app/src/commands/hub.ts` / `mesh.ts` / `enroll.ts`：删除本地 `withAuth`，改 import `./with-auth`

## B6 实现选择

- 规范实现取 **app 侧**（`upgrade-lock` / `upgrade-process`）：`ps -o <field>= -p <pid>`，与 `processStartIdentity` 的 `lstart=` 参数顺序一致。
- gateway 原版 `processCommandLine` 用 `ps -p <pid> -o command=`，macOS BSD `ps` 输出等价；linux `/proc/<pid>/cmdline` 与 `/proc/<pid>/stat` 字段 20（`rest[19]`）逻辑未改。
- 原模块继续再导出，现有测试 import 路径不变。

## B8

三份实现逐字相同，仅 enroll 的 `io` 类型是 `EnrollIo`（`HubIo` 的超集）。抽出后 `io` 收成 `{ auth?: LocalAuthContext }`。用户可见错误文案 / 退出路径未改。

## 度量

| 项 | 前 | 后 |
|---|---:|---:|
| `apps/gateway/src/system/upgrade.ts` 行数 | 1037 | 992 |
| `packages/app/src/commands/hub.ts` 行数 | 1313 | 1297 |
| `cd packages/app && bun test src/commands src/lib` | 463 pass / 43 files | **472 pass / 45 files**（+5 `with-auth`；另 +1 文件来自并行任务） |
| `cd apps/gateway && bun test src/system` | 153 pass / 10 files | **153 pass / 10 files** |
| `packages/shared` `src/process` | — | **6 pass** |
| `packages/app` tsc 错误数 | 1（既有 `TS2688` node types） | 1（同条） |
| `apps/gateway` tsc 错误数 | 0 | 0 |
| `packages/shared` tsc 错误数 | 0 | 1（见下，非本任务文件） |
| `bunx biome check <changed files>` | — | 通过 |
| `bun scripts/complexity/gate.ts` | ok | **ok**（1258 files, 11682 functions） |

`packages/shared` tsc 多出的 1 条在 `src/http/read-body.test.ts:106`（B1 并行改动），本任务未碰该文件。

## 未能做的

无。`packages/shared/package.json` 与 B14 共享，本任务只追加 `./process` 一行；若 B14 后续整块重写 `exports`，需保留该键。
