# T4d 结果：中继标签指标磁贴重排（不再截断）

## 问题

1280×900 下中继标签的 13 格 `xl:grid-cols-6` 把面板（实际只有 ~880px）切成 ~130px 的格子，
标签被截成 `ACT…` / `INB…`，数值被截成 `0…`，事件循环副行截成 `pea…`，第 13 格「运行时长」
还单独掉到第三行。

## 改动

### 1. 磁贴数 13 → 12

- 完整排去掉「运行时长」格（头部条已有「运行中 · 版本 · 已运行 … · N 个租户」）；
  `UptimeTile` 组件保留，本机卡片的紧凑排仍在用。
- 「内存」与「堆内存」合成一格：值取 RSS，副行「堆 48.0 MB / 64.0 MB」。
  `MemoryTile` 新增 `showHeapTotal`（沿用 `ThroughputTile.showTotal` 的写法），完整排传 true，
  紧凑排不传（位置窄，只留堆已用量）。`HeapTile` 及 `tiles.heap` / `tiles.heapSub` 三语键一并删除。
- 第 12 格新增「重连」`ReconnectsTile`：`totalMemberReconnects(members)`，即各接入节点
  `reconnects` 之和（离线成员也算，断线本身就是要看的量）；为 0 时走 muted 色调。

### 2. 栅格

`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6`

与任务书给的 `… lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6` 有一处偏差：**去掉了 xl 的四列**。
原因是任务同时要求「两组、每组一行语义」——每组 6 格，四列会排成 4+2 的缺角行，实测截图
明显比 3+3 难看。列数只取 6 的因数（1 / 2 / 3 / 6）行才不缺角。四列与三列在 880px 面板下都
不截断（四列 ~200px、三列 ~275px），所以这里按视觉取三列。1536px 起（面板 ~1112px）走六列，
每组正好一行。

### 3. 分组

12 格拆成两个 `<section>`，各带一行 muted 小标题：

- 流量 / Traffic / トラフィック：在线节点、活跃流、入站速率、出站速率、帧速率、累计流量
- 进程 / Process / プロセス：延迟、事件循环、内存、CPU、连接数、重连

外层仍带 `data-testid="relay-metrics-tiles"`，分组各带 `relay-metrics-group-{traffic,process}`。

### 4. StatTile / Sparkline 原语

- 文字列去掉 `min-w-0`：它的最小宽度由标签与数值撑出来，空间不够时先挤折线。
- 标签去掉 `truncate`，改 `leading-tight`，允许折两行。
- 数值去掉 `truncate`，改 `whitespace-nowrap`（「275 MB」不会在空格处断行）。
- 副行仍是唯一走 `truncate` 的一行。
- 折线槽位 `shrink-0 self-end` → `hidden min-w-0 max-w-[40%] shrink self-end sm:block`：
  最多占 40%，可被压到 0，`sm` 以下（单列）直接不画。
- `Sparkline` 基础类加 `max-w-full`，SVG 才跟着容器缩（`preserveAspectRatio="none"`，横向压扁即可）。

StatTile 只有 `relay-metrics-tiles.tsx` 在用，无其他调用点受影响。

### 5. 文案（三语同步）

- zh：`bytesIn` 入向速率 → **入站速率**，`bytesOut` 出向速率 → **出站速率**，
  `traffic` 中转流量 → **累计流量**（文案规范禁用「中转」一词，它已被「中继」占用），
  趋势图例 入向/出向 → **入站/出站**。
- 新增 `tiles.memoryHeapSub`、`tiles.reconnects` / `reconnectsSub` / `reconnectsHint`、
  `groups.traffic` / `groups.process`；删除 `tiles.heap` / `tiles.heapSub`。三语键完全同步
  （en 与 zh 仍差 10 个复数键，是既有差异，非本次引入）。
- `bun run build:i18n` 已跑。

### 6. 趋势卡

图本来就是 `w-full`，390px 下不溢出；顺手给标题/图例那一行加了 `min-w-0 flex-wrap gap-y-0.5`，
峰谷标注换行时不挤。

## 实测（截图核对）

在 scratchpad 里搭了一次性校验：`renderToStaticMarkup` + 真实 i18n 资源出静态标记，用
`@tailwindcss/vite` 编出 apps/fe 的真实 CSS，Playwright 按 880 / 1112 / 640 / 358 四种面板宽度
（对应 1280 / 1600 / 800 / 390 视口）截图，并逐格检测「文本右边缘越过卡片内边界」「元素被
`overflow:hidden` 裁掉」「文档横向溢出」。四种宽度全部 0 命中。临时脚本已从仓库删除
（`git status` 干净，无 `__tilecheck*` 残留）。

- 1280：每组 3+3 两行，标签数值完整。
- 1600：每组一行六格，折线自动压窄，仍不截断。
- 390：单列，折线不画，趋势卡峰谷标注换行。
- 本机卡片紧凑排 4+3 与副行「堆 48.0 MB」保持原样。

## 文件

- `apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx`
- `apps/fe/src/pages/settings/relay/relay-metrics-model.ts`（新增 `totalMemberReconnects`）
- `apps/fe/src/pages/settings/relay/relay-metrics-panel.tsx`（骨架格数 8 → 12）
- `apps/fe/src/pages/settings/relay/relay-metrics-trends.tsx`
- `apps/fe/src/pages/settings/relay/relay-metrics-ui.test.tsx`
- `packages/ui/src/components/stat-tile.tsx` / `stat-tile.test.tsx`
- `packages/ui/src/components/sparkline.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` + 生成物

## 验证

| 项 | 改前 | 改后 |
|---|---|---|
| `apps/fe` `bun test src/pages/settings/relay` | 126 pass / 0 fail | 129 pass / 0 fail |
| `apps/fe` `bun test src/` | 2294 pass / 0 fail | 2294 pass / 0 fail |
| `packages/ui` `bun test` | 414 pass / 0 fail | 414 pass / 0 fail（stat-tile 34 → 36） |
| `apps/fe` `bunx tsc --noEmit -p .` | 14 error（全在 settings/nodes，他人在改） | 0 error |
| `packages/ui` `bunx tsc --noEmit -p .` | 0 | 0 |
| `bunx biome check`（改动文件） | — | 干净 |
| `bun scripts/complexity/gate.ts` | 1 violation（`settings/nodes/local-machine-card.tsx`，非本任务） | ok（0 violation） |

## 遗留

- 无 TODO。`RelayTilesSkeleton` 仍用紧凑排的栅格（`sm:grid-cols-2 lg:grid-cols-4`），
  它只是加载占位，面板处格数已调到 12；如果要与分组版式严格对齐需要再给它加一个变体，
  当前收益不大没做。
