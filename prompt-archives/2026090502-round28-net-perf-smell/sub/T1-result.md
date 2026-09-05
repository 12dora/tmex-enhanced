# T1 结果：cloudflared 边缘地址解析（fake-IP 劫持绕过）

## 背景与结论

本机（生产机，只读排查）系统解析器是 Surge 增强模式，`*.argotunnel.com` 被解析成
198.18.0.0/15 的 fake-IP，cloudflared 到边缘 7844 的 QUIC/TCP 全部被代理吞掉，进程常驻但
0 边缘连接。cloudflared 支持 `--edge <host:port>`（可重复），给了静态列表就完全跳过
SRV/DNS 发现。本任务在网关侧加了「检测 fake-IP → DoH 解析真实边缘 IP → 带 `--edge` 拉起
cloudflared」的链路，并把结果暴露到 `/api/tunnel/status` 的新字段 `edge` 供前端降级面板使用。

## 改动文件

- **新增** `apps/gateway/src/tunnel/edge-resolver.ts`
  - `isFakeIp(ip)`：198.18.0.0/15；IPv6/垃圾输入返回 false，不抛错。
  - `isUnusableEdgeIp(ip)`：fake-IP + 私网/环回/链路本地/组播/CGNAT，DoH 结果过滤用。
  - `resolveEdgeViaDoh(fetchImpl, signal?, now?)`：DoH JSON 查 `_v2-origintunneld._tcp.argotunnel.com`
    的 SRV（`accept: application/dns-json`；cloudflare-dns.com 失败回落 dns.google），再查各
    SRV target 的 A 记录；SRV 失败时直接回落 `region1/region2.v2.argotunnel.com` + 7844。
    结果按 region 交错、去重、最多 8 条；单请求 5s、总预算 10s；无可用地址时抛错。
  - `resolveEdge(opts)`：系统 lookup（默认 `dns.promises.lookup(..., { all: true })`，可注入）→
    任一地址是 fake-IP 就走 DoH；DoH 成功 `mode: 'static'`，失败 `mode: 'system'` + `lastError`；
    未检测到 fake-IP 不发 DoH。env `TMEX_TUNNEL_EDGE_ADDRS`（逗号分隔 `host:port`，运行时读
    `process.env`，未进 loadEnv schema）优先，仍会计算 `fakeIpDetected`。**永不抛错**。
  - `describeEdge(edge)`：拉起时的单行日志文本。
- `apps/gateway/src/tunnel/spawn.ts`：`SpawnHandle` 增加 `edge?: TunnelEdgeResolution | null`。
- `apps/gateway/src/tunnel/provider.ts`：新增可选第 4 个构造参数
  `{ resolveEdge?, log? }`（原三参签名保持兼容）；导出 `edgeArgs()`；`spawnNamedRun` /
  `spawnQuickRun` 拉起前解析一次，`mode==='static'` 时在 `run` 前插入 `--edge <addr>`（named
  模式必须在子命令前，`--edge` 是 `tunnel` 命令的 flag），并把结果挂到 `handle.edge`；解析
  抛错时静默回落到无 `--edge`。
- `apps/gateway/src/tunnel/supervisor.ts`：新增 `edge` 字段，spawn 时从 `child.edge` 同步，
  `stop()` 清空。
- `apps/gateway/src/tunnel/manager.ts`：
  - 新选项 `resolveEdge` / `edgeRecoveryDelayMs`；默认非测试环境用真实
    `resolveEdge({ fetchImpl, now })`，`config.isTest` 下返回 null（避免单测打真实 DNS/网络）。
  - `status().edge`：托管模式返回当前解析（外部接管返回 null）；`stop()` / `jobStop` 清空。
  - `jobCheck` 的 `connector_down` 与 `connectorHint`（0 连接时）追加提示：
    `edge DNS resolved to fake-IP 198.18.x (local proxy); static edge override active|failed: <err>`。
  - 自愈：连接器轮询中若托管进程连续 ≥90s（`edgeRecoveryDelayMs`，默认 90_000）报 0 连接、
    且当前是 `mode: 'system'`，重新解析一次；拿到 static 地址就**只重启一次**（`edgeRecoveryDone`
    标志，连接恢复 >0 才复位），沿用 supervisor 既有 stop/start 与退避；外部接管的 cloudflared 不动。
- **新增** `apps/gateway/src/tunnel/edge-resolver.test.ts`（19 例）：fake-IP 判定、SRV/A JSON
  解析、well-known 回落、DoH 端点故障转移、8 条上限、env 覆盖、系统 lookup 失败、全失败不抛错、
  provider `--edge` 只在 static 模式追加（含 named 模式 `--edge` 在 `run` 之前）、解析器抛错不阻塞拉起。
- `apps/gateway/src/tunnel/manager.test.ts`：新增 `TunnelManager edge resolution` 两例
  （status 暴露 edge + check 的 fake-IP 提示；90s 后一次性带 `--edge` 重启且不重复）。

`packages/shared` 未改动（`TunnelEdgeResolution` / `TunnelStatusResponse.edge` 已由契约提前加好）。

## 验收

- `cd apps/gateway && bun test src/tunnel src/api/tunnel-routes.test.ts`
  - 改动前：190 pass / 0 fail（13 文件）
  - 改动后：**211 pass / 0 fail**（14 文件，787 expect）
- `bunx tsc --noEmit -p apps/gateway`：无输出（0 错误，与基线一致）。
- `bunx biome check <改动文件>`：Checked 7 files, no fixes applied（干净）。
- `apps/api/tunnel-routes.ts` 未改：路由直接透传 `manager.status()`，新增字段不破坏既有断言。

## 本机实测（脚本在 scratchpad，未入库；未启动 cloudflared、未碰生产 tmex）

```
system lookup: [["region1.v2.argotunnel.com",["ERR DNSException: getaddrinfo ENOTFOUND"]],
                ["region2.v2.argotunnel.com",["198.18.92.12"]]]
resolveEdge  : {
  "mode": "static",
  "fakeIpDetected": true,
  "edgeAddrs": ["198.41.192.227:7844","198.41.200.13:7844","198.41.192.167:7844",
                "198.41.200.53:7844","198.41.192.77:7844","198.41.200.33:7844",
                "198.41.192.47:7844","198.41.200.43:7844"],
  "checkedAt": "2026-09-05T01:33:44.466Z",
  "lastError": null
}
```

与预期一致：系统解析器给出 fake-IP（region1 甚至直接 ENOTFOUND），DoH 拿到真实边缘 IP 并
按 region1/region2 交错输出 8 条。

## 遗留 / 待确认

1. **只做 A 记录，未查 AAAA**。IPv6-only 网络下 DoH 会拿不到可用地址，回落 `mode: 'system'`
   并在 `lastError` 说明。若要支持，扩 `resolveEdgeViaDoh` 加 type=28 并按 `[v6]:port` 拼装。
2. **静态边缘列表不会自动刷新**。只在每次拉起 cloudflared 时解析一次；Cloudflare 边缘 IP 变更
   后需重启隧道（或等自愈逻辑触发）。是否需要定期刷新 + 平滑重启，待产品决定。
3. **自愈只在 metrics 可达时生效**：判断依据是 `/ready` 的 `readyConnections === 0`；metrics
   端点探不到（`reachable === false`）时不触发重启，避免误杀。
4. **`--edge` 会同时关掉 SRV 发现**：若静态列表全部不可达，cloudflared 不会自己回落到系统解析。
   目前的保护是「只在检测到 fake-IP 时才启用 static」，正常网络永远走系统解析。
5. `TMEX_TUNNEL_EDGE_ADDRS` 只做了 `host:port` 形状校验，没做连通性预检；属运维/调试逃生口。
6. 前端文案映射（degraded 面板展示 fake-IP 提示）由 FE 侧任务处理，后端消息保持英文。
