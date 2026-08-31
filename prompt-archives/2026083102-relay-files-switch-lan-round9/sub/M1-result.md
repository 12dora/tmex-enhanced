# M1 结果：终端 pane 切换延迟基线

产出：

- `sub/measure/measure-switch.ts` —— 可重复的测量脚本（自己拉 tmux、起临时 gateway、开 Playwright、出 CSV）
- `sub/measure/README.md` —— 基线与「优化后」两条命令行、全部可调参数、测量口径与安全约束
- `sub/measure/baseline.csv` —— 本次基线的 32 行原始数据（cross / same 各 16 次，前 2 次为 warmup）

## 测什么

一次「切换」= 点击侧栏里某个 pane/window 行，直到那个 pane 的内容出现在终端里。分两类：

- **cross**：跨 window 切换（走完整 select 事务：`TMUX_SELECT → SWITCH_ACK → TERM_HISTORY → LIVE_RESUME`）。
  循环序列 `%0(w0) → %2(w1) → %1(w0) → %2(w1) → …`，3 个 pane 全用上，每一步都跨 window。
- **same**：同 window 内切 pane（轻量 `FOCUS_PANE`，无屏障、无 history）。循环 `%0 ↔ %1`。

每类 16 次，丢弃前 2 次，统计 n=14。所有时间相对 `t0`；`t0` 取**页面内 capture 阶段收到 click 事件**
的 `performance.now()`，不含 Playwright→浏览器的 CDP 往返。判定用页面内的 `requestAnimationFrame`
循环逐帧读 `window.__tmexE2eXterm` 的 buffer，WS 帧由 `page.addInitScript` 注入的 `WebSocket`
包装器按 borsh 信封头（magic `TX` + kind）打时间戳。

## 基线数字（单位 ms）

### cross —— 跨 window 切换（n=14）

| 区间 | median | p90 |
| --- | --- | --- |
| `route` 路由切到目标 pane | 8.9 | 13.8 |
| `switch_ack` SWITCH_ACK 到达 | 28.9 | 40.7 |
| `ph_gone` boot placeholder 消失 | 33.3 | 39.9 |
| `remount` 终端实例重挂载 | 33.3 | 39.9 |
| `history` TERM_HISTORY 到达 | 65.4 | 77.6 |
| **`first_content` 首帧看到目标 pane 内容** | **72.6** | **82.5** |
| `live` 切换中打入的字符可见 | 72.6 | 82.5 |
| `live_after_keys` 同上，自按键发出起算 | 67.3 | 77.0 |
| `live_resume` LIVE_RESUME 到达 | 515.3 | 523.7 |
| `first_output` 首个 TERM_OUTPUT | 521.2 | 526.0 |
| `post_live_after_keys` 稳态实时输出往返 | 39.7 | 46.7 |

`history_bytes` median 32566（min 32380 / max 32908），全部未触发 CHUNK 分片；
每次切换后 t0 起收到的 WS 帧 median 9.5 个。14/14 出现了 boot placeholder，14/14 发生终端实例重挂载。

### same —— 同 window 内切 pane（n=14）

| 区间 | median | p90 |
| --- | --- | --- |
| `route` 路由切到目标 pane | 11.0 | 13.7 |
| `remount` 终端实例重挂载 | 19.5 | 22.1 |
| **`first_content` 首帧看到目标 pane 内容** | **19.5** | **22.1** |
| `first_output` 首个 TERM_OUTPUT | 23.6 | 25.0 |
| `live` 切换中打入的字符可见 | 42.2 | 48.4 |
| `live_after_keys` 同上，自按键发出起算 | 36.4 | 42.4 |
| `post_live_after_keys` 稳态实时输出往返 | 41.5 | 51.8 |

同 window 不走屏障，`switch_ack` / `history` / `live_resume` 全部 n/a（符合设计）。
0/14 出现 boot placeholder，但 **14/14 仍然重挂载了终端实例**。

## 三个值得后续优化盯住的点

1. **`LIVE_RESUME` 被硬编码延迟 450ms**。`apps/gateway/src/ws/borsh/switch-barrier.ts` 里
   `LIVE_RESUME_DELAY_MS = 450`，LIVE_RESUME 固定比 TERM_HISTORY 晚 450ms 发；实测
   `live_resume` median 515ms、`first_output` median 521ms。也就是说跨 window 切换后**实时输出通道要
   半秒才放开**——切完立刻在目标 pane 里跑东西，前 ~450ms 的输出只能等屏障过后补上。
   `first_content` 只有 72.6ms，但「切过去就能跟着看输出」的体感是 ~520ms。
2. **cross 切换的 72.6ms 里，约 65ms 花在等 TERM_HISTORY**（ACK 28.9 → history 65.4 → 上屏 72.6）。
   history payload 是一屏 + 50 行 scrollback 的 `capture-pane -e` 文本，约 32KB；
   从 ACK 到 history 有 ~36ms 的空档（tmux `capture-pane` 往返 + 编码）。
3. **同 window 切 pane 也会重挂载终端实例**（14/14，`__tmexE2eXterm` 换了对象）。轻量路径本来不该
   重建终端，19.5ms 里相当部分是重挂载 + 首帧渲染。

## 复现环境

- 机器：Darwin 24.6.0 / Apple Silicon；chromium 由 Playwright 1.58.2 提供，headless，视口 1440×900
  （终端实际 64 cols × 43 rows）。
- gateway：从 `c850e077`（本分支 base）`git archive` 出的干净树
  `<scratch>/src-base`，`bun install --frozen-lockfile` 后直接跑
  `packages/app/src/runtime/server.ts`；`NODE_ENV=test`（走仓库根 `test.env`）、
  `GATEWAY_PORT=19765`、`TMEX_BIND_HOST=127.0.0.1`、`DATABASE_URL` 指向 scratch 里的一次性 db、
  `TMEX_MIGRATIONS_DIR=<src-base>/apps/gateway/drizzle`、
  `TMEX_FE_DIST_DIR=<scratch>/fe-dist-base`（改动前构好的产物）。env 是显式白名单，不继承 shell。
- 前端：不用 vite dev server（别的 agent 在改源码，HMR 会污染），只用上面这份预构建 dist，由 gateway 自己托管，
  因此 API / WS 都是同源。
- tmux：**只用专用 socket `tmex-r9-perf`**，会话 `m1perf`，`-x 200 -y 50`，2 个 window / 3 个 pane
  （w0 两个 pane，w1 一个 pane）。每个 pane 的 PS1 设成唯一标记 `MK<nonce>P<i>:`（标记进提示符，
  不会被滚出屏幕），页面把 pane resize 到真实尺寸**之后**再灌 300 行宽文本，保证 TERM_HISTORY 是满屏字符。
- 收尾：脚本自己 kill 临时 gateway 与会话；本轮结束后额外执行了
  `tmux -L tmex-r9-perf kill-server`。全程未触碰生产 tmex（9883 / launchd / `~/Library/Application Support/tmex/`），
  未在默认 socket 上执行任何 tmux 命令，未改动 worktree 里的任何仓库文件。

## 稳定性

同配置连跑两轮（`baseline` 与 `baseline-rep2`）：

| 指标 | run1 median / p90 | run2 median / p90 |
| --- | --- | --- |
| cross `first_content` | 72.6 / 82.5 | 72.7 / 83.1 |
| cross `history` | 65.4 / 77.6 | 65.8 / 78.8 |
| cross `live_resume` | 515.3 / 523.7 | 517.2 / 521.6 |
| same `first_content` | 19.5 / 22.1 | 21.7 / 22.2 |

跨轮漂移：cross 各项 < 2ms，same 的 median 约 2.2ms。**判定优化效果时，median 变化 < 3ms 不要当成信号。**

其它需要注意的点：

- `same` 的 `first_content` 呈双峰（~13–15ms 与 ~21–22ms），因为它基本就是「下一个 rAF 帧」，
  落在哪一帧取决于点击相对 vsync 的相位。用 median/p90 比用均值稳。
- cross 的 `first_output` 只有 7/14 有值：LIVE_RESUME 之后的 700ms 收帧窗口内不一定有新的 TERM_OUTPUT。
  这一列只作参考，主指标看 `live_resume` 与 `post_live_after_keys`。
- `live_ms` 在 cross 场景恒等于 `first_content_ms`：点击后 ~7ms 就 send-keys，这行字符会被 tmux
  `capture-pane` 一起卷进 TERM_HISTORY。真正的稳态实时往返看 `post_live_after_keys`（cross 39.7ms，
  same 41.5ms，两者一致，说明屏障放开后实时通道本身没有额外损耗）。

## 「优化后」怎么复跑

见 `sub/measure/README.md`。一句话：从 worktree 构一份新 dist，然后

```bash
LABEL=after RUNS=16 WARMUP=2 \
  GATEWAY_SRC_DIR=/Users/konata/code/tmex-enhanced-wt-r9 \
  FE_DIST_DIR=<scratch>/fe-dist-after \
  bun measure-switch.ts
```

单轮约 55 秒（不含 vite build）。

---

# M1 追加：新增 `single` 场景 + baseline2 / after2 对比

## 为什么加 `single`

原来的 `cross` 在 `w0`（两个 pane → 前端渲染分屏视图）和 `w1` 之间来回，**永远不会命中 keep-alive
保活路径**——那条路径只在「路由到的 window 只有一个 pane」时才生效。于是新增第三个场景：

- 会话布局改成 4 个 window / 5 个 pane：`w0` 两个 pane（`%p0`/`%p1`），`w1`/`w2`/`w3` 各一个 pane（`%p2`/`%p3`/`%p4`）。
- `single` 序列 `%p2 → %p3 → %p4 → %p2 …`，`RUNS=16`、`WARMUP=3`（轮转池是 3 个 window，预热 3 次才全热），
  统计口径与 `cross` 完全一致。
- 新增两列：
  - `want_history` —— 从**出向** `TMUX_SELECT`(`0x0201`) 帧里解出的 `wantHistory` 标志（WS 包装器同时
    拦截 `send()`）。同窗 `FOCUS_PANE`(`0x0212`) 路径没有这帧，留空。
  - `keepalive_panes` —— 切换刚完成那一帧 `[data-testid="terminal-keep-alive-pane"]` 的元素个数。

> ⚠️ **`remount` 在 after 构建上不再是「重挂载」信号。** 它判的是页面全局 `__tmexE2eXterm` 换了对象；
> keep-alive 落地后每次切换这个全局都会换身份（指向当前可见 pane 的实例），即使底层终端根本没被销毁重建，
> 所以 after 构建上 `remounted` 恒为 14/14。判断是否真走了保活路径，改看
> **`keepalive_panes > 0` + `want_history == 0` + `ph_appeared == 0`** 这三个。README 里也记了这条。

## 对比（median / p90，单位 ms）

两次 run 用的是同一个脚本、同一份 tmux 会话布局；baseline2 = `src-base`(c850e077) + `fe-dist-base`，
after2 = `/Users/konata/code/tmex-enhanced-wt-r9` + `fe-dist-r9`。

### single —— 单 pane window 轮转（keep-alive 路径，n=13）

| 区间 | baseline2 | after2 | 变化 |
| --- | --- | --- | --- |
| `route` | 5.6 / 13.5 | 7.9 / 12.4 | 持平 |
| `switch_ack` | 25.3 / 32.7 | 21.3 / 30.8 | 持平 |
| `ph_gone` | 31.2 / 39.3 | **0 / 0** | placeholder 不再出现 |
| `history` | 82.7 / 105.2 | **n/a** | 不再下发 TERM_HISTORY |
| **`first_content`** | **89.7 / 113.4** | **18.7 / 27.4** | **−79% / −76%** |
| `live_resume` | 532.6 / 556.2 | **21.4 / 30.8** | **−96%** |
| `first_output` | 529.9（n=1） | 21.3 / 35.3（n=13） | 同上 |
| `post_live_after_keys` | 42.0 / 47.3 | 44.5 / 48.0 | 持平 |
| `want_history` | 1×13 | **0×13** | 全部不再要 history |
| `keepalive_panes` | 0 | **3** | 三个 pane 全部保活在 DOM |
| `placeholder 出现` | 13/13 | **0/13** | 终端不再重新 boot |
| `history_bytes` | 32694 | — | 省掉每次 ~32KB 的回放 |

### cross —— 跨 window，目标含多 pane window（n=14）

| 区间 | baseline2 | after2 | 变化 |
| --- | --- | --- | --- |
| `switch_ack` | 32.5 / 59.4 | 34.5 / 43.7 | 持平 |
| `ph_gone` | 38.4 / 65.8 | 38.7 / 49.1 | 持平 |
| `history` | 105.7 / 161.8 | 97.1 / 106.2 | 持平（p90 略好） |
| `first_content` | 111.3 / 168.4 | 103.2 / 112.5 | 噪声内，见下 |
| `live_resume` | 554.3 / 612.6 | **102.8 / 110.4** | **−81%** |
| `post_live_after_keys` | 40.0 / 49.1 | 42.2 / 55.5 | 持平 |
| `want_history` | 1×14 | 1×14 | 仍然要 history（分屏视图不走保活） |
| `keepalive_panes` | 0 | 0.5（中位） | 切到单 pane window 那半数留了保活 pane |

### same —— 同 window 内切 pane（n=14）

| 区间 | baseline2 | after2 | 变化 |
| --- | --- | --- | --- |
| `first_content` | 20.5 / 23.6 | 16.6 / 21.5 | 噪声内 |
| `first_output` | 25.0 / 27.6 | 25.6 / 27.3 | 持平 |
| `post_live_after_keys` | 42.8 / 49.8 | 39.0 / 50.3 | 持平 |
| `want_history` | n/a×14 | n/a×14 | 两边都走 `FOCUS_PANE` |

## 复现性校验（第二对交错跑）

baseline2/after2 那一轮机器上还有别的 agent 在跑构建与测试，`cross` 抖得比较厉害（baseline2 里有一次
341ms 的离群值）。为了确认方向，又交错跑了一对 `baseline3` / `after3`（CSV 在 scratch 的
`measure/baseline3.csv`、`measure/after3.csv`）：

| 指标 | baseline2 → after2 | baseline3 → after3 |
| --- | --- | --- |
| single `first_content` | 89.7 → 18.7 | 73.4 → 17.4 |
| single `live_resume` | 532.6 → 21.4 | 520.7 → 21.9 |
| single `want_history` | 1×13 → 0×13 | 1×13 → 0×13 |
| single `keepalive_panes` | 0 → 3 | 0 → 3 |
| cross `first_content` | 111.3 → 103.2 | 83.9 → 96.4 |
| cross `live_resume` | 554.3 → 102.8 | 534.9 → 97.0 |
| same `first_content` | 20.5 → 16.6 | 16.8 → 14.5 |

结论：

1. **`single` 场景的提升是结论性的**：两轮都是 ~75–90ms → ~17–19ms（约 4–5 倍），且机制证据齐全
   （`want_history` 全变 0、`keepalive_panes` = 3、placeholder 不再出现、TERM_HISTORY 不再下发）。
2. **`live_resume` 的 450ms 屏障延迟在两个场景都被拿掉了**：cross 从 ~540ms 降到 ~100ms，
   single 从 ~525ms 降到 ~22ms。这是「切过去能不能马上跟着看输出」的体感主因。
3. **`cross` 的 `first_content` 没有可判定的变化**（两轮方向相反，且都在当轮噪声量级内）：
   分屏视图仍然要 history，符合预期——多 pane window 不在这次保活的覆盖范围里。
4. `same` 无变化，符合预期（本来就走轻量 `FOCUS_PANE`）。

## 本轮噪声提示

baseline2/after2/baseline3/after3 都是在其它 agent 并发占用 CPU 的情况下跑的，`cross` 的 median 在
84–111ms 之间漂。**跨轮对比 `cross` / `same` 时，median 变化小于 ~15ms 不要当信号**（比第一次基线的
3ms 阈值宽得多）；`single` 的差距是 4 倍量级，不受影响。要拿更干净的 `cross` 数字，等机器空下来再跑一对交错的。

## 收尾

临时 gateway 均已退出，`tmux -L tmex-r9-perf kill-server` 已执行；全程只用专用 socket，未在默认 socket
上执行任何 tmux 命令，未触碰生产 tmex（9883 / launchd / `~/Library/Application Support/tmex/`），
未修改 worktree 或主仓里的任何既有文件。

> 目录里的 `measure/baseline.csv` / `measure/after.csv` 是**旧版脚本**（只有 cross/same 两个场景、
> 没有 `want_history`/`keepalive_panes` 两列）留下的产物，`after.csv` 不是本次跑的。
> 以 `baseline2.csv` / `after2.csv` 为准。
