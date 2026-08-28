- **P1（高）— [auth-spawn.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/auth-spawn.ts:156)：父进程未协调信号，且丢失子进程的终止信号。**  
  场景：TTY 下 `enroll` 等待时按 Ctrl-C，终端会向同一前台进程组中的 Node 父进程和 Bun 子进程发送 SIGINT。子进程会在 `runEnroll` 中捕获 SIGINT 并尝试输出提示，但父进程使用默认 SIGINT 行为退出并关闭新建的 stdout/stderr 管道，导致提示无法可靠转发，甚至触发 EPIPE。此前子进程直接继承终端 fd，不依赖父进程继续存活。与此同时，[waitChildClose](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/auth-spawn.ts:104) 忽略 `close` 的 `signal` 参数，把所有信号终止都转换成退出码 1；实测 SIGTERM 得到 `{ code: null, signal: "SIGTERM", mappedByPatch: 1 }`，而不是 143。Node 文档也明确说明信号终止时 `code` 为 `null`、`signal` 非空：[ChildProcess close event](https://nodejs.org/api/child_process.html#event-close)。  
  修复：在子进程生命周期内临时接管 SIGINT/SIGTERM，协调或幂等转发给子进程，保持父进程存活直至子进程关闭且输出排空，然后恢复处理器；同时保留 `signal`，在子进程未自行处理信号时向父进程重发，或至少转换为 `128 + signal number`。应补 PTY Ctrl-C 和子进程直接被 SIGTERM 的测试。

- **P2（中）— [env-file.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/app/src/lib/env-file.ts:35)：悬空 symlink 会被静默替换。**  
  场景：`app.env` 是指向尚未创建目标的绝对或相对 symlink，例如管理员预先准备配置挂载布局后执行交互式 `tmex init`。`realpath()` 返回 `ENOENT`，代码无法区分“入口不存在”和“入口是悬空链接”，于是回退到 `filePath`；后续 `rename()` 会覆盖 symlink 目录项，在安装目录内创建普通文件，真实目标仍不存在。  
  修复：遇到 `ENOENT` 时先用 `lstat()` 判断入口是否为 symlink，再用 `readlink()` 解析目标，即使目标叶子尚不存在也在目标目录执行临时文件加 rename；无法安全解析时应报错，不能破坏链接。补充绝对和相对悬空 symlink 测试。

验证受只读沙箱限制：涉及 `mkdtemp` 的测试以环境 `EPERM` 失败；不写临时目录的 env-file 测试 2 项通过，`git diff --check` 通过。

**Verdict：REQUEST CHANGES。**