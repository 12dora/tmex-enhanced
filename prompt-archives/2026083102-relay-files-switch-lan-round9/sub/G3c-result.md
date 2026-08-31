# G3c 结果：并发 ws-secure 竞速剩余 blocker

## 做了什么

**Blocker 1.1 — winner 已选出、track 前 stop 会关 socket**  
`raceWsSecureEndpoints` 的 parent-abort 改为 `abortRaceParent`：abort 输家后关闭已当选 winner，并把 `winner` 置 `null` 返回。`dialWsSecure` 在 stale 分支先 `winner.session.close('stopped')` 再抛错。两层一起覆盖「race 返回前 abort」和「返回后、track 前 stale」。

**Blocker 1.2 — 接收端 keys 跟 session 走**  
`rememberKeys` 改为按 `LinkSession` 写入 `WeakMap`，且一律在 `track()` 之前调用。`installLive` 只从该 session 的 WeakMap 取 keys 写到 live。parked 的是同一 session 对象，提升时 `installLive` 读到的是它自己的 keys，不会覆盖当前 live，也不会在提升后丢 keys。

**Should-fix 2.1 — `linkDetailOf` 纯内存**  
不再 `getPeer()`。只读 `live` + `lastDirectAttempt`；`endpoints` 固定 `[]`。投影仍用已构建的 `peerById`。`mesh-routes.ts` / `node-list-projection.ts` 无需改。

**Should-fix 2.2 — stagger sleep 在 abort 时清掉**  
竞速单测：三个 candidate、abort-aware 挂起 sleep，parent abort 后两条 pending sleep 均 reject，且后两个 URL 不再进入 `dial`。

## 文件

- `apps/gateway/src/mesh/peer-ws-race.ts` + `peer-ws-race.test.ts`
- `apps/gateway/src/mesh/peer-manager.ts` + `peer-manager.test.ts`

未改：`mesh-routes.ts`、`node-list-projection.ts`（G3b 已走 `peerById`）。

## 测试 / tsc / gate

| | before | after |
|---|---|---|
| `apps/gateway` bun test | 3013 pass / 0 fail（304 files） | 3018 pass / 0 fail（+5 单测；304 files） |
| `bunx tsc --noEmit -p .` | 21 errors | 21 errors（未增长） |
| biome（改动文件） | — | 通过 |
| complexity gate（owned） | `peer-manager.ts` 2295 ≤ 2297 | 2296 ≤ 2297；owned 函数均低于锁。全仓仍有 **他组** 5 条（`upgrade-apply.ts` / `init.ts` / `upgrade.ts` / `tmux-selection-actions.ts`） |

新增单测：parent abort 后 winner 关闭且 `winner: null`；挂起 stagger sleep 后 abort 不再 dial；PeerManager「winner 已选出、track 前 stop」socket 关闭且无 live；ACCEPTOR 同节点两路 inbound：第二路不覆盖 keys，关掉第一路后 promoted session 的 `sessionKeysOf()` 匹配；`linkDetailOf` 不读 peer 记录。

## 指挥官需跟进

1. 复杂度门禁全仓失败是他组文件，owned 全绿。
2. 未跑 Playwright / `bun run dev`。未改 i18n / allowlist / frontend。
3. `mesh-routes.ts` 无需改：`collectNodes` 已从 `peerById` 取 endpoints，`linkDetailOf` 不再打 DB。
