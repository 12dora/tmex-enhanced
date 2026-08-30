# G4 result — Fix backend review findings

## What changed and why

1. **`broadcastNodeList` tri-state `'sent' | 'unchanged' | 'failed'`**  
   Auth 只在 `'unchanged'` 时补发缓存字节。`'failed'`（含 `keyLogSource.head()` 抛错）与 round 前一样：吞掉错误、不发列表，避免把过期 `key_log_head` 交给刚认证的节点。

2. **无认证 link 时驱逐缓存**  
   `listForBroadcast` 为空则直接 `delete` 指纹/缓存字节并返回，不 `buildNodeList`。最后一条 link 关闭因此不会为 0 个接收方构建/缓存一份 offline list。

3. **去掉二次 encode**  
   指纹改为投影的 `JSON.stringify({ ...msg, version: 0 })`（构造顺序稳定，不含 version），变更路径只调用一次 `encodeUplinkCtl`。测试 spy 断言每次变更 broadcast 恰好 1 次 `node.list` encode。未采用按 key 排序的 replacer：它对 32 节点投影比二次 encode 更慢，且投影本身顺序稳定。

4. **`ImmediateScheduler.advance(ms)`**  
   只触发已到期 interval，按 `dueAt` 排序，用快照（回调里新挂的 timer 等下次 `advance`）。`tickIntervals()` 保持原语义以免打坏旧测试。idle / park / retire 新用例全部改走 `advance`，缺 re-arm 或 deadline 算错会失败。

## Files

- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/hub/uplink-server.test.ts`
- `apps/gateway/src/mesh/test-support.ts`
- `apps/gateway/src/mesh/peer-manager.test.ts`

## Measurements

Bench: `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/g4-encode-once-bench.ts`  
payload 9094 B / 32 nodes / 2000 rounds：

| 路径 | before | after |
|---|---|---|
| 变更（2× encode vs json 指纹 + 1× encode） | 0.0441 ms/op | 0.0412 ms/op（1.07×） |
| 未变（1× encode vs 仅 json 指纹） | 0.0207 ms/op | 0.0195 ms/op（1.06×） |

行为指标：变更 broadcast 的 `encodeUplinkCtl({ t: 'node.list' })` 从 2 降为 1（测试锁定）。墙钟收益有限，因为 `encodeUplinkCtl` 本身就是 JSON+UTF-8；主要收益是不再多分配一份指纹 `Uint8Array`，且 encode 次数符合审查要求。

## Verify

- `cd apps/gateway && bun test src/hub`：59 pass / 0 fail
- `cd apps/gateway && bun test src/mesh`：475 pass / 0 fail（含 `peer-manager.test.ts`，无 EADDRINUSE）
- `bunx tsc --noEmit -p .`：21 errors（= 基线 21），触及文件 0
- biome：4 个改动文件 clean

## Left / risk

- 指纹依赖投影对象的插入顺序，不按 key 排序。`buildNodeList` / `projectNode` 构造顺序稳定；若上游某天打乱 object key 顺序，可能把未变投影当成变更（多发，不会发过期 list）。
- 空接收方路径返回 `'unchanged'`（已删缓存）。Auth 在 `registry.put` 之后调用，不会走到空列表。
- `ImmediateScheduler.tickIntervals()` 仍立刻触发全部 interval，仅新 deadline 测试走 `advance`。
