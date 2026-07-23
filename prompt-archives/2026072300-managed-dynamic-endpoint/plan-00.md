# Managed Gateway Dynamic Endpoint Implementation Plan

## 背景与边界

当前 managed Gateway 由外部 owner 启动，但监听地址仍来自静态配置。跨仓计划要求 owner
只注入动态端口请求和一次性 readiness 协议，Gateway 在 listener 建立后发布实际 endpoint。
本计划只改 tmex Gateway，不实现 Companion 侧 parser 或 child 生命周期。

## Task 1：冻结现状与协议

1. 审计 `managed-entry.ts`、`config.ts`、`runtime.ts` 和现有测试。
2. 查本地 Bun 类型定义，确认 `Bun.serve` 的端口 0、`server.port`、stop/reload 与
   WebSocket 生命周期 API。
3. 固定环境变量 `TMEX_MANAGED_ENDPOINT_PATH`、`TMEX_MANAGED_ENDPOINT_NONCE`，固定
   schema v1、loopback 与 payload 上限。

## Task 2：readiness 协议与原子发布

1. 新建 `apps/gateway/src/system/managed-endpoint.ts`，集中负责 env 解析、schema 校验和
   同目录临时文件到目标文件的原子 rename。
2. 新建长期协议测试，覆盖空 nonce、非 loopback host、port 0/越界、未知字段或超大
   payload，以及最终文件完整性。
3. readiness 日志不得包含 nonce 或 owner proof。

## Task 3：managed listener 与 runtime replacement

1. `config.ts` 仅为 managed 入口允许 `GATEWAY_PORT=0`，普通入口维持既有默认值和校验。
2. `managed-entry.ts` 先建立唯一长生命周期 Bun listener，再从 `server.port` 原子发布
   readiness。
3. handler 通过可交换 delegate 调用当前 runtime；交换窗口 HTTP 返回 503，并关闭旧
   WebSocket；runtime restart 不重新绑定 listener。
4. runtime replacement 失败时终止进程，避免 listener 存活但 runtime 永久不可用。

## Task 4：验证与提交

1. 运行 managed endpoint、config、managed-entry version 测试。
2. 运行 `@tmex/gateway` 全量测试，确认普通入口默认端口无回归。
3. 在本目录写 `plan-00-result.md`，记录实现、证据与残余风险。
4. 以 `feat(gateway): publish managed dynamic endpoint` 提交 tmex 改动，不推送，也不提交
   vibex gitlink。

## 风险与验收标准

- 原子 rename 只保证同文件系统语义，因此临时文件必须与目标文件同目录。
- readiness 文件仅是发现协议；Companion 仍须独立校验普通文件、非 symlink、大小、PID、
  nonce、loopback 与 owner proof。
- Gate：managed 端口 0 能发布实际非零端口；普通入口行为不变；runtime replacement 不更换
  endpoint；所有指定测试通过。
