# 第二十六轮计划：PWA/登录修复、本机 tab 重构、中继性能监控、CI 清零

## 背景

- 现网已迁为 B（tmexhub-sh，`relay,node`）中继 + 五个纯节点，全部 1.1.27（见 `round25` 档案）。
- 用户在 PWA（tmexhub-sh 域名）上反馈四个问题：登录用户名预填 UUID；冷启动焦点落在关闭侧栏按钮；首屏英文；四台老节点「加载设备失败」。
- 设置 → 多节点互联 → 本机 卡片在 hub/relay 两代功能叠加后字段堆积、逻辑混乱。
- CI `unit-tests` 在 main 上每次都红（relay 测试的未观察 RST 拒绝），panels 本地 15 个失败，tsc 有 7 条基线错误。

## 探索结论（EX1–EX4，见 sub/）

| 问题 | 根因 | 修法 |
|---|---|---|
| 用户名预填 UUID | `relay join`/`hub join` 把 key-log genesis uid 写进 `users.username`；`/api/auth/mode` 原样返回；`LoginPage` 用它做初值 | 后端：username 等于 uid / 形如 UUID 时返回 null；前端：永不预填，空输入按 `mode.uid` 登录 |
| 冷启动焦点 | 移动端 standalone 在 `/` 自动 `setOpenMobile(true)`，Base UI Sheet 打开时聚焦第一个可 tab 元素（关闭按钮） | 自动打开后释放落入抽屉的焦点；关闭按钮改 `focus-visible` |
| 首屏英文 | 只读 `navigator.language`；站点语言要等侧栏/设置页请求成功才应用；请求失败还会把语言降级成 en_US | `resolveInitialLanguage`（localStorage 缓存 → `navigator.languages`），失败不降级，成功写缓存 |
| 加载设备失败 | B 从 hub 改中继后 node id 变了；PWA 里 hub 时代签的 `tmex_s_<id>` cookie 仍在；目标节点校验 `viaNodeId` 报 401 `via_mismatch`；前端 `loggedIn` 只看 cookie 存在，不再走登录门（跨入口实测复现：401 且无 Set-Cookie，`loggedIn:true`） | 后端：401 时 Set-Cookie 过期该 cookie、503 带安全 reason、中继节点列表过滤非 admitted；前端：typed error、`NODE_LOGIN_REQUIRED` 触发一次重登录并重取、面板显示具体原因 |
| CI 红 | `relay-hardening.test.ts` 未观察的 `read()` 拒绝 | 测试保留 reader 并 cancel |
| panels 15 失败 | `device-folder-tree.test.tsx` 进程级 `mock.module('react-i18next')` 污染 | 改用独立 i18n 实例 |
| tsc 7 条 | 测试类型 + `.ts` 后缀动态 import | 逐条修 |

## 本机 tab 重构设计（T4a）

原则：一张卡片按「身份 → 连接 → 服务 → 网络」四段自上而下，状态只出现一次，内部标识默认折叠，操作按风险分级；hub 时代文案对中继节点必须正确。

```
本机                                   [角色徽标] [状态徽标：已连接中继 · 45 ms]   [⋯ 更改角色 / 离开 / 账号安全]
├─ 连接（Uplink）
│   standalone → 单一设置向导（四条路径：设为 Hub / 加入 Hub / 加入中继 / 本机作为中继），删除重复的 StandaloneRelaySetup
│   relay 模式 → 中继行列表（主机、在线徽标、延迟、当前挂载标记、kicked/最近错误内联）
│                提醒堆（kicked / readmit / metaPending / packPending / notAttached 统一样式，各带一个动作）
│                操作：主按钮「追加中继」；次级菜单「重新输入口令 / 轮换元数据密钥 / 移除 <host>」；危险区「离开中继」
│   hub 模式   → 当前 Hub 行 + Hub 列表 chips + 提醒 + 「更换 Hub」
│   ▸ 连接详情（Collapsible，默认收起）：租户编号（可复制）、元数据密钥代数、经中继可见节点数、配额（Progress）、key-log 是否追平、本机 node id（可复制）、Hub 优先级/纪元/授权
├─ 中继服务（仅 relay 角色）→ T4b 的 RelayServiceMetrics：公网地址 + 口令徽标 + 指标瓦片 + 「打开中继控制台」
│   relay.mode==='none' 时显示「接入本机中继」CTA
└─ 网络
    直连插件行（状态徽标 + 开关 + 安装/删除），重启提示内联
    允许域名访问行（开关 + 域名小字）
```

删除：接入 Hub / 接入中继 两个 tab 及其 localStorage 偏好；`relayServiceCounts` 一行式文案；`｜` 拼接的 tooltip 详情；`directSwitchHint`（用禁用态 tooltip）；「通用设置」标题；重复出现的 URL。
改正：`localAddressHint` 按角色；`directRemoveConfirm.description` 按 hub/relay；`BecomeRelayForm` 用中继专用直连文案；local status 非 401 错误要显示。

## 中继性能监控（T5 后端 + T4b 前端）

- 新增 `GET /api/relay/metrics`（relay admin 鉴权，本机登录会话即可），类型见 `packages/api-client/src/relay/metrics-types.ts`；`relay-metrics.ts` 聚合 registry / tenant store / metering / 进程指标 / 事件循环 lag，5 s 采样，60 个样本环形缓冲。
- 采集补齐：成员 RTT（服务端 ping 时间戳）、重连次数、每成员活跃流与速率、frames/s（mux 计数）、密封包 `updatedAt`（迁移 0046）。
- 前端：`packages/ui` 新增 `Sparkline`、`StatTile`；本机卡片精简瓦片；顶层「中继」tab 改为完整仪表盘（趋势 + 成员表），5 s 轮询且页面隐藏时暂停。

## 任务清单与分工

| 任务 | 执行 | 范围 |
|---|---|---|
| EX1–EX4 探索 | codex luna | 只读 |
| T1 CI/测试/tsc 清零 + auth/mode | grok | 见 sub/T1-prompt.md |
| T2a 登录预填 + PWA 焦点 | Opus | apps/fe LoginPage / standalone / sidebar-title |
| T2b 首屏语言 | Opus | apps/fe i18n / packages/stores site |
| T3a 前端过期会话重登录 + 错误可观测 | Opus | api-client client/devices、panels device-management、fe node |
| T3b 后端 via_mismatch 清 cookie 等 | grok | gateway mesh forwarder / relay-node-list / relay-wiring |
| T4a 本机 tab 重构 | Opus | apps/fe/src/pages/settings/nodes/** |
| T4b 指标 UI（Sparkline/StatTile/仪表盘） | Opus | packages/ui、apps/fe/src/pages/settings/relay/**、nodes/relay/relay-service-metrics.tsx |
| T5 中继指标后端 | grok | apps/gateway/src/relay/**、shared mux stats、迁移、api-client admin-api |
| R1/R2 审查 | codex sol | 后端 / 前端 diff |
| 实测 + 发版 + 本机替换 | 指挥官 | 临时实例 + 现网 |

## 验收

- CI 三个 job 绿；各包 `bun test` 0 fail；tsc 0；根 lint 绿。
- 现网 B 公网路径：清掉旧 cookie 后四台节点设备列表正常；不清 cookie 时前端自动重登录。
- 本机 tab 在 standalone / node(hub) / relay,node 三种角色下布局符合设计，无 hub 时代错误文案。
- `GET /api/relay/metrics` 在 B 上返回真实速率与成员 RTT。

## 注意事项

- 现网 B 的 `hub leave` 禁忌与临时实例的 tmux socket 隔离见 memory。
- 前端并行编辑期间不跑 e2e；`viewport-policy.spec.ts` 改为按「最小可见客户端为 owner」断言，放到前端改动收尾后再跑。
