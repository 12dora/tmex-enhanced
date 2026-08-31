# O6 结果：agent composer 遮挡真 bug + resize 用例断言重写

## 问题 1：窄侧栏下控件溢出遮住发送按钮（产品 bug，已修）

### 复现与实测

`tests/agent-session.spec.ts:404` 稳定失败，playwright 报 `agent-chat-send` 的点击点被
`agent-control-chars-switch` 拦截（`from <div class="flex min-w-0 flex-1 items-center gap-2"> subtree
intercepts pointer events`）。失败截图确认：侧栏宽约 280px，composer 内容宽约 260px，
「Confirm writes ▢  Control chars ▢」这一组自然宽约 263px，而 running 态右侧还要放
steer/send/stop 三个 icon button（约 96px）。

### 根因

footer 原结构：

```
<div class="flex min-w-0 flex-wrap items-center gap-2">        ← 外层可 wrap
  <div class="flex min-w-0 flex-1 items-center gap-2">        ← 左侧组：min-w-0 可缩到 0
    <WriteModeControls class="flex shrink-0 items-center gap-3"/>   ← shrink-0：拒绝收缩
    <div class="min-w-0 flex-1"><ModelPicker/></div>
  </div>
  <div class="ml-auto flex shrink-0">…按钮…</div>
</div>
```

左侧组带 `min-w-0` 所以会被压到远小于内容宽度，但它唯一的宽内容 `WriteModeControls` 是
`shrink-0`，于是内容按 max-content 渲染并**溢出**父盒（overflow 默认 visible），直接盖到右侧按钮上；
同时 ModelPicker 被挤成 0 宽（截图里完全看不见）。`flex-wrap` 在这里不起作用——外层只有两个 item，
左侧组的 flex-basis 是 0，永远"放得下"，不会换行。

### 修复（`packages/panels/src/agent/agent-composer.tsx`）

1. 拆掉那层多余的左侧包装 div，让 `WriteModeControls` / ModelPicker 容器 / 操作按钮组成为
   外层 wrap 容器的三个同级 flex item。
2. ModelPicker 容器给 `basis-32`（128px）：宽度不够时它整体换行下沉到第二行，和按钮组排一行，
   而不是被压成 0 宽。
3. `WriteModeControls` 根节点去掉 `shrink-0`，改为 `flex min-w-0 flex-wrap items-center
   gap-x-3 gap-y-1.5`；两个开关小组各加 `min-w-0`，label span 加 `truncate`。
   这样极窄时先在开关组之间换行，再退化为 label 省略号，任何宽度下都不会溢出遮挡按钮。
   （`Switch` 组件自带 `shrink-0`，开关本体不会被压扁。）

没有用 z-index（那只是把遮挡方向反过来），也没有改测试去 force-click。

实测截图（280px 侧栏、running 态）：第一行「Confirm writes ▢  Control chars ▢」，
第二行「模型选择器 + ⚡/发送/停止」，无重叠，ModelPicker 恢复可见。

## 问题 2：`ws-borsh-theme-resize.spec.ts` 的 drift 断言——诊断修正

### 交办诊断与实测结论不一致

任务书给的诊断是"分屏比例在快速 resize 中漂移，单 pane cols 漂了 30 列"。实测把
window/pane/term 三个尺寸都打出来后，真实原因是**基线取早了**：

```
DBG t0  window 40x24  pane 20x24  term 20x24   ← 循环前基线（一致性 poll 立刻通过）
DBG t1  window 99x37  pane 50x37  term 50x37   ← 3s 后布局落定
DBG after0..5（restore 之后，连续 6s 采样，全部稳定）
        window 99x37  pane 50x37  term 50x37   panes: %526 50x37 | %527 48x37
```

xterm 挂载时先以 20×24 出现，gateway 立刻把 tmux 同步成同样大小，于是
`|term-pane| <= 1` 在 t0 就成立、`expect.poll` 首次采样即返回，基线被钉在 20×24。
布局落定后涨到 50×37，所谓"drift 30 列"正是 `50-20=30`；我先按交办改成 window 断言时报
drift 72，也正是 `(99-40)+(37-24)=72`。

**分屏比例其实没有漂移**：restore 之后两个 pane 稳定在 `50x37 | 48x37`，与循环前完全一致，
window 也精确回到 99×37。产品行为是正确的，这个用例从头到尾是测试侧的首屏时序 bug。

### 重写内容（`apps/fe/tests/ws-borsh-theme-resize.spec.ts`）

1. 新增 `waitForSettledTerminalSize(page, paneId)`：`expect.poll` 到「term 尺寸连续两次采样不变
   **且** 与 tmux pane 一致（drift ≤ 1）」才算落定。循环前取基线、循环后判收敛都用它，
   彻底消除"一致性瞬时成立"的假阳性。
2. 删掉 `waitForTimeout(2_000)` 固定 sleep 与单 pane cols/rows 断言，改为按交办的两条断言：
   - 断言 1：restore 后 `waitForSettledTerminalSize`（FE 终端与 tmux pane 重新一致）；
   - 断言 2：`expect.poll` tmux **window** 总尺寸回到循环前值，`cols+rows` 偏差 ≤ 2。
   注释说明为什么不断言单 pane：产品只保证 window 网格贴合视口，分屏比例由 tmux layout 决定。
3. 帧计数断言（`counts.windowStyle >= 1`）原样保留。
4. `apps/fe/tests/helpers/tmux.ts` 新增 `getWindowSize(target)`（`#{window_width}\t#{window_height}`），
   原有 helper 未改。
5. 用例标题同步改为
   `ws-borsh: rapid theme toggle × browser resize converges back to window size + term/pane consistency`
   （原标题写的是 "keeps pane cols/rows stable"，已不符）。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `run-e2e.ts tests/agent-session.spec.ts:404` | ✅ 通过（修复前稳定失败） |
| `run-e2e.ts tests/agent-session.spec.ts`（6 个用例） | 修复后首轮 6/6 通过；复跑时 `:538` 偶发失败，见下 |
| `run-e2e.ts tests/ws-borsh-theme-resize.spec.ts` | ✅ 通过，2.0–2.4s（原来卡 2s sleep + 超时） |
| 同上 `--repeat-each=4` | ✅ 4/4 通过 |
| `tests/mobile-agent-watch.spec.ts`（含 model picker 可见断言） | ✅ 2/2 通过 |
| `cd packages/panels && bun test src/agent` | ✅ 74 pass / 0 fail |
| `bunx tsc --noEmit -p .`（packages/panels、apps/fe） | ✅ 均 0 错误 |
| `bunx biome check <4 个改动文件>` | ✅ clean |

### 关于 `agent-session.spec.ts:538`（provider unreachable）

修复后首轮全文件跑通过（1.1m），之后复跑出现 1 次失败；单独 `--repeat-each=3` 为 **2 通过 / 1 失败**。
判定为既有 flake，与本次改动无关：

- 失败点是 `agent-error-banner` 等不到，而失败截图显示侧栏停在 **Terminals tab**、Agent tab 未选中，
  会话树里那条 session 已经带红色错误点——说明发送成功、后端确实报错了，只是 UI 没停在 Agent tab；
  composer 的 flex 布局改动不可能导致侧栏 tab 切换。
- 该用例链路是 SDK 内置重试 + run 级重试，本机负载下耗时 60–70s（超时 150s），本身对时序敏感。

## 待办 / 交接

- `docs/known-issues.md:22` 仍把 `ws-borsh-theme-resize.spec.ts:39` 列为已知失败（"cols/rows 漂移超阈值"），
  该条已不成立，可以删掉；文件不在本任务的 ownership 内，未改。
- `apps/fe/tests/theme-propagation.spec.ts:210` 有同形状的用例，但用的是**单 pane** session 且
  同样只 poll 一致性——它也有"基线取早"的隐患（单 pane 下 window==pane，症状会表现为整体 drift）。
  本次未动，若后续该用例抖动，可复用同一个 settled-size 思路。
- `agent-session.spec.ts:538` 的 flake 建议单独立项（大概率是 Agent tab 选中态在长时间 pending 后被
  rehydration 覆盖）。

## 改动文件

- `packages/panels/src/agent/agent-composer.tsx`（产品修复）
- `apps/fe/tests/ws-borsh-theme-resize.spec.ts`（用例重写）
- `apps/fe/tests/helpers/tmux.ts`（新增 `getWindowSize`）
- `apps/fe/tests/agent-session.spec.ts`：**未改动**（曾临时插入 screenshot 做视觉验证，已还原）
