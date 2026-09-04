# 第二十六轮结果：1.1.28

## 一、交付

| 任务 | 结果 |
|---|---|
| 1 登录名预填 UUID | 后端 `/api/auth/mode` 在 username 等于 uid 或形如 UUID/32-hex 时返回 null；前端登录页永不预填，空输入 / username 为空 / 等于 uid 时按 `mode.uid` 登录（`resolveLoginUid`、`loginPreflight` 纯函数）。现网 B 回环实测登录框为空，随便输入用户名亦可登录。 |
| 2 PWA 冷启动焦点 | sidebar context 一次性 `suppressInitialFocus` → 自动展开的 Sheet 传 `initialFocus={false}`；关闭按钮改 `focus-visible` 焦点环。首版 focusin+blur 启发式在 StrictMode 下失效，审查后弃用。 |
| 2 首屏英文 | `resolveInitialLanguage`（localStorage `tmex.site.language` 缓存 → `navigator.languages`），站点设置成功写缓存、失败不再降级 en_US。 |
| 2.1 加载设备失败 | 真因：B 由 hub 改中继后 node id 变化，PWA 里旧入口签的 `tmex_s_<id>` cookie 让目标报 401 `via_mismatch`，前端只看 cookie 存在就认为已登录。跨入口实测复现（docker-node 签的 cookie 拿到 B：401、无 Set-Cookie、`loggedIn:true`）。修：入口在目标明确判会话无效（`via_mismatch/expired/revoked/unknown`）且请求确实带了该 cookie 时 Set-Cookie 过期之（仅规范 32-hex id）；前端 `node-session-recovery` 对 `NODE_LOGIN_REQUIRED` 自动重登录一次并重取；设备面板显示真实原因 + 重试；`NODE_UNREACHABLE` 带安全 `reason`。 |
| 4 本机 tab 重构 | 卡头（角色徽标 + 唯一状态徽标 + 溢出菜单）+ 连接 / 中继服务 / 网络 三段；删除双 tab 与 localStorage 偏好、重复的 standalone 中继向导、`｜` 拼接详情、「通用设置」标题、`directSwitchHint`；内部标识收进「连接详情」折叠；hub 时代文案按角色改正；本机状态非 401 失败可重试；中继角色未接入时按中继语义显示（后端此时 `mode:"hub"` 为既有行为）。 |
| 4.1 中继性能监控 | `GET /api/relay/metrics`（5 s 采样、60 点历史、进程/租户/成员维度）、成员 RTT / 重连 / 流数、`LinkMux.stats()`、`sealed_pack_updated_at`（迁移 0046）；`Sparkline`/`StatTile` 原语；本机卡片 4+3 精简瓦片；中继 tab 12 格分「流量 / 进程」+ 三条趋势 + 成员表。临时 relay,node 实例接入自身中继后实测：在线 1/1、链路 1、帧速率 ≈0.8/s、事件循环折线正常。 |
| 5 失败与遗留 | CI：`relay-hardening.test.ts` 未观察的 `read()` 拒绝；panels 15 失败为 `mock.module('react-i18next')` 污染；tsc 7 条清零；`viewport-policy.spec.ts` 改为「最小可见客户端为 owner」；`forwarder.ts` 拆四个模块回到门禁内。 |

审查：R1（后端 3 条全修）、R2（前端 4 条全修）、R3（指标后端 5 条全修）、R4（前端 6 条全修）。

## 二、e2e 发现的严重问题（已修）

首版「401 即清 cookie」在 mesh e2e 里把刚签发的会话删掉了两次：一是登录前并发发出、不带 cookie 的请求，其 401 响应晚于登录的 Set-Cookie 到达；二是目标上按入口会话鉴权的接口（`/n/<id>/api/mesh/connection`）对有效的按节点 cookie 也回 401 `{code:NODE_LOGIN_REQUIRED}`。最终规则：请求带了该 cookie **且** 目标 401 体的 `error` 是会话校验原因之一才清；WS 升级失败的回退 401 不再清。

## 三、测试计数（终态）

gateway、fe、stores、panels、ui、shared、api-client、app 全部 0 fail（见 `sub/` 各结果与本轮日志）；tsc 全部 0；根 lint + 复杂度门禁 ok；e2e 标准套件 110/1（`terminal-render-regressions` bug2 负载抖动，单跑 5/5）；mesh 12/12；viewport-policy 2/2。

## 四、实测方法

- B 真实数据：`ssh -f -N -L 127.0.0.1:29884:127.0.0.1:9883 shanghai` + vite `TMEX_GATEWAY_URL=http://127.0.0.1:29884`（回环免 passkey；29883 被 docker-node 占用）。
- 本机卡片 / 中继指标：dev 网关不含 `/api/local/*`、`/api/setup/*`，需 `bun run build` 后跑 `packages/app/dist/runtime/server.js`（`NODE_ENV=test`，setup 会写 worktree 根 `test.env.local`，测完必须删）。
- 截图在会话 scratchpad `shots/`。

## 五、遗留

1. R1-#3/#4（round 25）仍不修；`packages/app` 的 `metrics-types.ts` 成员 `name` 恒为 null（中继侧无 name 列）。
2. 新建 relay,node 的 `/api/mesh/relay/status` 返回 `mode:"hub"` 与占位 hub 候选 `http://127.0.0.1`（既有后端行为），本轮只在前端按角色规避。
3. B 经中继首个远端请求约 18 s（直连拨号超时后才退中继，`dcBreaker` 熔断中），未在本轮处理。
4. 现网各节点仍是 1.1.27；PWA 的四个问题都在 B 上生效，需把 B（及其余节点）升级到 1.1.28。
