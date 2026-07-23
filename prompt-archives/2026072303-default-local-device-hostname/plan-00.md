# 默认本地设备 hostname 实施计划

> 日期：2026-07-23
> 状态：实施中。

## 背景

Gateway 已通过 `ensureDefaultLocalDeviceSeeded()` 在真正全新数据库中一次性创建 local device，当前名称固定为
`local`。多机聚合时该名称缺少区分度。

## 实施

1. 在 `apps/gateway/src/db/index.ts` 使用 Bun 支持的 `node:os` `hostname()`。
2. 全新库 seed 的设备名改为 `hostname().trim() || 'local'`。
3. 不修改一次性标记、全新库判定、session、认证或 runtime status 行为。
4. 更新 `apps/gateway/src/db/default-local-device-seed.test.ts` 的稳定行为断言。

## Gate

- 全新库 seed 一台且仅一台 local device，名称等于当前 hostname。
- 空 hostname 有 `local` 安全回退。
- 重复启动、删除后启动、老库与已有设备行为不变。
- 定点测试和 Gateway typecheck 通过。

