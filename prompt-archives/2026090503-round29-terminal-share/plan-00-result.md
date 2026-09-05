# 第二十九轮结果：1.1.34（终端分享）

分支 `feat/round29-terminal-share`，worktree `/Users/konata/code/tmex-r29`，基线 main `227481eb`（1.1.33）。
分工：Opus 子代理（探索 EX1–EX3、编码 T1–T10、审查修复 RF1–RF3、文档 DOC）、
codex gpt-6-astra high（backend / frontend / mesh 三路审查）。

## 一、交付

| 任务 | 结果 |
|---|---|
| 1–5 终端分享 | 后端 T1（共享类型 `@tmex/shared/share`、四张表 + 迁移 0047、share 服务 / 存储 / 录制器 / 地址候选 / 巡检、owner 8 条与 share-access 3 条路由）、T2（ws 作用域：`GatewaySession.shareScope`、入站白名单、出站元数据过滤、广播排除、1501 `SHARE_FORBIDDEN`、4410 `closeShareSessions`）、T3（`tmex_sh_<via>` cookie 与 `x-tmex-set-share*` 头翻译、`share:<token>` 流 auth、公开路径、4401/4410 穿透 Hub 与中继的终止性关闭码）；前端 T4（工具栏按钮 + 分享弹窗）、T5（`/s/:id` 页在 RootLayout 之外、专用运行时零常规 `/api/*`、4410/4401 处理、移动端键盘避让）、T6（设置「分享」tab：进行中 / 历史 / 日志回放时间轴 / 设置）。文档 `docs/share/2026090503-terminal-share.md` |
| 6 PWA 节点加载慢 | EX2 定位七条假设。T8a 前端：pending 不再整节隐藏（改渲染节点头 + 上次快照占位）、`tmex:mesh-nodes` 首帧缓存（只存身份与在线态）、mode 与 nodes 并发 + 1/3/10 s 有界重试、有会话钥时静默登录一次、页面可见 / online 时 mesh WS 退避清零。T8b 后端：前台拨号竞速（DC 2.5 s 预算 → 并行 ws-secure，直连 4 s 总限）、forwarder 取链路 5 s deadline、hub presence 90 s 陈旧窗口、指纹变化重置 uplink 退避。文档 `docs/frontend/2026090504-sidebar-node-first-paint.md` |
| 7 链路信息窗 i18n | T7：23 个稳定直连失败码 + 参数（`wsCode`/`dcCode`），零端点与熔断冷却不再是静默洞；ICE 状态 / 候选类型 / 候选对按枚举翻译，未知码回落原文等宽。文档 `docs/hub/2026090505-direct-failure-codes.md` |
| 8 遗留清理 | T7 Job B：`uplink-pool.anyAbort` 监听器泄漏改用共享 `combineAbortSignals`。T9：升级下载阶段持续字节进度（inflight 扇出、content-length、512 KiB/500 ms 节流），关闭 KI-2。T10a：hub / mesh 两条 ctl 解码 switch 合并为参数化 `decodeUplinkCtl`，`uplink-server.ts` 2224 行拆为六个协作模块，退掉 4 条 allowlist 条目 |
| 9 顺手修复 | `getLink()` 残留 pending 挡住后台升级、`maybeUpgrade()` 合并后丢重试、录制器因 pane 未同步丢弃输入、显式指定的分享地址被误当内网拒绝 |

## 二、提交（`git log --oneline 227481eb..HEAD`）

```
1c1d5026 fix(mesh): 前台取链路不再先烧满 15 s DC 超时…（T8b + Hub 分享登录限速）
57abd18e fix(uplink): 编解码合并遗漏的三段式尺寸门与 9 组报错文案逐字还原
c03f2fd0 fix(fe): 分享审查修复（RF3）
b45b93e2 fix(share): 审查修复（RF1）
22591087 refactor(hub): 合并两条 uplink ctl 解码 switch；UplinkServer 拆六个协作模块（T10a）
2a09098b fix(share): 显式地址不再强制公网；录制器不再丢输入；新增 mesh e2e 分享用例
8046d986 feat(update): 升级下载阶段持续字节进度（T9，关闭 KI-2）
730ca2ed fix(fe): 侧栏节点首屏（T8a）
d27ff1c6 fix(mesh): 直连失败码 + 按码 i18n；uplink-pool anyAbort 泄漏（T7）
efd6e214 feat(share): 终端分享前端（T4/T5/T6）
01884713 feat(share): 终端分享后端（T1/T2/T3）
```

RF2（mesh 侧审查修复）在文档定稿时与本文并行落地，内容见第三节。

## 三、审查（codex gpt-6-astra high，三路）

| 路 | 结论 |
|---|---|
| backend | 13 项：1 blocker（异步抓屏 / 读历史返回后不复核归属）、1 major（开放模式把分享连接升成普通连接）、并发登录绕过限速、Hub 共用限流桶、失效 cookie 阻断重登、丢 4401 等，其余 minor |
| frontend | 4 major（分享 WS 未绑定 shareId、Hub 失效 cookie、Hub 丢 4401、回放裁画面）+ 5 minor |
| mesh | 7 项：1 blocker（开放模式绕过隔离）、5 major（失效 cookie、来源 IP、失效常规 cookie 遮蔽分享凭证、初验丢 4401、升级期间到达的撤销事件丢失）、1 minor（`{{until}}` 原文） |

**已修**：

- **RF1（后端 / ws）**：抓屏与读历史在异步返回后、发 Begin 之前复核 scope；pane 移出即撤销租约订阅并丢弃
  待发批次；`ShareMetadataView` 只为「曾暴露、现已移出」的实体发 removal；限速改成验证前预占额度 +
  第 10 次失败硬锁 15 min + 同（分享, IP）并发验证上限 2；`endShare` 先刷录制缓冲再置态；长期分享续期时
  重新下发 cookie 头；开放（未启用登录）部署禁止创建分享（`SHARE_AUTH_REQUIRED`）；`share-session-index`
  补 `dispose()`。
- **RF2（mesh）**：分享 ws 握手强制按 `?share=<id>` 绑定该分享凭证、不回退常规会话；分享公开 HTTP 路径上
  失效的分享 cookie 降级为匿名（WS 仍严格拒绝）；初次分享 ws 鉴权失败改用
  `encodeTerminalStreamClose(4401, 'SHARE_LOGIN_REQUIRED')`；开放模式禁止创建分享的装配侧接线；
  熔断无解除时刻时下发 `breaker_paused`。
- **RF3（前端）**：分享页 ws 带 `share=<id>` 并按 `nodeId+shareId` 重建运行时；回放开启视口平移并交还
  `touch-action`；分享模式隐藏分屏 / 关闭 pane / 标题栏拖动（保留 splitter 与尺寸仲裁）；弹窗重开预选默认
  地址、以列表查询为准；错误码统一映射 i18n；设备查询失败不再覆盖成功快照。
- **T8b**：Hub 侧按（真实来源 IP, shareId）的分享登录配额，复用节点侧同一个限流器实现。

**判定不修**：

1. **节点侧感知真实来源 IP**（backend #5 / mesh #3 的彻底解法）。要新增一条 Hub 可信填写、浏览器不可覆盖的
   peer 上下文字段，改动面跨 forwarder / stream 协议；Hub 侧配额已经堵住实际的误锁场景，登记为 KI-8。
2. **把 `/api/share-access/*` 公开前缀收紧到三个端点 + 方法**（mesh optional）：当前该前缀下没有别的路由，
   收紧只防未来失误，属过度防御；真要防，靠的是「新增路由时不要挂在这个前缀下」的约定。
3. **回放改增量索引**（frontend optional）：单条录像上限 50 MB、分页 2 MiB 边下边播，实测无卡顿。
4. **`nodes.hub` zh_CN / `relay.admin.tenants.columns.id` ja_JP 的「订正」**：两处都符合各自语料的既定用法与
   文案规范，改了反而不一致。

## 四、测试终态

| 包 / 套件 | 结果 |
|---|---|
| `apps/fe` `bun test src/` | 2598 pass / 0 fail（155 文件） |
| `apps/gateway` `bun test src/share src/ws` | 430 pass / 0 fail |
| `apps/gateway` `bun test src/mesh` | 1347 pass / 0 fail（97 文件） |
| `apps/gateway` `bun test src/api src/db` | 537 pass / 0 fail |
| `apps/gateway` `bun test src/hub` / `src/system` / `src/relay` / `src/mesh/integration` | 231 / 170 / 159 / 63，全 0 fail |
| `packages/shared` | 793 pass / 0 fail |
| `packages/panels` | 1004 pass / 0 fail |
| `packages/api-client` | 245 pass / 0 fail |
| `packages/stores` / `packages/terminal-ui` / `packages/app` | 432 / 394 / 898（1 skip），全 0 fail |
| `bunx tsc --noEmit` | 各包 0 错 |
| `bunx biome check` | clean |
| `bun scripts/complexity/gate.ts` | ok，0 stale；本轮退掉 4 条 allowlist 条目（`decodeHubInner` cc 42、`decodeMeshUplinkCtl` cc 32、`encodeMeshUplinkCtl` cc 49、`uplink-server.ts` 2247 行），未放宽任何条目 |

**实测**：mesh e2e 分享用例在独立 detached checkout 上**连跑两次全绿**：

```bash
cd apps/fe && TMEX_E2E_MESH=1 TMEX_E2E_MESH_ONLY=1 bun run scripts/run-e2e.ts tests/mesh-share.spec.ts
```

覆盖 Hub 转发路径下的创建分享 → 无痕上下文打开链接 → 输口令 → 只见该 window（其它 window 与设备名不可见）
→ 输入生效 → 终止后收到 4410 → 日志有内容。

## 五、坑

1. **录制器不能拿「pane 已同步」当输入的准入条件**。`recordInput` 原本要求 `panes.has(paneId)`，而 pane 集合
   靠 2 s 轮询设备快照更新——新开的 pane 上敲的第一批字符会被静默丢弃。改成见到陌生 pane 先触发一次同步再记账。
2. **合并解码器时，「重新编码后的字节一致」不足以证明等价——调用方按报错文案分流时，文案就是行为**。
   T10a 首轮漏掉 mesh 尺寸门的中间一段，把超尺寸非 `key.log.res` 帧的 `ctl too large` 变成
   `ctl string too long`，直接改写了 `uplink-reconnect.mapUplinkCtlError` 的指标标签与重连判定。
   修复后把比较口径升级为「接受/拒绝 + 重编码字节 + 报错类名 + 报错文案」逐字比对，语料补齐
   「超尺寸 × 17 种类型 × pending 开关」，8596 组 0 差异，并把文案钉进 `codec-parity.test.ts`。
3. **e2e 环境里没有公网地址**：hub 只有 localhost，自动候选为空，创建分享直接 `SHARE_ORIGIN_INVALID`。
   用例先 `PUT /api/share/settings` 显式指定默认分享地址；同时把 `rankShareOrigins` 改成
   「自动候选过滤内网，用户显式填的 `custom` 不过滤」——内网演示分享本来也该能用。
4. **分享连接不能靠「无常规会话」来识别**：已登录的浏览器打开分享页时会优先命中常规会话，连接没有
   `shareScope`，撤销也关不掉它。最终改成握手显式带 `?share=<id>`，带参数一律走分享鉴权。
5. **并发子代理踩同一批共享文件**：locale JSON、`scripts/complexity/allowlist.json`、`docs/known-issues.md`
   只能定点编辑，编号整理与 `--tighten` 留到收尾统一做。多个 agent 在途时，`tsc` / `bun test` 的红要先归因
   到别人的在飞文件再判断。

## 六、遗留

1. `apps/gateway/src/mesh/peer-manager.ts` 上帝类拆分（KI-7 余项）仍未立项。
2. Hub 转发不把浏览器来源 IP 带给节点，节点端分享限速在该路径上空转（KI-8，Hub 侧配额兜底）。
3. 本机自升级仍无下载字节进度（KI-9）；`upgrade.ts` 贴着行数 allowlist，要先拆文件。
4. 录制器跟随 pane 靠 2 s 轮询设备快照；日志保留按日志行 `at` 裁剪而非按分享结束时间整条删。
5. 分享的并发口令验证上限固定为 2；同一 NAT 后大量访客同时首次登录需要把
   `SHARE_LOGIN_MAX_CONCURRENT` 提到 4–8。
6. 折叠的远端在线分节与未登录分节仍以「至少开过一台设备」为显示门槛，是「节点不出现」的另一类原因。
7. 发版 1.1.34 与本地 tarball 升级本机为收尾步骤，按 `docs/release/2026041300-cli-release-process.md` 执行。
