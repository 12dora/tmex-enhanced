# O4 结果 — 第十四轮实测驱动 `live-r14.ts`

## 交付物

- `prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/live-r14.ts`（唯一新增文件，1303 行）
- 未改动任何源码；无 git 操作。运行副本放在 scratchpad `live/`，与交付物逐字节相同。

## 怎么跑

```bash
cp prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/live-r14.ts \
   /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c87e7d41-4167-4f04-b03f-99760894dfcc/scratchpad/live/
cd /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c87e7d41-4167-4f04-b03f-99760894dfcc/scratchpad/live
bun run live-r14.ts all          # 或 ADMIT / RELAY / FORWARD / UNINSTALL / ROLE / TOKENS
# KEEP=1 保留 LIVE_ROOT，LIVE_ROOT=<dir> 指定根目录
```

全套约 **90 秒**，每部打印 `PASS <part>` / `FAIL <part>: reason`，有 FAIL 则退出码 1。
脚本从**任意目录**都能跑（对 `packages/shared/src/auth`、`packages/app/src/lib/hub-client` 用绝对路径 import，头部注释已注明这两处必须与 `REPO` 常量同步）。

## 实测结果（全部自己跑通）

`bun run live-r14.ts all` 跑了两轮（G6 落地前 / 后），两轮都是 **PASS ADMIT / RELAY / FORWARD / UNINSTALL / ROLE / TOKENS，`DONE failures=none`，退出码 0**，各约 90 s。
另外单跑过一次 `ADMIT` 复核收尾清理（LIVE_ROOT 自动删除、tmux socket 与 socket 文件清干净、无残留 server 进程）。日志要点：

| 分部 | 关键证据 |
|---|---|
| ADMIT | A 的 `app.env` **没有** `TMEX_HUB_PEERS`；A 与 C 的 `/api/mesh/hubs` 都给出 `{id:B, mode:standby, authorization:'signed'}`，`writerHubId=A` |
| RELAY | D 挂 B、C 挂 A；写者投影 `attachedHubId`：`[{C→A},{D→B}]`；`C → /n/<D>/api/system/info` 与 `D → /n/<C>/…` 双向 **200** |
| FORWARD | 经 B 的 `POST https://B/api/hub/enrollments` → **201**，响应头 `X-Tmex-Forwarded-By: <B nodeId>`，token 行确实落在 A 的 `enrollment_tokens` |
| UNINSTALL | F 本机 `POST /api/system/uninstall` → **409 `{code:UNINSTALL_NOT_ALLOWED, reason:no_service_manager}`**；入口中继 `POST /api/mesh/nodes/<F>/uninstall` → **409 同码**；`GET …/operation` → `phase:'failed'`（不是悬挂的 requested/uninstalling），F 仍存活 |
| ROLE | demote A（transition `complete`）→ promote B **省略 writerEpoch，服务端分配 epoch=2** → C 在 ~2 s 内 failover 到 B → A 重启后日志 `[hub] starting fenced: higher writerEpoch=2 from hub=…` 且仍是 standby → 再 promote A（epoch=3）写者切回，C 挂回 A |
| TOKENS | 写者 A 建 token → 复制到 B（见下）→ 杀 A → B 提升为写者（epoch=4）→ 新实例 E 用同一 token `hub join https://B` 成功，B 上该 token `used_at` 非空且 `node_id=E`，E 的 `admit-node` 落链 |

## 设计要点（和 r13 的差异）

- **不再用 playwright**。本 worktree 只有 `apps/fe/node_modules/@playwright/test`，从 scratchpad 无法解析；改成纯 HTTP：
  - 本机会话复用 `packages/app/src/lib/hub-client.ts` 的 `loginWithRootKey`（从 `/api/auth/mode` 的 kdfParams 派生根钥）；
  - **节点会话按入口分桶**：node 会话绑定签发它的 `viaNodeId`，直连拿到的 sid 不能经 `/n/<id>/…` 用。脚本实现了 `loginVia(entry,target)`，走入口的 `/api/auth/challenge` + `/api/auth/login`（forwarder 的 `AUTH_SKIP` 只放行这两条，所以**不能**先读 `/n/<id>/api/auth/mode`），`login.entry` 必须填入口 node id 否则 `ENTRY_MISMATCH`。
  - 结果：全套 90 s（r13 单 Part B 就要几分钟）。
- **join 流程全自制**：`createEnrollment` + `POST /api/hub/enrollments` + `encodeJoinToken` + `tmex hub join` + 轮询 `/api/hub/enrollments/<id>` + 自签 `admit-node` 提交 `POST /api/auth/keylog?hub=sync`。比 r13 扒 `tmex enroll` 的 stdout 稳，且能指定**从哪台 hub** join（D 必须 join B）。
- **版本门**：`hub.tokens` / `hub.attachments` / `hub.write-forward` / `admit-hub` 都要求对端 ≥ 1.1.13，而仓库 `packages/app/package.json` 还是 1.1.12。production 下版本从 `install-meta.cliVersion` 读，因此实例的 install-meta 一律写 `cliVersion: "1.1.13"`，并在 bootstrap 里断言 `/api/mesh/nodes[].version === '1.1.13'`。**发版号一变，改这一个常量即可。**
- **`platform: 'live'`**：`deploymentFromPlatform` 只认 darwin/linux，写成别的即 `deployment: 'none'`，正是 UNINSTALL 分部要的 `no_service_manager` 守卫；也如实反映临时实例没有服务管理器。r13 写的是 `darwin`，那样卸载会走到 spawn 再因为找不到 `cli/bin/tmex.js` 500，测不到守卫。
- **端口整块预检**：`freeBase()` 一次校验 6 组 `base+k / base+100+k / base+200+k`。首次实测就撞上 Syncthing 占着 22000（r13 只检查了 gateway 端口）。
- **`TMEX_FE_DIST_DIR`**：production 的 `loadEnv` 会校验目录存在，而本 worktree 没有 `apps/fe/dist`。脚本在缺失时自动造一份占位静态根（本驱动只打 HTTP API）；有真 dist 时优先用真的。
- 所有实例 `TMEX_UPLINK_PREFER_NEAREST=0`，独立 install dir / 端口 / tmux socket（`tmex-live-r14-*`），全部 127.0.0.1。**全程没有碰生产 tmex（9883 仍在跑，install dir 未读写）与 `tmex` tmux session**；收尾按 `DATABASE_URL=<LIVE_ROOT>` 精确杀进程、kill 自己的 tmux socket 并删 socket 文件。

## 必须知道的取舍：RELAY 的分裂是人为制造的

本机两台 hub 互相可达时，普通 node 的候选顺序永远「active 优先」（`MeshHubStore.list()` 排序 + failback 探测），**没有任何合法手段让 D 长期挂在 standby 上**（生产里靠网络分区，或 G6 的 RTT 就近挂载）。因此脚本在 D join 完成后，往 D 的 `hub_trust` 插一条「A 的 URL ↔ B 的 CA」的错误 pin——`uplink-pool` 对已存在的 pin 不覆盖（`hubTrust.get(url)` 命中即 return），D 对 A 的 WS 与 `/healthz` 一律 TLS 失败，稳定留在 B。

被这条 hack 影响的只有「D 能否连上 A」；`hub.attachments` 路由表、`attachedHubId` 投影、`hub-relay` 数据面、授权校验都是真实路径。G6 的 `TMEX_UPLINK_PREFER_NEAREST` 落地后，可以改成让 D 自然就近挂 B，届时这段可以删。

## 给 commander 的观察

1. **`replicatedTo` 竞态**：TOKENS 里写者返回的 `replicatedTo` 是空数组，但 2 s 后 B 的 `enrollment_tokens` 里那行**已经存在**；同一次运行里 node-f 的创建又返回了 `["<B>"]`。即「2 s 内 ACK」的语义确实是尽力而为，UI 不能拿空数组当「没复制」。脚本对此做了兜底（空数组时改轮询 B 的库），不判 FAIL。
2. **非 self 的 hub 在别的节点上没有 `authorization` 字段**：C 看 A 是 `authorization` 缺省（A 从未被 `admit-hub`），只有 B 是 `signed`。FE 的角色切换如果硬要求 `authorization === 'signed'` 才让切，生产里必须把**两台** hub 都 admit 一遍，否则切回旧主会被前端拦住。建议在文档/UI 里写清楚。
3. 角色切换刚落地那几秒，入口到目标的 uplink 还没回来，`/n/<id>/api/hub/role` 会先回 **503 NODE_UNREACHABLE**。脚本对 503 做了重试（最长 120 s）；FE 侧最好也别把这个瞬时 503 直接报成失败。
4. 跑了两轮全套：第一轮在 **G6 改 `apps/gateway/**` 的过程中**，第二轮在 **G6 写完 `G6-result.md` 之后**（工作区已含 config / uplink-pool / hub-peer-poller / tls-service 的改动），两轮都 `DONE failures=none`。所有实例的 `TMEX_UPLINK_PREFER_NEAREST=0`、未开 `TMEX_HUB_AUTO_PROMOTE`，G6 的两个新开关都没有干扰既有路径。

## 未做

- 兼容门（节点版本 < 1.1.13 挡住 `admit-hub`）按任务书跳过，实测里没法真造一个旧节点；单测已覆盖。
- G6 的自动 promote / RTT 就近挂载没有分部覆盖（O4 任务书里没有；等 G6 落地后可以加一部）。
- 没跑包级 `bun test` / `tsc` / `biome`：本任务没有改任何包内源文件，`prompt-archives/**` 不在 biome 与 tsconfig 的覆盖范围（`biome check` 对该路径直接 "No files were processed"）。
