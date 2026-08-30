# 第六轮执行结果：性能热点调优 + code smell 第五轮 + 复杂度门禁

基线 main `19dd4992` → 本轮分支 `feat/round6-perf-smell`。三轮性能（探索→修复→审查→基准验证）+ 一轮 code smell（S1/S2 探索→T/U 实施→审查）+ 门禁落地。

## 阶段 1：性能（3 轮）

探索报告 `sub/X1..X4`（第 1 轮）、`sub/Y1..Y2`（第 2 轮）、`sub/Z1..Z2`（第 3 轮=基准验证，base worktree 对照）。

### 关键收益（Z1/Z2 复测数字，BASE→HEAD）

**前端/终端**
- agent 长对话：历史块按 messages 引用缓存 + 行 memo + 200 块窗口，2000 条×500 flush 75→8.7 ms（8.6×）；流式 markdown 增量切块 43→2.5 ms；composer 50 次 flush 0 重渲染；persist 去重 2000 次 setItem→0
- 终端渲染：ghostty 行 dirty consume-and-clear，单脏行 1.15→0.14 ms、干净帧 0.9→0.015 ms（60×）；选区拖拽 900 µs→1.1 µs/move
- I/O 路径：TERM_OUTPUT 零拷贝解码（十帧 1 MiB 31→0.04 ms）；LF 规范化单趟 160→7.4 ms/10 MiB；history 分页批量重放 510→46 ms/22 页；输出合并 4 ms 有界窗口
- 设备/侧栏：连接态按设备 useSyncExternalStore（500 行×5000 事件失效 250 万→5000）；侧栏树不再随终端输出重渲染；文件树 500 条上限 + memo
- 启动与包体：入口 gz 416→352 KB（Ghostty/argon2/noble 出入口）；设置页按 tab 分块 118→9 KB；CodeViewer/MarkdownPreview highlightAuto 守卫（1 MiB 9.5 s→0.13 s）；工具输出 64 KiB 预览（SSR 540→46 KB）
- 内存：非活跃会话历史 LRU 8 份/4 MiB；写回后同样执行预算

**gateway**
- agent 每轮窗口化加载历史 22.7→0.8 ms（27×，10k 行→119 行）
- hub node.list 一次编码+指纹跳发 7.5→0.4 ms/100 links（18×）
- forwarder：PaneData 免解码（noteInbound 87→46 ms/10 MiB）、pendingStreams 泄漏修复+60 s TTL、DEVICE_CONNECTED 单次解码
- tmux：legacy 历史 4096 行/4 MiB 有界+同 pane 合飞、结构刷新 150 ms 静默、cold pane 零拷贝（2.3→0.9 ms）
- watch：按 pane 分组单次 capture（100 规则 100→1 次/tick）、绝对 deadline+单调时钟、upsert 免回读
- REST N+1：/api/devices 与 /api/tmux/tree 100 设备 202 查询→3
- 文件：上传先校验再有界流式+异步落盘+per-session 队列（HTTP/RTC 统一）；raw 读改流式；rsync 列表 top-k 有界（RSS 161→68 MiB，CPU 有意换 1.1–1.6×）

### 审查（codex sol，6 份 + 复审）

review-fe-chat/term/fe-dev/be/fe2/be2/be3。修复：render 期写 ref、未吸底窗口冻结、DPR 回落、tri-state 广播、上传并发串行化、watch 空组重臂/绝对 deadline、空 capture≠target-missing、重连代际键控、登录 chunk 失败兜底、历史预算写回执行、代理对截断等。有意不修：rsync 截断目录改为全局排序页（更优语义，测试注明）、200 块窗口对浏览器页内查找的影响（Claude Code 式取舍）。

## 阶段 2：code smell（1 轮实施 + 审查修复）

探索 `sub/S1/S2`。实施 T1–T6、U1/U2：forwarder 1089→779、uplink-client 1371→843（key-log sync 独立状态机）、user-key-service 1012→849、uplink-server 1446→1185、mesh-runtime 装配按职责拆函数（constructMeshDeps 201→19 行、onNodeList CC30→8）、isAdvertisablePeerAddress CC20→6、local reconnect CC16→2（local/ssh 共享 policy helper）、IPv6 解析/握手超时/jsonText 去重、设备重排/文件夹树/tmux store 去重。S1/S2 判定不动的内聚体（peer-manager 2283、ghostty-wasm 1620 等）进 allowlist 并记录理由。

## 阶段 3：门禁

`scripts/complexity/gate.ts`（自建 TS-AST McCabe）：CC≤15、函数≤120 行、文件≤900 行；118 条 allowlist 锁定当前值（恶化即 fail、条目失配报 stale）；接入 `bun run lint`。CC>15 违规 48→46→（拆分后）后有意保留全部入册；文件>900 从 10 个减到 7 个（其余判定为内聚/装配根）。

## 验证

- 全包测试（`sub/test-final.txt`）：相对基线只增不减（gateway 2671→2784+、panels 580→629、fe 866→883、stores 321→334、ghostty 189→202、terminal-ui 318→323、shared 365→376、ws-client 262→268）；tsc 错误与基线一致（gateway 21、stores 1、api-client 5、app 1）；app 1 fail 为既有 cpu-features stub。
- Z1/Z2 基准均无产品路径回归（write-vt 慢的是诊断用 legacy 路径）。
- 38+ commit，净行数（不含测试/bench）约 +3.2k，其中门禁+allowlist ~620 行、模块拆分搬迁（uplink-key-log-sync/session-login/stream-replay-state 等）占大头，真实新增逻辑主要是保护路径（上传串行化、chunk 重试、历史预算）。

## 未做 / 后续

- canvas 文本 run 批绘、DataChannel 分片双拷贝、scrollback 内存预算、locale 门控首屏、目录虚拟化：LOW/风险取舍，Z1 确认非 HIGH。
- `hasWsSecureCandidate`/`shouldTryDc` 仍 listPeers().find；tree endpoint 2 次查询。
- rsync 反序 200k 仍 ~1.6× 旧全量 CPU（换 90 MiB 内存），正序 ~1.5×。
- （补充最后一批 G9/G10 审查修复后的状态于下）
