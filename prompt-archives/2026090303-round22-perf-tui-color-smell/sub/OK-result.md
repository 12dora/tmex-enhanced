# OK — i18n core/rest 拆分 + 82 条死 key + README 安全声明 + ws-borsh 规范补齐

分支 `feat/round22-perf-tui-color-smell`，worktree `/Users/konata/code/tmex-r22`。全程未做任何 git 操作。

---

## 1. i18n 首屏语言包拆 core / rest（EX5 §0.5、§8 ②）

### 设计

- 切分依据落在新文件 `packages/shared/src/i18n/core-keys.ts`：`I18N_CORE_KEY_PREFIXES` 是**按点边界匹配**的前缀表，`splitTranslation()` 把一棵翻译树拆成互斥两棵（叶子总数守恒，构建时断言）。
- `packages/shared/scripts/build-i18n.ts` 在生成 `resources.ts` / `types.ts` 之后，额外产出 `packages/shared/src/i18n/locales/generated/<lng>.{core,rest}.json`（生成物，勿手改）。
- `apps/fe/src/i18n/index.ts`：`resourcesToBackend` 只拉 `*.core.json`（首绘前 `await i18nReady`）；新增 `ensureI18nRest()` 用 `i18n.addResourceBundle(lng, 'translation', rest, true, true)` 补 rest；`react.bindI18nStore: 'added'` 让 rest 落地后已挂载组件自动重渲染（即便某处抢跑也会自愈，不会把裸 key 留在屏幕上）；`languageChanged` 时若已取过 rest，为新语言补拉。
- **懒路由 loader**：`apps/fe/src/use-page-module.ts` 的 `requestPageModule()`。新增 `setPageModulePrerequisite()` 注入点，由 `@/i18n` 在模块求值时注入 `ensureI18nRest`；未注入时保持原有时序（一个 `then` 直达 ready），因此既有断言不受影响。前置条件失败只 `catch` 掉，不参与页面失败判定。
- `apps/fe/src/main.tsx`：首帧后 `requestIdleCallback`（无则 `setTimeout(…, 0)`）预取 rest，覆盖不经路由 loader 的懒面板（连接设备 / 安全面板 / 终端设置 sheet / watch 对话框）。

### core 前缀表（21 条）

`agent` `appError` `auth` `common` `device` `deviceStatus` `files` `nav` `notification` `sidebar` `terminal` `watch` `websocket` `window`，以及 `settings` 下的 7 个子路径 `settings.theme` / `themeDark` / `themeLight` / `terminal.loadFailed` / `loadFailedHint` / `loading` / `reloadApp`。

推导方式不是拍脑袋：先用 `bunx vite build --sourcemap` 拿到入口 chunk `.map` 的 `sources`（257 个 workspace 模块，rollup 摇树后的真值），扫出其中的字面量 key 与模板前缀；再用「从 `main.tsx` 出发、遇 `import()` 即止步」的**静态**图（374 个模块，保守上界）复核。两者只差一个 `files` 命名空间（1.8 KB），直接把 `files` 也放进 core，从而让保守口径的静态图成为可长期执行的守卫。

拆分结果：core 607 key / rest 1317–1322 key。

### 实测（`bunx vite build`，读 `dist/index.html` 里的 entry 名）

| 语言包（首绘阻塞项） | before raw | before gz | after core raw | after core gz | Δ gz |
| --- | ---: | ---: | ---: | ---: | ---: |
| zh_CN | 99,615 | **33,868** | 25,457 | **10,097** | **−23,771（−70.2%）** |
| en_US | 105,278 | **32,387** | 26,513 | **9,297** | **−23,090（−71.3%）** |
| ja_JP | 141,192 | **36,774** | 35,039 | **10,892** | **−25,882（−70.4%）** |

rest chunk（首绘后才拉）：zh_CN 70,973 / 24,266 gz · en_US 75,446 / 23,248 gz · ja_JP 101,785 / 26,418 gz。

入口 JS / CSS：`index-LTH1gYR6.js` 1,134,255 / 348,443 gz + CSS 147,046 / 23,050 gz（任务开始时）→ `index-D6b3IYTi.js` 1,139,428 / 350,022 gz + CSS 139,327 / 22,321 gz（现在）。
**这两个数不是本任务的净效果**：同一 worktree 里有约十几个 agent 并行改代码，两次构建之间入口图已被别人动过。本任务对入口 JS 的净增量只有 `main.tsx` + `use-page-module.ts` 的约 30 行（语言包本来就是独立 chunk，没有从入口里搬走字节）。**真正的首屏收益就是上表的语言包一列：−23～26 KB gz。**

### 验证

- 新增 `apps/fe/src/i18n/core-coverage.test.tsx`（5 个用例）：
  1. 重建入口静态图（`Bun.Transpiler.scanImports`，跳过 `dynamic-import`），断言规模合理；
  2. core + rest 恰好等于完整语言包、互不重叠、各自符合前缀判定；
  3. 前缀表无死条目；
  4. **入口图里出现的每个 key（字面量 + 模板前缀展开）都在 core 包里**；
  5. 用只装 core 的独立 i18next 实例（`saveMissing` + `missingKeyHandler`）逐个 `t()` 全部入口 key，断言 `missing` 为空；并用 `I18nextProvider` + `renderToStaticMarkup` 渲染外壳最早可见的 `PageLoadFallback`，断言产物里没有裸 `common.*`。
  - 已做变异验证：把 `window` 从前缀表删掉后重跑，用例 4 立刻失败并逐条列出 `window.close <- packages/panels/src/device-tree/device-tree-actions.ts` 等 20 行；恢复后通过。
- `apps/fe/src/use-page-module.test.ts` 补 2 个用例：前置条件未就绪不进 ready；前置条件 reject 不拖垮页面。
- 产物抽检：`zh_CN.core-*.js` 含 `pageLoadFailed`、不含 `remoteAccess`；`zh_CN.rest-*.js` 含 `remoteAccess`；入口 chunk 同时引用两个 chunk 名。

---

## 2. 82 条死 key（EX5 §5.1、§8 ⑪）

重新独立复核，没有直接抄名单：对 en/zh/ja 三份 locale 的全部叶子 key（en 2010 条），逐条检查「全 key 字符串出现」与「末段作为标识符（`(^|[^A-Za-z0-9_$])last([^A-Za-z0-9_$]|$)`）出现」，语料覆盖 `apps/{fe,gateway}`、`packages/*`、`scripts`、`apps/fe/tests`（含 e2e）、`index.html`，排除生成物。结果 **81 条**（en 口径）+ `nodes.upgrade.allHint`（只在 zh/ja 有裸 key，en 是 `_one`/`_other`）= **82 条**，与报告的分布逐个命名空间对上（weixin 13 · terminal 12 · telegram 10 · settings 8 · device 7 · sidebar 6 · nodes 6 · agent 4 · apiError 4 · common 3 · 其余 9）。

模板前缀的假阳性按报告要求重新穷举了一遍：全仓 `t(\`…\${`  共 30 个 i18n 前缀（含报告未列的 `agent.tool.` `deviceStatus.errorBadge.` `settings.terminal.shortcuts.action.` `watch.type` `watch.typeDesc` 与 `connectDevices.computer.*` 系的 `${prefix}` 变量），逐一确认无一覆盖名单内的 key。特别复核了 `nodes.upgrade.${reason}`：`UpgradeBlockReason = 'offline' | 'loginRequired' | 'tooOld' | 'atLatest'`（`upgrade-batch.ts:40`），不含 `upgradeAll` / `allHint` / `allProgress`。删除前又跑了一遍全仓 grep（全 key + 末段词边界），命中数为 0。

`sshError.sshConfigRefNotSupported` 是拼错的孤儿 key，一并删除；代码实际用的 `sshError.configRefNotSupported` 仍在（`error-classify.ts:11`），未受影响。

删除后跑 `bun run build:i18n` 重生成 `resources.ts` / `types.ts`（未手改、未 lint）。

体积：完整语言包 raw zh_CN 99,615 → 96,430、en_US 105,278 → 101,959、ja_JP 141,192 → 136,824，合计 **−10,872 B raw**。

一致性测试：新增 `packages/shared/src/i18n/locale-consistency.test.ts`（5 个用例）——三语 key 集合一致（复数后缀归一后比较，zh/ja 只有一种复数形态写裸 key 属 i18next 预期回退，测试里有说明）、所有值为非空字符串、`resources.ts` 与源 JSON 同步、`locales/generated` 的 core/rest 与源文件+前缀表同步（等于「忘了跑 build:i18n」会红）、前缀表无死条目。

---

## 3. README 安全声明（EX5 §7、§8 ⑯）

`README.md` §Security 与 `README.zh-CN.md` §安全 原文「tmex 未内置用户鉴权，请在受信网络内运行，不要直接暴露到公网」已重写。逐条以代码为准核实后写入：

- **默认状态**：standalone 全新安装绑定 `127.0.0.1:9883`（`packages/app/src/constants.ts:19-25`）、登录保护默认关闭、须在「设置 → 远程访问」开启；加入 mesh 的机器强制登录（`apps/gateway/src/db/local-auth-settings.ts:139` `defaultLoginEnforced`）。
- **账号**：口令不出浏览器 —— Argon2id(64 MiB/3 轮) → Ed25519 根钥，服务端只存根公钥 + KDF 参数（`packages/shared/src/auth/root-key.ts`、`apps/gateway/src/db/local-auth-http.ts:44-70`）；delegation 18 小时（`packages/shared/src/auth/delegation.ts:6`）、节点会话 18h 滑动 / 7 天硬上限（`node-session-store.ts:6-8`）；按 IP + UID 限流、失败模糊化。**刻意没写「OPAQUE」**——实现是 Argon2id 派生 + 挑战签名，不是 OPAQUE PAKE。
- **第二因素**：通行密钥（WebAuthn）二次验证，判定看「任意 origin 是否已有 passkey」（`local-auth-http.ts:55-62`）；回环 / RFC1918 / link-local / ULA / CGNAT 源地址豁免（`mesh/client-source.ts` `isTrustedLocalClient`，round 20）；并注明 IP 字面量 origin 无法注册 WebAuthn。TOTP 独立可选。
- **密钥日志与改密**：哈希链 + 根钥签名、同步到每个节点；常规改密走 `rotate-root-keep`（保留 passkey/TOTP/会话），`--full-reset` 才走 `rotate-root`（`packages/shared/src/auth/key-log.ts:398,406-432`、`packages/app/src/lib/hub-user-passwd.ts:58-76`）。
- **mesh 互认**：节点证书由用户根钥签发、hub 不签发凭证；节点间链路双向认证 + 每方向 AES-256-GCM（`packages/shared/src/auth/peer-handshake.ts`、`link/secure-channel-link.ts`）。
- **传输**：`TlsMode = none | external | selfsigned | acme`，ACME `http-01` / `dns-01`（Cloudflare、DNSPod）；反代终止 TLS 需 `TMEX_TRUST_PROXY=true`；tmex 自行下载并托管 `cloudflared`（named / quick），可强制校验 Cloudflare Access JWT。
- 补充要点：每节点「允许域名访问」开关；「仍需自行处理」段（强口令、走 HTTPS、保持所有节点为最新——旧版本节点不实现通行密钥二次验证，仍只校验口令，该判定是每节点各自从自己的 key 列表算出来的）。

功能概览新增一段 hub/node mesh 介绍（英/中各一段），CLI 命令逐字照抄 `packages/app/src/cli/help.ts`（`tmex init --role standalone|node|hub,node`、`tmex hub join <https-url> --token <t>`），未编造 flag。

**刻意不写**：Tailscale（仓库无任何集成）、多 hub 主备、TURN、直连平台矩阵。

文案按 `/Users/konata/code/tmex-copy-guidelines.md`：zh 用全角标点、UI 路径用「设置 → 多节点互联」/「设置 → 远程访问」并与界面标签逐字一致（已比对 i18n `settings.tabGroup.nodes` = 「多节点互联」、`settings.tabGroup.remoteAccess` = 「远程访问」、`nodes.detail.domainAccess` = 「允许域名访问」）、中继（Hub）首次出现带括号英文、无第二人称、数字与英文两侧留空格；术语统一为「多节点互联 / 组网」，正文不再混用裸 `mesh`。biome 不处理 Markdown（`Checked 0 files`）。

---

## 4. ws-borsh 规范（EX5 §7、§8 ⑰）

`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` 的 kind 表从 37 补到 **57**，与 `packages/shared/src/ws-borsh/kind.ts` 的 `KIND_*` 完全一致。新增 20 条：`0x020B` TMUX_REORDER_WINDOWS、`0x020C` TMUX_REORDER_PANES、`0x020D` TMUX_SUBSCRIBE_PANES、`0x020E` TMUX_FETCH_PANE_HISTORY、`0x020F` TMUX_RESIZE_PANE、`0x0210` TMUX_APPLY_STACKED_LAYOUT、`0x0211` TMUX_SPLIT_PANE、`0x0212` TMUX_FOCUS_PANE、`0x0213` TMUX_RENAME_PANE、`0x0214` TMUX_MOVE_PANE、`0x0215` TMUX_BREAK_PANE、`0x0307` CLIPBOARD_WRITE、`0x0801` SITE_THEME_UPDATE、`0x0802` SETTINGS_UPDATE、`0x0803` NOTIFY_EVENT、`0x0A01` NODE_EVENT、`0x0A02` RTC_SIGNAL、`0x0A03` CARRIER_SWITCH、`0x0A04` CARRIER_SWITCH_ACK、`0x0A05` ENROLL_REDEEMED；每条都补了取自 `schema.ts` 的字段清单，并新增「站点设置与站点级广播（0x0800-0x08FF）」「Mesh / hub（0x0A00-0x0AFF）」两节，注明 `0x0A01/0x0A02/0x0A05` 走 `/mesh/ws`、`0x0A03/0x0A04` 走 `/ws`。顺带按 `schema.ts` 修正了既有段落里失真的字段（`TMUX_CREATE_WINDOW` 缺 `cwd`、`WindowWire` 缺 `customName`/`layout`、`PaneWire` 缺 5 个字段、`TERM_HISTORY` 缺 `alternateScreen`/`modes`）。

新增 `packages/shared/src/ws-borsh/kind-doc-drift.test.ts`：从 `import.meta.dir` 上溯解析文档路径，截取 kind 表小节，用严格行正则解析（含 `0x` 却不匹配的行直接抛错，重复 hex 抛错），与 `import * as kindModule from './kind'` 推导出的 `KIND_*` 集合做三向比对（文档缺少 / 文档多出 / 名称不一致），并断言文档里每个 hex 都过 `isValidKind`。已做变异验证：删一行、改一个名字、破坏表格语法，三种漂移各自给出可读失败信息。

`docs/ws-protocol/2026021403-ws-state-machines.md` 的 6 个幽灵标识符全部替换为真实实现：`ws_open` → `socket.onopen` → `sendHello()`（`client.ts:341-344,526`）；`hello_s2c` → `ProtocolDispatcher.onHello` → `handleHelloNegotiated`（`client.ts:419,434`）；`backoff_timeout` → `ReconnectController.schedule()` 定时器到期 → `onReconnect` → `connect()`（`reconnect-controller.ts:44-47`）；`PENDING_DEBOUNCE` → `TerminalResizeScheduler`（防抖 + `RafCoalescer`）+ `TerminalResizeReporter` 的 `sizingMode` 闸门；`CLOSING` → `scheduleConnectionEntryRelease()` + `RUNTIME_IDLE_GRACE_MS = 5_000`；`RESYNCING` → `AttachedDevice.metadataNeedsRebase` + `requestMetadataRebase()` 与 `CanonicalPaneStream` 的 `SourceGap`。同时修掉两处顺带查实的错误：§1「HELLO 超时 3s」（代码里没有该定时器）改写为心跳 PONG 超时 + 指数退避；§5「debounce 80ms」→ `RESIZE_DEBOUNCE_MS = 150`，并补 `POST_SELECT_RETRY_MS = 60`。`docs/ws-protocol/2026070402-site-theme-update.md` 逐条核对无漂移，未动。

---

## 5. 文件清单

新增：
- `packages/shared/src/i18n/core-keys.ts`
- `packages/shared/src/i18n/locale-consistency.test.ts`
- `packages/shared/src/i18n/locales/generated/{en_US,zh_CN,ja_JP}.{core,rest}.json`（生成物）
- `packages/shared/src/ws-borsh/kind-doc-drift.test.ts`
- `apps/fe/src/i18n/core-coverage.test.tsx`

修改：
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（删 82 条死 key）
- `packages/shared/src/i18n/{resources,types}.ts`（`bun run build:i18n` 生成，未手改、未 lint）
- `packages/shared/scripts/build-i18n.ts`（**越界一次，见下**）
- `apps/fe/src/i18n/index.ts`、`apps/fe/src/main.tsx`
- `apps/fe/src/use-page-module.ts`（懒路由 loader，只加前置条件注入点与 await）、`apps/fe/src/use-page-module.test.ts`（+2 用例）
- `README.md`、`README.zh-CN.md`
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`、`docs/ws-protocol/2026021403-ws-state-machines.md`

**越界说明**：`packages/shared/scripts/build-i18n.ts` 不在「Files you own」列表里，但 core/rest 生成物只能由 `bun run build:i18n` 产出（任务本身也要求走这条路），EX5 §8 ② 亦点名要改它。改动是纯追加：多一个 `import`、一个 `writeSplitBundles()` 调用与函数体，未触碰既有的 resources/types 生成逻辑。i18n 是本次唯一由我负责的域，与并行 agent 无重叠。

---

## 6. 测试 / 类型 / lint

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `packages/shared` `bun test` | 472 pass / 0 fail | **525 pass / 0 fail**（含并行 agent 新增用例 + 本任务 7 个） |
| `apps/fe` `bun test src/` | 1744 pass / 0 fail | **1759 pass / 0 fail** |
| `packages/panels` `bun test` | — | 839 pass / 0 fail |
| `apps/gateway` i18n/push/events/site-settings | — | 112 pass / 0 fail |
| `packages/shared` `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `apps/gateway` `bunx tsc --noEmit -p .` | — | **0 error** |
| `packages/panels` `bunx tsc --noEmit -p .` | — | **0 error** |
| `apps/fe` `bunx tsc --noEmit -p .` | 1 error（`packages/ghostty-terminal`，他人在改） | 5 error，**全部来自 `packages/ui/{tooltip,lazy-overlay}.tsx` 与 `ghostty-terminal`（并行 agent 在途）；`apps/fe/src/**` 我的文件 0 error** |
| `bunx biome check`（我的全部非生成文件 + 生成的 locale JSON） | — | **clean，19 files** |
| `bun scripts/complexity/gate.ts` | ok | **ok（1286 files / 11890 functions）** |

未跑 e2e（任务明确要求）。

---

## 7. 遗留 / 注意

- `packages/shared/src/i18n/locales/generated/*.json` 是生成物，但 **没有** 加进 `biome.json` 的 ignore 列表（`biome.json` 不属于我的文件）。当前生成格式（2 空格缩进 + 末尾换行）与 biome 的 JSON formatter 输出一致，`biome check` 已实测 clean；若将来生成格式变化，需要有人把该目录补进 ignore。
- `zh_CN` / `ja_JP` 里 5 组 count 相关 key 仍写裸 key 而非 `_other`（`devices.folders.itemCount`、`nodes.revoke.bulkConfirm`/`bulkDone`、`nodes.uninstall.summary`、`nodes.upgrade.confirmAll`；第 6 组 `nodes.upgrade.allHint` 已随死 key 删除）。这是 i18next 的「缺复数形态回退基础 key」行为，`locale-consistency.test.ts` 按复数后缀归一后比较，已在测试里写明理由。要不要统一改成 `_other`，属产品/文案决策，本轮未动。
- 首屏预取用 `requestIdleCallback`（Safari 17.4+ 才支持），不支持时回落 `setTimeout(…, 0)`；两条路径都在首帧之后，不影响首绘。
