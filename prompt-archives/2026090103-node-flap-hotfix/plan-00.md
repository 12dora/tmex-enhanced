# 热修计划：1.1.8 远端节点设备卡片闪断（→ 1.1.9）

## 背景

- v1.1.8（round12）上线约 1 小时后用户反馈：桌面端非本机节点「莫名其妙掉线然后自动恢复」，追问后确认形态为「侧栏节点下方设备卡片消失 → 变为『登录该节点』 → 右侧终端提示已断开 → 不到 1 秒恢复，持续发生」，同时局域网节点延迟飙到 1000+ ms。
- 分支 `fix/node-flap-401`（worktree `../tmex-enhanced-wt-hotfix`，基于 main `84951d6d`）。

## 取证（systematic-debugging Phase 1）

- 生产 gateway 日志（只读）：升级后 `[uplink]` 无抖动；`[mesh][rtc] dial failed ... datachannel open timeout` 与 `[mesh][stream] failover` 在升级前后频率相当，属既有行为，不是新因。
- 「登录此节点」只能由 `loggedIn:false` 触发；1.1.8 能产生它的只有两条路径：REST 兜底（5 min，不可能造成亚秒级循环）与 **M1 审查修复新增的 `onAuthRequired(scope=node) → markLoggedOut`**。不到 1 秒即静默登录成功说明会话本身有效 → 该 401 是转发路径上的「虚假」401。
- 放大链路：401 → `markLoggedOut` → `useNodeLoginGate` 判 needsLogin → 抽掉 `NodeRuntimeScope` 子树（终端/WS 全断）→ 静默登录成功 → `markLoggedIn` → 重挂 → 重挂后的请求/WS 再次 401 → 循环。每轮重挂重新拨 WebRTC、发 mesh connection/rtc-config/authorize，解释了延迟飙升。
- 1.1.7 里同一事件无人监听，因此不可见。

## 处置

1. 立即止血：`tmex upgrade --version 1.1.7` 回滚本机生产（已执行，`/healthz` 1.1.7）。
2. 热修 1.1.9：节点级 401 不再就地翻 `loggedIn`，只触发一次列表回源（同一 node 每个兜底拍一次，`authSeen` 随 sweep 清空）；REST 按 cookie 判定登录态，真实过期时 cookie 随会话到期消失，回源即可反映。控制台 `console.warn('[mesh] node 401 node=… path=…')` 便于定位来源。
3. 后续：追虚假 401 的真实来源（候选：直连/中转路径切换后节点侧 `nodeSessionStore.verify` 的 `via_mismatch`，见 `apps/gateway/src/mesh/mesh-runtime.ts` `verifyBoundSession` 与 `forwarder.ts` 把上游任何 401 改写成 `NODE_LOGIN_REQUIRED`），codex EXA 报告见 `sub/EXA-result.md`。

## 验收

- fe 单测 1140 pass、tsc 0、biome 干净；`bun run build` + `test:tmex` 通过。
- 发版 1.1.9 → 本机升级 → 用户确认闪断消失、延迟恢复。
