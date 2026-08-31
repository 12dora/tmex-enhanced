# M1：终端 pane 切换延迟测量

`measure-switch.ts` 是一个自包含的可重复测量脚本：自己拉 tmux 会话、自己起临时 gateway、自己开
Playwright(chromium)，跑完输出 CSV + median/p90 表格，然后自动收尾。

## 前置条件

- Bun（`~/.bun/bin/bun`），tmux；chromium 由 Playwright 提供（`bunx playwright install chromium`，通常已装）。
- 一份**源码树**（含 `node_modules`，`bun install --frozen-lockfile` 过）和一份**前端产物**（`vite build` 的 dist）。
  两者可以来自不同 commit：脚本用 `GATEWAY_SRC_DIR` 起后端，用 `FE_DIST_DIR` 作静态根。

## 基线（branch base = c850e077）

基线用的源码树与产物已经准备在 scratch 里：

```
SCRATCH=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/ca52e5db-7f6e-4446-8b64-e719939894f2/scratchpad
```

如果 `$SCRATCH/src-base` 或 `$SCRATCH/fe-dist-base` 不在了，重建：

```bash
export PATH=$HOME/.bun/bin:$PATH
mkdir -p $SCRATCH/src-base
git -C /Users/konata/code/tmex-enhanced archive --format=tar c850e077 | tar -x -C $SCRATCH/src-base
cd $SCRATCH/src-base && bun install --frozen-lockfile
cd $SCRATCH/src-base/apps/fe && bunx vite build --outDir $SCRATCH/fe-dist-base --emptyOutDir
```

跑基线（默认值就是基线配置，约 80 秒）：

```bash
export PATH=$HOME/.bun/bin:$PATH
cd /Users/konata/code/tmex-enhanced/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/measure
LABEL=baseline2 RUNS=16 WARMUP=2 SINGLE_WARMUP=3 bun measure-switch.ts
# → baseline2.csv + 终端里的 median/p90 表（cross / same / single 三张）
```

## 优化落地之后（worktree 源码 + 新产物）

先从 worktree 构一份新的前端产物，再指过去：

```bash
export PATH=$HOME/.bun/bin:$PATH
WT=/Users/konata/code/tmex-enhanced-wt-r9
cd $WT/apps/fe && bunx vite build --outDir $SCRATCH/fe-dist-after --emptyOutDir

cd /Users/konata/code/tmex-enhanced/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/measure
LABEL=after2 RUNS=16 WARMUP=2 SINGLE_WARMUP=3 \
  GATEWAY_SRC_DIR=$WT \
  FE_DIST_DIR=$SCRATCH/fe-dist-after \
  bun measure-switch.ts
# → after2.csv，与 baseline2.csv 逐项对比
```

对比时只看 `cross` 与 `same` 两张表的 median / p90；两次跑同一配置的漂移见下面「稳定性」。

## 可调参数（全部走环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LABEL` | `baseline` | 结果标签，同时决定默认 CSV / db / 日志文件名 |
| `GATEWAY_SRC_DIR` | `$SCRATCH/src-base` | 起 gateway 的仓库根（须已 `bun install`） |
| `FE_DIST_DIR` | `$SCRATCH/fe-dist-base` | 前端产物目录（`TMEX_FE_DIST_DIR`） |
| `PORT` | `19765` | 临时 gateway 端口（9883/9663/19883 被硬拒） |
| `RUNS` | `16` | 每类切换（cross / same）各跑多少次 |
| `WARMUP` | `2` | cross / same 前 N 次只进 CSV、不进统计 |
| `SINGLE_WARMUP` | `3` | single 场景的预热次数（pool 是 3 个 window，至少 3 次才全热） |
| `TMUX_SOCKET` | `tmex-r9-perf` | 专用 socket；`default` / `tmex` 被硬拒 |
| `SESSION` | `m1perf` | tmux 会话名；`tmex` 被硬拒 |
| `SEED_LINES` | `300` | 每个 pane 灌多少行宽文本（决定 TERM_HISTORY 体量） |
| `SETTLE_MS` | `500` | 两次切换之间的静默时间 |
| `LINGER_MS` | `700` | 「首帧内容」之后继续收帧的时间，必须 > 450（见下） |
| `OUT` | `<label>.csv` | CSV 输出路径 |
| `HEADLESS` | `1` | `0` 可开有头浏览器肉眼看 |
| `VIEWPORT_W/H` | `1440/900` | 浏览器视口（决定 pane 的 cols/rows） |
| `KEEP_SESSION` | — | `1` 时结束不杀 tmux 会话，便于事后 `capture-pane` |
| `DEBUG_CAPTURE` | — | `1` 时打印各阶段 pane 尺寸与 capture 字节数 |

## 测量口径

每次切换的 `t0` 是**页面内 capture 阶段**收到目标侧栏行 `click` 事件的那一刻（`performance.now()`），
不是 Node 侧发出点击的时刻——避免把 CDP 往返算进去。之后页面里跑一个 `requestAnimationFrame` 循环逐帧判定：

| 列 | 含义 |
| --- | --- |
| `ph_appeared` / `ph_gone_ms` | boot placeholder 是否出现过 / 何时消失（没出现过记 0） |
| `route_ms` | `location.pathname` 变成目标 pane 路由 |
| `remounted` / `remount_ms` | `__tmexE2eXterm` 是否换成了另一个终端实例、何时 |
| `first_content_ms` | 首个满足「可见 buffer 含目标 pane 标记、且不含另两个 pane 的标记，canvas 已有尺寸」的帧 |
| `switch_ack_ms` / `history_ms` / `live_resume_ms` | 对应 WS 帧（`0x0401`/`0x0306`/`0x0402`）到达且 `paneId` 匹配目标 |
| `history_bytes` | 该次 TERM_HISTORY 的 payload 字节数 |
| `first_output_ms` | 切换后第一帧 `TERM_OUTPUT`（`0x0305`）且 paneId 匹配 |
| `chunk_*` | `CHUNK`（`0x0501`）分片帧的个数与首末时刻 |
| `want_history` | 出向 `TMUX_SELECT`(`0x0201`) 帧里的 `wantHistory` 标志；同窗 `FOCUS_PANE`(`0x0212`) 路径没有这帧，留空 |
| `keepalive_panes` | 切换刚完成那一帧 `[data-testid="terminal-keep-alive-pane"]` 的元素个数（基线恒为 0） |
| `keys_at_ms` | `tmux send-keys` 返回的时刻（相对 t0） |
| `live_ms` / `live_after_keys_ms` | 点击后**立刻**发 `echo LIVE_x`，该文本首次可见的时刻 |
| `post_live_after_keys_ms` | 切换**完全稳定后**再发一次 `echo`，测稳态实时输出往返 |

几个必须知道的细节：

- **`live_ms` 在 cross 场景等于 `first_content_ms`**：点击后 ~7ms 就 send-keys，这一行会被 tmux
  `capture-pane` 卷进 TERM_HISTORY 一起下发，所以它量的是「切换过程中打进去的字符多久能看见」，
  **不是**实时通道恢复的时间。真正的稳态 live 往返看 `post_live_after_keys_ms`。
- **`LINGER_MS` 必须 > 450**：gateway 的 `switch-barrier.ts` 里 `LIVE_RESUME_DELAY_MS = 450`，
  LIVE_RESUME 固定比 TERM_HISTORY 晚 450ms。窗口小于它会把 `live_resume_ms` / `first_output_ms` 统计成 n/a。
  如果优化改小了这个常量，也不用动 LINGER。
- **`first_content_ms` 不做像素级判定**：终端是 WebGL/canvas 渲染，逐帧 `readPixels` 既慢又会自己扰动测量。
  这里判定的是「该帧终端 buffer 已含目标内容且 canvas 有尺寸」，实际上屏发生在同帧或下一帧（≤16.7ms）。
- 页面内的 rAF 轮询本身有开销，但基线与对比跑用的是同一套探针，量级一致。

## 三个场景

脚本一次跑三类切换，会话布局是 4 个 window / 5 个 pane：`w0` 两个 pane（`%p0`/`%p1`），
`w1`/`w2`/`w3` 各一个 pane（`%p2`/`%p3`/`%p4`）。

| 场景 | 序列 | 覆盖的路径 |
| --- | --- | --- |
| `cross` | `%p0(w0) → %p2(w1) → %p1(w0) → %p2(w1) → …` | 跨 window 完整 select 事务；目标里有多 pane window（走分屏视图） |
| `same` | `%p0 ↔ %p1`（同一个 w0） | 轻量 `FOCUS_PANE`，无屏障、无 history |
| `single` | `%p2(w1) → %p3(w2) → %p4(w3) → …` | **路由窗口只有一个 pane**，这才是 keep-alive 保活路径覆盖的场景 |

`single` 用 `SINGLE_WARMUP=3`（默认），保证轮转池里三个 window 在开始统计前都已经热过一遍。

## ⚠️ `remount` 在 after 构建上不再是「重挂载」信号

`remount_ms` 判的是页面全局 `__tmexE2eXterm` 换成了另一个对象。keep-alive 落地之后，**每次切换这个
全局都会换身份（指向当前可见 pane 的那个终端实例），即使底层终端根本没有被销毁重建**。所以在 after
构建上 `remounted` 恒为 1，不能拿来判断「有没有真的重挂载」。

判断是否真的走了保活路径，看这三个：

- `keepalive_panes > 0` —— 有 pane 被保活在 DOM 里（`single` 场景 after 构建为 3）；
- `want_history == 0` —— 这次 select 没要 history（保活命中，不需要回放）；
- `ph_appeared == 0` —— 没出现 boot placeholder（终端没有重新 boot）。

## 安全约束（脚本内置硬拒）

- 端口 9883 / 9663 / 19883 直接抛错；只用 19765（可改，但别改成这几个）。
- tmux socket 只能是专用 socket，`default` / `tmex` 直接抛错；所有 tmux 调用都带 `-L <socket>`。
- 会话名不能是 `tmex`。新库启动时 gateway 会自动播种一个 `session=tmex` 的默认设备并在**本脚本的专用
  socket 上**建出同名会话，脚本会立刻删掉那个设备并 `kill-session`（仍然带 `-L <专用 socket>`）。
- 收尾只做 `tmux -L <专用 socket> kill-session -t <会话>`；**永远不要**在默认 socket 上 `kill-server`。

## 稳定性

同一配置连跑两次，`cross / first_content` 的 median 差 0.1ms、p90 差 0.6ms；`same` 的 median 差 2.2ms。
判定优化是否有效时，**小于 3ms 的 median 变化不要当成信号**。
