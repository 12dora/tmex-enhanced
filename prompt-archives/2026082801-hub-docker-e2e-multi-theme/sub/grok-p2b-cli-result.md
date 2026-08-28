# grok-p2b-cli 结果

工作区：`/Users/konata/code/tmex-enhanced-wt-merge`（仅改 `packages/app/`，未做 git 操作）。未触碰 `apps/gateway/**`、本机生产 tmex、名为 `tmex` 的 tmux session。

针对 `review-cli2.md` 的 P1（auth-spawn 信号）与 P2（env-file 悬空 symlink）。

## 基线 vs 最终

| 检查 | 基线 | 最终 |
| --- | --- | --- |
| `packages/app` `bun test src` | 234 pass / 0 fail（31 files） | 239 pass / 0 fail（31 files，+5 用例） |
| `bunx tsc --noEmit -p .` | 1 error（`TS2688` Cannot find type definition file for 'node'） | 1 error（同基线，未新增） |
| `bunx biome check` 改动文件 | — | clean |

tsc 那条 `TS2688` 与本次无关（`packages/app` 未装 `@types/node`）。

RED（实现前）：SIGINT 用例超时 5000ms 且残留子进程；SIGTERM 得到 `1` 而不是 `143`；绝对/相对悬空 symlink 写入后 `isSymbolicLink() === false`；循环链接抛出原始 `ELOOP`。

GREEN：`src/lib/auth-spawn.test.ts` + `src/lib/env-file.test.ts` 12 pass / 0 fail。

## P1 — 父进程协调 SIGINT/SIGTERM，并按 `128 + signal` 传播退出码

**根因**

- `waitChildClose` 只看 `close` 的 `code`，`code === null` 时一律变成 `1`。Bun/Node 实测 SIGTERM：`{ code: null, signal: "SIGTERM" }`。
- 父进程没有 SIGINT/SIGTERM 处理器。TTY 下 Ctrl-C 会让 Node 父进程按默认行为退出并拆掉 stdout/stderr pipe，子进程即使捕获 SIGINT 写出提示也无法转发，stdout 还可能 EPIPE。

**改动**（`packages/app/src/lib/auth-spawn.ts`）

- 子进程存活期间 `process.on('SIGINT'|'SIGTERM')`，每个信号只向 child `kill` 一次；父进程继续等到 `close` + stdout/stderr `end`，再在 `finally` 里摘掉处理器。
- `close(code, signal)`：`code !== null` 原样返回；否则 `128 + os.constants.signals[signal]`（SIGINT=130，SIGTERM=143）。
- 给转发目标挂 `error` 监听，忽略 EPIPE；`write` 遇到 EPIPE 停止往 dest 写，但继续抽干子进程管道。
- stdin 仍是 TTY 时 `inherit`，否则 `ignore`。

**测试**（`auth-spawn.test.ts`）

- fake child 捕获 SIGINT，写出 `caught-sigint`，以 130 退出；父进程 `process.emit('SIGINT')` 转发后退出码 130，dest 收到该行。RED：超时。GREEN：通过。
- fake child 被 `SIGTERM` 杀掉 → 父进程退出码 143。RED：`1`。GREEN：通过。

## P2 — 悬空 symlink 不再被 rename 替换

**根因**

- `realpath` 对悬空链接返回 `ENOENT`，旧代码回退到 `filePath`，随后 `rename(tmp, filePath)` 覆盖目录项，链接变成普通文件，真实目标仍不存在。

**改动**（`packages/app/src/lib/env-file.ts`）

- `realpath` 成功则写真实路径（既有 overlay→volume 用例）。
- `ELOOP`：抛 `cannot resolve env file symlink: …`，不碰链接。
- `ENOENT`：`lstat`；若是 symlink，用 `readlink` 相对链接所在目录 `resolve`，沿链走到缺失叶子，在**目标目录** tmp+rename 创建目标文件，链接保留。
- 环、跳数超 32、`readlink` 失败：同样抛上述错误。

**测试**（`env-file.test.ts`）

- 绝对悬空 symlink：`overlay/app.env -> /abs/.../volume/app.env`（目标尚无文件）。写入后 link 仍是 symlink，volume 文件被创建。
- 相对悬空 symlink：`../volume/app.env`。同上。
- 循环 symlink：抛 `cannot resolve env file symlink`，两端仍是 symlink。
- RED：绝对/相对用例 `isSymbolicLink() === false`。GREEN：三项均通过。既有「已存在的 symlink 更新 volume」用例仍过。

## 改动文件

生产：

- `packages/app/src/lib/auth-spawn.ts`
- `packages/app/src/lib/env-file.ts`

测试：

- `packages/app/src/lib/auth-spawn.test.ts`
- `packages/app/src/lib/env-file.test.ts`

未改 `apps/gateway/**`，未跑 git。
