# Prompt 存档

日期：2026-07-10
分支：`vibex/ws-socket-factory`（基于 `vibex/main`，即 A1 前端拆包后的九包结构）

## 背景

`@tmex/ws-client` 的 `BorshWebSocketClient` 在 `connect()` 里硬编码 `new WebSocket(url)`，并直接读全局
`WebSocket.OPEN` / `WebSocket.CONNECTING` 常量。这意味着：

1. 宿主只能替换 **URL**，不能替换 **transport 本身**。若宿主希望把 ws-borsh 帧承载在别的通道上
   （例如一条多路复用的长连接、或一个受控的隧道），现有 API 无法接入——`wsUrl` 指到别处也不行，
   因为那条通道往往有自己的握手/分帧语义，不是一个裸 WebSocket 端点。
2. 依赖全局 `WebSocket` 构造器与其静态常量，使得非浏览器环境（测试、SSR 探测）下 import 即受限。

A1 拆包已经把 URL 惰性化并提供了 `createGatewayConnection({ wsUrl })` 工厂（为本地/远程双端点切换准备），
但 transport 注入点仍然缺失。本次补上这一层。

## 任务

给 `BorshWebSocketClient` 增加可选的 `socketFactory`，允许宿主提供任何满足 `WebSocketLike` 结构的对象；
默认实现保持 `new WebSocket(url)`，行为完全不变。同时把 `readyState` 的比较改为本地常量，不再依赖全局
`WebSocket` 的静态属性。

`createGatewayConnection` 透出同名选项。

## 约束

- 默认行为零变化：不传 `socketFactory` 时与改动前逐字节等价。
- `WebSocketLike` 必须是浏览器 `WebSocket` 的结构子集，且足以支撑 `client.ts` 现有的全部用法
  （`readyState` / `binaryType` / `onopen` / `onmessage` / `onclose` / `onerror` / `send` / `close`）。
- 不引入新依赖。
- 补测试：默认工厂仍被使用；自定义工厂被调用且拿到正确 URL；注入的 socket 能驱动连接状态机。

## 结果

见同目录 `plan-00-result.md`。
