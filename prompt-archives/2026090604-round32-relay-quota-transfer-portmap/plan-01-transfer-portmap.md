# Round 32 计划（二）：共享传输引擎 + 节点间文件传输 + 端口映射 + 设备页三点菜单

前置：读 `plan-00.md` 与 `sub/EX2-file-transfer.md`、`sub/EX3-mesh-tunnel-portmap.md`。契约已由指挥官落地：
`packages/shared/src/contracts/transfer.ts`、`packages/shared/src/contracts/portmap.ts`（已从 `@tmex/shared` 主入口导出）。

## A. 共享传输引擎 `@tmex/transfer`（T1）

新 workspace 包 `packages/transfer`（`@tmex/transfer`），导出：
- `.`（浏览器安全）：`types`、`progress`（速率/ETA/节流，唯一实现）、`bytes`（concat/copy）、`chunker`（`iterateFrames(Blob | ReadableStream | FileRange, frameSize)`）。
- `./node`（仅 Node/Bun）：`source`（`openRange(path, start, end?)`）、`sink`（`ResumableSink`）、`push-driver`（`runPush`）。

设计要点（源自 `system/upgrade-staging.ts` + `remote-upgrade-job.ts` 的既有断点续传实现，先无行为变更地抽出，再扩展）：
- `ResumableSink`：`.part-<id16>` 内容寻址命名；`status()` 返回已收字节 / 已收区间；`write(range, body, {expectedBytes})`：`streams=1` 时保持 append + 增量哈希语义，`ranged` 模式预分配 + `pwrite` + 区间位图，完成后整文件最终校验 sha256（若提供）；短 body 视为链路中断（保留 `.part`，`incomplete`），只有全长 body 且哈希不符才删；`commit` = rename + chmod；TTL 24 h 清扫 + 开机孤儿扫描。
- `runPush(src, transport, {streams, maxAttempts, backoffMs, deadlineMs, onProgress, signal})`：offset 协商 → N 个不相交区间并行 `put` → 失败分类 → 退避阶梯 `[1,2,4,8,15,15,15]s` → 续传。`streams` 由能力位协商：对端无 `transfer-ranged-parallel` 则 1；transport 为 relay 时默认 2，直连默认 4（上限 8）。
- 三个消费者改接引擎：
  1. 升级推包 `remote-upgrade-job.ts` / `upgrade.ts` 的字节搬运半边（保留 job 状态机、phase/预算/watchdog），既有测试为回归套件。
  2. 浏览器上传/下载：`transfer-session.ts` 的临时文件改用 `ResumableSink`；`PUT /api/files/upload/:id?offset=&length=` 接受乱序区间；`upload-transfer.ts` 改为 `runPush`（浏览器侧 transport，并行 N 个 PUT，失败按 offset 续传，不再整包重来）；下载 `GET /api/files/download/:id/content` 支持 `Range`，客户端失败后从已收 offset 续传。RTC `bulk:` 快路径保留，`FilesBulkHooks` 拓宽为 `{status, writeRange, openRange, abort}`。本地设备读文件直接 `openRange`，不再 rsync 复制到 tmp。
  3. 节点间传输（下文 B）。
- `SystemInfo.transferCapabilities: TransferCapability[]`（`transfer-v2`、`transfer-ranged-parallel`）。
- 单文件上限统一走 `apps/gateway/src/files/transfer-limit.ts` 的 `effectiveTransferMaxBytes()`（R1 创建；T1 若先到则自己创建同名文件与签名 `effectiveTransferMaxBytes(config, relayQuota: { maxFileBytes: number | null } | null): number`，R1 接入 relay quota 来源）。

## B. 节点间文件传输后端（T1）

- 任务在源节点 A 运行。流程：浏览器 `POST /n/<B>/api/transfer/grants` → `{grantId, token, expiresAt}`（10 min，绑定 fromNodeId / destRootId / destPath）；浏览器 `POST /n/<A>/api/transfer/jobs`；A 用 `PeerManager.getLink(B)` 开 `http` 流调 B 的 `/api/mesh-internal/transfer/sessions`（带 grant）建立会话（B 校验 peer marker === fromNodeId 且 token 一次性），随后 `GET .../sessions/:sid/files/status`、`PUT .../sessions/:sid/files?rel=&offset=&length=`、`POST .../files/commit` 均带 sid；会话空闲 10 min 过期。
- `forwardInternalHttp` 增 `rawBody` / `headers` / `onProgress` / `signal`（镜像 `forwardAuthorizedHttp`）。
- 目录：A 侧递归展开为文件列表（`expanding` 阶段），B 侧按 `relPath` 建目录（路径安全：`checkAndNormalize` 落在 destRoot 内）。A === B 时本地复制。目标 root 为 ssh 设备时 B 先收到本地暂存再 `pushFileToDevice`；local 设备直接写到目标目录旁的 `.part` 再 rename。
- 冲突：默认 `skip`（记 `skipped`），可 `overwrite`。
- 任务注册表：源节点内存 `Map<jobId, Job>`（完成/失败保留 30 min），`GET /api/transfer/jobs`、`GET /api/transfer/jobs/:id`、`GET /api/transfer/jobs/:id/events`（NDJSON：snapshot → progress/item/state → end，进度节流 200 ms）、`DELETE /api/transfer/jobs/:id`（取消）。
- 单文件上限：A 侧展开时按 `effectiveTransferMaxBytes()` 标记 `quota_file_size` 失败；B 侧 status/put 同样校验。
- 测试：sink/driver 单测（移植升级用例）、`mesh/integration/transfer.integration.test.ts`（两个 in-process MeshRuntime，A→B 经 relay 链路，中途 RST 后续传成功、并行 4 流字节一致、目录展开）。

## C. 端口映射后端（T2）

- 新流类型 `tcp`：`TcpStreamOpenPayload = { type:'tcp'; mapId; host; port }`；`classifyOpenPayload` + `handleInboundStream` 分派到 `acceptTcpStream`。
- 模块 `apps/gateway/src/portmap/`：`types.ts`、`port-probe.ts`（bind+close 探测、保留端口 = gateway/peer/ssh 22 等）、`listener.ts`（`Bun.listen`，每连接 `getLink(B).openStream(payload)`，懒拨号）、`pump.ts`（socket ⇄ LinkStream 双向泵：读侧只在 socket 写入被接受后再 pull，写侧 `await stream.write` 期间暂停 socket；半关闭 END/FIN 双向映射；abort→RST/destroy）、`accept-tcp-stream.ts`（B 侧：解析 payload → `port_map_exports` 中存在 `mapId` 且 `fromNodeId === peer` 且 enabled → `Bun.connect` 5 s 超时 → 泵）、`store.ts`（drizzle + Memory 实现，仿 `tunnel/config-store.ts`）、`manager.ts`（CRUD、开机恢复、pause/resume、计数器、`stop()`）、`routes.ts`（浏览器 API）。
- 迁移 `0050_port_maps.sql`（`port_maps`、`port_map_exports`），追加到 `managed-migrations.ts`（R1 用 0049，T2 用 0050；两者都要改 `managed-migrations.ts` 各自追加一行）。
- API（A 侧，node-session 鉴权）：`GET /api/portmap`、`POST /api/portmap`（409 `port_in_use`）、`PATCH /api/portmap/:id`、`DELETE /api/portmap/:id`、`GET /api/portmap/probe?host=&port=`；（B 侧）`GET/POST /api/portmap/exports`、`DELETE /api/portmap/exports/:mapId`、`GET /api/portmap/target-probe?host=&port=`。
- 每映射并发连接上限 64（超出拒绝 accept），`listenHost` 默认 127.0.0.1；链路丢失不重放，直接关本地 socket。`manager.stop()` 加入 mesh `stopQuietly` 与 `GatewayRuntime.stop()`。
- 性能：`Bun.listen`/`Bun.connect` 若支持 `setNoDelay` 则开启；泵不额外缓冲；链路复用 `PeerManager`（dc → ws-secure → relay）。
- 测试：`port-probe.test.ts`、`pump.test.ts`（in-memory link pair：半关闭、RST、背压）、`mesh/integration/portmap.integration.test.ts`（两个 in-process MeshRuntime + echo server，经 relay 路径字节往返、暂停后连接被拒、export 缺失被 RST）。

## D. 前端（F1）

- `DevicesPage.PageActions`：三点菜单（`Ellipsis`），项：恢复默认布局（保留确认框）、文件传输、端口映射；新建文件夹按钮保留在菜单外。
- 文件传输弹窗（`apps/fe/src/pages/devices/transfer/`）：`sm:max-w-5xl`，两栏各：节点选择（`useMeshNodes` + `sortNodes`，仅在线且已登录）、根目录选择（`fetchFileRoots`）、面包屑 + 路径、条目列表（文件+目录，复选框多选，shift 区间选择，双击/Enter 进目录，`PICKER_SKIP_RENDER_THRESHOLD` 虚拟化思路）、「发送到右侧 / 发送到左侧」按钮；下方传输列表（文件名、方向 A→B、大小、已传/总量、速度、ETA、进度条、状态、取消）。数据源：`packages/api-client/src/transfer.ts`（grants/jobs/events）+ `packages/panels/src/files/transfer-jobs-store.ts`（zustand，NDJSON 订阅；现有 `startTransferToast` 改为该 store 的渲染器之一，浏览器上传/下载任务也进同一 store）。
- 端口映射弹窗（`apps/fe/src/pages/devices/portmap/`）：列表（本机端口 → 目标节点:端口、状态、连接数、流量、暂停/继续、删除），新建表单（监听节点 A、监听端口（失焦即探测，占用则报错并禁用提交）、目标节点 B、目标地址/端口（探测是否在监听，仅提示）、名称）；创建顺序：先 B `POST /api/portmap/exports` 得 mapId，再 A `POST /api/portmap`（失败则回滚 export）；删除反向。列表聚合所有在线已登录节点的 `GET /n/<id>/api/portmap`，弹窗打开期间 2 s 轮询。
- i18n 键：`devices.menu.*`、`devices.transfer.*`、`devices.portmap.*`（rest bundle）；文案按 `/Users/konata/code/tmex-copy-guidelines.md`。
- 单测：菜单渲染、选择 helper、传输列表格式化、端口表单校验。

## 文件范围（并行互斥）
- T1：`packages/transfer/**`（新）、`apps/gateway/src/transfer/**`（新）、`apps/gateway/src/system/{upgrade,upgrade-staging,remote-upgrade-job,remote-upgrade-io}.ts`、`apps/gateway/src/files/**`（除 `transfer-limit.ts` 归 R1）、`apps/gateway/src/api/file-transfer-*.ts`、`apps/gateway/src/mesh/forwarder.ts`（仅 `forwardInternalHttp` 扩展）、`apps/gateway/src/mesh/rtc/bulk.ts`、`packages/api-client/src/{upload-transfer,download-transfer,transfer-types}.ts`、`packages/ws-client/src/direct/bulk-client.ts`、`packages/panels/src/files/bulk-transfer.ts`、`packages/shared/src/contracts/{system,files}.ts` 定点、`api/index.ts` 注册一行。
- T2：`apps/gateway/src/portmap/**`（新）、`apps/gateway/src/db/schema/portmap.ts`（新）+ `schema.ts` 一行、`drizzle/0050_*`、`managed-migrations.ts` 一行、`mesh/stream-targets.ts`（classify + accept 分派）、`mesh/peer-live-registry.ts`（分派）、`mesh/types.ts`（payload 类型）、`mesh-runtime.ts` / `runtime.ts` 各一处注册、`api/index.ts` 注册一行。
- F1：`apps/fe/src/pages/DevicesPage.tsx`、`apps/fe/src/pages/devices/{transfer,portmap}/**`（新）、`packages/api-client/src/{transfer,portmap}.ts`（新）+ index 导出、`packages/panels/src/files/transfer-jobs-store.ts`（新）与 `transfer-toast.tsx`、locale `devices.*` 子树。
- R1：见 plan-00。
- 共享文件冲突规则：locale JSON 各改各的子树；`api/index.ts` 与 `managed-migrations.ts` 只追加一行；`packages/api-client/src/index.ts` 只追加导出行。指挥官统一跑 `build:i18n`。
