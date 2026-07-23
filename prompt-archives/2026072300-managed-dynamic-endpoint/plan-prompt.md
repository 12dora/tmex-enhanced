# Managed Gateway Dynamic Endpoint Implementation Prompt

## 2026-07-23

实现 vibex 跨仓计划
`../../../../prompt-archives/2026072304-canonical-stream-local-ipc-test-stack-replan/plan-00.md`
的 Task 3，仅覆盖 tmex 拥有的 managed Gateway 动态 endpoint handshake。

背景：

- 跨仓计划已完成产品和架构拍板，本实施不重新设计 canonical state feed。
- Companion 是 managed Gateway 的唯一 child owner；Gateway 应绑定 OS 分配的私有 loopback
  临时端口，并通过一次性 readiness 文件把实际 endpoint 交给 Companion。
- 普通开源 Gateway 入口必须继续使用既有默认端口；动态端口只属于 managed 入口。
- 当前 vibex worktree 为 `.worktrees/canonical-terminal-stream`，主仓 `main` 已在开工前合入；
  tmex 起点 gitlink 为 `ed388f8e585e20362c77286b1d25aae146f45c12`。

实施要求：

- readiness 环境变量固定为 `TMEX_MANAGED_ENDPOINT_PATH` 和
  `TMEX_MANAGED_ENDPOINT_NONCE`；不得记录 nonce。
- readiness schema 固定为 schemaVersion、nonce、pid、transport、host、port；host 只允许
  loopback，port 必须是 1..65535，transport 固定为 tcp。
- managed 入口接受 `GATEWAY_PORT=0`，Bun.serve 成功后必须使用 `server.port` 发布实际端口。
- readiness 通过同目录临时普通文件写入，再原子 rename 到目标路径；payload 有严格大小边界。
- listener 生命周期长于可替换的 Gateway runtime；replacement 期间 HTTP 返回 503，旧
  WebSocket 主动关闭；replacement 失败时进程退出。
- 不触碰已安装 tmex、9883、默认 tmux socket 或名为 tmex 的 session。
- 每次使用 Bun API 前先查本地 Bun 类型定义或源码；commit 使用中性开源语气，不推送。

验收命令：

```bash
bun test apps/gateway/src/system/managed-endpoint.test.ts apps/gateway/src/config.test.ts
bun test apps/gateway/src/managed-entry.version.test.ts
bun run --filter @tmex/gateway test
```

## 2026-07-23 跨组件对接补充

Companion 实施方要求尽快固定 readiness env 名，并确认 managed entry 的启动行为：

- env 使用 `TMEX_MANAGED_ENDPOINT_PATH` 与 `TMEX_MANAGED_ENDPOINT_NONCE`；
- nonce 不得进入日志；
- 向 Companion 回报精确 schema、边界和入口行为，确保 Rust parser 使用同一契约。

实施中进一步确认：两个一次性 env 在入口读取并校验后，应在业务 runtime 导入和创建前从
`process.env` 删除，避免被 tmux、rsync 或其他子进程继承。
