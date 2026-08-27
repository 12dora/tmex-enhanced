## 审查发现

### 1. 中｜高置信度：SSRF 漏放行站点本地 IPv6 地址

位置：[ip-address.ts:98](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/tools/ip-address.ts:98)

`isPrivateIpv6Bytes()` 仅拒绝 ULA、link-local、loopback 和部分 IPv4-mapped 地址，遗漏 `fec0::/10` 站点本地地址。

具体复现：

```ts
isPrivateHostname('fec0::1') // false
validateFetchUrl('http://[fec0::1]/') // 返回 { url }
```

当主机存在该地址空间的本地路由时，`fetch_url` 可以访问站点内部 HTTP 服务，绕过 SSRF 限制。

最小修复：拒绝 `fec0::/10`：

```ts
if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0xc0) return true;
```

并为 `fec0::1`、`feff::1` 补充 classifier 和 `validateFetchUrl` 回归测试。

### 2. 低｜高置信度：共享通知 builder 改变 Telegram 空消息行为

位置：[notification-format.ts:109](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/events/channels/notification-format.ts:109)

旧 Telegram 实现仅在 `message` 为非空字符串时添加消息行；共享 builder 现在对空字符串也输出消息行。

具体场景：

```ts
payload: { message: '' }
```

重构前 Telegram 不输出消息字段；现在会发送：

```text
Message：
```

这属于隐藏在共用 builder 中的可见文本变化，现有测试只覆盖非空消息。

最小修复：要求消息非空后再追加：

```ts
const message = event.payload?.message;
if (typeof message === 'string' && message.length > 0) {
  lines.push(`${t('notification.message')}：${message}`);
}
```

并增加 Telegram generic 空消息回归测试。

## 其他核对结果

未发现 rsync 入队/cleanup 顺序、doctor 输出顺序或退出码、Borsh 序号与分片、`run_command` 完成判定，以及被删除符号残余引用方面的缺陷。相关定向测试中 95 项通过；另有 5 项因只读沙箱禁止 `mkdtemp` 而返回 `EPERM`，不是断言失败。