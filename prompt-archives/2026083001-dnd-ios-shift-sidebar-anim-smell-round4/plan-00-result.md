# 执行结果：设备页 iOS 式退避 / 侧栏节点切换动画 / code smell 第四轮

分支 `chore/round4-dnd-sidebar-smell`（worktree `../tmex-enhanced-wt-r4`，基于 main `ea63e01e`），共 25 个 commit。分工：cursor-agent grok-4.6 high 后端 8 批（G1–G5、R1–R8 中 R6/R7/R8）、Opus 前端 7 批（侧栏动画、O1–O6）、codex luna 探索 3 份、codex sol 审查 5 份；指挥官本人修拖拽根因与全部审查回归。

## 任务 1：设备页拖拽双向退避（`59178d70`）

根因：`collision.ts` 的候选集把被拖元素自身排除，指针回到原位时 `closestCenter` 只能选邻居，`overIndex` 回不到 `activeIndex`，sortable 不归位。修复：同容器兄弟候选（指针分支、键盘分支）加入 active 自身；`resolveDrop(active, active)` 本就返回 null，drop 语义不变。`collision.test.ts` 补「拖到 n3 再拖回原位选中自己」「跨容器不把自己当目标容器兄弟」；原「分组间空隙」用例按新语义改为「离自己中心更近 = 原位、越过中点归邻居」。

## 任务 2：侧栏节点切换动画（`2458b686`、`490b1f05`、`fe9efe7f`）

不引入动画库：
- `DeviceRow` 子树改受控 Base UI `Collapsible`（展开/收起都有高度+透明度过渡，去掉叠加的 `tmex-reveal`；首屏已展开的设备由 Base UI 取消入场过渡）。
- 设备/窗口/pane 选中态、指示条、展开箭头补 100–150ms 过渡。
- 新增 `useSectionPresence`（`apps/fe/.../use-section-presence.ts`）：分节淡出后再卸载，reduced-motion 直落终态；退场期间锁存上一帧可见设备 id 集合（`pinnedDeviceIds`，`useSidebarDeviceStats` 新增 `visibleIds`），设备行随整节淡出（两轮审查各抓到一个先消失的路径）。
- `app-sidebar.tsx`：agent/files tab 的 `Reveal` key 带路由节点 id（重挂淡入），panes tab 保持稳定 key。

## 任务 3：code smell 第四轮

| 指标 | 前 | 后 |
|---|---|---|
| CC>15 函数 | 72 | 37 |
| CC>30 函数 | 10 | 5（`emitOsc`/`encodeMouseEvent`/`classifySshError` 为历史保留；另两个是合并到 shared 的 uplink 解码 switch） |
| 源码行数（ts/tsx，去测试/生成） | 171 434 | 170 345（−1 089） |
| 非测试 diff | — | 67 文件 +5 955 / −7 043 |

三轮内容：
1. 去重：mesh/hub 两份 uplink 协议编解码 → `@tmex/shared/uplink`（−135）；DataChannel 分片器 → `@tmex/shared/link` fragment-core（−60，golden 字节测试）；节点列表投影 `node-list-projection`、流泵 `stream-pump`、请求校验 `api/route-input`、`http.mapError` 复用、设备排序 `sortDevices`、`CopyButton`/`ROLE_LABEL_KEY`/`actionErrorText`。
2. 拆分降 CC：`runCatchUpFromList` 59→<20、`decodeUplinkCtl`（迁移）、`tls-config-store.upsert` 40→表驱动、`handleRedeem`/`redeemInTransaction`、`handleLogin`、`createMeshRuntime` 777→6 行、`assembleTmex` 365→148、`applyMany`/`persistApplied`、`PeerManager.dial/track/handlePeerCtl`、`forwarder.failover/adaptResponse`、ACME `issue` 161→52、`DeviceManagementPanel` 243→83、`LocalMachineCard` 602→292（抽 `direct-section.tsx`）、`loginToNode`、`useNodeLoginGate`、`fragment-core.push`、`direct-carrier-controller` −83。
3. 修掉的 bug：forwarder `flushQueue` 双调用与 HTTP abort listener 泄漏、`sleep` abort listener 堆积（forwarder/enroll）、enroll 显式空 TOTP 不可达分支、stream-targets `cancel()/end()` rejection 未观察与响应头失败后上传不取消、hub `copyDirection` 未 await `end`、peer ctl 异步 handler unhandled rejection、stream-pump 丢零长 HEAD 帧（审查）、hub redeem 内部异常被映射成 400（审查）、passkey verifier 异常被当坏签名（审查）、forwarder 死方法/死字段、`AcmeIssueInput.fetch` 从未接入、`logoutEverywhere` 无调用方（删）。

审查判定不修：passkey verifier 异常经外层 catch 仍是 `MALFORMED` 400（既有行为，非本次回归）；stream-targets 上游提前响应后上传半流不 END（旧代码同样 abort 上传，非回归）。

## 未做 / 后续

- 两个 uplink 解码 switch（CC60/56）与 `handlePeerCtl` 23、`projectMeshListNode` 19、`resolveNestedCommand` 26：扁平分派/解析器，拆表只增行。
- queued pump（`link-stream-carrier` ↔ `websocket-link`）试抽后净增 80 行，回退。
- `mesh/index.ts`、`auth/index.ts` barrel 再导出的死符号未清（barrel 不在 agent 范围）。
- R8（hub redeem + collectNodes 投影）净 +37 行换四个函数 CC<15，是唯一净增的批次；`DeviceManagementPanel` 拆分 +28 行。

## 验证

见文末（全包测试 / 构建 / 上线）。

### 全包测试（终态，`sub/final-tests.txt`）

panels 507/0、shared 365/0、ws-client 262/0、stores 282/0、ui 47/0、app 409/1（既有 `cpu-features stub plugin`）、gateway 2500/0（tsc 21 个既有错误未增加）、fe 671/0；与 `sub/test-baseline.txt` 相比只增不减。

### 审查（codex sol，5 份）

- fe-1 / fe-2 / all-3：分节退场锁存三次迭代（选中设备 → 可见设备 id 集合）；最后一条「设备被删除时行立即消失」判定为合理行为不修。
- be-1：hub redeem 内部异常映射 400、passkey verifier 异常当坏签名 → 已修（`446ab28c`）。
- be-2：stream-pump 丢零长 HEAD 帧 → 已修（`83ee0e25`）；上传半流不 END、passkey 异常仍走 MALFORMED 判定为既有行为。
- be-3：无发现。

### 上线

`bun run build` → `npm pack`（`tmex-cli-1.0.2.tgz`）→ 临时实例（19983）`/healthz` ok、`/` 200 → 生产库三件套备份到 scratchpad → `npx ./tmex-cli-1.0.2.tgz upgrade --apply-current-package --yes --lang zh-CN` → `install-meta.json updatedAt 2026-08-30T05:22:14Z`，`127.0.0.1:9883/healthz` ok，mesh peer 重连正常，新 fe bundle 含 `pinnedDeviceIds`。
