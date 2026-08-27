## Blocker

- `packages/app/src/runtime/assemble.ts:100`  
  **问题：** `localUiGuard` 仅对 `/api/*` 调用，旧 `/ws` 会直接落入 `gateway.handleRequest` 并完成升级，完全没有校验 `tmex_s_self`。  
  **影响：** 在 `node` 或 `hub,node` 模式下，未登录客户端可直接连接 `/ws`，发送现有 Gateway Borsh 指令并访问 tmux，会绕过整个 mesh 登录机制。  
  **建议修复：** 在 gateway WebSocket 升级前强制验证本地 node session；让 guard 覆盖 `/ws`，并按规范把已验证身份传给 Gateway 会话。补充无 cookie 的 `/ws`、HEAD/OPTIONS 和规范化路径测试。

- `apps/gateway/src/mesh/mesh-runtime.ts:371`  
  **问题：** peer 收到的 HTTP stream 只分派给 `gateway.dispatchHttp`，不会经过目标节点的 `HubRuntime` 或 `MeshHttpRuntime`。  
  **影响：** `POST /n/B/api/auth/challenge` 到达 B 后被旧 gateway API 返回 404，因此远程节点根本无法登录；`/n/<hub>/api/hub/nodes` 同样永远到不了 hub 路由。即使改成调用 mesh，目前 stream 构造的 Request 也没有设置 `via=peerNodeId` 和 `auth`，登录挑战绑定及 hub 鉴权仍会失败。  
  **建议修复：** 提供统一的目标侧 HTTP dispatcher，按 `hub → mesh auth/mesh routes → gateway` 分派；扩展 dispatch context，先在 Request 上设置实际 `peerNodeId`、原始 session auth 和已验证 uid，再进入该链路，且避免重新进入 entry forwarder。

- `packages/app/src/runtime/assemble.ts:100`  
  **问题：** guard 检查的是重写前路径，`/n/self/*` 和 `/n/<本机 nodeId>/*` 不以 `/api/` 开头，随后却会被 mesh 重写成受保护的本地 API。  
  **影响：** 未登录请求 `GET /n/self/api/mesh/nodes` 可读取节点证书投影、地址和 inventory；`GET /n/self/api/mesh/rtc-config` 可直接取得 TURN 用户名和 credential。  
  **建议修复：** 对路由规范化后的本地目标 Request 执行 guard，而不是只检查原始 URL；严格识别 `self` 和实际本机 nodeId，并加入无 cookie、编码斜杠、尾斜杠及 HEAD/OPTIONS 覆盖测试。

## Major

- `packages/app/src/runtime/assemble.ts:108`  
  **问题：** mesh 对 `/n/self/*` 建立的 rewrite 不会传给 gateway；mesh 未处理时，assembly 仍把原始 Request 交给 `gateway.handleRequest`。  
  **影响：** 即使用户已登录，`/n/self/api/devices` 和 `/n/self/ws` 分别落入 SPA/升级失败；本机 `/n/self/api/hub/*` 也无法进入 hub，违反 entry 侧本地路由规范。  
  **建议修复：** 让 self 路由返回规范化后的 Request，或提供统一的本地 dispatch 函数，使重写后的请求继续按 `hub → guard → mesh → gateway` 执行。

- `apps/gateway/src/mesh/mesh-runtime.ts:313`  
  **问题：** 节点状态始终广播 `ws://127.0.0.1:<port>/peer`，而实际 PeerServer 默认监听所有接口；hub 不会把该地址改写成 uplink 对端地址。  
  **影响：** 两台不同机器收到的 peer endpoint 都指向各自本机，握手会连接错误节点并因 nodeId 不符失败，所有 LAN 直连只能退化为 relay。  
  **建议修复：** 广播真实可达的 LAN/IPv6 接口地址，并将 PeerServer 的绑定地址作为独立、显式配置；不要把通配监听地址或 loopback 当作跨节点 endpoint。

- `packages/app/src/runtime/server.ts:40`  
  **问题：** SIGINT/SIGTERM 处理器在默认 `standalone` 模式下也无条件安装，改变了旧版本的监听器和信号退出行为。  
  **影响：** 所有存量 standalone 安装收到 SIGTERM 后会进入新的异步清理及五秒超时路径，而不是维持原行为，直接违反“standalone 无新 listeners、行为不变”的兼容要求。  
  **建议修复：** standalone 保持原启动路径和信号行为；仅在启用 mesh 角色时安装新增关停编排，或证明并实现完全一致的旧信号语义。

- `packages/app/src/runtime/assemble.ts:18`  
  **问题：** 总关停超时是 5 秒，而 Gateway 内部 `AgentSupervisor` 自身就允许等待 5 秒，之后还要停止 push、tmux、Telegram、微信等组件。  
  **影响：** 活跃 agent 使用完整内部超时时，外层定时器会先调用 `process.exit(1)`，后续 gateway 清理和 `server.stop(true)` 没有机会完成。  
  **建议修复：** 让总超时大于各阶段最坏耗时之和，或向各组件传递统一截止时间；超时预算必须覆盖完整的 peer、uplink、hub、gateway 和服务器关闭流程。

- `packages/app/src/runtime/assemble.ts:179`  
  **问题：** `stop()` 没有幂等或并发合并机制；信号处理器中的 `stopping` 只防止两个信号重复执行，无法与 restart 回调协调。  
  **影响：** `/api/settings/restart` 正在执行时若服务管理器同时发送 SIGTERM，两条路径会并发调用 `mesh.stop()`、`hub.stop()` 和 `gateway.stop()`，可能重复关闭 peer、WebSocket、tmux runtime，并由先完成的一方提前退出进程。  
  **建议修复：** 在 assembly 内缓存唯一的 `stopPromise`，所有 restart、SIGINT、SIGTERM 路径共享它；服务器停止和退出也应由同一个 shutdown coordinator 负责。

## Minor

- `apps/gateway/src/mesh/mesh-runtime.ts:108`  
  **问题：** in-memory uplink 通过强制类型转换调用 `UplinkClient` 的私有 `bindLink`、`authenticate`、`setState`、`startHeartbeat` 等状态机细节。  
  **影响：** 这些私有成员被重命名或重构时，此处的手写接口仍可通过类型检查，但 `hub,node` 会在运行时出现“方法不存在”或状态机分叉；普通 node 的 WebSocket uplink 测试无法覆盖这种回归。  
  **建议修复：** 在 `UplinkClient` 提供正式的 link factory/transport 注入入口，让 WebSocket 和 InMemoryLink 复用同一公开连接循环与认证状态机。

结论：该 diff 目前不宜合并。远程登录与 hub 目标路由因目标侧 dispatcher 缺失而不可用，同时本地 `/ws` 和 `/n/self` 存在实际鉴权绕过；此外 LAN endpoint、standalone 兼容及关停编排仍有明确回归。