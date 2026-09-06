# Round 32 计划（四）：远程 agent 窗格 grant（缓解不可信节点注入按键）

## 问题
`/api/mesh-internal/tmux/{send-input,capture,pane-info}` 只校验对端标记（`requirePeerMarker`），任意已准入节点可向其它节点任意窗格注入按键 / 读屏。

## 设计（零体验降级）
- 目标节点 Y 新增 `POST /api/agent/pane-grants`（node-session 鉴权）：`{ fromNodeId, deviceId, paneId }` → `{ grantId, token, expiresAt }`；表 `agent_pane_grants`（id、token_hash、from_node_id、device_id、pane_id、created_at、last_used_at、expires_at），滑动过期 7 天（每次使用续期），硬上限 30 天；`DELETE` 可吊销；节点被吊销时清掉其全部 grant。
- 发起节点 X 在 `POST /api/agent/sessions`（nodeId 非空）时用 `forwardAuthorizedHttp(req, { nodeId: Y })` 换 grant（浏览器请求本就带 `tmex_s_<Y>`，能看到 Y 的窗格即已登录 Y），随 agent 会话持久化（`agent_sessions.remote_grant`，master key 加密），`RemotePaneRuntime` 每次 RPC 带 `grant: { grantId, token }`。
- Y 侧 RPC 校验：grant 存在且未过期、`fromNodeId === 对端标记`、`deviceId / paneId` 与请求一致；否则 403 `PANE_GRANT_REQUIRED` / `PANE_GRANT_INVALID`。
- 兼容：Y 无该路由（旧版本，404）→ X 不带 grant 继续（旧 Y 仍只看 peer 标记）；旧 X 打新 Y → 被拒（升级后首次用户操作时 X 静默补签：会话缺 grant 或 RPC 返回 `PANE_GRANT_*` 时标记，下一次带用户 cookie 的会话请求（发消息 / 恢复）里重签）。
- UI：会话因 grant 失效报错时提示「需重新登录目标节点」文案（复用现有 NODE_LOGIN_REQUIRED 处理）。

## 验收
- 集成测试：无 grant 的 peer 调用 send-input / capture / pane-info 被 403；正确 grant 放行；deviceId/paneId 不匹配、fromNodeId 不匹配、过期均被拒；旧 Y（无路由）退化路径。
- 现有 agent 会话单测 / mesh e2e 全绿。
