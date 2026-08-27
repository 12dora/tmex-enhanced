## 审查发现

### 1. 低｜高置信度：创建会话时的验证错误优先级发生变化

位置：[agent-session-config.ts:176](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/agent-session-config.ts:176)、[agent-session-config.ts:232](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/agent-session-config.ts:232)

创建和更新共用字段顺序后，`systemPrompt` 被提前到 `writeMode` 之前，同时 Web Search 的语义校验被推迟到所有字段解析完毕之后。这改变了旧接口返回的具体错误消息。

具体输入：

```json
{
  "modelId": "gpt-test",
  "writeMode": "invalid",
  "systemPrompt": 123
}
```

旧实现先校验 `writeMode`，返回：

```text
Write mode must be confirm or auto
```

新实现先解析 `systemPrompt`，实际返回：

```text
Invalid request
```

类似地，`useProviderWebSearch: true` 与无效 `maxStepsPerTurn`、`providerHostedTools` 同时出现时，新实现也可能先返回后者的错误，而旧实现先返回 Web Search 的 provider/protocol 错误。

最小修复：继续复用同一份字段规格，但为 create/update 提供各自的遍历顺序；同时增加 create-only 的字段后校验钩子，在解析 `useProviderWebSearch` 后立即执行原有语义校验。补充多字段无效输入的错误优先级回归测试。

## 其他结果

未发现 SSH 认证顺序、解密与回退、`stateSnapshotsEqual` 字段集合、pane-info 输出、assist-regex、dep-install 或测试清理方面的其他具体回归。

定向验证：126 项测试通过，0 项失败。涉及本地监听的完整 LLM/watch API 测试受只读沙箱禁止 `Bun.serve({ port: 0 })` 限制，未能运行。