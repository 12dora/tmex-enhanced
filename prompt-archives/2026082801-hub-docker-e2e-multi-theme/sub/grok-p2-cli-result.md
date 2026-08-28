# grok-p2-cli 结果

工作区：`/Users/konata/code/tmex-enhanced-wt-merge`（仅改 `packages/app/`，未做 git 操作）。未触碰 `apps/gateway/**`、本机生产 tmex、名为 `tmex` 的 tmux session。

## 基线 vs 最终

| 检查 | 基线 | 最终 |
| --- | --- | --- |
| `packages/app` `bun test` | 232 pass / 0 fail | 234 pass / 0 fail（31 files，+2 用例） |
| `bunx tsc --noEmit -p .` | 1 error（`TS2688` Cannot find type definition file for 'node'） | 1 error（同基线，未新增） |
| `bunx biome check` 改动文件 | — | clean |

tsc 那条 `TS2688` 与本次无关（`packages/app` 未装 `@types/node`）。

## P2 — 无 TTY 时 Node CLI 吞掉 Bun 子进程 stdout

**根因**

- `node dist/cli-node.js enroll|hub user add …` 经 `spawnAuthCli` → `runCommand(..., { stdio: 'inherit' })` 再拉起 `bun runtime/cli-auth.js`。
- `runCommand` 的 `inherit` 把子进程接到父进程 fd 0/1/2。`docker exec` 不带 `-t` 时父进程 stdout 是 Node 设成 **非阻塞** 的 pipe/Socket。子进程继承这个非阻塞 fd 1 后，Bun 的 `write` 可能 `EAGAIN` 丢数据，或输出要等进程退出才从 docker 管道里刷出来。
- `runCommand` 的 `pipe` 模式只把 chunk 攒进字符串，**子进程 `close` 之前不往父进程 stdout 写**。`enroll` 会一直等 redeem，join token 行因此永远不会出现。
- 父进程用 `process.exitCode` 而不是 `process.exit()`（这一点本来是对的），但没有在 pipe 排空后再返回；也没有 `detached`/`unref`。

直接跑 `bun /opt/tmex/runtime/cli-auth.js enroll …` 不经过这层 Node spawn，所以能打出 token。

**改动**（`packages/app/src/lib/auth-spawn.ts`）

- 默认不再 `stdio: 'inherit'`。stdout/stderr **始终 pipe**，每个 chunk **原样** `dest.write(buf)`（默认 `process.stdout` / `process.stderr`），带 backpressure（`write` 返回 false 时 pause + drain）。
- 等 `close` **和** stdout/stderr `end` 都结束后才 resolve，再由 `index.ts` 设 `process.exitCode`。不 `process.exit()`、不 `detach`/`unref`。
- stdin：父进程是 TTY 时 `inherit`（密码 prompt），否则 `ignore`（容器/`docker exec` 无 `-t`）。
- `stdio: 'pipe'` 且未注入 dest 时只收集不转发（保留 `index.test.ts` 的捕获语义）。

**测试**（新建 `packages/app/src/lib/auth-spawn.test.ts`）

- fake child 先写 `JOIN_TOKEN abc`，停住，等 go 文件后再写 `node admitted` / stderr，并以 4 退出。
- 注入非 TTY `Writable`。断言 token 在子进程仍运行时就到达 dest；go 之后完整 stdout/stderr 与 exit code 4。
- RED：inherit 路径 token 出现在测试 runner fd 上，注入 stream 超时。GREEN：53ms 通过。

## P3 — `writeEnvFile` 把符号链接 `app.env` 换成普通文件

**根因**

- `writeEnvFile` 在 `app.env` 旁写 tmp，再 `rename(tmp, filePath)`。
- `filePath` 若是 symlink（`/opt/tmex/app.env -> /var/lib/tmex/app.env`），`rename` 替换的是链接本身，volume 上的真实文件不更新，`hub join` 状态在 `compose run --rm` 后丢失。

**改动**（`packages/app/src/lib/env-file.ts`）

- `realpath(filePath)`，`ENOENT` 时回退到原路径（首次创建）。
- tmp 建在 **目标文件所在目录**（与真实文件同文件系统，避免 EXDEV），再 atomic `rename` 到 realpath。符号链接保留，volume 文件被更新。

**测试**（`env-file.test.ts`）

- overlay symlink → volume 真实文件；`writeEnvFile(link)` 后 `lstat(link)` 仍是 symlink，realpath 不变，link 与 real file 内容均为新 env。
- RED：`isSymbolicLink() === false`。GREEN：通过。既有「不存在则创建 + atomic rename」用例仍过。

## 改动文件

生产：

- `packages/app/src/lib/auth-spawn.ts`
- `packages/app/src/lib/env-file.ts`

测试：

- `packages/app/src/lib/auth-spawn.test.ts`（新）
- `packages/app/src/lib/env-file.test.ts`

未改 `apps/gateway/**`，未跑 git。
