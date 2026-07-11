# 验收反馈：设备树默认展开与层级视觉修正

日期：2026-07-10

## 背景

tmex 第一轮实现已完成后，用户验收明确要求设备树默认展开、在线／离线点恢复、disclosure 箭头回到设备行最右，并恢复设备→window 的视觉缩进。本补充计划只调整 tmex，Vibe X Webapp 仍等待 tmex 验收通过。

## 已确认决策

- 未写入本地存储的设备视为展开；用户主动收起后写入 `false`，刷新后保持收起。
- 默认展开意味着首次进入设备列表时需要为所有可见设备建立后台快照订阅，保证树不是长期 Loading。这是用户对默认展开要求的直接结果。
- 在线／离线点以 tmux runtime 的真实连接 ACK `deviceConnected` 为基础；运行时错误或重连中均显示离线。`connectedDevices` 仅表示前端订阅意图，不能用于该视觉状态。状态点保持无交互，不恢复 Connect／Disconnect 控制，也不影响 disclosure 规则。
- 设备行继续保留左侧 drag handle；状态点在右侧、disclosure 箭头为最右控件；window 树容器增加左侧缩进，不改变现有卡片、DND 或 pane 树结构。

## 实施与验证

1. 先扩展隔离 E2E：默认设备 disclosure 为展开、可显示窗口树；在线状态点和右侧 disclosure 入口存在；刷新后的收起状态仍为收起。
2. 在红测确认后，将缺省 disclosure 解释为展开，订阅 effect 同步覆盖值为 `true` 或未显式收起的设备。
3. 调整设备行控件顺序与子树 padding；不恢复任何连接动作。
4. 用 Playwright 截图和关联 E2E 验证桌面布局、持久化与既有侧边栏规则。
