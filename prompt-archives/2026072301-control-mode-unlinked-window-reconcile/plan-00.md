# Control Mode 外部窗口删除收敛计划

**目标：** 让 Gateway 在收到 `%unlinked-window-close` 时与 `%window-close` 一样，
立即从 canonical metadata 删除对应窗口子树，使 Native 与 Webapp 不再展示失效窗口。

## 实施

1. 为 `createControlModeSubscription` 增加协议回归测试，输入真实
   `%unlinked-window-close @N` 通知并断言产出统一的 `window-close` source event。
2. 在共用 subscription 层归一化两种 close 通知，不在 local / SSH connection
   各复制逻辑。
3. 运行 control-mode、metadata projection、DeviceSessionRuntime 与 Gateway
   全量测试。
4. 在三个隔离测试容器上更新 Gateway 后，创建并从 tmux 外部删除窗口，确认
   Native / Webapp metadata 自动收敛。

## 验收

- `%window-close` 与 `%unlinked-window-close` 都生成相同的结构删除事件；
- 删除窗口的 pane 子树随 metadata patch 原子移除；
- local 与 SSH 共用同一实现；
- 测试容器后端窗口数与客户端窗口列表一致；
- 不改协议 wire shape，不引入轮询或数据库写入。
