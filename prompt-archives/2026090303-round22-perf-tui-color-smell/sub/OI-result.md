# OI — CodeViewer：高亮移出渲染路径 + highlight.js 语言按需注册

对应 EX1 §U2 与 EX5 §3.4 / §8 第 ⑦ 行。工作区 `/Users/konata/code/tmex-r22`（与其它 agent 并行）。

---

## 1. 做了什么

### 1.1 高亮移出渲染路径（Web Worker）

原实现 `code-viewer.tsx:215` 在 `useMemo` 里同步跑 `highlightCode`，render 期间硬冻主线程。
现在拆成四层：

- `language-map.ts`（进主图，纯表 + 纯函数，不 import highlight.js）：扩展名映射、`AUTO_DETECT_LIMIT` / `HIGHLIGHT_LIMIT` 两条护栏、`planHighlight(codeLength, fileName)` —— 主线程与 worker 共用同一份策略判定（`language` / `auto` / `plain`）。
- `highlight-engine.ts`：可注入的高亮内核工厂（`hljs` 实例 + `loadLanguage` 解析器 + 自动识别子集）。语言按名缓存「加载中/已加载」Promise，同一语言只 `import` + `registerLanguage` 一次；失败则从缓存剔除以允许重试。
- `highlight.worker.ts` + `highlight-protocol.ts`：module worker，`{ id, code, fileName }` → `{ id, html }`。`html === null` 表示未高亮，主线程直接把原文当文本子节点渲染（React 自己转义），不再拼 `escapeHtml` 出的 HTML 字符串——顺带省掉大文件那份 1.79 MB 的转义副本。
- `highlight-client.ts`：worker 生命周期 + 请求路由。`request()` 返回 cancel；`error`/`messageerror` 时 terminate 并把在途请求改走主线程兜底。
- `use-highlighted-code.ts`：首帧返回 `null`（渲染纯文本），worker 回包后 `startTransition` 换成 HTML；state 带着请求时的 `code`/`fileName`，渲染期再比一次，**迟到回包天然作废**；effect cleanup 再取消一次。`plan === 'plain'` 时根本不发请求（不把 2 MiB 字符串 postMessage 出去）。

`plainText 先上屏 → worker 回包 → 换 HTML` 这条链保住了 `AUTO_DETECT_LIMIT = 64 KiB` / `HIGHLIGHT_LIMIT = 512 KiB` 两条原护栏，语义逐条不变。

**worker 是可行的**：`packages/panels` 以源码 TS 被 `apps/fe` 的 vite 直接消费，`new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })` 被 vite 静态识别。**但必须改 `apps/fe/vite.config.ts` 一行**（任务允许的那一行）：

```
worker: { format: 'es' },
```

不加这行 vite 直接构建失败：`Invalid value "iife" for option "worker.format" - UMD and IIFE output formats are not supported for code-splitting builds.`（默认 iife 拒绝 worker 内的代码分割，等于把 36 个语言全内联进 worker，按需就没了。）

主线程兜底（老浏览器无 module worker、或 worker 运行时报错）**没有做真正的分片**：hljs 的输出 span 跨行嵌套，按行切会破坏结构。兜底只做「先 `scheduler.yield()`／`setTimeout(0)` 让出一帧保证纯文本已上屏，再整段跑」。这一点在 `highlight-client.ts` 顶部注释里写明了。

### 1.2 语言按需注册

- `language-loaders.ts`：36 个 `() => import('highlight.js/lib/languages/x')`，键与顺序同上游 `lib/common.js`。worker 侧用它，一个文件只下自己那一个语言 chunk。
- `bundled-languages.ts`：36 个静态 import 的整包表，**只给主线程兜底路径用**。这是为了修一个我自己引入的副作用（见 §4）。
- `highlightAuto` 改用固定的 11 语言子集 `AUTO_DETECT_LANGUAGES`（`bash c diff go ini javascript json markdown python xml yaml`）并显式传 `languageSubset`。按需注册后「当前注册了什么」取决于用户此前看过哪些文件，不钉死子集会让同一文件在不同会话识别出不同语言；子集同时是自动识别的成本上限。

### 1.3 行号栏与超大文件分块（`line-gutter.ts`）

- `countLines()` 不再走 `code.split('\n').length`（6 万行文件会额外分配一个 6 万项数组），改逐个 `indexOf('\n')` 计数。
- **没有用 CSS counter**：counter 需要每行一个元素，6 万行 = 多 6 万个 DOM 节点，比一个文本节点严格更差。实测拼串本身 60k 行仅 **2.03 ms**、200k 行 6.95 ms（`Array.from+join` 与 `+=` 同价），瓶颈从来不是拼串，而是整段 `<pre>` 的布局。
  采用任务允许的另一条：**记忆化虚拟行号栏**——按 500 行定长切块，块内容只与起始行号有关、与文件无关，于是块串**跨文件复用**（模块级 Map，上限 256 块）。
- `code.length > HIGHLIGHT_LIMIT`（永远是纯文本）时按 500 行一块渲染，每块 `content-visibility: auto` + `contain-intrinsic-height: auto <行数×19.5>px`，屏外块不参与布局。块行号栏用 `width: <位数>ch` 固定，保证跨块对齐。
- `splitCodeBlocks()` 保证「各块 `lineCount` 之和 ≡ `countLines(code)`」且「块文本以 `\n` 重组 ≡ 原文」，两条都有断言。

---

## 2. 体积实测（同一时刻的干净 A/B）

并行 agent 一直在改仓库，跨时间的构建不可比。最终数字是**同一条命令里连续两次构建**得到的：先带我的改动构建 A，再把 `code-viewer/` 还原成 `HEAD` 版本构建 B，其余文件完全相同。
命令：`cd apps/fe && bunx vite build --outDir <scratch> --emptyOutDir`；gzip 用 `gzip -9`；入口从 `dist/index.html` 里取。

| 产物 | BEFORE (raw / gz) | AFTER (raw / gz) |
| --- | ---: | ---: |
| 入口 `index-*.js`（从 index.html 取） | 948,370 / **290,886** | 948,339 / **290,878** |
| `FilePage-*.js` | 9,903 / 3,930 | 12,558 / 5,009 |
| `hljs-terminal-theme-*.js`（FilePage 的**静态**依赖） | 159,457 / **49,346** | — 已从 FilePage 静态图移除 |
| `highlight.worker-*.js` | — | 24,856 / 10,001 |
| `core-*.js`（hljs 内核，主线程侧） | （含在上面 49,346 里） | 20,835 / 8,359 |
| 按需语言 chunk | — | typescript 7,759 / **3,082**；python 3,462 / 1,489；json 415 / **335**；yaml 1,854 / 844 |
| dist js 总量 raw / chunk 数 | 6,062,690 / 135 | 6,230,991 / 175 |

**入口首屏 gzip 变化 −8 B（噪声）**——CodeViewer 只经 FilePage 懒加载，本来就不在首屏图上，符合预期。

**打开一个代码文件实际要下的字节（gzip）**：

| 文件 | BEFORE | AFTER | 变化 |
| --- | ---: | ---: | ---: |
| `.ts` | 3,930 + 49,346 = **53,276** | 5,009 + worker 10,001 + typescript 3,082 = **18,092** | **−66%** |
| `.json` | 53,276 | 5,009 + 10,001 + 335 = **15,345** | **−71%** |
| `.py` | 53,276 | 5,009 + 10,001 + 1,489 = **16,499** | **−69%** |

更关键的是**首帧关键路径**：BEFORE 的 49,346 gz 是 `FilePage` chunk 的静态 import，必须下完才出内容；AFTER 关键路径只剩 FilePage 自身的 5,009 gz，worker chunk 与语言 chunk 都在纯文本已上屏之后异步取。

EX5 §8 第 ⑦ 行的预期是「FilePage chunk 49 KB gz → ~10 KB，每次实际只多下 1–2 KB」。实测关键路径 49.3 KB → 0，异步部分 10.0 KB（worker，含它自带的 hljs 内核）+ 0.3～3.1 KB（单语言）。

---

## 3. 运行时实测

| 项 | 数值 |
| --- | --- |
| `highlightAuto` 63 KiB 未知扩展名，**同进程 A/B**：36 语言（改动前）vs 11 语言子集（改动后） | **224.3 ms → 36.0 ms（6.2×）**，且这 36 ms 现在在 worker 线程 |
| 500 KiB `.ts` 同步高亮（本机 Bun/JSC，对应 EX1 的 232 ms 那一格） | 82.0 ms，**全部移出主线程** |
| 行号拼串 60k 行 / 200k 行 | 2.03 ms / 6.95 ms（`Array.from+join` 与 `+=` 同价）——据此判定 CSS counter 不划算，改块缓存跨文件复用 |

主线程剩下的成本是「收到 HTML 后写 innerHTML」这一段，无法靠 worker 消掉（hljs 输出的 span 跨行，切不开）；512 KiB 以上的文件已经走分块 + `content-visibility`，这一段也被压掉了。

---

## 4. 一个我自己引入、并已修掉的副作用

第一版把 36 个语言全部改成逐语言动态 import 后，`markdown-preview`（`rehype-highlight → lowlight` 静态引用同一批 ESM 模块）从「1 个合并 chunk」变成「36 个独立 chunk」：raw 相同（159,453 vs 159,457），但**逐文件 gzip 合计 65,564 vs 49,346，多付 16 KB gz + 35 个请求**——小文件各自压缩丢掉了共享上下文。

修法：新增 `bundled-languages.ts`（36 个静态 import 的整包表）**只给主线程兜底路径用**，worker 侧继续用逐语言动态 import。两条路径分属两次 rollup 构建，于是：

- 主图里语言只被 `bundled-languages` 与 lowlight 静态引用 → rollup 重新合成一个共享 chunk（`yaml-CdB7EsRe.js` 138,297 / 41,087 gz），markdown 侧回到 `core 8,359 + 41,087 = 49,446 gz`、2 个请求（BEFORE 49,346 gz、1 个请求），**基本持平**；
- worker 构建单独产出 36 个按需 chunk。

代价是 dist 总 raw +168 KB（语言模块在两次构建里各存一份），chunk 数 135 → 175。两份都是「活」的：只用代码查看器的用户下 worker 那份，只看 markdown 的用户下合并那份，**没有人两份都下**（同时用两条链的用户会各下一次，属少数）。

代价换来的是常见路径的 −66%～−71%，判断是划算的；如果后续要把这 168 KB 也省掉，正确做法是让 `markdown-preview.tsx` 给 `rehypeHighlight` 显式指定语言集或改懒加载 lowlight——那个文件不属于本任务，未动。

---

## 5. 测试

`packages/panels` 内 `bun test src/code-viewer`：**基线 5 pass / 0 fail → 现在 35 pass / 0 fail（5 个文件，107 断言）**。

任务要求的六条全部覆盖：

| 要求 | 覆盖位置 |
| --- | --- |
| 高亮回来前可见纯文本 | `code-viewer.test.tsx`「高亮回来之前渲染纯文本」（SSR 不跑 effect，正是首帧状态：无 `hljs-`，有 `const a = 1; // &lt;tag&gt;`） |
| 高亮结果被应用 | `highlight-client.test.ts`「worker 回包按 id 交付」；`highlight.worker.test.ts` 端到端（真 worker，真 `import` 语言 → `registerLanguage` → 回包） |
| 陈旧回包被忽略 | `highlight-client.test.ts`「取消后的回包被丢弃」「切文件后旧回包不覆盖新请求」「未知 id 的回包被忽略」 |
| 语言懒加载且只加载一次 | `highlight-engine.test.ts`「已知扩展名只加载对应语言，且只加载一次」「并发请求同一语言不会重复加载」「加载失败时不高亮，且允许下次重试」 |
| 未知扩展名路径 | `highlight-engine.test.ts`「未知扩展名走自动识别子集」「没有加载器的语言名（如 dockerfile）退回自动识别」；`highlight.worker.test.ts` 同名用例 |
| 大文件护栏仍跳过高亮 | `highlight-engine.test.ts` 两条限额用例（且断言**根本没去加载语言**）；`code-viewer.test.tsx` 的 plan + SSR 双重断言；`highlight.worker.test.ts`「超过 512 KiB 的已知语言不高亮」 |

另加 `line-gutter.test.ts`：`countLines` 与 `split` 等价、分块行数守恒 + 无损重组、起始行号连续、整块行号串跨调用复用同一实例。

**关于原有断言**：原 4 条护栏用例中有 2 条（`未知扩展名的小文件仍走自动识别`、`已知语言在 64 KiB 以上仍然高亮`）断言的是 `renderToStaticMarkup` 输出里**同步**含 `hljs-`。高亮改成异步后这个形态不可能成立，因此改成在**策略层**（`planHighlight` 判定）与**引擎层**（`await engine.highlight(...)` 真出 `hljs-keyword`）两处断言同一语义——覆盖只增不减，没有删弱任何一条护栏。原「语言清单与上游 `lib/common.js` 对账」那条保留并加强：现在同时对账 `COMMON_LANGUAGE_NAMES`、`LANGUAGE_LOADERS` 键序、`BUNDLED_LANGUAGES` 键序，任一处跟上游漂了都会先红。

---

## 6. 验收

| 项 | 结果 |
| --- | --- |
| `bun test src/code-viewer`（packages/panels） | 35 pass / 0 fail（基线 5 pass / 0 fail） |
| `bunx tsc --noEmit -p .`（packages/panels） | **0 error**（基线 0 error） |
| `bunx biome check`（我的文件 + `apps/fe/vite.config.ts`） | clean，19 files no fixes |
| `bun scripts/complexity/gate.ts` | `complexity gate ok (1292 files, 11915 functions)`，无需动 allowlist |
| e2e | 按要求未跑 |

并行 agent 的在途改动导致 `bun test src/`（panels 全量）有 4 个 `src/files/*` 失败（`@tmex/ws-client` 缺 `getBulkClient`），以及 `apps/fe` 的 `tsc` 报 `packages/ghostty-terminal/src/canvas-renderer.ts` 的 `GhosttyColorRgb` 未使用——**都不在我的文件里，未触碰**。

---

## 7. 文件清单

新增（全部在 `packages/panels/src/code-viewer/`）：
- `language-map.ts`、`language-loaders.ts`、`bundled-languages.ts`
- `highlight-engine.ts`、`highlight-protocol.ts`、`highlight.worker.ts`、`main-thread-engine.ts`
- `highlight-client.ts`、`use-highlighted-code.ts`、`line-gutter.ts`
- 测试：`highlight-engine.test.ts`、`highlight-client.test.ts`、`highlight.worker.test.ts`、`line-gutter.test.ts`

改写：
- `packages/panels/src/code-viewer/code-viewer.tsx`（247 → 95 行，只剩渲染）
- `packages/panels/src/code-viewer/code-viewer.test.tsx`

仓库内唯一的外部改动（任务明确允许的一行）：
- `apps/fe/vite.config.ts` —— 在 `build` 之前加 `worker: { format: 'es' }` 及两行说明注释。**没有动其它任何配置项。**

未动：`index.ts`（导出面不变）、`hljs-terminal-theme.css`、`markdown-preview.tsx`、`FilePage.tsx`（`FilePage.test.tsx` 本来就 mock 掉 `CodeViewer`，不受影响）。

---

## 8. 留给后续的两条

1. **`markdown-preview` 侧的 lowlight 仍全量静态引用 36 个语言**（49 KB gz）。改成显式语言集或懒加载后，`bundled-languages.ts` 就可以删掉，dist 那 168 KB raw 的重复也一起消掉。属 markdown 那条链，本任务未越界。
2. **512 KiB 以内的高亮 HTML 仍是一整块 innerHTML**（500 KiB TS ≈ 1.06 MB HTML）。要继续压这一段得让 hljs 按行产出（lowlight 出 hast 再切），风险与工作量都上一个台阶，本轮未做。
