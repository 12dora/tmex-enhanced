# U2 结果 — fe: markdown highlightAuto 护栏、按需 chunk 失败兜底、TunnelStatusCard 评估

## 1. MarkdownPreview 自动语言识别护栏（Z1 HIGH）

### 做法

`rehype-highlight` 的 `detect: true` 会对所有未标语言的 fenced 块调 `lowlight.highlightAuto`，
拿全部语法各跑一遍，代价随体积暴涨。网关放行的文本上限是 2 MiB，所以这条路径可以在渲染期
把主线程冻住十秒量级。

没有全局关掉 `detect`（那会让所有未标语言的短片段失去高亮），而是在 **remark 阶段**加一个
就地的护栏 `guardAutoDetect(docLength)`：遍历 mdast，把「没有 `lang` 且（自身 > 64 KiB 或整篇
> 256 KiB）」的 `code` 节点通过 `data.hProperties` 打上 `className: ['no-highlight']`。
`mdast-util-to-hast` 的 `code` handler 会把 `hProperties` 合并到 `<code>` 上，而 `rehype-highlight`
的 `language()` 读到 `no-highlight` 直接返回 `false`、整块跳过（连 `hljs` class 都不加）。

- 块级阈值 64 KiB 与 `CodeViewer` 已有的 `AUTO_DETECT_LIMIT` 对齐；
- 文档级阈值 256 KiB 挡住块级阈值看不见的「成百上千个小块累加」；
- 显式 ` ```ts ` 这类块完全不受影响，仍走快两个数量级的 `hljs.highlight`。

配套修了一个会跟着暴露出来的行为漂移：被打上 `no-highlight` 的块拿不到 `language-*` class，
原来的 `code` 组件只按 `language-*` 判断「是不是 fenced 块」，会把它按 inline code 的药丸样式渲染。
判断改成 `lang || className?.includes('no-highlight')`，实测确认大块仍是块级样式
（`<pre class="bg-muted …"><code class="font-mono text-[13px] no-highlight">`），inline code 的
`px-1.5 py-0.5` 药丸样式不变。

### 测量（bun 1.3.14，同一进程内预热后取稳定值）

同一份 1 MiB 未标语言代码块，`renderToStaticMarkup(<MarkdownPreview/>)`：

| | 耗时 |
|---|---:|
| 护栏前（`detect: true`，无护栏） | **9048 ms** |
| 护栏后 | **134 ms**（三次 139 / 119 / 123 ms） |

约 **67×**。剩下的 ~130 ms 是 react-markdown 自身解析 + 序列化 1 MiB 文本的固有开销，
与语言识别无关——所以任务书里「< 100 ms」这条线在当前依赖下达不到，用例改成断言
`< 500 ms`（离 9 s 的回归有一个数量级余量），并同时断言输出里没有 `hljs-` class。
bench 脚本是一次性的，已删除，数字见上表。

### 测试（`packages/panels/src/markdown/markdown-preview.test.tsx`）

原 `markdown-preview.test.ts` 改名成 `.tsx`（需要 JSX 做静态渲染），原有 5 条 `resolveImgSrc`
用例原样保留，新增 4 条：

- 小的未标语言块仍然自动识别（输出含 `hljs-`）；
- 显式 `ts` 的大块仍然高亮（`hljs-keyword`）；
- 1 MiB 未标语言块：输出含 `no-highlight`、不含 `hljs-`、不退化成 inline 药丸样式、耗时 < 500 ms；
- 阈值函数 `skipsAutoDetect` 的三条边界。

## 2. 按需 chunk 加载失败的兜底（Z1 MEDIUM）

### 现状调查

仓库里已有的机制是**路由级**的：`usePageModule` + `PageLoadFallback`（`page-wrapper.tsx` 用），
它管的是 `PageWrapper` 自己发起的模块加载，接不到 `React.lazy` 在渲染期抛出的东西。
`SettingsPage` 的 7 个标签页和 `FilePage` 的 markdown 预览走的是 `React.lazy` + `Suspense`，
没有任何错误边界。

实测确认了两件事（`react-dom/server` 探针，用完即删）：

- `renderToStaticMarkup` **不支持** class 错误边界，组件抛出会直接穿透；
- 被拒的 `React.lazy` 在 SSR 下不会报错，而是**永远停在 Suspense fallback 上**；在浏览器 CSR 下
  则是渲染期抛出、整页白掉。而且 `React.lazy` 会把 reject 永久缓存成 `Rejected`，重挂载也不会重试。

所以「加一个错误边界组件」在这套只有 `react-dom/server` 的测试环境下既测不了、在 SSR 路径上也没用。

### 做法

新增一个共享小组件 `apps/fe/src/lazy-chunk.tsx`（64 行），把失败**在 loader 里**就地转成
路由页那张重试卡片，复用现有的 `PageLoadFallback`（同一套 i18n key 与 `page-load-error` /
`page-load-retry` testid）：

```
lazyChunk(load) = lazy(() => load().then(
  (c) => ({ default: c }),
  () => ({ default: (props) => <ChunkRetry load={load} componentProps={props} /> })
))
```

`ChunkRetry` 点重试就重新走一次 `import()`；连续失败到 `MAX_CHUNK_RETRIES = 2` 后重试按钮改成
整页刷新——发版后 index.html 指的旧 chunk 已经 404，浏览器又把失败的模块 URL 记进 module map，
只有重新取 index.html 才拿得到新版。重试成功的模块按 loader 记进一张模块级 Map，
否则 `lazy` 里定死的「失败」会让切走再切回来又看到重试卡片。

调用点只把 `lazy(() => import(x).then(m => ({default: m.Y})))` 换成
`lazyChunk(() => import(x).then(m => m.Y))`：`SettingsPage` 的 7 个标签、`FilePage` 的
`MarkdownPreview`。成功路径与原来完全一致（仍是 `React.lazy` + 外层 `Suspense`，
「切换过一次后是同步的」这条性质不变），现有的 `SettingsPage.test.tsx` / `FilePage.test.tsx`
两段式渲染用例一字未改照常通过。

### 测试（`apps/fe/src/lazy-chunk.test.tsx`）

- 加载成功时正常渲染目标组件并透传 props；
- **rejected import**：首帧是 Suspense fallback，settle 后渲染出 `page-load-error` +
  `page-load-retry`，不再停在骨架上、也不抛出。

## 3. TunnelStatusCard / wizardStepState — 不改，建议进 allowlist

按任务书的判定标准（`deriveTunnelStatusView` 能让 JSX 变平、**零净增行**、两边 CC < 15）逐条算过，
两条都不成立，因此**没有改**，理由如下。

### `TunnelStatusCard`（CC 34 / 216 行，`status-card.tsx:48`）

它的 CC 几乎全部来自 JSX 里的条件渲染，而门禁按 `&&` / `||` / `??` / 三元逐个计数
（JSX prop 里的箭头函数是独立函数，不计入父函数）。逐条数下来 33 个判定点，其中：

- **能被 `deriveTunnelStatusView` 合并掉的只有复合条件**：`actions.error && !ackError`（−1）、
  `process.state === 'error' && lastError`（−1）、`configured && !adopted && !stoppable`（−2）、
  `!adopted && !stoppable`（−1）、`!adopted && stoppable`（−1）、`adopted || running`（−1）、
  `stoppable` 自身的 `||`（−1）——合计 −8，CC 34 → **约 26，仍然远高于 15**。
- 剩下 20 多个是 `{flag && <JSX/>}` 一对一的开关，派生对象换不掉：一个 flag 仍然是一个判定点。
- 而派生函数自己 CC ≈ 10、约 +25 行，**净增行为正**。

真要压到 15 以下只能把 JSX 拆成 3 个子组件（通知区 / 详情区 / 动作按钮区），单是 props 管道就
约 +25 行，且把一张卡片的条件逻辑摊到三处，可读性变差。作为纯展示组件，CC 这个指标在这里
度量的是「条件渲染分支数」而不是控制流复杂度。

**建议 allowlist**：`apps/fe/src/pages/settings/remote-access/status-card.tsx:TunnelStatusCard`
（`cc: 34, lines: 216`），理由「展示型组件，CC 全部来自一对一的条件渲染开关；派生视图对象最多降到
26 且净增行，再降只能拆成 3 个子组件、纯粹的抽象税」。这与 S2 报告里
「remote-access components 已经有 step / status 子组件、没有契约重复」的结论一致。

### `wizardStepState`（CC 27 / 32 行，`tunnel-model.ts:127`）

一个对 9 元联合 `WizardStepId` 的穷尽 switch：9 个 case 各 +1，其余是每步 2–3 个条件。
它已经是这段逻辑最紧凑的写法，而且：

- 拆成 9 个小函数 + 分派要 +25 行左右，还会把「所有步骤的判定并排读」这个唯一的价值拆散；
- 更不能表格化——`hostname` / `create` 两个 case 递归复用 `wizardStepState('login' | 'hostname', ctx)`，
  是真实的步骤依赖链，表驱动表达不了；任务书也明令禁止把顺序逻辑改成表。
- 穷尽 switch 由 TS 保证漏 case 会编译报错，这是它现在最强的安全网。

**建议 allowlist**：`apps/fe/src/pages/settings/remote-access/tunnel-model.ts:wizardStepState`
（`cc: 27, lines: 32`），理由「9 元联合的穷尽 switch，每步独立判定且 hostname/create 依赖前序步骤，
拆分或表驱动都会更差；CC 来自 case 数量而非控制流深度」。

> 注：`scripts/complexity/allowlist.json` 目前是 `{}`，且不在本任务 scope 内，没有动它——
> 上面两条请由负责 allowlist 的 agent 落入。

## 改动文件

| 文件 | 变化 |
|---|---|
| `packages/panels/src/markdown/markdown-preview.tsx` | +41 / −3（护栏 + `code` 组件的块判定） |
| `packages/panels/src/markdown/markdown-preview.test.ts` → `.test.tsx` | 改名 + 40 → 77 行（新增 4 条用例） |
| `apps/fe/src/lazy-chunk.tsx` | 新增 64 行 |
| `apps/fe/src/lazy-chunk.test.tsx` | 新增 40 行 |
| `apps/fe/src/pages/SettingsPage.tsx` | +15 / −18（净 −3） |
| `apps/fe/src/pages/FilePage.tsx` | +4 / −3（净 +1） |

行数账：生产代码净 **+100** 行（护栏 +38、`lazy-chunk` +64、两个页面净 −2），测试净 **+77** 行。
本轮的「净负/持平」目标在 U2 上没有达成，也不打算靠搬运凑数：item 1 与 item 2 都是**新增缺失的
防护路径**（一条秒级停顿的性能护栏 + 一条原本不存在的失败恢复路径），item 3 则明确判定为
「不值得为指标加抽象」而原样保留。

## 验证

- `bun scripts/complexity/gate.ts --report`：改动前后 `>15` 榜单里与本 scope 相关的条目**完全不变**
  （`TunnelStatusCard` 34/216L、`wizardStepState` 27/32L），新增的 `guardAutoDetect` / `skipsAutoDetect` /
  `lazyChunk` / `ChunkRetry` 以及改动过的 `buildComponents`、两个页面组件**都没有进榜**（CC ≤ 15、行数 ≤ 120）。
  报告总计 `files 1057, functions 8712, CC>15: 44, >120 lines: 75`（含其他 agent 的并行改动）。
- `packages/panels`：`bun test` **629 pass / 0 fail**（基线 580/0，差额含其他 agent 新增用例，本任务 +4）；
  `bunx tsc --noEmit -p .` **0 error**（基线 0）。
- `apps/fe`：`bun test src/` **882 pass / 0 fail**（基线 866/0，本任务 +2）；
  `bunx tsc --noEmit -p .` **0 error**（基线 0）。
- `bunx biome check <6 个改动文件>`：**No fixes applied / 0 error**（期间跑过一次 `--write`，只动了这 6 个文件）。
- 未跑 Playwright（按任务书要求）。

## 风险与遗留

- **护栏的可见变化**：整篇 > 256 KiB 的 markdown 里，原本能被自动识别的**小**代码块现在也不高亮了。
  这是文档级阈值的有意取舍（挡住上千个小块累加），2 MiB 上限下最坏情况就是「大文档里的无标注块显示为纯文本」，
  显式标语言的块始终正常。
- `lazyChunk` 的恢复 Map 以 loader 函数为 key，假定同一个 loader 只有一个挂载点（当前 8 个调用点都满足）。
  若将来同一个 loader 被多处同时挂载，行为仍然正确（各自独立重试），只是恢复缓存会被共享。
- `ChunkRetry` 走到上限后的整页刷新调 `window.location.reload()`，只在浏览器点击路径上执行，
  SSR / 测试路径不会碰到。
- `React.lazy` 的语义决定了「首次 import 失败后，该 chunk 的 lazy 永远解析成重试卡片」；
  `ChunkRetry` 通过重试 + 恢复 Map 自愈，但如果用户不点重试就切走，下次进来仍是重试卡片
  （这正是期望行为——模块确实还没加载成功）。
