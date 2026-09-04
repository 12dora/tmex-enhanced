# 本机隧道「无边缘连接」只读排查（2026-09-05）
- cloudflared 2026.8.3 pid 5771，由 tmex 4464 拉起（00:09:39），config: tunnel 21cd0c16 → tmex.konata.tv → 127.0.0.1:9883
- 127.0.0.1:51992/ready → 503 {"readyConnections":0}；metrics ha_connections=1（陈旧计数）；lsof 只有 metrics 监听，无任何边缘 socket
- `cloudflared tunnel info 21cd0c16` → does not have any active connection（云端确认）
- https://tmex.konata.tv/healthz → 302 到 misaka10086.cloudflareaccess.com（边缘/Access 在答，源站没到）
- nc region1/region2.v2.argotunnel.com:7844 → FAIL；dig region1 → 198.18.91.209（Surge fake-IP）
- nc 198.41.192.167/198.41.200.13/198.41.192.7:7844 直连 IP → OK；443 OK
=> 真因：Surge 把 *.argotunnel.com 走了代理策略，代理不通 7844（TCP/QUIC）。tmex/UI 报的是真实状态。
修法（用户侧）：Surge 规则加 `DOMAIN-SUFFIX,argotunnel.com,DIRECT` 与 `DOMAIN-SUFFIX,cftunnel.com,DIRECT`（QUIC 用 UDP 7844，也建议放行 UDP）。
