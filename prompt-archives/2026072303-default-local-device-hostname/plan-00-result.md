# 默认本地设备 hostname 实施结果

> 完成日期：2026-07-24
> 对应计划：`plan-00.md`

## 结果

- Gateway 全新数据库首次 seed 的 local device 名称改为当前 `hostname()`。
- 对 hostname 做 `trim()`，异常空值回退为 `local`。
- 一次性 seed 标记、全新库判定、local 类型、默认 session 和认证方式均未改变。
- 存量数据库、已有设备、重复启动和用户删除设备后的行为保持不变。

## 验证

- `bun test apps/gateway/src/db/default-local-device-seed.test.ts`：6 pass。
- `bun run --filter @tmex/gateway build`：通过。
- 全量 `tsc --noEmit` 仍命中仓内既有 agent/SSH/Buffer 类型错误；错误不涉及本次 DB
  实现或回归测试。
