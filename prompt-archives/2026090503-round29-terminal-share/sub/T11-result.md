# T11 结果 — jiefa-app「tab 自己消失」的代码侧加固

对应 `sub/EX4-jiefa-tabs-report.md` 的四条修法。四项全部落地，测试与门禁全绿。

## 1. 断线期间缓冲的按键不再无限重放（H1）

`STALE_INPUT_TTL_MS = 10_000`（前端）/ `STREAM_STALE_INPUT_TTL_MS = 10_000`（转发侧）。

- 初版按 EX4 建议取 3 s；收到 commander 的远端取证（真因是 OOM + systemd scope，见「注意事项」）后改为**保守的 10 s**：一次正常 failover 约 5 s，期间敲的内容必须照常送达，只拦掉「几十秒后才落地」的那一类。
- **前端**（`packages/ws-client`）
  - `pending-send-queue.ts`：`PendingFrame` 加 `enqueuedAt`；新增 `dropStaleOrderedInput(now?, ttlMs?)`，丢掉超时的有序输入（`KIND_TERM_INPUT` / `KIND_TERM_PASTE`），返回一条可直接派发的 `PendingOverflowInfo`（`reason: 'stale'`），无丢弃返回 `null`。结构性命令不受影响。
  - `client.ts`：`flushPendingMessages()` 先调用它，有丢弃就走既有 `emitPendingOverflow` 通道。
  - `websocket-transport.ts`：`PendingTransportCommand` 加 `enqueuedAt`（时钟可注入，构造函数第二参 `now`），`flushPendingCommands()` 同规则过滤，每次 flush 最多派发一次 `stale` 事件。
  - `canonical-pending-commands.ts`：`flush()` 同规则过滤，同样每次 flush 最多一次事件。
  - `transport-types.ts` / `pending-send-queue.ts`：`pending-overflow` 事件与 `PendingOverflowInfo` 加可选 `reason: 'overflow' | 'stale'`（不填即 overflow，旧构造点全部兼容）。
- **提示**（复用既有 `pending-overflow` 管线）
  - `packages/stores/src/tmux-event-router.ts`：`reason === 'stale'` 时提示 `terminal.staleInputDropped`，否则维持原来的 `websocket.inputDropped`。
  - 文案（三语，`terminal.staleInputDropped`）：en `Input typed while disconnected was discarded` / zh `断线期间的输入已丢弃` / ja `切断中に入力された内容は破棄されました`。未跑 `build:i18n`（由 commander 统一跑）。
  - `packages/terminal-ui` 未改：提示走 stores 的通知通道，终端组件无需改动。
- **转发侧**（`apps/gateway/src/mesh`）
  - `forwarder-failover.ts`：新增 `dropStaleQueuedInput(pump, now, ttlMs?)`，在 `completeFailover` 里于 `host.flushQueue(pump)` **之前**执行；有丢弃时打 `[mesh][stream] dropped stale queued input bytes=N age_ms=M`。
  - **队列不是不透明裸字节**：`pump.queue` 里是完整的 borsh 信封（`StreamReplayState.rewriteQueuedFrame` 已在解它），因此实现的是**逐帧**判定而非任务书里的「整队超时才丢」兜底：解得出信封且 kind 为 `KIND_TERM_INPUT` / `KIND_TERM_PASTE`，或 canonical 命令为 `TerminalInput` 才算输入；解不出信封的一律保留。因为队列按时间有序，被丢的必然是前缀，不会打乱字节序。
  - `forwarder.ts`（scope 外的最小改动，3 处）：`ForwardPump` 加 `queuedAt: number[]`，`enqueueFrame` 压入 `Date.now()`，`flushQueue` 一并清空。

## 2. 护盾窗口 `tmex-park` 不再外泄（H4）

先读了 `control-mode-lifecycle.ts:59-71` 与 `session-commands.ts` 的实现：护盾**必须是活动窗口**（`new-window` 不带 `-d`），attach 引发的焦点/尺寸抖动才会落在它身上。因此**没有**改成 `-d`，按任务书 (b) 的分支保留其「活动」语义，改为让前端永远看不到它。

- `external/snapshot-projector.ts`
  - `parseSnapshotWindows`：`row.name === PARKING_WINDOW_NAME` 的行直接跳过，且**不会**被记为 `activeWindowId`。
  - `parseSnapshotPanes`：把 `windows.get(row.windowId)` 的存在性判定提到活动 pane 判定之前——护盾窗口的 pane 不再能顶掉 `activePaneId` / `activeWindowId`。因为二者只在 `!== undefined` 时才写回 host，**活动窗口自然停留在上一个真实窗口**（有端到端测试覆盖）。
- `control-mode/metadata.ts`
  - `ControlModeMetadataBridge` 新增 `noteParkingWindow(id)` / `isParkingWindow(id)`（最多记 4 个 id，防止清理失败时无界增长）。
  - `session-window-changed`（护盾变成活动窗口）、`window-renamed`、`window-close` / `unlinked-window-close` 命中护盾 id 时返回 `null`；`window-renamed` 到 `tmex-park` 这个名字时顺带学到 id。`session-window-changed` 这条是真正的缺陷修复——它原本会把 canonical 元数据里所有真实窗口的 `active` 清成 false。
  - 为压住复杂度门禁，`parse()` 的三个 window 分支抽成 `parseSessionWindowChanged` / `parseWindowRenamed` / `parseWindowClose`（CC 30 → 门禁内）。
  - `%window-add` **无法**过滤：tmux 的 `%window-add @N` 不带窗口名，护盾建在 attach 之前、新控制客户端也看不到它这条。它只触发一次 reconcile 快照，而快照已过滤，无副作用。
- `control-mode-subscription.ts`（scope 外的最小改动）：`ControlModeSubscription` 暴露 `noteParkingWindow`。
- `external/control-mode-lifecycle.ts`：attach 返回后、删护盾之前登记 id（此时订阅才存在）；并按任务书 (c) 加了 debug 日志 `parking window created/removed id=… reason=attach|reattach device=…`（`reattach` 由 lifecycle 实例内的 `attachedOnce` 判定），**未改动任何 attach 语义**。
- `metadata/event-applier.ts`：`window-renamed` 的目标名若是 `tmex-park` 直接丢弃（真实窗口不会被改成这个名字）。

## 3. 可诊断性（H2/H5/H6）

- 新增 `external/destroy-log.ts`：`formatTmuxDestroyLog()` 纯函数 + `logTmuxDestroy(host, command, id)`（窗口取快照里的窗口名，面板取 `currentCommand`）。
  - `[tmux] kill-window id=@3 name=claude reason=user session=tmex`
  - `[tmux] kill-pane id=%7 name=zsh reason=user session=tmex`
  - `[tmux] kill-window id=@9 name=tmex-park reason=parking session=tmex`
- 覆盖网关自己发出的全部销毁点：`SessionCommands.closePane`、`closeWindowInternal`、`removeParkingWindow`。
- `metadata/event-applier.ts`：每条观察到的 `%window-close` / `%unlinked-window-close` 打一行 info：
  `[tmux] window-close observed id=@1 name=main pane_current_command=claude exit_status=unavailable tracked=yes`
- `reconnect-control-channel.ts`：控制通道重挂成功后打一行 info（`control client reattached device=… attempt=N session=…`），把 `%window-close` 与重连/护盾周期对得上。
- 抽出的 `external/parking-window.ts`：`createParkingWindow` / `removeParkingWindow` 的实现体（把 `session-commands.ts` 压回门禁行数内，`SessionCommands` 保留同名薄委托方法，外部调用点不变）。

## 4. systemd 单元自检（H2）

- `packages/app/src/lib/service.ts`：新增纯函数 `systemdUnitLacksKillModeProcess(content)`、`tmexSystemdUnitPath()`、常量 `SYSTEMD_KILL_MODE_WARNING`。
- 新增 `packages/app/src/runtime/service-selfcheck.ts`：`warnOnStaleSystemdUnit()`（只读、仅 Linux、读不到 unit 不告警），在 `runtime/server.ts` 的 `main()` 打完版本号后立即调用，打出
  `[service] tmex.service lacks KillMode=process; tmux may be killed on restart — run tmex upgrade / re-install to refresh the unit`
- **未**接入 `/api/local/status`：`LocalStatus` 是前后端共享契约，加字段要动 shared 类型与前端，不属于「trivial」，按任务书只记日志。

## 测试

新增/改动的测试：

| 位置 | 内容 |
| --- | --- |
| `packages/ws-client/src/stale-input-drop.test.ts`（新） | 6 项：假时钟下 TTL 内/外的有序输入、结构命令免疫、canonical flush 只提示一次、transport 重连后重放 |
| `packages/stores/src/tmux-event-router.test.ts` | `reason: 'stale'` 走 `terminal.staleInputDropped`，不再复用 `websocket.inputDropped` |
| `apps/gateway/src/mesh/forwarder-failover.test.ts` | 4 项：逐帧 TTL 判定、TTL 内不丢、裸帧保留、`runStreamFailover` 端到端丢弃 + 日志行正则 |
| `apps/gateway/src/tmux-client/external/snapshot-projector.test.ts` | 3 项：护盾从窗口列表过滤、护盾 pane 不顶掉活动 pane、活动窗口是护盾时保留上一个真实窗口 |
| `apps/gateway/src/tmux-client/control-mode/metadata.test.ts` | 4 项：护盾的激活/关闭/改名事件不外泄、id 记忆上限 |
| `apps/gateway/src/tmux-client/external/session-commands.test.ts` | 2 项：`formatTmuxDestroyLog` 两种命令 |
| `apps/gateway/src/tmux-client/metadata/event-applier.test.ts` | 3 项：`formatWindowCloseObserved` 的已知/未知/带退出码 |
| `packages/app/src/runtime/service-selfcheck.test.ts`（新） | 7 项：检测器纯函数 + 非 Linux 跳过 / 旧 unit 告警 / 新 unit 静默 |

验证命令与结果：

- `packages/ws-client`：`bun test` 413 pass / 0 fail；`bunx tsc --noEmit -p .` 0 错误
- `apps/gateway`：`bun test src/tmux-client src/mesh`（含 `src/mesh/forwarder-failover.test.ts`）2069 pass / 0 fail，exit 0；`bunx tsc --noEmit -p .` 0 错误。
  - 备注：中间有一次跑出 `2068 pass / 1 fail`（未打印用例名），随后连跑两次 `src/tmux-client src/mesh` 与一次 `src/mesh` 均 0 fail，判为 mesh 侧既有的时序 flake，与本次改动无关。
- `packages/app`：`bun test` 907 pass / 1 skip / 0 fail；`bunx tsc --noEmit -p .` 0 错误
- `packages/stores`：`bun test` 433 pass / 0 fail；tsc 0 错误
- `packages/terminal-ui`：`bun test` 394 pass / 0 fail；tsc 0 错误
- `bunx biome check <改动文件>`：clean
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1673 files, 14682 functions)`

## 注意事项 / 行为影响

1. **真因不是本任务的第 1 项。** commander 的远端取证：jiefa-app 的 tmux 3.6 把每个 pane 放进 `tmux-spawn-*.scope`；内核 OOM killer 杀掉 pane 里某个子进程时，systemd 默认 `OOMPolicy=stop` 会停掉整个 scope（连 bash 一起），窗口随之消失。三次发生的时间戳与 OOM 精确对齐。本任务的第 1 项因此**不是**修复，而是保守的防回放护栏（TTL 拉到 10 s）；真正对定位有价值的是第 3 项的 `%window-close` 日志与第 4 项的 systemd 自检。
2. **`exit_status` 恒为 `unavailable`。** tmux 的 `#{pane_dead_status}` 只在 `remain-on-exit on` 时有值，而 tmex 从不设置它——`%window-close` 到达时窗口已经不存在，无处可查。`formatWindowCloseObserved` 留了 `exitStatus` 形参（有测试覆盖），将来若开 `remain-on-exit` 可直接填入。OOM 的证据只能从 journald 取，不会出现在 tmex 日志里。
3. **TTL 的取舍。** 10 s 内的输入照常重放（含正常 failover）；超过 10 s 的按键/粘贴被丢弃并弹一次提示。极端弱网下用户可能需要重敲——这是刻意的，好过把 `exit` 打进已恢复的 shell。
4. **转发侧的逐帧判定**依赖信封可解。若将来 mux 帧改成加密/不透明，`isOrderedInputFrame` 会全部返回 false，退化为「不丢」，安全方向正确。
5. **护盾窗口仍是活动窗口**（未加 `-d`），焦点护盾语义不变；变的只是它对前端不可见。若哪次清理失败留下一个真实存在的 `tmex-park` 窗口，它同样会被快照过滤——用户在本机 tmux 里仍能看到并手工删掉。
6. **`window-add` 仍会触发一次 reconcile 快照**（无法从 `%window-add @N` 判断是不是护盾），代价是每次 attach 多一次快照，结果已被过滤。

## scope 外的最小改动（已逐条列出）

- `apps/gateway/src/mesh/forwarder.ts`：3 处（`queuedAt` 字段初始化 / 入队打时间戳 / flush 清空）。
- `apps/gateway/src/tmux-client/control-mode-subscription.ts`：接口加 `noteParkingWindow` 并转发给 bridge。
- `packages/ws-client/src/index.ts`：导出 `PendingDropReason` 类型。
- `packages/app/src/runtime/server.ts`：`main()` 里一行自检调用。
- 新增文件：`apps/gateway/src/tmux-client/external/{destroy-log,parking-window}.ts`、`packages/app/src/runtime/service-selfcheck.ts`。
