# dep-install 执行结果

## 背景

`packages/app/src/lib/dep-install.ts` 的 `executeDependencyInstall`（原 83 行、CC≈19）把 sudo 探测、交互确认、命令解析、管道执行和安装后版本校验揉在一起，无法用假 spawner 测执行流。

## 改动

抽出 `packages/app/src/lib/dependency-install-runner.ts`：

| 函数 | 职责 |
| --- | --- |
| `resolveInstallPlan` | 空命令报错、sudo 可用性、`resolveInstallCommand`、打印 hint |
| `confirmInstall` | autoConfirm / 非交互拒绝 / `promptConfirm` |
| `runInstallCommand` | 打印 running；`\|` 走 `sh -c`，否则按空格拆 bin/args |
| `verifyInstalledDependency` | bun / tmux 版本校验，成功或 failed+manual |

`executeDependencyInstall` 留在 `dep-install.ts`，变为 7 行编排（签名兼容，第三参可选 `DependencyInstallRunnerDeps`）。commands 仍从 `./lib/dep-install` 导入，未改 `packages/app/src/commands/**`。

注入点：`runCommand`、`promptConfirm`、版本检查、`isSudoAvailable`、`uid`、`platform`、`log`/`error`。生产路径默认接到原 `process` / `prompt` / bun / tmux。

`planTmuxInstall` darwin 分支去掉 `TMUX_INSTALL_COMMANDS.brew!`（biome `noNonNullAssertion`；`brew` 缺失时返回 `[]`，与原先类型断言失败才会走到的路径等价）。

## Bug

无行为修复。执行语义与原来一致（含 spawn throw → 失败、管道走 `sh -c`、非交互 sudo 不可用则拒绝）。

## 测试

`dependency-install-runner.test.ts` 用假 spawner / prompt / 版本检查覆盖执行流：

- 成功（brew 拆命令 + 校验通过）
- 非 0 退出（跳过校验）
- 校验失败
- 用户拒绝确认（不 spawn）
- 用户确认后 spawn
- bun 管道走 `sh -c`
- spawn throw
- darwin 无命令 → brewMissing
- 非 darwin 无命令 → unknownDistro
- 非交互 sudo 不可用

`dep-install.test.ts` L33–176 未改，规划 / sudo 前缀用例原样通过。

## 文件

- 修改：`packages/app/src/lib/dep-install.ts`
- 新建：`packages/app/src/lib/dependency-install-runner.ts`
- 新建：`packages/app/src/lib/dependency-install-runner.test.ts`
- 未改：`packages/app/src/lib/dep-install.test.ts`、`packages/app/src/commands/**`

## 验证

- `bunx biome check --write` 上述 4 个文件：通过
- `cd packages/app && bun test src/lib/dep-install.test.ts src/lib/dependency-install-runner.test.ts`：28 pass / 0 fail
- `cd packages/app && bun test`：100 pass / 0 fail（基线 90；本任务 +10）
- `bunx tsc --noEmit -p .`：1 error（`Cannot find type definition file for 'node'`，与基线一致，非本任务引入）

## 未做 / 为何

- 未拆 `planTmuxInstall` / `getInstallHintAsync`（不在任务范围）
- 未改 commands 侧调用（范围外；可选 deps 第三参向后兼容）
- runner 从 `dep-install` 取 `resolveInstallCommand` / `isRootUid` / `isSudoAvailable`，与编排函数形成 ESM 环；类型与默认实现仍单源，运行时绑定正常，未再抽第三文件
