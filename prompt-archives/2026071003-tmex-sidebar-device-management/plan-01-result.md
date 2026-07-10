# 验收反馈：设备树默认展开与层级视觉修正执行结果

日期：2026-07-10

## 实施结果

- 未持久化的设备 disclosure 现在默认展开；用户手动收起会持久化为 `false`，刷新后仍收起。默认展开设备会无感建立后台快照订阅，确保窗口树可立即显示。
- 设备行恢复只读在线／离线状态点。状态点使用真实连接 ACK `deviceConnected`，并在运行时错误或重连中显示离线；不使用只表示前端订阅意图的 `connectedDevices`，也未恢复任何 Connect／Disconnect 交互。
- disclosure 箭头位于设备行最右；状态点位于箭头左侧。设备→window 树容器恢复 `pl-10`（40px）左缩进，保留原有设备卡片、窗口／pane 结构和拖拽行为。

## 回归覆盖

- `sidebar-device-disclosure.spec.ts` 验证：默认展开、窗口树可见、收起后的刷新持久化、箭头位于状态点右侧、40px 缩进，以及没有 Connect／Disconnect 控制。
- 该用例额外创建一个连往 `127.0.0.1:1` 的 SSH 设备，等待其错误徽标出现并断言状态点离线；同时等待正常本地设备收到 ACK 后显示在线，避免把初始灰色误判为通过。
- 视觉核验使用任务开发服务的 `/devices`：Agent 在最上方且收起、Panes 与 Files 同时展开，6 个设备默认展开，状态点和最右箭头的排布符合验收反馈。

## 验证证据

- `bun test packages/stores/src/ui.test.ts apps/fe/src/components/global-device-provider.test.ts`：9 passed，0 failed。
- `bunx tsc --noEmit -p apps/fe/tsconfig.json`：退出码 0。
- `bun run build:fe`：退出码 0；仅有既有 Vite chunk-size 提示。
- 侧边栏／设备相关 E2E（`agent-session`、`devices`、`mobile-agent-watch`、`mobile-sidebar-safe-area`、六个 sidebar 用例）共 19 passed，0 failed。
- 变更文件的 Biome 检查通过。`DevicePage.tsx:511` 的 exhaustive-dependencies 报告来自基线已有代码，已用 `git blame` 确认，不属于本轮修改。
- 独立代码审查结论：无 blocker、无 major；确认状态点的 ACK/错误／重连语义、默认展开持久化、最右箭头和缩进均正确。

## 开发服务

- 开发前端继续运行在 `http://localhost:19883`（HTTP 200）。
- 开发网关继续运行在 `http://127.0.0.1:19663/healthz`（`status: ok`、`env: development`）。
- 未启动 Vibe X Webapp 实施，继续等待 tmex 验收。
