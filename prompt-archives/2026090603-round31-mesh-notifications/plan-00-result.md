# Round 31 执行结果

分支 `feat/round31-mesh-notifications`，worktree `/Users/konata/code/tmex-r31`，版本 1.1.36。

## 交付
| 项 | 结果 | 提交 |
|---|---|---|
| 多节点通知汇聚（A） | 汇聚声明随节点状态 `inventory.notifySink` 复制（hub/中继/直连三路，按最新权威观测选取）；节点侧 `mesh-forward` 通道每 sink 有界合并队列（20 条 / 3 分钟，键 nodeId:deviceId:paneId:eventType）、单在途、15 s 投递截止、退避重试、桥清空即收敛；汇聚侧 `/api/mesh-internal/notifications` 对端标记 + 未知节点拒绝 + IdleLru 限流 60/min + 事件类型白名单 + 节点名自查 + 202 快回；节流键含 nodeId；带 nodeId 的事件不转发（防环路与远程 agent 重复） | 03c798a1、df94df0d |
| 范围加固（C）+ 前端 | 通知页横幅、「多节点通知」卡片（10 s 轮询 + 节点变化失效）、节点详情「通知设置」入口；入口页固定订阅 `KIND_NOTIFY_EVENT`（此前 Web 端无消费者）；直连/转发 toast 共用身份去重注册表（`packages/notifications/toast-dedupe.ts`，2 s 合并窗、10 s TTL）；`/n/<入口id>` 归一为 self | 5284de5a、0cb518a7 |
| 分享密码 | `shares.password_enc`（AES-GCM）、`GET/POST /api/share/:id/password`（no-store）、修改可选踢人（作废凭证 + ws 4401）、登录验密后复核哈希/状态；带密码链接 `#p=`（预填不提交、消费后抹掉、同文档导航亦消费）；设置行菜单查看/修改/复制带密码链接；Safari 手势内同步写剪贴板 | 010a8c09、2aff2a47、f90bedf5 |

## 设计偏离
- 汇聚声明未走 key-log（仅 root/passkey 可签），改走 inventory；被攻破的 hub 可伪造 sink 标记（中继模式免疫），文档已明示。
- 文案统一用「密码」而非「口令」（与既有分享文案一致）。

## 审查
codex gpt-6-astra high 三片（`sub/R1-be-review`、`R1-fe-review`、`R1-share-password-review`）共 17 条，全部修复（RF4–RF6）。

## 验证
- 八包 tsc 0；根 lint + 复杂度门禁 ok；单测 gateway 4911/10（mesh phase-2 环境性）、fe 2693/0、panels 1039/0、shared 795/0、api-client 252/0、app 936/0、stores 435/0、notifications 23/0。
- mesh e2e 17/17（mesh-notify 真实转发 toast、mesh-share 新增带密码链接预填与改密踢人/保留两条）；默认项目 settings/mobile-settings/watch 5/5。

## 踩坑
- `WATCH_EVENT`/tmux 事件无网关时间戳，去重只能靠 id 字段 + 到达时间窗。
- `setupWatchEventHandlers` 用 WeakSet 永不注销，路由别名必须在 runtime id 层归一，否则会出现双 toast。
- 60 s latest-release 缓存与 i18n 全局 mock 的跨包串扰同 round30。
