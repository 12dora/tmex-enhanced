# 临时双实例实测：POST /api/local/leave（2026-08-29，commit 8de33cf）

脚本 `live-leave.ts`（仓库源码起 hub,node + node 两个 production 模式实例，独立 install dir 与 tmux socket，端口 215xx/295xx/395xx，不触碰生产）。hub 开自签 HTTPS（`PUT /api/tls selfsigned`）后 `enroll` 出 v2 加入码，node 经 `hub join https://localhost:<tls>` 加入。

| 步骤 | 结果 |
|---|---|
| standalone 调 leave | 400 `not_member` |
| node 未登录调 leave | 401 |
| node 登录后 `expectedRole=hub,node` | 409 `role_mismatch` |
| node 登录后 `expectedRole=node` | 200 `{ok,fromRole:node,restarting}`；自退出后被拉起为 standalone；`app.env` `TMEX_ROLES=standalone`、`TMEX_HUB_URL=`、`TMEX_HUB_PUBLIC_URL=`；users/user_key_log/user_keys/node_sessions/node_certs/nodes/enrollment_tokens/peer_cache/hub_trust/node_identity 全部 0 行；`/api/auth/mode` → `none`；hub 侧该节点转为离线记录 |
| 再次 enroll + join | 成功，节点身份为新 id（旧记录留在 hub，可在 hub 吊销） |
| hub,node 登录后 leave | 200；重启为 standalone，10 张表清空，`mode:none` |
