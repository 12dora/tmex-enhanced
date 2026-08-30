# Topic C：Settings 页面结构与远程访问（Tunnel）现状报告

仓库根目录：`/Users/konata/code/tmex-enhanced-wt-r5`

## 结论摘要

- Settings 由 `apps/fe/src/pages/SettingsPage.tsx` 统一注册六个 tab；路由既支持本机 `/settings`，也支持 mesh 入口下的 `/n/:nodeId/settings`。当前没有“远程访问”tab。
- 现有 terminal tab 很适合作为 UI 结构模板，但它同时包含浏览器本地偏好和服务端共享快捷键两种保存模型，不能直接套用到主机级 tunnel 配置。
- 代码已经支持“外部 TLS 由 Cloudflare Tunnel/nginx/caddy 终止”的兼容模式，以及 `TMEX_TRUST_PROXY` 配置；Cloudflare API 代码只服务于 ACME DNS-01，不是 cloudflared tunnel 管理。
- mesh 的跨 NAT 连接已经有 node→hub 的出站 uplink、hub relay、节点间 peer link 和 reach/transport 状态，但没有 cloudflared 的安装、登录、创建 tunnel、DNS route 或服务托管 API。
- `apps/gateway/src/system` 不是通用主机管理模块；主机 env、服务安装、进程执行等能力主要在 `packages/app` 的安装版 CLI/runtime 内部，当前没有安全地暴露给前端的通用接口。
- 最接近目标的异步交互模式是 setup wizard、enrollment watcher 和 TLS ACME pending 轮询：预检查 → 提交 → 展示结果 → 等待重启/轮询状态。cloudflared 登录与服务启动仍需要新的、受限的后端任务模型。

## 1. Settings 页面结构

### 路由、tab 列表与注册方式

`apps/fe/src/main.tsx:244-272` 的 `pageRoutes()` 注册页面模块；`settings` 路由在 `:265-267`：

```tsx
{ path: 'settings', element: <PageWrapper moduleLoader={settingsModule} /> }
```

同文件 `:275-286` 把 `pageRoutes()` 放到根路由和 `/n/:nodeId` 子路由下；因此入口有 `/settings` 与 `/n/:nodeId/settings` 两种路径。`:280-281` 还保留了 `/nodes -> /settings?tab=nodes` 和 `/account/security -> /settings?panel=security` 的重定向。

`apps/fe/src/pages/SettingsPage.tsx:40-64` 定义 tab 类型、数组和 URL 参数校验：

```ts
type SettingsTab =
  | 'general'
  | 'devicesAndFiles'
  | 'nodes'
  | 'notifications'
  | 'ai'
  | 'terminal';

const SETTINGS_TABS = [
  'general',
  'devicesAndFiles',
  'nodes',
  'notifications',
  'ai',
  'terminal',
] as const;
```

`SettingsPage.tsx:86-128` 将 tab 转成 `tabItems`。当前视觉顺序是：

| tab 参数 | 中文 i18n key | 组件 |
|---|---|---|
| `general` | `settings.tabGroup.general` | `GeneralSettingsTab` |
| `terminal` | `settings.tabGroup.terminal` | `TerminalSettingsTab` |
| `devicesAndFiles` | `settings.tabGroup.devicesAndFiles` | `DevicesAndFilesTab` |
| `nodes` | `settings.tabGroup.nodes` | `NodesTab` |
| `notifications` | `settings.tabGroup.notifications` | `NotificationSettingsTab` |
| `ai` | `settings.tabGroup.ai` | `AiSettingsTab` |

实现并非动态插件注册：新增 tab 需要同时修改 `SettingsTab`、`SETTINGS_TABS`、`tabItems` 以及渲染分支。`SettingsPage.tsx:130-169` 通过 `activeTab` 条件渲染内容，`:74-84` 从 `?tab=` 读取并用 `navigate` 替换 URL。

### 当前 Settings 表单的加载与保存

站点设置使用 TanStack Query + React state，没有使用 react-hook-form：

- `apps/fe/src/pages/settings/use-site-settings-form.ts:25-30` 使用 `useQuery`、`useMutation`、`useQueryClient`、`useRuntime` 和 `useSiteStore`。
- `:52-63` GET `/api/settings/site`，`:67-74` 将服务端值映射为 draft。
- `:76-102` PATCH `/api/settings/site`，body 由 `buildSiteSettingsPayload(draft)` 生成；成功后 invalidate query、刷新 site store 并 toast。
- `:104-123` 用普通 React state 合并字段并暴露 `save/isSaving`。
- `apps/fe/src/pages/settings/site-settings-form.ts:8-76` 集中定义 draft、默认值、服务端映射与 payload。

`apps/fe/src/pages/settings/general-settings-tab.tsx:14-89` 和 `notification-settings-tab.tsx:13-151` 都是受控字段 + `SettingsSaveButton`。设备/文件和 AI tab 是面板组合：`devices-and-files-tab.tsx:1-9`、`ai-settings-tab.tsx:1-9`。

后端对应路由在 `apps/gateway/src/api/settings-routes.ts:20-50`：site GET/PATCH、terminal shortcuts GET/PATCH；路由注册在 `:65-95`。重启接口 `:54-63` 仅调用 `runtimeController.requestRestart()`，不是主机服务管理器。

### Terminal tab：可复用模板与边界

`packages/panels/src/settings/terminal-tab.tsx:1-33` 明确分成两张 Card：

```tsx
<TerminalSettingsPanel showShortcuts={false} />
<TerminalShortcutsEditor />
```

- `TerminalSettingsPanel`（`terminal-settings-panel.tsx:41-73`）读写 `useUIStore`，保存字体、行高、字体 ID、键盘行为等浏览器本地偏好；`:75-205` 是受控输入、范围校验与预览。
- `TerminalShortcutsEditor`（`TerminalShortcutsEditor.tsx:56-88`）是 draft、拖拽、输入、预览、loading/error/retry 和显式保存 UI。
- `use-terminal-shortcuts-editor.ts:137-149,245,314` 允许注入 load/save/query key，默认使用当前 runtime 的 gateway；API 在 `packages/api-client/src/terminal-shortcuts.ts:4-25`，GET/PATCH `/api/settings/terminal-shortcuts`。
- `packages/panels/src/settings/index.ts:1-29` 是 settings panel 的导出入口。

远程访问 tab 可以复用 Card、状态 header、错误/重试和显式保存按钮，但主机操作不应复用浏览器 `useUIStore` 的本地偏好模型。

### i18n 与现有 Settings 测试

- 源翻译位于 `packages/shared/src/i18n/locales/zh_CN.json:193-260`；tab key 为 `settings.tabGroup.general/devicesAndFiles/nodes/notifications/ai/terminal`，terminal 文案和 shortcut 文案在 `:226-260`。
- 英文同一结构见 `packages/shared/src/i18n/locales/en_US.json:193-260`；日文 locale 也有对应 settings key。
- `packages/shared/src/i18n/resources.ts`、`types.ts` 是生成文件，不应直接编辑；应修改 locale 源文件后运行现有 i18n 构建脚本。
- `apps/fe/src/pages/SettingsPage.test.tsx:1-90` 覆盖六个 tab、顺序、i18n key、互斥渲染、URL deep link、非法参数回退 general，以及 `settingsTabFromParam`。

## 2. Remote access、TLS 与 mesh 连接现状

### 已存在的公开暴露支持：外部 TLS 兼容模式

`apps/fe/src/pages/settings/nodes/https/external-panel.tsx:1-68` 的说明明确把外部 TLS 实现列为 “Cloudflare Tunnel/nginx/caddy”；该面板实际只编辑 `trustProxy`，并提示保存后重启。它不会安装或控制 cloudflared。

TLS API 的真实边界：

- `apps/gateway/src/tls/types.ts:1-70` 定义 `none/external/selfsigned/acme` 及公开状态/私密材料类型。
- `packages/app/src/runtime/tls-routes.ts:6-58` 提供 GET/PUT `/api/tls`、POST `/api/tls/renew`、GET `/api/tls/ca.crt`；`:61-101` 解析四种 mode。
- `packages/api-client/src/local/tls-types.ts:1-106` 中 `cloudflareToken` 只属于 ACME `dns-01` 更新请求；`hasCloudflareToken` 是脱敏状态字段。
- `apps/gateway/src/tls/tls-config-store.ts:16-24,94-166` 加密存储私密材料，只返回布尔存在状态，不返回明文 token。
- `packages/app/src/tls/tls-service.ts:277-345` 的 external mode 主要写入 `TMEX_TRUST_PROXY`、停止本地 TLS listener 并标记需要重启；ACME mode 才使用 Cloudflare DNS token。

前端 ACME 也证明 Cloudflare 目前是 DNS challenge 依赖，而不是 tunnel 管理：`apps/fe/src/pages/settings/nodes/https/acme-panel.tsx:80-120,199-220` 仅在 `dns-01` 展示 token；`packages/app/src/tls/cloudflare-dns.ts:1-90` 只调用 Cloudflare DNS API 创建/删除 TXT 记录；`acme-service.ts:61-79,145-180` 将它注入 ACME DNS 流程。

### 配置含义：`TMEX_BASE_URL`、Hub public URL 与 proxy

- `apps/gateway/src/config.ts:133-141` 将 `TMEX_BASE_URL` 读为 gateway base URL，默认 `http://127.0.0.1:8085`。
- `packages/app/src/lib/install.ts:45-56` 从 bind host/port 生成安装版的 `TMEX_BASE_URL`；它是本机 gateway 地址，不是 tunnel 公网地址。
- `apps/gateway/src/config.ts:179-191` 同时读取 `TMEX_HUB_URL`、`TMEX_HUB_PUBLIC_URL`、`TMEX_PEER_PORT`、STUN/TURN、`TMEX_PEER_BIND_HOST` 和 `TMEX_TRUST_PROXY`。
- `docs/hub/2026082800-hub-node-operations.md:27-37` 定义 `TMEX_HUB_PUBLIC_URL` 为 Hub 对外 HTTPS 地址，且 Hub 初始化的非交互模式要求提供它。
- 同文档 `:209-219` 的 Cloudflare 建议是：`TMEX_BIND_HOST=127.0.0.1`，cloudflared 指向本机 `9883`，`TMEX_HUB_PUBLIC_URL` 写 tunnel 的 HTTPS 域名，增加 `TMEX_TRUST_PROXY=true` 后重启。

这说明当前产品把 tunnel 当作外部部署组件；Hub public URL 是 mesh/Hub 语义，不能用 `TMEX_BASE_URL` 代替。

### Hub uplink、relay 与 NAT 路径

可观测的数据流如下：

```text
浏览器 → entry gateway /n/:id/*
       → mesh Forwarder → PeerManager 选择已有 peer link
       → 节点间 direct/peer 或 Hub relay

node → 出站 WSS /hub/uplink → hub
hub → 为目标 node 打开 uplink stream → pumpRelay → node
```

证据：

- `apps/gateway/src/mesh/uplink-protocol.ts:21-28` 把 Hub URL 转为 `ws/wss` 并固定路径 `/hub/uplink`。
- `apps/gateway/src/mesh/uplink-client.ts:66-97,414-442` 支持 hubUrl、身份、TLS CA，并建立出站 WebSocket；`:318-348` 发送 node status、heartbeat 和 relay open。
- `apps/gateway/src/mesh/uplink-client.ts:459-525` 绑定 link、处理 relay OPEN 和 uplink auth；`:534-553` 处理 `node.list`、`rtc.signal` 等控制消息。
- `apps/gateway/src/hub/uplink-server.ts:738-865` 验证 node 证书/签名、维护在线 registry、接收 status；`:1120-1181` 校验 relay 目标并 pump relay/heartbeat；`:1279-1344` 生成 node list。
- `apps/gateway/src/mesh/forwarder.ts:126-139,416-500` 处理 `/n/:id` 的 HTTP/WS 转发；远端不可达返回 `NODE_UNREACHABLE`，无目标 node session cookie 返回 `NODE_LOGIN_REQUIRED/4401`。
- `apps/gateway/src/mesh/peer-manager.ts:518-543,579-590` 获取或拨号 peer link，归类 `relay` 或 `lan`；`apps/gateway/src/mesh/types.ts:50-73` 定义 `ws-secure/relay/dc` transport 与 `lan/relay` reach。
- `apps/gateway/src/mesh/node-list-projection.ts:12-24,84-149` 把 online、reach、transport、direct_capable、loggedIn、isHub 投影成前端 DTO；`mesh-routes.ts:91-111,195-229` 提供 GET `/api/mesh/nodes`。
- `apps/gateway/src/mesh/mesh-runtime.ts:707-718,755-827,925-937,1200-1227` 上报 endpoint/direct 能力、创建 uplink、处理节点列表和 uplink offline。

操作文档 `docs/hub/2026082800-hub-node-operations.md:188-207` 给出 direct/ICE 顺序：同 LAN、IPv6、STUN、TURN、Hub relay；UPnP/NAT-PMP 尚未实现。`apps/fe/src/node/mesh-nodes.ts:35-57,254-346` 通过 `/api/mesh/nodes` 加事件流并每 30 秒轮询刷新 reach/transport/online；Hub 管理 API 在 `apps/fe/src/node/hub-api.ts:1-36,63-112`，路径是 entry gateway 的 `/n/<hub>/api/hub/*`。

### Hub join code / enrollment

现有“Hub join code”不是 tunnel token，而是一次性 enrollment/join token：

- `apps/fe/src/node/enrollment.ts:522-624` 创建一次性 key、向 Hub 创建 enrollment、生成 v1/v2 join token；`:634-667` 清零原始 token buffer。
- `apps/fe/src/node/enrollment.ts:670-705` 只信任 HTTPS Hub URL（开发本地 HTTP 例外），生成 `npx tmex-cli hub join ... --token ...` 命令。
- `apps/fe/src/pages/settings/nodes/management/enrollment-section.tsx:1-5,133-210` 只在内存/临时 session 显示 join secret、显示命令，并以 `public_url` 或 mode 中的 Hub public URL 解析命令地址。
- `apps/fe/src/node/enrollment-watch.ts:1-9,69-163` 通过 `/mesh/ws` 的 `ENROLL_REDEEMED` 推送和 `/n/<hub>/api/hub/enrollments/:id` 每 5 秒轮询等待兑换。
- `packages/app/src/commands/hub.ts:508-646` CLI join 校验 token、写入 `TMEX_ROLES=node`/`TMEX_HUB_URL`、清空 node 的 Hub public URL并重启服务。

相关 i18n 在 `packages/shared/src/i18n/locales/zh_CN.json:1440-1456`（enrollment）和 `:1482-1575`（setup wizard），不是 tunnel 配置文案。

### Docs/CLI 中 tunnel 的实际范围

`README.md:78-87`、`README.zh-CN.md:79-88` 只建议 Cloudflare Access/Tailscale 作为远程访问方案。`docs/2026021000-tmex-bootstrap/deployment.md:73-77,149-175` 说明 Cloudflare Tunnel/nginx/Caddy 反代到 `127.0.0.1:9883`，并要求 WebSocket upgrade 和 `TMEX_TRUST_PROXY=true`。

全仓源码检索 `cloudflared|cloudflare|tunnel` 的结果中，没有 cloudflared 安装、登录、创建 tunnel、route DNS、运行服务的实现；CLI 帮助和参数也没有 tunnel 命令：`packages/app/src/cli/help.ts:3-42`、`packages/app/src/lib/args.ts:3-18`、`packages/app/src/index.ts:1-98`。其中唯一 Cloudflare 专用实现是 ACME DNS client。

## 3. Gateway system 模块与可复用主机能力

### Gateway 现有 system API

`apps/gateway/src/api/system.ts:24-49` 只有 `/api/system/info`、更新检查和升级相关处理；`:52-91` 是 update/upgrade。`apps/gateway/src/api/system-routes.ts:60-65` 仅把 `/api/system/*` 交给 system handler。`apps/gateway/src/system/info-public.ts:1-45`、`managed.ts:1-103`、`install-info.ts:1-91` 负责系统信息、管理模式和安装信息。

唯一接近进程控制的是 `apps/gateway/src/system/upgrade.ts:1-142`：它为自身升级 spawn `bun add` 并 detached 执行 `tmex-cli upgrade --apply-current-package`。这不是通用命令执行器。

重启也很窄：`apps/gateway/src/control/runtime.ts:1-30` 只有 listener flag/request；`apps/gateway/src/api/settings-routes.ts:54-63` 的 POST restart 调用它。

因此当前不存在以下 Gateway API：

- 检查或下载 cloudflared binary；
- 交互式或 token 式登录；
- 创建 tunnel、配置 ingress、route DNS；
- 启动、停止或查看 cloudflared service；
- 读写 `app.env` 的通用 GET/PATCH；
- 通用 spawn、任务进度、日志流或取消接口。

### packages/app 中可以借鉴但不能直接暴露的能力

- `packages/app/src/lib/process.ts:1-77` 的 `runCommand(command,args,options)` 支持 spawn、pipe、timeout、kill；它是 CLI 内部工具，不能直接变成前端可传任意 command 的 API。
- `packages/app/src/lib/env-file.ts:1-123` 支持解析 env、解析 symlink、atomic write、merge missing；`install-layout.ts:14-43` 将 `<installDir>/app.env`、runtime/resources/native 组织成安装布局。
- `packages/app/src/lib/service.ts:9-390` 有 systemd/launchd unit 构建、install/start/stop/uninstall/status，但这些函数面向 tmex 安装服务；没有 cloudflared 专用 unit、配置目录、版本管理或安全状态模型。
- `packages/app/src/commands/init.ts:265-306` 负责写 app.env、run script、安装 tmex service；`commands/hub.ts:254-320,589-646` 负责写 roles/hub URL 和重启；均不是 tunnel workflow。
- `packages/app/src/runtime/setup-service.ts:140-185,325-412` 有 env 写入锁、原子 patch、重启调度和 setup transition；`:462-516` 暴露 local status/direct；`:610-745` 实现 becomeHub/joinHub。
- `packages/app/src/runtime/local-routes.ts:53-103` 只提供 `/api/local/status`、`/api/local/direct`、`/api/local/leave`；direct action 仅为 install/remove/enable/disable。`packages/api-client/src/local/local-api.ts:47-78` 是其客户端。

这些原语说明“执行有限主机变更、原子写配置、安排重启、查看 service status”已有实现基础，但 cloudflared 还缺少全套领域模型与 API。尤其不要把 `runCommand`、明文 app.env 或 Cloudflare token 直接交给浏览器。

## 4. 现有异步长流程与可复用向导模式

### Hub setup / join wizard

`apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:1-106` 是 standalone 本机 setup 入口，用 `Reveal key={path}` 在 Become Hub 与 Join Hub 两步之间切换。

- `join-hub-form.tsx:37-110,113-208` 管理 URL/token/name/direct/insecureLocal 的受控状态；提交前通过 `submitJoinHub` 检查旧 health，POST 后展示 result，并接 `RestartPanel`。
- `become-hub-form.tsx:39-145,263-299` 有 precheck 状态、预检查结果、提交状态、错误和结果展示。
- `apps/fe/src/pages/settings/nodes/setup/submit.ts:1-50` 先读取 `/healthz.startedAt`，再 POST `/api/setup/hub` 或 `/api/setup/join`。
- `packages/api-client/src/local/setup-api.ts:47-112` 封装 precheck/becomeHub/joinHub；`packages/app/src/runtime/setup-routes.ts:10-59` 提供本机 setup 路由；`setup-service.ts:325-340` 在 transition 后调度重启。
- `apps/fe/src/pages/settings/nodes/setup/form-parts.tsx:1-160` 提供 `SetupNotice`、`FormField`、`SwitchRow`、带 elapsed/loading/success/timeout/CLI fallback 的 `RestartPanel`。
- `apps/fe/src/pages/settings/nodes/restart/use-restart-now.ts:9-115` 与 `wait-for-restart.ts:1-123` 使用 downtime + health/`startedAt` 变化确认重启；默认探测间隔 1 秒，超时 60 秒。

### Enrollment 的推送与轮询模式

`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:35-179` 组合 Hub/node 列表、刷新、创建 enrollment、admit action 和离线禁用状态。`enrollment-watch.ts:1-163` 同时使用 `/mesh/ws` push 与 Hub API 轮询，以应对推送丢失或 Hub 暂时不可达。

`use-admit-action.ts:36-220` 将 root 自动签名、passkey 用户手势、提交、等待 Hub ack、unknown/stale/error disposition 分开处理。这是涉及凭证和长等待时可借鉴的安全边界。

### TLS self-signed/ACME 异步状态

- `https-section.tsx:1-4,41-100,170-385` 负责 mode 选择、busy/confirm/restart orchestration。
- `tls-mutations.ts:1-124` 将 save/renew 序列化，必要时先确认停止 listener，并在错误后刷新状态。
- `use-tls-status.ts:1-70` 明确 PUT 返回 pending 后轮询 GET；`refetchInterval` 在 ACME pending 时为 3 秒。
- `selfsigned-panel.tsx:1-149` 是校验、提交、CA 展示的表单模板；`external-panel.tsx:1-68` 是轻量配置模板。

对应测试：

- `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx:34-167` 覆盖 wizard path、Become/Join 渲染、insecureLocal、token textarea。
- `apps/fe/src/pages/settings/nodes/https/https-section.test.tsx:90-299` 覆盖加载、none/external、self-signed、ACME pending/token/error 和 busy lock。
- `apps/fe/src/node/enrollment-watch.test.ts:59-180` 覆盖轮询、push、unknown/multiple；`enrollment.test.ts:370-422` 覆盖 token、内存清理和 public URL。
- `packages/app/src/runtime/setup-routes.test.ts:124-226`、`setup-service.test.ts` 覆盖 setup 路由、互斥和 env/lock；`packages/app/src/commands/join.test.ts:622-659` 覆盖 join 写 env 与重启。
- TLS 后端/CLI 侧测试在 `packages/app/src/tls/tls-service.test.ts:115-245`、`acme-service.test.ts:117-230`、`cloudflare-dns.test.ts`。

这些流程可以复用“步骤 UI、受控状态、后端状态查询、重启等待、错误 code 映射”结构；不能假设 cloudflared 的 login/create/route 是一个同步 HTTP 请求，因为当前仓库没有对应任务或持久状态实现。

## suggested implementation plan

1. 先确定作用域：远程访问是配置当前 entry node、Hub，还是允许在 `/n/:id` 对任意 node 配置。现有 `LocalApi`/`/api/local/*` 默认代表本机；若支持远端，必须明确 API 是否走 `/n/:id`，不能让入口节点误改自身。
2. 新增领域状态与受限 API，建议放在 `packages/app/src/runtime` 与 `packages/api-client/src/local`，或为明确的 gateway proxy 增加对应模块。至少区分 binary、认证、tunnel、DNS route、service、public URL、错误和任务状态；不要新增通用 exec 或通用 app.env 读写。
3. 在 `packages/app` 增加 cloudflared provider/command 和独立 service 配置。复用 `process.ts`、`env-file.ts`、`service.ts` 的安全与原子写入模式，但为下载校验、版本、配置文件、systemd/launchd unit、start/stop/status 建立 cloudflared 专用实现。登录优先采用非交互 token 或受控授权流程；现有 `runCommand` 没有面向浏览器的 stdin/交互会话协议。
4. 在 `apps/gateway` 或安装版 runtime 增加窄化的分步 endpoint：preflight、install、authenticate、create/route、start/status、cancel（如确有需要）。长任务使用持久 job/status 或事件加轮询，不把子进程 stdout 原样暴露给前端。
5. 新增 `apps/fe/src/pages/settings/remote-access-tab.tsx` 并在 `SettingsPage.tsx:40-169` 注册；建议沿用 setup wizard 的步骤卡片、`SetupNotice`、`RestartPanel`，沿用 TLS 的 busy lock、pending 轮询与错误刷新。若每台 node 可单独配置，应把入口放进节点管理或节点详情，并复用 `/n/:id` 目标语义。
6. i18n 只修改 `packages/shared/src/i18n/locales/zh_CN.json`、`en_US.json`、`ja_JP.json` 的源 key；不要手改生成的 `resources.ts/types.ts`。为安装、登录、tunnel、DNS、service、proxy header、重启和失败恢复分别提供明确文案。
7. 测试覆盖：新增 runtime/provider 的命令与 service mock、env 原子写入/回滚、重启和状态转换测试；新增 gateway auth、权限和并发测试；新增 Settings tab、步骤跳转、错误、轮询和刷新测试。验证时只使用仓库临时 test 环境，不读取或重启本机生产 tmex。

主要陷阱：不要把 `TMEX_BASE_URL` 当公网地址；不要把 Hub join token 当 Cloudflare 凭证；不要把 ACME Cloudflare DNS token 逻辑误当 tunnel API；不要在 node offline 时让 UI 把 entry gateway 的本地状态当成远端状态；不要复用 tmex service 名称而覆盖现有服务；不要在没有任务恢复、取消和超时边界的情况下启动可长期运行的 cloudflared 进程；Cloudflare Tunnel 前置仍需正确代理 `/ws`、`/n/:id/ws`、`/mesh/ws`、`/hub/uplink`，并保持 `TMEX_TRUST_PROXY` 语义清晰。