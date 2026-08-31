# 第七轮执行结果：性能调优 + iOS PWA bug 修复 + code smell 清理

基线 main `8897894c` → 分支 `feat/round7-perf-smell`（worktree `../tmex-enhanced-wt-r7`）。探索/审查/任务报告全部在 `sub/`。

## 阶段 1：性能（1 轮探索 + 2 波修复 + 审查闭环，提前收束）

探索 E1–E4（codex luna xhigh，已注入前六轮排除清单）**均未发现 HIGH 项**，共 15 个 MED（含 bug），全部落地：

**gateway（grok BA–BH）**
- agent：step 边界消息批量单事务落库（单条保留原子快路径）、提交后按序广播；ws-hub 订阅先登记后 sync + null/异常回滚 + sessionId 128/订阅数 64 上限，re-sync 失败只回滚本次新建登记
- canonical：分片 slice→subarray 零拷贝（同步编码契约测试锁定）；metadata 分片按 revision 缓存 + 增量尺寸累计（1000 条 23ms→缓存命中）；并发 attachDevice 竞态泄漏修复（per-device in-flight 锁）
- tmux：快照无变化跳过全量重投影（metadata/retention/history 三维脏拆分，epoch 重置仍强制 re-establish）
- mesh：forwarder failover 队列 256 帧/4MiB 上限（溢出 1011 关连接）；node.list 持久化收敛 emit 单次；key_log_head 入状态指纹 + append 后 100ms 防抖广播（且通知改挂本地 apply 成功后）；send 契约 Promise 化统一走 failover；入站帧单次 envelope 解码（WS/mux/RTC 三路统一）
- hub：key-log 分页 wire 一次编码 + 累计尺寸选前缀（原 O(n²) 重编码）；node.list 广播按 userId 代际串行化（慢构建带旧 head 不再抢占高版本）
- db：批量 RETURNING 按 seq 排序（顺序无保证）

**前端（Opus O-C..O-J）**
- ghostty：WASM 模式查询代际缓存（悬停/滚轮零查询、write 路径 3-5 次→2 次）；选区自动滚动空转零渲染；滚动条淡出 deadline 单定时器
- stores/fe：pane agent 徽标 O(P×S)→O(1) 索引 + running 优先语义修复；侧栏孤立会话区引用逐层复用（元数据事件零重算），审查后改 per-mount collector（多 node 不互刷）；AgentTab 全量 snapshots 订阅→按设备窄订阅
- 网络：离线节点不再发 /api/devices（enabled 门控+AbortSignal）；useHubNode 代际+单飞；site 设置取数三层语义（fetchSettings/ensureFreshSettings/refreshSettings）+ 在途单飞，保存 2 次 GET→1；设备卡 roots 上提 hasRoots
- ws-client：重连挂起队列 100 条静默丢弃→字节预算 2MiB/2048 帧 + 有序输入整段丢弃 latch + overflow 显式事件

**审查（codex sol，be/fe/libs 三份 + smell 批次）**：0 P0、9 P1、3 P2；P1 全部修复（剪贴板乱序/dispose、site 单飞两处竞态、侧栏模块级缓存、key_log_head 时序、RETURNING 顺序、ws-hub 误删订阅），P2 按价值裁决（AbortSignal 最小化落地、单条 append 快路径恢复、FE0E 补漏落地）。

## 阶段 2：用户 iOS PWA bug（4 项，全部修复）

1. 上报模式（tmux mouse on）单指拖拽原会升级为 TUI drag（tmux 内选择+复制），改为单指=滚轮滚动、长按=本地选词、tap/双指不变（O-A）
2. 选择后自动复制失败：OSC52 剪贴板写入无用户手势被 iOS 拒绝 → 延迟到下一次真实手势内重试（20s TTL、latest-wins、copyPending 提示），审查后补代际+dispose 守卫（O-A/O-H）
3. 终端设置面板「加载失败」：iOS 独立模式缓存旧 index 指向已删 chunk → 模块级加载缓存 + 空闲预载 + 「重新加载应用」兜底（O-B）
4. 窗口标题 `✳`（U+2733 等 Extended_Pictographic 且非 Emoji_Presentation 字符）在 iOS 按 emoji 呈现 → 显示路径追加 U+FE0E，rename 回写走 rawTitle 防选择符入库；审查后补 buildBrowserTitle/标题复原分支（O-B/O-J）

## 阶段 3：code smell（1 轮，S1/S2 均无 HIGH，审查零发现）

- fe：三个设置页状态 hook 收敛共享 useProtectedStatusQuery；删除 useSessionKey 订阅层、setSharedMeshEvents（O-K）
- 跨包：TMEX_ROLES 角色模型纯转换收敛 packages/shared/src/roles（gateway fail-closed / app 归一化两个包装，跨包一致性测试）（BI）
- gateway：RTC 入站统一已解码分发；stream-replay tryDecodeEnvelope；external-detect 死 API/双投影清理；decodeEnvelopeAndPayload、access-rules 旧别名删除（BJ）
- **门禁**：gate.ts 新增 `--tighten`（同口径只降不升），allowlist 118→117 条、82 处锁值下调（manager.ts 1255→1185、handleMessage CC 16→9、createSiteStore 201→145 等）

## 终态验证

各包 bun test（对比第六轮基线）：gateway 2800→2861、fe 883→917、panels 629→650、stores 334→368、shared 376→392、ws-client 268→283、terminal-ui 323→325、ghostty-terminal 202→211、api-client 132、app 414→422（1 fail 为既有 cpu-features stub）；全部 0 新增失败。tsc 错误数与基线一致（gateway 21 / stores 1 / api-client 5 / app 1，其余 0）。`bun run lint`（含复杂度门禁）通过。

## 未做 / 后续

- `encodeMouseEvent` 每次上报仍查约 8 个模式（1003 any-event tracking 下的剩余热点），修复需改 wasm bindings 签名（O-E 报告）
- `ghostty-terminal/src/link-detector.ts:18` 顶层 lookbehind RegExp 在 iOS <16.4 会模块求值抛错（O-B 发现的潜在隐患，非本轮 bug 成因）
- ws-client overflow 目前只有 console/事件，FE 无 toast（BG 有意保留）
- S1/S2 判定不动的项：近阈值单一职责组件、协议 parser、既有保留清单（见 code-smell-retained-hotspots 记忆）

## 附：全仓 lint 清零（用户追加指令）

`bun run lint`（biome check . + 复杂度门禁）在 main 上即有 259 个预存错误（第六轮归档脚本 + 测试文件格式漂移），本轮清零：prompt-archives 加入 biome ignore（归档不格式化）；测试/spec 文件 overrides 豁免 noNonNullAssertion/noDelete（测试惯用法，process.env 用 delete 是正确写法）；全仓 `biome check --write` 统一格式（180+ 文件）；手工修复：theme spec 的 `[^]*`→`[\s\S]*`、spike-assert while 赋值表达式、main.tsx 有意依赖加注释豁免、index.css @import 位置（Vite 构建期解析，源顺序承载主题覆盖语义）文件级豁免、build-i18n node: 协议、重连指示器 div→button（键盘可达）、清理失效 biome-ignore。gate.ts 的 --tighten 改动同步修 noDelete；ghostty-wasm allowlist 1620→1624（格式化撑行）。

## 附 2：遗留项处置（用户指令：1 修复 / 2 评估 / 3 修复）

1. **link-detector lookbehind**：`FILE_PATH_PATTERN` 构造包进 `buildFilePathPattern()` try/catch，不支持 lookbehind 的引擎（iOS Safari <16.4）返回 null，文件路径检测优雅降级、URL 检测不受影响，模块不再求值即抛。
2. **encodeMouseEvent 模式查询实测**（Bun + 真实 wasm，M 系列桌面）：`isTerminalModeEnabled` 34.8 ns/次、完整 `encodeMouseEvent`（motion+SGR+1003）218 ns/次；120Hz 持续鼠标移动 = 0.026 ms/s，240Hz = 0.052 ms/s。按低端移动设备 50× 放大也仅 ~1.3 ms/s（单核 0.13%）。**结论：非热点，不修**，wasm bindings 签名保持不动；此项从待办中移除。
3. **ws-client 溢出 toast**：`pending-overflow` 事件接 `notifications.error`，新增 i18n key `websocket.inputDropped`（zh：「连接中断，刚才的输入未能发送。连接恢复后请重新输入或粘贴。」，en/ja 同义），测试断言 toast 触发。

## 附 3：后续 bug 会话（同日，用户逐项报告）

1. **iOS 选择工具条折行**：按钮补 whitespace-nowrap/shrink-0。
2. **侧栏设备展开触发无谓重连**：折叠只藏树是设计；展开无条件 connect()（先置 pending）是 bug，改为未连接才自动连。
3. **绿色文字染色残留**：OL 以像素 oracle（8000 帧 + 1700 控制器场景）证明渲染管线在"同字形改色必须重绘"（ASCII/CJK）与 wasm 视图路径上均正确，未做投机修复；固化 4 条回归测试；另修真实缺口——canvas 位图属性被外部改写时 clean 帧也强制全量重建（iOS 位图丢失防护）；发现 1 次内核脏位漏报（像素无差，未修，已记录）。复现待用户观察是否伴随切 app/键盘/熄屏。
4. **远程访问页（BK+BL+指挥官真机验证）**：
   - 侦测：token 模式隧道支持（转义日志 ingress 解析、token 旁 hostname 约定文件、accessStore→cert.pem 凭证链只读探测）；真机确认 tmex.konata.tv 正确识别、接管可用
   - 登录：cloudflared 写默认路径 cert 被接受并拷入管理目录（修复"授权成功仍报进程失败"）
   - Access：新增 external.externalAccess 三态；真机实测 cert 令牌权限不足时 CF apps 接口静默返回空（organizations 同凭证 403），故 cert 来源空列表降级 checked:false（不可证伪），仅用户令牌的空列表可信
   - 文案：settings.remoteAccess 三语专业化重写（新增 14 key 零改名，错误文案均含可执行下一步）

## 附 4：远程访问二期 + 设置加载 + 节点取消（同日第三批）

- **设置 tab 加载慢**（BO）：双段串行 RTT（chunk 下载→挂载→数据请求）→ 空闲逐个预热七个 tab chunk + 悬停预热与 ai/terminal 数据预取，入口 +0.19kB gzip。
- **节点待确认取消按钮**（指挥官）：pending 行右侧新增取消，删本地记录、join 串即消，hub 侧按 10 分钟窗口自然过期。
- **standalone 本机登录**（BM→BP→BQ 三段安全链）：local_auth 单例表 + /api/auth/mode 加性 localAuth 四元组；bootstrap/toggle 仅本机可调、零凭证不可生效；整站门（UI/REST/WS/healthz 降级）接 live effective；生产 standalone 经 authSurfaceOnly 装配缝挂 auth 面（inert peers/streams，不建 mesh 网络栈），local-routes 统一交 authenticate；装配 E2E：bootstrap→enable→login→关门→disable 恢复。已知边界：反代把 requestIP 全写成 127.0.0.1 时 loopback 判定失真；生效后无 cookie 关闭需先登录。
- **向导「直接连接」路径**（BN）：纯前端 WizardMode='direct'（服务端枚举不动），mode→direct 两步；4 档访问保护（节点登录保护/本机登录已启用/无保护+启用流程+硬确认/unknown 不误报）；凭证已保存常驻块改一次性 toast；Access 步骤标题去 Cloudflare 前缀、『无需公网 IP 或端口映射』。
- 门禁：auth-routes 入册 fileLines（三段合入越 900，拆分只搬行）；--tighten 全量校准 118→116 条。
