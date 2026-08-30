# O12 结果 — 侧边栏默认不列出其他节点，登录入口只留在「管理设备」

## 问题回顾

只在入口节点登录后，侧边栏会为每个远端 node 渲染一条带「登录该节点」的紧凑行；点完登录，
该 node 的设备默认不显示（`sidebarDeviceVisibility` 对远端缺省 false），整节随即被
`shouldHideSidebarNodeSection` 隐藏——表现为「登录成功后节点从侧边栏消失」，而「管理设备」
里它却是已连接、可见的。

## 改动

### 1. `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`

- 新增导出 `hasSidebarVisibleDeviceForNode(visibility, runtimeNodeId)`：按复合键前缀
  `${runtimeNodeId}:` 在 UI store 的 `sidebarDeviceVisibility` 里找是否存在显式 `true`。
  **为什么不按设备列表反查**：未登录的 node 读不到它的设备列表，而 mesh 的 inventory 在
  gateway 侧（`mesh-runtime.ts` 的 `statusProvider`）只带 `{ version }`、根本没有 `devices`，
  所以只能反过来看开关本身；远端设备缺省隐藏，用户在「管理设备」里打开时才会写入 `true`。
  前缀比较对 `node-a` / `node-ab` 这类互为前缀的 id 也安全（分隔符 `:` 参与比较）。
- `SidebarNodeSignIn`（在线但未登录）：在所有 hook 之后加门槛，
  `present = 当前路由选中了该 node 的某台设备 || hasSidebarVisibleDeviceForNode(...)`，
  不满足即整节 `return null`（连分节头、登录行一起）。过 `useSectionPresence` 做淡入淡出，
  与在线 / 离线分节同一套出入场（用户在「管理设备」里拨动开关时侧边栏是实时的）。
  保留「当前正浏览该 node 的设备」这一例外，否则从设备页深链进来会没有任何登录入口可点。
- 顶部注释补上这条统一门槛的说明。
- 离线分节与在线已登录分节**未改**：它们本来就是「一台可见设备都没有就整节隐藏」（
  `shouldHideSidebarNodeSection`，self 例外），与新规则一致。
- self 分节完全未变（`toSidebarEntries` 里 self 恒 `loggedIn: true`，走不到登录分支）。

侧边栏里没有别的「去登录」提示文案需要删除：`auth.node.loginToThisNode` /
`auth.node.loggingIn` 都只出现在这条登录行内部，行本身在有可见设备时仍然保留。
因此**未新增 / 未修改任何 i18n key**。

### 2. `apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx`

- 新增 `describe('hasSidebarVisibleDeviceForNode')`：只认本 node 前缀下显式 `true`；
  互为前缀的 node id 不互相带出。
- 原「在线但未登录：默认折叠成一个登录入口」拆成四条：
  - 未开过任何设备显示 → 整节不渲染（无 `sidebar-node-login-*` / `node-badge-*`）；
  - 开过设备显示 → 保留紧凑登录行（折叠态、不自动登录、不渲染设备树）；
  - 显式 `false` + 别的 node 开着设备 → 仍不渲染；
  - 路由停在该 node 的某台设备上 → 保留登录行。

### 3. `apps/fe/tests/mesh-login.spec.ts`（未运行 e2e，按要求只更新断言）

第一条用例重命名为 `mesh: sidebar shows the hub self node; other nodes only once a device is
enabled`：
- 登录后断言 `sidebar-node-header-self` 可见、`sidebar-node-header-<remote>` **计数为 0**
  （旧断言是可见）；
- `/api/mesh/nodes` 的成员/在线/fan-out 登录断言原样保留；
- 之后在远端 node 上建一台设备、把 `tmex-ui`（共享 UI store，storagePrefix 为空）里的
  `sidebarDeviceVisibility['<remoteNodeId>:<deviceId>']` 置 `true` 后 reload，再断言分节头出现、
  `node-badge-<remote>` 的 title 以 nodeId 结尾（原徽标断言不丢），`finally` 里删设备。
第二条用例（远端终端回显）无 sidebar 断言，未改。

其余 e2e（`sidebar-device-disclosure.spec.ts`、`mesh-passkey.spec.ts` 等）均不涉及
`sidebar-node-*` testid，无需改。

## 验证

- `cd apps/fe && bun test src/` → **846 pass / 0 fail**（59 文件；基线 671 是本轮其他 agent 加测试前的数字）
- `cd apps/fe && bunx tsc --noEmit -p .` → **0 error**（基线 0）
- `bunx biome check` 改动的三个文件 → 通过（`mesh-login.spec.ts` 用 `--write` 只做了格式化）
- 未跑 e2e，未跑 git 状态变更命令，未改 `apps/fe/src/pages/settings/**` 与 gateway。
  packages/panels 未改动（`selectSidebarVisibleDevices` / `shouldHideSidebarNodeSection` 够用）。

## 风险 / 遗留

- `apps/fe/tests` 不在 `apps/fe/tsconfig.json` 的 `include` 里，e2e 规格没有类型检查兜底；
  改动只用了已有 helper（`createDeviceOnNode` / `deleteDeviceOnNode`）与 `@tmex/stores` 的
  `sidebarDeviceVisibilityKey`（同目录 `sidebar-device-disclosure.spec.ts` 已有同源 import 先例），
  但真实执行需由 commander 在跑 mesh e2e 时确认。
- 门槛依赖「用户显式打开过开关」这一事实。若某台已开启显示的远端设备后来被删除，残留的 `true`
  会让该 node 继续显示一条登录行；这与设备可见性开关本身的既有语义一致（键不随设备删除清理），
  没有额外引入清理逻辑。
- gateway 的 mesh inventory 目前只带版本号、不带设备列表，所以离线 node 的灰显设备行在真实环境
  基本不会出现（既有行为，未在本任务范围内改动）。

---

## 追加：mesh e2e 修复（commander 报告两条用例失败后）

### 根因（两条各不相同，且都不是「侧栏改动本身有 bug」）

1. **第一次那轮跑的是旧前端**。mesh e2e 由 hub 直接托管 `apps/fe/dist`，而
   `tests/helpers/mesh-boot.ts` 的 `ensureFeDist()` 只在 dist 缺失或 `TMEX_MESH_E2E_BUILD_FE=1`
   时才重新构建。当时 dist 的时间戳是 22:04，我的源码改动是 22:49 —— 失败截图里侧栏仍旧渲染着
   远端 node 的「Sign in」行，正是旧行为。用 `TMEX_MESH_E2E_BUILD_FE=1` 重建后这条断言即成立。
2. **`create device on <nodeId>` 的 401 是既有问题，与侧栏无关**。
   `loginSelf()` 明确「只登录 entry 自身、不做任何 fan-out」，而 `/api/mesh/nodes` 的
   `loggedIn` 就是「浏览器有没有该 node 的会话 cookie」（`node-list-projection.ts:152`）。
   旧用例既没点过任何登录按钮（侧栏折叠态 `useNodeLoginGate({enabled:false})` 不发请求），
   也就从来拿不到远端 node 的会话——原来的 `expect(remote?.loggedIn).toBe(true)` 本身就是错的，
   这条用例在本轮之前应当已经在失败。

   另一个关键事实：**会话钥 sk_sess 只在内存里**（`session-key-store.ts` 顶部注释），
   `page.goto` / `page.reload` 这类整页导航会把它丢掉，之后点「登录此节点」只会跳
   `/login?node=`（我第一版 helper 用 `goto('/devices')` 就栽在这里，截图停在登录页）。
   所以补登录必须走 **SPA 内部跳转**。

### 改动（只动测试与 helper，产品代码未再变）

- `apps/fe/tests/helpers/mesh.ts`：新增 `signInToNodeFromDevicesPage(page, nodeId)`——
  点侧栏里的 `a[href="/devices"]`（SPA 跳转，保住内存里的会话钥）→ 等 `devices-page` →
  点 `node-login-<id>` → 等 `devices-node-login-<id>` 消失。注释写明了「必须 SPA 跳转」的原因。
- `apps/fe/tests/mesh-login.spec.ts`
  - 用例 1 改名为 `mesh: other nodes join the sidebar only after one of their devices is enabled`，
    完整走一遍新流程：登录后侧栏只有 self、远端整节不出现 → `/api/mesh/nodes` 成员/在线断言 +
    `loggedIn` 断言改为 `false`（并注明原因）→ 在「管理设备」里登录远端 node（登录后设备页出现
    `devices-node-header-<id>`，侧栏**仍然**不列出它）→ 建一台设备 → reload → 点设备卡片上的
    「终端」开关 `device-card-sidebar-<deviceId>` → 侧栏这一节才出现，并断言 `node-badge` 的
    title 以 nodeId 结尾（原徽标断言保住）。不再直写 localStorage，全程真实 UI 操作。
  - 用例 2（远端终端回显）：在 `createDeviceOnNode` 之前插入 `signInToNodeFromDevicesPage`，
    并注明 `/n/:id/api/*` 需要该 node 的会话。

### 验证

`cd apps/fe && bun run test:e2e --project mesh` 连跑两次，均 **5 passed**：

```
  ✓  1 [mesh-setup] › tests/mesh.setup.ts:4:1 › mesh: boot hub and node (4.0s)
  ✓  2 [mesh] › tests/mesh-login.spec.ts:22:1 › mesh: other nodes join the sidebar only after one of their devices is enabled (2.0s)
  ✓  3 [mesh] › tests/mesh-login.spec.ts:80:1 › mesh: terminal on the joined node echoes through the entry (1.9s)
  ✓  4 [mesh] › tests/mesh-passkey.spec.ts:19:1 › mesh: register a passkey on the entry node and log in with it (2.2s)
  ✓  5 [mesh-teardown] › tests/mesh.teardown.ts:4:1 › mesh: stop hub and node (206ms)

  5 passed (12.9s)
```

其余复核：`apps/fe` `bun test src/` 846 pass / 0 fail；`bunx tsc --noEmit -p .` 0 error；
四个改动文件 biome 通过。`apps/fe/dist` 已用 `TMEX_MESH_E2E_BUILD_FE=1` 重建过一次
（该目录是构建产物，未纳入版本控制）。

### 给 commander 的提醒

跑 mesh e2e 时如果本轮有前端源码改动，必须带 `TMEX_MESH_E2E_BUILD_FE=1`（或先删 `apps/fe/dist`），
否则 hub 托管的是上一次构建的前端，断言测的是旧行为。
