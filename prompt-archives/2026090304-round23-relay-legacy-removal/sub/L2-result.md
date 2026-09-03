# L2 结果：用仓内 class-merge 取代 tailwind-merge

## 改动文件

| 文件 | 说明 |
| --- | --- |
| `packages/ui/src/class-merge.ts`（新增，496 行） | 类名合并器，行为对齐 tailwind-merge 3.4.0 默认配置（Tailwind CSS v4） |
| `packages/ui/src/class-merge.test.ts`（新增，305 行） | 251 条锁定用例（期望值全部取自 tailwind-merge 实际输出）+ 3 条结构用例 |
| `packages/ui/src/utils.ts` | `cn()` 改为 `mergeClassNames(clsx(inputs))` |
| `packages/ui/src/utils.test.ts` | 补 6 条 `cn()` 用例（clsx 展开、跨参数覆盖、简写/细分方向、变体前缀、未知类、空输入） |
| `packages/ui/package.json` | 删掉 `tailwind-merge` 依赖（仅此一行，未动 bun.lock） |

未改任何调用点。全仓 `tailwind-merge` 的 import 只有 `packages/ui/src/utils.ts` 一处，已消除。

## 实现方式

不是手写规则，而是把 tailwind-merge 默认配置的 `classGroups`/`conflictingClassGroups`
**等价压缩**成一张表，运行时按同样的前缀树 + 校验器顺序解析：

- `TABLE`：350 个组、111 行，形如 `组名::候选1|候选2`。候选可以是字面量（按 `-` 拆成前缀树多级）、
  `前缀-(嵌套)`、`.`（前缀自身成组）、`<校验器>`；`$xxx` 是 `MACROS` 里 15 个公共候选集
  （`$space`/`$color`/`$radius`/`$width`/`$inset`/`$size`/`$pos` 等）。
- `VALIDATORS`：21 个校验器（`num`/`int`/`frac`/`pct`/`tshirt`/任意值 `[..]`/任意变量 `(..)` 及
  带 label 的 length/number/size/position/image/shadow/family-name 变体），正则逐字抄自
  tailwind-merge 的 `validators.ts`。
- `CONFLICTS`：48 条跨组作废规则（下表）。
- 解析流程与 tailwind-merge 一致：`splitModifiers`（括号深度感知，`:` 拆变体、`/` 记后缀修饰符）→
  `!` 前后缀 → 变体链排序（`orderSensitiveModifiers` 与任意变体 `[..]` 作为分段边界，段内字典序）→
  `修饰符ID + 组ID` 去重 → 倒序遍历、后者胜。未识别的类名原样保留、保持相对顺序。
- 500 条上限的结果缓存（满则整清，非 LRU）。

### 冲突组表（`CONFLICTS`，命中后者即作废前者）

| 组 | 一并作废 |
| --- | --- |
| `p` / `m` / `scroll-m` / `scroll-p` | 对应的 `x y s e t r b l` 八个方向组 |
| `px` `py` `mx` `my` `scroll-mx` `scroll-my` `scroll-px` `scroll-py` | 各自的两个方向组 |
| `inset` | `inset-x inset-y start end top right bottom left` |
| `inset-x` / `inset-y` | `right left` / `top bottom` |
| `gap` | `gap-x gap-y` |
| `size` | `w h` |
| `flex` | `basis grow shrink` |
| `font-size` | `leading`（Tailwind v4 的 `text-sm` 同时定行高） |
| `line-clamp` | `display overflow` |
| `overflow` / `overscroll` | 各自的 `-x -y` |
| `rounded` | 全部 14 个角/边组；`rounded-t/r/b/l/s/e` 各自作废两个角 |
| `border-w` / `border-color` | 各自 8 个方向组；`-x/-y` 再各作废两个 |
| `border-spacing` | `border-spacing-x/y` |
| `translate` | `translate-x translate-y translate-none`；`translate-none` 反向作废全部 |
| `touch` | `touch-x touch-y touch-pz`；三者反向作废 `touch` |
| `fvn-normal` | 其余 5 个 font-variant-numeric 组，且互相反向作废 |

## 验证

对照物是仓里现存的 `tailwind-merge@3.4.0`（`node_modules` 里直接 import），逐条比对
`mergeClassNames(x)` 与 `twMerge(x)`：

| 用例集 | 规模 | 差异 |
| --- | --- | --- |
| 语料单类：从 `packages/ui` `packages/panels` `packages/terminal-ui` `apps/fe/src` `packages/theme`（737 个源文件）抽出的字符串里，被 tailwind-merge 识别为类名的 token | 1135 | 0 |
| 语料两两组合 | 1,290,225 | 0 |
| 配置字面量类名（933 条）+ 按校验器合成的类名（26 种取值 × 215 个校验器节点） | 7417 单类 + 877,906 两两组合 | 0 |
| 全池随机两两组合（7417 个 token 池） | 2,000,000 | 0 |
| 随机 2–11 类组合，随机叠加 1–3 层变体前缀、`!` 前/后缀、负号、`/50` 后缀修饰符 | 500,000 | 0 |
| 真实语料类名串（源码里 ≥2 个类、识别率 >60% 的字符串，947 条）单串 / 两两拼接 / 拼随机覆盖类 | 947 + 897,756 + 935,636 | 0 |
| 手写疑难用例（见下）| 233 | 0 |
| 边界输入（空串、纯空白、多空格/换行、`p-`、`-`、`p--2`、`[]`、`[:]`、`[a:]`、`[:b]`、`hover:`、`:p-2`、`p-2/`、`/p-2`、`!`、`!!p-2`、`p-2!!`、300 字符长串） | 26 | 0 |

合计约 650 万次比对，**0 处不一致**。

手写用例覆盖：p/px/pt 与 m/mx/mt 双向、负值 margin、`size` vs `w/h`、`inset` vs `top/left/start`、
`rounded` vs 边/角、border 宽度 vs 颜色 vs 样式 vs collapse、ring/outline/shadow 的宽度 vs 颜色、
字号 vs 颜色 vs 对齐 vs 换行、v4 的 `text-sm` 清 `leading-*`、`text-sm/6` 后缀修饰符、
`line-clamp` 清 display/overflow、`touch-pan-y` 与 `touch-none` 互清、`translate-none`、
`fvn`、gap/space/grid/flex、overflow/overscroll、变体前缀（`hover:` `sm:` `dark:` `group-hover:`
`data-[state=open]:` `[&_svg]:` `*:` `after:` `[@media(...)]:` `has-[...]:` `in-data-[...]:`）、
变体顺序无关（`hover:focus:p-2` 与 `focus:hover:p-4` 视为同组）、`!` 前后缀、任意值/任意变量/
任意属性（`[overflow-wrap:break-word]`、`[color:red]`、`[--foo:bar]`）、未知类透传与去重。

`packages/ui` 测试基线由 **110 → 370**（新增 251 + 6 + 3；含原有 110）。

### 命令输出

- `cd packages/ui && bun test` → 370 pass / 0 fail
- `bunx tsc --noEmit -p packages/ui` → 0 错误；`bunx tsc --noEmit -p apps/fe` → 0 错误
- `bunx biome check packages/ui/` → 干净（60 个文件）
- 连带回归（未改动但重度依赖 `cn`）：`packages/panels` 911 pass、`packages/terminal-ui` 400 pass、
  `apps/fe` `bun test src/` 1798 pass / 0 fail
- `bun run lint`：biome 全仓干净；复杂度门禁失败 3 条，**全部不在本任务范围**（见"需要指挥官处理"）

## 体积：实测数字与预期有出入（重要）

用 `bun build --minify --target browser` 单独打包对比：

| | 未压缩 | minify 后 | minify+gzip |
| --- | --- | --- | --- |
| `tailwind-merge` dist | 97.2 KB | 25.2 KB | **8.05 KB** |
| `class-merge.ts`（本实现，全量 350 组） | 28.4 KB（源文件） | 21.2 KB | **7.10 KB** |

即净省约 **0.95 KB gzip**，不是任务描述里预期的 7.7 KB。原因是"冲突合并"这件事的信息量
基本等于那张组表：只要想保持和 tailwind-merge 一致的判定，表就省不掉，tailwind-merge 自己的
8 KB gzip 里也基本全是表。若要换更多体积，只能砍覆盖面（砍掉的组会退化成"未识别类名"：
不去重、不解冲突，两个类都留下，最终由 Tailwind 生成的 CSS 顺序决定谁生效）。实测三档：

| 覆盖 | minify+gzip | 相对 tailwind-merge |
| --- | --- | --- |
| 全量 350 组（当前实现） | 7.10 KB | −0.95 KB |
| 245 组（砍 mask-*、blend、3D/perspective/skew、snap、break-*、columns、text-shadow/inset-shadow/inset-ring、部分 backdrop-* 等冷门族） | 5.98 KB | −2.07 KB |
| 187 组（只保留语料用到的 132 组 + 冲突闭包） | 5.22 KB | −2.83 KB |

我选了**全量**：多出的 1～2 KB gzip 换不了"以后有人写了没覆盖的工具类、合并静默失效"这种坑，
且当前实现与 tailwind-merge 逐字节一致，可回归。若指挥官要那 2 KB，只需从 `TABLE` 里删掉对应
行（表是一行一组、`;` 分隔多组的纯数据），删完跑 `packages/ui` 的测试即可确认没删到在用的组。

性能（20000 次调用）：命中缓存 5.0ms vs tailwind-merge 6.0ms；全冷（每次都是新串）122ms vs 111ms；
模块首次建表 2.6ms，与 tailwind-merge 相当。

## 已知差异

对照 tailwind-merge 3.4.0 默认配置，**没有发现任何输出差异**。三处有意简化（均不改变输出，
已写进文件头注释）：

1. 不支持 `prefix` / `experimentalParseClassName` 两个配置项（仓里没用到）。
2. 后缀修饰符（`text-sm/6`）的 `conflictingClassGroupModifiers` 表在默认配置里只有
   `font-size → leading` 一条，与基础冲突表完全相同，因此没有单列（合并后集合一致）。
3. 结果缓存是"满 500 条即整清"，不是 tailwind-merge 的双 Map LRU。只影响命中率，不影响结果。

行为上唯一需要知会开发者的点（与 tailwind-merge 相同，但表由我们自己维护）：**升级 Tailwind /
新增工具类族时，若新类不在 `TABLE` 里，它会被当作未识别类名原样保留、不参与冲突消解**。
文件头注释已写明表来自 tailwind-merge 3.4.0 的 default-config、升级时需同步。

## 建议目视回归的页面/组件

`cn` 有约 195 个调用点，改动是全局性的，建议按下面顺序扫一遍（重点看"覆盖类是否生效"和
"是否出现两条同类样式打架"）：

1. **设置页**：Settings 各 tab 切换（`SettingsPage.tsx:160` 依赖冲突消解）、节点/设备/远程访问子页。
2. **浮层**：dialog / alert-dialog（`dialog-impl.tsx:79,112`）、sheet 四个方向（`sheet-impl.tsx:94-124`）、
   dropdown-menu（`dropdown-menu-impl.tsx:231`）、select（`select.tsx:13,101,135`）、popover、tooltip。
3. **侧栏**：展开/收起/offcanvas/icon 三态、拖拽把手、菜单项 hover/active
   （`sidebar-primitives.tsx:14,25,36,47,72,131`、`sidebar-menu.tsx:16,27,73,165,201`）；移动端侧栏。
4. **设备/文件树**：文件夹层级缩进、选中/拖拽态、文件页侧栏。
5. **Agent 会话**：chat thread 气泡（`chat-thread.tsx:191,201`）、markdown 预览
   （`markdown-preview.tsx:107,170`）、流式 markdown（`streaming-markdown.tsx:185,243`）、
   代码查看器（`code-viewer.tsx:74,81`）。
6. **终端**：TerminalPreview、分屏 pane 标题栏 hover 态。
7. **卡片/标签页**：card 各 size 变体（`card.tsx:73`）、tabs 的 line/default 变体（`tabs.tsx:16,46`）。
8. **节点徽标 / agent-session-row**（`agent-session-row.tsx:83,95`）、链路/中转徽标颜色。

（本任务只跑单测，未跑 Playwright e2e —— 按共同规则由指挥官统一跑。）

## 需要指挥官处理

1. **`bun install`**：`packages/ui/package.json` 已删 `tailwind-merge`，但 `bun.lock` 未动
   （规则要求）。请在合并前跑一次 install 更新锁文件。注意：我的验证脚本依赖
   `node_modules` 里还留着 `tailwind-merge`，install 后它会消失，届时对照测试无法复跑
   （单测不依赖它，全部是硬编码期望值）。
2. **两处过时注释**（不在我的 scope，未改）：
   - `apps/fe/src/components/page-layouts/components/use-section-presence.ts:6`
   - `apps/fe/src/components/side-panels/side-panel-host.tsx:65`
   都提到 "tailwind-merge"，语义仍成立（合并器行为一致），只是名字过时，建议顺手改成
   "类名合并器"。
3. **`bun run lint` 当前失败 3 条，都不是本任务的文件**（应为并行 agent 的在改文件）：
   - `apps/fe/src/pages/settings/relay/relay-tab.tsx:36 RelayTab: 236 行 > 120`
   - `packages/shared/src/auth/key-log.ts:526 applyKeyLogRecord: CC 18 > 15`
   - `packages/shared/src/relay/codec.ts:385 parseByType: CC 34 > 15`
   `class-merge.ts` 496 行、无函数超标，未进任何 allowlist。
4. **测试基线更新**：`packages/ui` 110 → 370。
5. **体积预期**：见上文"体积"一节，实际只省 0.95 KB gzip；要更多需砍覆盖面，取舍权在你。
