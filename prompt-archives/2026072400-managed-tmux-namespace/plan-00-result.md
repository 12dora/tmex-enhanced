# Managed tmux Namespace Implementation Result

## 结果

- managed Gateway 新增结构化参数 `--tmux-namespace <name>`。
- 未传参数时会在业务模块加载前清除父进程继承的旧 namespace 状态，使用 tmux 默认 server。
- 显式参数仅接受安全、非空、非 `default` 的名称；缺失值、重复参数、未知参数和与
  `--version` 混用均快速失败。
- `--version` 保持不加载生产配置、不创建数据库、不绑定端口的即时返回行为。
- managed compiled smoke 改为显式独立 namespace，避免测试触碰默认 tmux server。

## 验证

- `bun test apps/gateway/src/managed-args.test.ts apps/gateway/src/managed-entry.version.test.ts`
  ：5 项通过。
- `bun test apps/gateway/src/config.test.ts apps/gateway/src/api/tmux-health.test.ts
  apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts`：30 项通过。
- Biome 对四个变更文件检查通过。
- macOS arm64 compiled Gateway：
  - `--version` 返回 `tmex-gateway 0.17.0`；
  - 非法 default namespace 在业务启动前失败；
  - artifact scanner 通过；
  - 使用显式隔离 namespace 的 managed readiness、health、system API 与 WebSocket
    smoke 通过。

## 偏差与处置

真实 compiled executable 验证确认 Bun 会把内嵌入口路径放在 `process.argv[1]`，业务参数
从 `process.argv[2]` 开始。实现已按源码运行和 compiled executable 的共同实际行为统一解析，
并以 compiled smoke 复验。

