# plan-00 执行结果（2026-08-27 → 2026-08-28）

worktree `../tmex-enhanced-wt-hub`，分支 `feat/hub-node`，base `4a14ff2`。按 `plan-00.md` 的分工（grok 4.6 后端、Opus 5 前端、codex luna 探索、codex sol 审查、Claude 指挥官）执行，每个子任务的 prompt / result / review 都在 `sub/<id>-{prompt,result,review}.md`；流程固定为「实现 → codex 审查 → 指挥官逐条判定 → `<id>-fix` 修复 → 包内测试 + tsc 不高于基线 + biome → commit」。本轮 codex 审查的 blocker / major 几乎全部判定有效并已修复，未采纳的只有两处（见"未采纳"）。

## 各阶段落地情况

| 阶段 | 任务 | 状态 | 关键 commit / 报告 |
|---|---|---|---|
| 0 | E0-1..4 探索、基线 | 完成 | `phase0-result.md` |
| 1 | B1-1 GatewaySession/Carrier 拆分 | 完成 + fix（closeSession/handleCarrierClose 语义） | `b1-1-result.md`、`b1-1-fix-result.md` |
| 1 | B1-2 link 编解码 / 流控 / SecureChannel | 完成 + fix（AAD=线上帧头、串行 nonce、WINDOW 校验、WS 背压等 9 项） | `b1-2-*` |
| 1 | B1-3a/b/c 身份原语、存储、key-log 服务 | 完成 + fix（reset-root 仅 genesis、signer 矩阵、delegation 时间窗、passkey Borsh assertion、原子 token 消费等） | `b1-3*` |
| 2 | B2-1 HubRuntime | 完成 + fix（签名 revoke、validating append、事务 redeem、passkey enroll、hostile ctl 边界） | `b2-1-*` |
| 2 | B2-2a/b Mesh 传输面 / HTTP 面 | 完成 + fix（uplink 域分离签名、ws-secure、header 过滤、可信 via、本地 /ws 守卫、目标侧分发链、登录体去 sid 等） | `b2-2*` |
| 2 | B2-3/4/6/7/9/10 角色装配、接线、集成测试 | 完成 + 三轮修复（生产直连端到端、直连入站按会话续验/吊销拆除、connectionId 绑定、dc 会话校验、载体等级仲裁与 retiring 链路、关停协调、非空跑集成测试） | `b2-3`、`b2-4`、`b2-6`、`b2-7`、`b2-9`、`b2-10` |
| 2 | B2-5/8 前端契约 | 完成（keylog/head、passkeys、mode 字段、ENROLL_REDEEMED、keylog hub=sync、passkey origin 过滤） | `b2-5`、`b2-8` |
| 3 | B3-1/2 node 侧 RTC、bulk | 完成 + fix（切换顺序、握手队列上限、分片边界、DC 发送队列、TURN 结构化） | `b3-*` |
| 3 | F3-1/2/3/4 浏览器直连、bulk、connectionId | 完成 + fix（RFC 8122 指纹、attempt 代际、四阶段屏障、rtcSession 绑定切换帧、bulk 超时/尺寸守卫） | `f3-*` |
| 4 | F4-1/2/3/4/5 登录、每 node 运行时、Nodes 页、passkey 节点管理 | 完成 + fix（enroll_sk 不落盘、nodeId 严格校验、4401、两段式 TOTP、密钥清零等） | `f4-*` |
| 5 | C5-1/2/3/4 CLI、native manifest、打包 | 完成 + fix（Node 引导 → Bun `cli-auth.js`、join 只信任已验证链、原子 join、HTTPS redirect=error） | `c5-*` |
| 6 | D6-1 文档 | 完成 | `docs/hub/2026082800-hub-node-operations.md`、`deployment.md` 重写 |
| 6 | standalone e2e | 完成，无回归（94/7/1，7 个失败与既有基线一致） | `sub/e2e-standalone.md` |

## 验收对照（设计"验收标准"）

- 4（失陷模拟集成测试）：`apps/gateway/src/mesh/integration/mesh.integration.test.ts`、`direct-path.integration.test.ts` 覆盖登录 fan-out、`/n/:id/api|ws` 透传、relay 密文、上传取消、吊销、三个失陷场景。
- 5（standalone 不变）：assemble 在 standalone 不构造 mesh、不装信号处理器；e2e 基线不退化。
- 6（tarball 增量）：native JS ≈ 11 KB + argon2/noble ≈ 114 KB，远小于 1 MB（`c5-2-result.md`）。
- 1/2/3（真实双机 LAN、hub 停机互操作、直连中途断开）**未做**：需要两台真实内网机器，留给下一轮。

## 未采纳 / 有意取舍

- codex 建议 `node_sessions` 增加 DB CHECK 约束：改为 store 层判别联合类型 + 运行时检查，避免重生成已落地的迁移。
- 浏览器多凭证且无可信元数据时需「探测 + 正式」两次 WebAuthn 仪式（B2-8 精确 origin 过滤后属罕见场景）。

## 遗留

- 真实双机验证（验收 1–3）与 mesh e2e 用例（Playwright virtual authenticator）未做。
- 多标签页绑定已通过 WS URL `?cid=` nonce + `GET /api/mesh/connection?cid=` 解决（B2-11 / F3-5）。
- `rtc-loopback.integration.ts` 需 `TMEX_NATIVE_DIR` 才跑真 native 组。
- 既有 tsc 基线错误（gateway 23、app 1、api-client 5、stores 1、theme 10）未清理，与本任务无关。

## 最终基线（commit 前逐包验证）

最后一次全量：gateway 1823、shared 283、ws-client 235、stores 125、api-client 96、panels 217、app 175、terminal-ui 205、ui 14、notifications 15、theme 6、fe 208，全部 0 fail；tsc：gateway 23（基线 27）、stores 1、api-client 5、app 1、theme 10（均等于基线），其余 0；standalone e2e 94/7/1（7 个失败为既有基线）。
