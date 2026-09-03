# TASK A+B 结果 — 拆 `peer-manager.ts` / 降 `mesh-runtime.ts`

机械拆分，公开表面与副作用顺序不变。未改测试、未改 allowlist。

## A. `peer-manager.ts` → 两个 collaborator

### `DcUpgradeCoordinator`（`peer-dc-upgrade.ts`）

状态：`upgradeGate` / `dcUpgradeRetry` / `dcBreaker` / `dcHealth` / `dcAttemptSeq` / `upgradeInflight` / `upgradeWaiters` / `upgradeScan`。

方法：`wantsUpgrade`、`ensureGate`、`noteUpgradeResult`、`scheduleCoalescedUpgrade`、`acquireUpgradeSlot`、`releaseUpgradeSlot`、`maybeUpgrade`、`queueUpgrade`、`runUpgradeDial`、`cancelDcUpgradeRetry`、`nextDcAttemptId`、`cancelDcHealthTimer`、`armDcHealthTimer`、`dcUpgradeRetryDelayMs`、`armDcUpgradeRetry`、`scheduleDcBreakerProbe`，以及 `startScan` / `clearScan` / `dispose`。

为压 `peer-manager.ts` 行数，顺带搬入纯函数 `parseEndpoints`、`sanitizeEndpoints`、`dcFailureReason`。常量 `PEER_UPGRADE_*` / `PEER_DC_UPGRADE_*` / `PEER_MAX_ENDPOINTS` / `PEER_MAX_ENDPOINT_LENGTH` 仍由 `peer-manager.ts` re-export，测试 import 路径不变。

`runUpgradeDial` 的 port `dialDc` 注入的是 `PeerManager.dial`（全量拨号），不是 `dialDc`。

### `RtcWakeGate`（`peer-rtc-wake.ts`）

状态：`wakeGate` / `incomingWakeGate` / `rtcWakeNonces`。

方法：任务列出的全部 wake 方法 + `forgetPeer` / `dispose`。为压行数并避免 port 绕回 `PeerManager` 造成递归，`signalingFor` / `sendRtcSignal` 也落在本类；`dispatchRtcWake` 调自身的 `sendRtcSignal`。

常量 `PEER_RTC_WAKE_*` 由 `peer-manager.ts` re-export。

### `PeerManager` 接线

biome `lineWidth: 100` 会把 one-line private forwarder 折成 3 行，塞回 `peer-manager.ts` 会超 1950。因此 forwarder 做成 `PeerCollaboratorHost` 抽象基类（`peer-dc-upgrade.ts`）的 `protected` 委托；`PeerManager extends PeerCollaboratorHost`，内部仍写 `this.maybeUpgrade(...)` 等，行为不变，公开表面字节级不变。

- 构造里创建 `dcUpgrade` / `rtcWake` 并注入 ports
- `start()` → `this.dcUpgrade.startScan(...)`（interval 回调仍做 fingerprint / backoff prune / advertised status / notifyPeerEndpointsChanged）
- `stop()`：`clearScan` → drop parked/live/retiring → `rtcWake.dispose()` → `lostDirect.clear()` → `dcUpgrade.dispose()`
- `onRevoked`：`upgradeGate.delete` + `rtcWake.forgetPeer` + `cancelDcUpgradeRetry`

### 必须保留的两处缓存（未搬、未改语义）

- `keyLogHeadCache` + `notifyKeyLogHeadChanged()` 置 `null` 仍在 `peer-manager.ts`
- `os.networkInterfaces()` TTL 缓存仍在 `constructMeshDeps`：`createTtlCache` / `ifaceCache.get()` / `refresh` / `invalidate`；实现搬到 `node-list-apply.ts` 后由 `mesh-runtime.ts` re-export（`STATUS_IFACE_CACHE_TTL_MS`、`createTtlCache`、`attachKeyLogHeadNotify`），测试 import 路径不变

## B. `handleUplinkNodeList` → `node-list-apply.ts`

抽出纯函数，由 deps 对象驱动：

| 函数 | 职责 |
| --- | --- |
| `reconcileHubStoreFromNodeList` | retired-source 检查 + `replaceAll` + secondary cleanup |
| `emitListedNodeEvents` | 列表节点事件 + `notifyPeerEndpointsChanged` |
| `emitUnlistedHubEvents` | 未列入 nodes 的 hub 补发 |
| `pruneStaleListedPeers` | 剔除过期 listed peer |
| `applyUplinkNodeList` | 编排：lastNodeList / hubGeneration / lastRtc，**`listReach()` 只算一次**并透传 |

`handleUplinkNodeList` 现为三行转发（CC=1）。`listedHubNodeIds` / `meshHubNotRetired` 一并搬入；`createUplinkWiring` 仍从 `node-list-apply` import `meshHubNotRetired`。

## 复杂度（与 `scripts/complexity/gate.ts` 同算法）

| 项 | 实测 | 门槛 |
| --- | ---: | --- |
| `peer-manager.ts` fileLines | **1930** | ≤1950 |
| `mesh-runtime.ts` fileLines | **1559** | ≤1560 |
| `handleUplinkNodeList` CC | **1**（3 行） | ≤10 |
| `applyUplinkNodeList` CC | 6 | 默认 |
| `reconcileHubStoreFromNodeList` CC | 9 | 默认 |
| `emitListedNodeEvents` CC | 11 | 默认 |
| `emitUnlistedHubEvents` CC | 5 | 默认 |
| `pruneStaleListedPeers` CC | 5 | 默认 |

未改 `scripts/complexity/allowlist.json`。全局 gate 仍会因其他文件失败。

## 验收

- `cd apps/gateway && bun test`：**3797 pass / 6 fail / 0 error**（3803 tests, 352 files）。6 fail 全部是任务列出的已知 flake，无新增失败：
  - `PeerManager > replay cache is per-peer and retains nonces for the full validity window`
  - `multi-hub in-process integration > token created on A survives A crash: B promoted via role API can redeem`
  - `stream failover integration > legacy HELLO/DEVICE_CONNECT/SUBSCRIBE/SELECT keeps 0x305 SEQ after dc death`
  - `large raw-body push over mesh > 24 MiB rawBody reaches the target over the hub relay path`
  - `large raw-body push over mesh > 24 MiB rawBody reaches the target over a ws-secure direct peer path`
  - `RtcPeerManager > ice failed summary lists local and remote candidate types`
- `peer-manager.test.ts`（除上述 replay-cache flake）、`peer-manager.upgrade.test.ts`、`mesh-runtime.test.ts`、其余 mesh `*.integration.test.ts` 均通过。**零测试改动。**
- `cd apps/gateway && bunx tsc --noEmit -p .`：0 error（基线 21）
- `bunx biome check` 五个改动文件：通过

## 触及文件

- `apps/gateway/src/mesh/peer-manager.ts`（改）
- `apps/gateway/src/mesh/peer-dc-upgrade.ts`（新）
- `apps/gateway/src/mesh/peer-rtc-wake.ts`（新）
- `apps/gateway/src/mesh/mesh-runtime.ts`（改）
- `apps/gateway/src/mesh/node-list-apply.ts`（新）
- `prompt-archives/2026090302-round21-perf-idle-smell/sub/AB-result.md`
