# Q2 结果：panels — ToolCallCard 有界输出预览

## 结论

Y1 报告第 4 项在代码中已核实：`ToolDetailsDialog` 打开后把整串 output 塞进单个 `<pre>`（`max-h-64` 只限视口不限 DOM），且 `extractToolImages(call)` 写在 `ToolDetailsDialog` 函数体内——弹窗关着时也会随卡片每次重渲染对整串 output 做一次 `value.replace(/\s/g,'')` 全串拷贝 + 正则匹配（旧实现还拷两次）。两项均已修复。

## 改动

### 1. `<pre>` 只挂载有界预览（+ 提示 + 复制完整输出）

`CollapsedText` 是所有工具视图（`SendInputBody` / `ReadScreenBody` / `WebSearchBody` / `FetchUrlBody` / `GenericBody` 的 input 与 output）共用的 `<pre>` 渲染点，因此边界只在这一处实现，覆盖全部路径。

新增纯函数 `previewEnd(text)`：返回挂载到 DOM 的截断位置，**64 KiB 与 2000 行取先到者**。截断时 `<pre>` 只渲染 `text.slice(0, end)`，下方追加一行提示 `agent.tool.previewNote`（「仅显示前 N 个字符（共 M）」，带 `data-testid="agent-tool-preview-note"`）和一个 `agent.tool.copyFull` 按钮，`onClick` 走 `navigator.clipboard.writeText(text)`——**复制拿的是闭包里保留的完整串，不是预览串**。未截断时行为与之前逐字节一致（无提示、无按钮）。

### 2. 图片探测加上尺寸阈值 + 出图工具白名单 + 记忆化

- `asImageSrc(value, allowBareBase64)`：值长度 > `IMAGE_VALUE_MAX_CHARS`（512 KiB）直接返回 `null`；`data:image/` 与图片 URL 仍对所有工具生效；**裸 base64 猜测只在 `call.toolName` 含 `image` 时开放**（对应 provider hosted tool `image_generation`，见 `apps/gateway/src/agent/tools/hosted.ts:15`）。顺带把原来两次 `value.replace(/\s/g,'')` 合并成一次。
- 弹窗内容抽成 `ToolDetailsBody`（Base UI 的 `Dialog.Portal` 关闭时不挂载），扫描因此**只在弹窗真正打开时执行**，且用 `useMemo` 按 `call` 记忆，重渲染不重扫。`ToolDetailsDialog` 只剩壳。

这是本轮唯一的可观察行为变更：一段恰好只由 base64 字母表字符组成的 `run_command` 输出，旧代码会把它当成 PNG 渲染成一张（必然坏掉的）`<img>` 并隐藏文本输出；现在按文本正常显示。这属于修正而非回归。另需注意 > 512 KiB 的 `data:image/...` 输出现在不再内联渲染（阈值是任务指定的；这么大的 data URI 本身就是要规避的 DOM 负担）。

## 文件

- `packages/panels/src/agent/messages/tool-call-card.tsx`（+66 / −21，净 +45）
- `packages/panels/src/agent/messages/tool-call-card.test.tsx`（新增，110 行）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`：`agent.tool` 下各加 `previewNote` / `copyFull` 两个 key（各 +2 行）
- `packages/shared/src/i18n/{resources.ts,types.ts}`：`bun run build:i18n` 重新生成（未手改、未 lint）

## 测量（before/after）

一次性 bench 脚本在 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/{tool-card-bench.test.tsx,old-card.tsx}`（`old-card.tsx` 是 `git show HEAD:` 取出的旧版，只加了 `export` 与一个等价的 `OldDetailsBody` 包装）。500 KiB `run_command` 输出，`ToolDetailsBody` SSR：

| 指标 | 旧 | 新 |
|---|---:|---:|
| SSR HTML 字节（500 KiB 纯文本输出，20 字符/行） | 540,127 | 45,794 |
| SSR 耗时（ms/次，20 次均值） | 2.281 | 0.489 |
| 关闭态每次重渲染的图片扫描（ms/次，500 KiB 值，50 次均值） | 0.854 | 0.004 |

补充：若 500 KiB 输出恰好全是 base64 字母表字符，旧版会把它同时写进 `<a href>` 和 `<img src>`，SSR HTML 达 **1,025,616** 字节；新版仍是有界的 69,330 字节（该用例走文本预览）。

新版 45,794 而非 ~65 KiB，是因为 20 字符/行时 2000 行上限先于 64 KiB 命中——两条边界都生效。

## 测试 / 类型 / lint

- `cd packages/panels && bun test` → **616 pass / 0 fail**（改动前该 worktree 实测 601；本次新增 15 个用例。任务书给的 606 与实测基线对不上，已确认 `git status packages/panels` 只有我这两个文件）
- `cd packages/panels && bunx tsc --noEmit -p .` → **0 error**（基线 0）
- `cd packages/shared && bun test` → **376 pass / 0 fail**；`bunx tsc --noEmit -p .` → **0 error**
- `bunx biome check` 于 `tool-call-card.tsx`、`tool-call-card.test.tsx`、三个 locale JSON → 全部干净（未对生成的 `resources.ts` / `types.ts` 跑 lint）

新增用例覆盖：`previewEnd` 的四种边界（空串/短文本、64 KiB 上限、2000 行上限、字符上限先到）；500 KiB 输出 SSR HTML < 100 KiB 且含提示与复制入口、且不含超过预览长度的连续原文；小输出原样渲染且无提示；`extractToolImages` 的 data URI / 图片 URL 全工具生效、裸 base64 仅出图工具生效、> 512 KiB 跳过、未完成/出错/被拒不探测。

## 遗留与风险

- 「复制完整输出」按钮在无 `navigator.clipboard` 的环境（非 HTTPS 的非 localhost 页面）会静默失败——用 `navigator.clipboard?.writeText` 做了可选链，不抛异常，但也没有 toast 反馈。加 toast 需引入 `sonner`，超出本轮「净行数尽量小」的范围，故未做。
- 未触碰 `chat-thread.tsx`、streaming-markdown、stores、apps/fe。
