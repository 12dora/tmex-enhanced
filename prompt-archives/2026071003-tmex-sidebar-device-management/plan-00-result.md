# tmex 设备树与侧边栏迭代执行结果

日期：2026-07-10

> 本文记录第一阶段实现。后续验收反馈对设备树默认状态、状态点和层级视觉作了修订，最终口径与验证见 `plan-01-result.md`。

## 实施结果

- 基于父仓 gitlink `ebbdf7c34024b94f6ac392c4f8b2521e72315d65` 的 tmex 分支 `vibex/tmex-sidebar-device-management` 完成实施；未提前改动 Vibe X Webapp。
- 删除前端持久化的“用户连接意图”与侧边栏／设备管理页的 Connect、Disconnect、连接绿灰点和点击卡片连接交互。底层 tmux 订阅协议仍保留为运行时实现。
- 设备树改为独立 disclosure，状态与一级分区状态一同按 runtime `storagePrefix` 写入 `${storagePrefix}tmex-ui`。折叠不会断连；刷新后只恢复当前路由设备和用户已展开设备的订阅，不会批量订阅全部设备。
- 删除设备后，全局订阅层会清理已不存在设备的底层订阅；路由指向已删除设备时不会被清理逻辑重新订阅。
- 侧边栏窗口／pane 高亮严格由浏览器 URL 的 `deviceId + windowId + paneId` 三元组决定，不再用 tmux snapshot 的 `active` 字段补高亮。`matchPath(location.pathname)` 的 pane 参数在当前 React Router 版本仍为编码值，因此只在侧边栏路径解析处解码一次。
- Agent 移至一级条目首位。Agent 展开时独占；Panes、Files 可同时展开；打开任一非 Agent 项会收起 Agent。保持既有 Sidebar 结构、token 和 Lazy/Suspense 边界，只微调一级触发器密度、图文层级与顶部间距。
- 删除已确认无代码引用的旧 `apps/fe/src/components/Sidebar.tsx`，避免未来误复用旧连接态界面。

## 审查中补齐的边界

两次独立只读审查提出并关闭了以下问题：

1. 当前终端路由中，用户手动收起设备树后刷新不得被自动展开覆盖。
2. 非当前、已展开设备在刷新后必须恢复订阅并重新显示窗口树，不能停在 Loading。
3. E2E 的 localStorage 清理改为仅初始化时执行，确保 reload 断言实际验证持久化。

## 验证证据

- `bun test packages/stores/src/ui.test.ts apps/fe/src/components/global-device-provider.test.ts`：9 passed，0 failed。
- `bunx tsc --noEmit -p apps/fe/tsconfig.json`：退出码 0。
- `bun run build:fe`：退出码 0；仅有既有 Vite chunk-size 提示。
- `cd apps/fe && bun run test:e2e tests/sidebar-device-disclosure.spec.ts tests/devices.spec.ts tests/mobile-agent-watch.spec.ts tests/agent-session.spec.ts tests/sidebar-close-confirm.spec.ts tests/sidebar-click-no-pty-injection.spec.ts`：14 passed，退出码 0。
- `cd apps/fe && bun run test:e2e tests/sidebar-pane-menu-alignment.spec.ts tests/sidebar-resize.spec.ts tests/mobile-sidebar-safe-area.spec.ts`：4 passed，退出码 0。
- 通过本 task 的临时 devserver 对 `/devices` 做了桌面截图检查：Agent 位于最上方且默认收起，Panes、Files 同时展开；设备仅显示 disclosure；设备管理卡片不存在 Connect 入口。
- 两位独立审查者最终均报告无 blocker／major。

## 开发服务与数据

- 已按授权从 `/Users/krhougs/LocalCodes/tmex` 复制开发数据库 WAL 三件套到 task worktree 的 `vendor/tmex/` 根；未读取或改动安装版生产目录。
- 临时开发服务保持运行：前端 `http://localhost:19883` 返回 HTTP 200，网关 `http://127.0.0.1:19663/healthz` 返回 `{"status":"ok","restarting":false,"env":"development"}`。
- 未触碰 9883、安装版 tmex 或默认 tmux socket；E2E 仅使用 `tmex-e2e` socket。

## 后续门槛

本阶段等待用户对 tmex 验收。验收通过前，不启动 Vibe X Webapp 的 tmex 风格迁移、功能同步或多 instance 设备聚合实施。
