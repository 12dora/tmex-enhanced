# Terminal Preview And Stale Route Recovery（tmex 子计划）

## 背景

Vibe X production CSP 修复后，真实设置预览已有四层 Canvas 和可见字形，但现有 E2E错误
地按正式终端的 `data-terminal-engine` 外壳查找，制造假阴性。另有一个独立真实缺陷：
`DeviceConsole` 对失效 pane 在 2.5 秒 settle 后回落，对失效 window却永久等待。

## 实施

1. 给 `TerminalPreview` 根与挂载节点增加稳定、无业务耦合的测试标识，测试真实 Canvas
   尺寸和非单色像素。
2. 提取或直接覆盖失效 selection 的恢复决策；先写测试证明 window在宽限前等待、宽限后
   回落到快照活动 window/pane，pane relocation与合法深链行为保持不变。
3. 修改 `DeviceConsole` 的失效 window分支，优先活动 window/pane，缺少 active标记时
   使用首个可用 window/pane；无 window仍回设备列表。
4. 跑 panels/terminal-ui 定向 Bun测试、类型检查和 Vibe X受保护 loopback真实 E2E。

## 验收

- 设置预览测试不依赖正式终端 DOM形状；
- 失效 window不会永久空白或停在 not-found，合法传播宽限不缩短；
- 不执行任何默认 tmux socket操作，不触碰名为`tmex`的 session或生产 tmex服务。
