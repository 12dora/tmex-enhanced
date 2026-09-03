# 第二十二轮执行结果

分支 `feat/round22-perf-tui-color-smell`（base main `c462f3bd` / 1.1.21）。
41 个 commit，463 文件 +36.1k / −11.4k（其中约 +13k 为新增测试与 bench，`sub/` 下 42 份探索/任务/审查报告）。

## 一、Claude Code 输入框「变浅绿」（任务 2）——round 21 回归，已修

EX2 用差分 fuzz（两台终端 + 每帧全新 render state 真值）与真 WASM 复现定位：
round 21 把 `outputSinceRender` 同时当作「光标落定门」与「位移复用安全门」，而 `forceFullRepaint()`
（tab 切回 / window focus / legacy 历史回填）会清掉它。于是「同一批输出里既追加了行又原位重画了输入框」
撞上切回时，位移复用把原位重画整批丢弃并消费掉行脏位，屏幕**永久卡在上一帧**——Claude Code（Ink）
恰恰是「追加消息 + 原位重画输入框」同批到达。修法：拆成 `cursorPendingOutput`（forceFullRepaint 可清）
与 `rowsPendingOutput`（只由 renderNow 算完 scrollDelta 后清）。复现用例
`terminal-render-coordinator.force-repaint-shift.test.ts`。

顺带：`style.faint`（SGR 2）此前被解析但渲染器完全忽略，Claude Code 的提示/占位文字亮度与正文一样；
现按半亮语义向有效背景 50% 混合。round 21 的 canvas ping-pong blit 在测试里从未执行过
（fake-dom 缺 `drawImage`/`insertBefore`），已补。

## 二、流畅度（任务 1）

EX1 实测（Apple Silicon，Bun 1.3.14）后落地：

| 项 | 改前 | 改后 |
|---|---:|---:|
| 击键回显固定定时器延迟（网关 16 ms + 客户端 4 ms，trailing-edge） | +20 ms | 0（leading-edge，burst 合帧次数不变） |
| 渲染桥整屏帧（`render-bridge.bench`） | 1.18 ms | **0.64 ms**（get_multi 批读 + 平坦循环） |
| 保活池 2 个隐藏 pane 的渲染 | 全量跑 | 挂起（write 仍喂 WASM，恢复强制全画）；3 pane 同时输出 8.0→3.0 ms/帧 |
| 网关终端帧 borsh 编码（64 KiB） | 437 µs | **3.1 µs**（融合编码器，字节等价） |
| 浏览器 canonical PaneData 解码（32 KiB） | 96 µs | 1.0 µs（零拷贝 peek；修 round 21 接通 canonical 引入的回归） |
| mesh 中继只读 kind/seq | 56 µs | 0.25 µs（view 解码） |
| WebRTC 直连单片帧 | 266 ns / 3.4 µs | 99 / 90 ns（零拷贝） |
| 流式 markdown 未封口围栏每次 flush（150 KB） | 13.3 ms | 1.3 ms |
| CodeViewer 高亮 63 KiB 自动检测 | 224 ms 主线程 | 36 ms，Worker 内 |
| 文件树 500 行 SSR | 62 ms（501 个 ContextMenu） | 16–19 ms（1 个） |

另：mesh 侧栏三处不稳定引用让 memo 100% 失效（每次 NODE_EVENT 全树重渲染）、终端字号输入每键重建
所有 ghostty 实例、设置页草稿重渲染整页、快捷键编辑器每键 6N 次 stringify、分屏拖拽每 pointermove
两次强制布局、触摸滚动无惯性、`Terminal`/`SplitPaneView` 无 memo——均已处理。

**WASM 判定**：热点不在 WASM 边界（95 ns/cell）而在包着它的 JS 层（116 ns/cell），纯 JS 扁平化已 1.8×；
字形图集实测比 run 批绘慢 4×；fork ghostty 加批量导出会破坏 `verify:wasm` 上游锁定——三者均不做。

## 三、待机功耗（任务 3）——推翻 round 21 的归因

EX3 隔离实测：以生产速率（9 事件/秒）跑完整输出管线只占 ≈0.006% 核；所有定时器合计 <0.02%。
真正的空闲 CPU（≈1.8–2.1 个百分点）来自 **push supervisor 启动即为库里每台设备常驻 tmux 控制模式**，
并为没人看的 pane 跑完整解析（生产日志 `dropped_events` 高达 90%）。

落地：
- 无观察者的 pane 只跑通知状态机（BEL/OSC/title/clipboard/theme），不物化输出、不进广播、不 ingest
  retention；有人看时从下一 chunk 起物化。零客户端仍能收到 bell/notification 推送。
- CSI 参数定长缓冲（SGR 密集流 85.8→43.0 µs/事件，ANSI-heavy 解析 47→105 MiB/s）；unescape scratch、
  paneId intern、parser frame pool、fanout 去闭包（GC 线程曾占网关 user CPU 16.9%）。
- RTC 直连升级加「彻底放弃」态（此前熔断到 16 min 封顶后仍每 ~3.4 min 跑一轮无效 ICE+DTLS）；
  `node_datachannel` 惰性加载（usrsctp 定时线程 ≈100 唤醒/秒在空闲进程归零）。
- PWA：心跳采纳协商的 15 s（24→8 唤醒/分钟）、隐藏 pane 不再排帧、键盘抬升面 `will-change` 改条件生效。
- 可观测性：`ws-metrics` 窗口真 30 s（此前 111–969 s 乱跳），`[tmux-metrics]` 改日志级别门控。

## 四、坏味道（任务 4）

`bun run lint` 全绿，allowlist `--tighten` 145→141。门禁本轮已枯竭（CC/行数 top-40 全在 allowlist），
价值集中在逼近门禁的五个文件与重复：`upgrade-apply` 898→374、`uplink-client` 897→719、
`canvas-renderer` 897→738、`tmux-command-handlers` 892→381、`canonical-state-client` 892→740、
`render-state` 952→431、`db/schema` 865→6（按域拆 6 文件）。
去重：第三份 `readBodyCapped`（分片上传体积上限）、四份 IP 判定（本机免二次验证路径，尽表锁定语义）、
base32/TOTP 重封装、semver ×3、SHA256SUMS 校验 ×2、PID 解析、api-client 40 个 CRUD 模板、
mesh 轮询 store、设置页表单原语 ×4 + 危险确认框 ×4、微信/Telegram 表单壳、进程身份助手、`withAuth` ×3。
破环 8 个；passkey/rtc/peer 测试夹具抽共享（−600 余行）。

## 五、精简（任务 5）

- 首屏入口 gzip **345,670 → 282,345 B（−18%）**：base-ui 弹层实现懒加载（−47.5 KB）、direct 栈按需
  import（−12.8 KB）、sonner 门面、hljs 按扩展名按需（FilePage −49 KB）；首绘阻塞语言包 33.9→10.1 KB
  gz（core/rest 拆分）。
- 删除：无调用方路由（tree-order ×4、微信 per-user、`/api/capabilities` 全链）、13 个死导出、
  15 个 `*Row` 类型、PoC 脚本、health-check.sh、82 条死 i18n key、11 个 `--fc-*` + 5 个 `--chart-*`
  幽灵 token、motion 死导出；apps/fe 15 条纯转发依赖；katex 版本对齐（此前 0.17 CSS 配 0.16 JS）；
  KaTeX 字体只留 woff2。
- 文档：README 安全声明此前写「未内置鉴权、勿暴露公网」与鉴权栈矛盾，已按代码重写；ws-borsh 规范
  kind 表 37→57 并加防漂移测试。

## 六、审查与修复

codex 三路审查（backend / frontend / libs）。libs 提出 5 项、修 4 项（显式 `pongTimeoutMs` 不随协商放大、
faint 缓存封顶、共享 scratch 随所属实例释放、合帧冷却表随 discard 清理）；
第 4 项（自定义 scheduler 下跨 pane leading-edge）仅注入 scheduler 的测试路径可触发，不修。
（backend / frontend 审查结果见下文补记。）

## 七、验收

| 项 | 结果 |
|---|---|
| shared 533 / ws-client 408 / ghostty 329 / terminal-ui 398 / stores 440 / panels 889 / ui 77 / theme 52 / api-client 175 / notifications 15 / fe 1769 | 全绿 |
| app 690 | 仅既有 cpu-features 一条 |
| gateway | 见补记 |
| `bun run lint` | biome + complexity gate 全绿 |
| 首屏 entry gzip | 345,670 → 282,345 B |

## 八、遗留

- multi-hub 集成测试 `A down → 重挂 B → 中继` 在本分支约 1/4 概率失败（main 0/9），见补记。
- `readRow()` 在 `reuseReportedDirty` 时不逐 cell 比对，正确性押在「无输出」前提上（EX2 建议二）。
- 文件树目录行的填充行（loading/empty/show more）右键不再有原生菜单（目录菜单未一并提到根）。
- legacy 状态流下线（1,742 行）需先定最低可入网版本；`tailwind-merge` / `react-router` 替换属产品决策。
