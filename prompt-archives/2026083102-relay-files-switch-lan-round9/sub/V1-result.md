# V1 实测结果：侧栏文件多节点 + 终端链路徽标（临时 hub+node 双实例）

结论：**任务 1（终端头部链路徽标）与任务 2（侧栏 Files 多节点分节）在真实双实例上均按预期工作**，未发现功能性 bug。
下面按 A / B / C 三段给出实测证据、精确 DOM 结构、原始接口返回，以及若干值得记录的观察项。

- 代码来源：`/Users/konata/code/tmex-enhanced-wt-r9`（其他 agent 仍在改，本次实测未修改任何仓库文件）
- 截图与日志：`prompt-archives/2026083102-relay-files-switch-lan-round9/sub/live/`
- 生产环境完全未触碰：临时实例网关端口 21600 / 21601，peer 端口 39111 / 39112，TLS 29600，tmux socket 只用 `tmux -L tmex-r9-live`

---

## 1. 环境与复现命令

harness（改编自 r5 的 `live-r5.ts`，保留 `freePort / appEnv / startLoop / apiLogin / waitNode / joinNode` 结构）与浏览器脚本已归档：

- `sub/live/live-r9-setup.ts` —— 起 hub（`TMEX_ROLES=hub,node`）+ node（先 standalone、`hub join` 后重启为 node），建设备与文件根
- `sub/live/live-r9-probe.ts` —— playwright-core 驱动无头 Chromium 的全部断言

```bash
SCRATCH=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad/live

# 1) 从 worktree 现编 fe dist 到 scratch（一次通过，无重试）
cd /Users/konata/code/tmex-enhanced-wt-r9/apps/fe \
  && bunx vite build --outDir $SCRATCH/fe-dist --emptyOutDir      # ✓ built in 9.22s

# 2) provision 两个实例（harness 内部自动 enroll + hub join + 重启 + 建设备/文件根）
cd $SCRATCH && bun setup.ts        # 写出 $SCRATCH/state.json 后常驻

# 3) 两个实例都切中文（否则 UI 走 TMEX_DEFAULT_LANGUAGE 默认的 en_US，见「观察项 O1」）
curl -X PATCH -H "cookie: <hub cookies>" -H 'content-type: application/json' \
     -d '{"language":"zh_CN"}' http://127.0.0.1:21600/api/settings/site
curl -X PATCH -H "cookie: <node cookies>" -H 'content-type: application/json' \
     -d '{"language":"zh_CN"}' http://127.0.0.1:21600/n/<nodeId>/api/settings/site

# 4) 浏览器实测
cd $SCRATCH && bun probe.ts
```

关键参数：

| 项 | hub | node |
| --- | --- | --- |
| `GATEWAY_PORT` | 21600 | 21601 |
| `TMEX_PEER_PORT` | 39111 | 39112 |
| `TMEX_BIND_HOST` / `TMEX_PEER_BIND_HOST` | 127.0.0.1 | 127.0.0.1 |
| `TMEX_ROLES` | `hub,node` | `standalone` → `node` |
| tmux session（socket `tmex-r9-live`） | `r9hub` | `r9node` |
| 文件根 | `.../live/hub-files`（a.txt / b.txt） | `.../live/node-files`（n1.txt / n2.txt）、`.../live/node-files-2`（m1.txt） |

- hub 侧 mesh id（entry 自身）：`503e85a2e306273e54f49586cf6d99b6`，展示名 `tmex`
- 远端 node：`9e035912f7c1f6376c0f8d7bc2602807`，展示名 `r9-remote-node`
- hub 自建设备 `hub-dev` = `c730a751-…`；node 自建设备 `node-dev` = `f25eb78f-…`

---

## 2. A：侧栏 Files tab 多节点（任务 2）—— 通过

点开 `[data-testid="sidebar-tab-files"]` 后，**确实是两段 node 分节，分节头就是节点名**。

### A.1 观察到的 DOM 结构

```
[data-testid="files-tab"]
├─ 头部行：<span>文件</span> + button[data-testid="files-refresh"][title="刷新文件列表"]
└─ ScrollArea
   ├─ div[data-testid="files-node-section-self"]                 ← entry 自身（hub）
   │  ├─ button[data-testid="files-node-toggle-self"]  文本 = "tmex"      ← 分节头 = NodeBadge
   │  ├─ button[aria-label="拖动以调整节点顺序"]  (GripVertical，整节拖排)
   │  └─ button[data-testid="file-dir-9743c81d-…-/…/live/hub-files"]  文本 = "hub-files" + 设备徽标 "hub-dev"
   │     ├─ button[aria-label="拖动以调整目录顺序"]  (根级 GripVertical)
   │     ├─ button[data-testid="file-item-…/hub-files/a.txt"]  "a.txt"
   │     └─ button[data-testid="file-item-…/hub-files/b.txt"]  "b.txt"
   └─ div[data-testid="files-node-section-9e035912f7c1f6376c0f8d7bc2602807"]   ← 远端 node
      ├─ button[data-testid="files-node-toggle-9e035912…"]  文本 = "r9-remote-node"
      ├─ button[aria-label="拖动以调整节点顺序"]
      └─（未登录时）div[data-testid="files-node-login-9e035912…"]  文本 = "登录后显示文件" + button "登录该节点"
         （已登录时）两个根：node-files / node-files-2，各带一个 aria-label="拖动以调整目录顺序" 的 handle
```

分节头文本逐字：`tmex` 与 `r9-remote-node`（`headerText` 取 `files-node-toggle-*` 按钮的 textContent）。

### A.2 未登录形态（截图前置条件满足）

浏览器 cookie jar 里此时只有 entry 自身会话，远端 node 未登录，分节渲染出登录行：

```json
{"section":"9e035912f7c1f6376c0f8d7bc2602807","headerText":"r9-remote-node",
 "loginRow":true,"loginRowText":"登录后显示文件登录该节点","rootRows":[],"fileRows":[]}
```

截图：`live/A1-sidebar-files-node-signed-out.png`（侧栏）、`live/A1-full-signed-out.png`（整页）

### A.3 登录远端 node 后

走设备页 SPA 内跳登录（`devices-node-login-<id>` 内的 `node-login-<id>`），登录后登录行消失、两个根出现：

```
self            roots=[hub-files(hub-dev)]                     files=[]
9e035912…       roots=[node-files(node-dev), node-files-2(node-dev)]   files=[]
```

展开两侧的根后：

```
self            roots=[hub-files]                    files=[a.txt, b.txt]
9e035912…       roots=[node-files, node-files-2]     files=[n1.txt, n2.txt]
```

- 远端分节展开的 `n1.txt` / `n2.txt` 的 testid 前缀是 node 侧根 id `7379e97f-…`，路径是 node 上的 `/…/live/node-files/*` —— 数据确实来自远端 node（该目录只在 node 的文件根里注册）。
- hub 分节列出 `a.txt` / `b.txt`，同样正确。

截图：`live/A2-sidebar-files-two-sections.png`（两段分节，未展开）、`live/A3-sidebar-files-expanded.png`（展开后）

### A.4 拖拽把手

两级把手都在，用 `aria-label`（`files.rootDragHandle` / 节点级另一条 key）区分，**没有 data-testid**：

- 整节把手：`button[aria-label="拖动以调整节点顺序"]`，每个 `files-node-section-*` 各一个
- 根级把手：`button[aria-label="拖动以调整目录顺序"]`，每个文件根一个（hub 1 个、node 2 个）

（对应源码 `packages/panels/src/files/files-node-section.tsx` 的 `drag.dragHandleLabel`，与 `packages/panels/src/files/files-node-roots.tsx:207` 的 `t('files.rootDragHandle')` → `directory-node-view.tsx:81` 的 `aria-label={drag.label}`。）

### A.5 排序 API 端到端

```
GET  /n/<nodeId>/api/files/roots
  → [["7379e97f-…","node-files",0], ["8a6defcb-…","node-files-2",1]]
PUT  /n/<nodeId>/api/files/roots/order   body={"rootIds":["8a6defcb-…","7379e97f-…"]}
  → 200，返回 [["8a6defcb-…","node-files-2",0], ["7379e97f-…","node-files",1]]
点 [data-testid="files-refresh"] 后侧栏远端分节：
  → roots=[node-files-2, node-files]      ← 顺序确实翻转
```

截图：`live/A4-sidebar-files-reordered.png`

---

## 3. B：终端头部链路徽标（任务 1）—— 通过

从设备页 SPA 内跳进远端 node 的终端页：
`http://localhost:21600/n/9e035912f7c1f6376c0f8d7bc2602807/devices/f25eb78f-…/windows/@2/panes/%252`
（`@2` / `%2` 即 socket `tmex-r9-live` 上 `r9node` 会话的窗口与 pane，已用 `tmux -L tmex-r9-live list-panes -a` 核对。）

### B.1 徽标

`[data-testid="badge-node-link"]` 文本（多次采样）：**`中转 · 14ms`**、`中转 · 4ms`、`中转 · 1ms`。

即本回环环境下 entry↔node 走的是 **relay**（不是 `局域网`/`公网`），带 RTT 后缀，文案是 `中转`——**没有出现旧文案「经 Hub 中转」**。

截图：`live/B1-badge.png`（徽标特写）、`live/B0-device-page.png`（整页）

### B.2 诊断浮层 `[data-testid="ice-diagnostics"]`

点击徽标后浮层每一行（label / value 原样）：

| 标签 | 值 |
| --- | --- |
| （标题）连接详情 | — |
| 到达路径 | 中转 |
| 承载 | 中转 |
| 延迟 | 14ms |
| 已连接 | 3 分钟 |
| 中转地址 | localhost:29600 |
| （标题）未直连原因 | — |
| WebSocket | `refused ws://[240e:390:5e0e:d820:fc86:2a5a:8738:7]:39112/peer` |
| WebRTC | `direct_capable=false` |

**整段文本不含「未知」**（脚本断言 `text.includes('未知') === false`）。

截图：`live/B2-ice-diagnostics.png`（裁剪）、`live/B2-ice-diagnostics-full.png`（整页）

### B.3 `GET /api/mesh/nodes`（浏览器 cookie）

远端 node 的对象（完整响应见 `live/mesh-nodes.json`）：

```json
{
  "id": "9e035912f7c1f6376c0f8d7bc2602807",
  "name": "r9-remote-node",
  "publicKey": "N020N1i_Hq4umV4X_Jr8GcIJjhkOBqwNLewUMfkU9nM",
  "online": true,
  "reach": "relay",
  "transport": "relay",
  "rttMs": 2,
  "version": "1.1.3",
  "direct_capable": false,
  "inventory": { "version": "1.1.3" },
  "loggedIn": false,
  "isHub": false,
  "peerAddress": "localhost:29600",
  "linkSinceAt": 1788183528911,
  "endpoints": [
    "ws://[240e:390:5e0e:d820:10c3:b591:6b3:c485]:39112/peer",
    "ws://[240e:390:5e0e:d820:806d:283:7502:23e]:39112/peer",
    "ws://192.168.3.23:39112/peer",
    "ws://[240e:390:5e0e:d820:fc86:2a5a:8738:7]:39112/peer",
    "ws://198.18.0.1:39112/peer"
  ],
  "directFailure": {
    "at": 1788183662541,
    "ws": "refused ws://[240e:390:5e0e:d820:fc86:2a5a:8738:7]:39112/peer",
    "dc": "direct_capable=false"
  }
}
```

四个新字段 `peerAddress` / `linkSinceAt` / `endpoints` / `directFailure` **全部存在且有值**。
hub 自身那一行（`isHub: true`）如设计所述全部为 `null` / `[]`。

### B.4 终端工具栏按钮（header 内，按 DOM 顺序）

| data-testid | aria-label | lucide 图标 |
| --- | --- | --- |
| `mobile-sidebar-open` | 收起侧边栏 | panel-left |
| `badge-node-link` | （无 aria-label） | activity |
| `split-right-button` | 向右分屏 | square-split-horizontal |
| `split-down-button` | 向下分屏 | square-split-vertical |
| （无） | 刷新页面 | refresh-cw |
| `terminal-input-mode-toggle` | 切换到编辑器输入 | keyboard |
| `watch-open-button` | 监控规则 | radar |
| `keyboard-behavior-open-button` | 终端设置 | settings2 |

其后是快捷键条（`terminal-shortcut-paste` / `enter` / `shift-tab` / `esc` / `ctrl-c` / `ctrl-d` / `↑↓←→` / `shift-enter` / `backspace`）。

**没有「回到底部 / jump to latest」按钮**：整页 `svg[class*="arrow-down-to-line"]` 计数 = **0**。
（`ArrowDownToLine` 仅剩两处与工具栏无关的用途：设置页快捷键动作图标 `packages/panels/src/settings/shortcut-action-meta.ts`、`ShortcutButtonRow.tsx`；agent 面板 chat-thread 另有自己的 `agent.panel.scrollToBottom` 按钮。）

截图：`live/B3-toolbar.png`

### B.5 远端终端可用性（附加验证）

在该 pane 里 `echo R9_LIVE_MARKER_OK` + Enter，xterm buffer 读回：

```
konata@KonatadeMacBook-Pro ~ % echo R9_LIVE_MARKER_OK
R9_LIVE_MARKER_OK
konata@KonatadeMacBook-Pro ~ %
```

即经 relay 的终端读写完全正常。截图：`live/B4-terminal-live.png`

---

## 4. C：直连不可用时的表现 —— 天然命中 relay，`directFailure` 已填充

本环境**不需要额外构造**就走了 relay，原因是设计使然：

- `TMEX_PEER_BIND_HOST=127.0.0.1` 让 peer server 只监听回环；
- 但 `enumeratePeerEndpoints()`（`apps/gateway/src/mesh/mesh-runtime.ts:347`）跳过 `addr.internal` 的地址，只播报**非回环网卡**地址；
- 于是 node 播报了 5 条 `ws://<LAN/IPv6>:39112/peer`，而它并不在这些地址上监听 → hub 直连全部 `refused` → 回落 relay。

结果：

- `transport = "relay"`，`reach = "relay"`，徽标 `中转 · <rtt>ms`
- `peerAddress = "localhost:29600"`（hub 的 TLS 公开地址，浮层里作为「中转地址」展示）
- `directFailure.ws = "refused ws://[240e:390:5e0e:d820:fc86:2a5a:8738:7]:39112/peer"`
- `directFailure.dc = "direct_capable=false"`（本 build 的 `direct_capable` 为 false，WebRTC 不可用，浏览器直连那条路也不存在，所以浮层走的是 `relay` kind，不列 ICE 明细——正是设计里「避免一整屏未知」的分支）

**没有实测到 `局域网`(ws-secure) / `公网` 分支**：要复现需把 `TMEX_PEER_BIND_HOST` 设成本机 LAN 地址（如 `192.168.3.23`），但那超出了本次「绑 127.0.0.1」的约束，未做。

---

## 5. 观察项（非本轮 bug，供参考）

- **O1（环境向）** `TMEX_DEFAULT_LANGUAGE` 只在站点设置行**尚不存在**时生效（`apps/gateway/src/config.ts:197` 只做 `languageDefault`）。实例首启后再改 app.env 不会改语言，必须 `PATCH /api/settings/site {"language":"zh_CN"}`。第一轮实测因此拿到的是英文 UI（`Files` / `Sign in to show files` / `Drag to reorder folders`），文案本身与中文一一对应，无缺失。
- **O2（展示向）** 诊断浮层的值用 `truncate`，`directFailure.ws` 这种长串在 288px 宽的浮层里被截断成 `refused ws://[240e:390:5e0…`，无 title/tooltip，鼠标悬停也看不到全文。功能上不影响（REST 里是全的），但排障时只能去接口看。
- **O3（行为向）** `directFailure.ws` 只保留**最后一次**失败的那个 endpoint 的原因（这里 5 条候选都 refused，只显示第 4 条）。`recordDirectFailure` 另有 `endpointsTried` 字段但不进 DTO，浮层看不到「一共试了几个」。
- **O4（行为向）** `enumeratePeerEndpoints` 播报的是所有非回环网卡地址，与 `TMEX_PEER_BIND_HOST` 实际绑定的地址无关。绑回环时会播报一堆自己并不监听的地址，直连必然 refused 一轮再回落。局域网部署下是对的，但回环/受限绑定场景会产生一次无谓的直连尝试与一条误导性的失败原因。
- **O5（测试向）** `node-login-<nodeId>` 这个 testid 同时出现在设备页 (`devices-node-login-*` 内) 与侧栏 Files 分节 (`files-node-login-*` 内)，Playwright strict mode 下 `getByTestId('node-login-<id>')` 会命中 2 个元素。写 e2e 时必须先按外层容器收窄（`apps/fe/tests/helpers/mesh.ts:241` 的 `signInToNodeFromDevicesPage` 目前是直接点 `node-login-<id>`，一旦该用例在 Files tab 打开的状态下跑就会 strict violation）。
- **O6（噪声）** 终端页刚打开时右下角闪过一次「重连中」toast，约 10s 内自行消失，随后终端读写正常（见 B.5）。属于页面首帧与 relay 建链的竞态，非阻塞。

## 6. 清理

- 两个临时实例（21600 / 21601）与其 supervisor 循环已终止
- `tmux -L tmex-r9-live kill-server` 已执行（该 socket 上的 `r9hub` / `r9node` / `tmex` 三个 session 均为本次实测自建，与生产默认 socket 的 `tmex` session 无关）
- 生产 tmex（launchd、9883、`~/Library/Application Support/tmex/`）全程未访问；仓库无任何文件改动、无 git 状态变更
