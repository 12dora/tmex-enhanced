## Findings

- **MAJOR** — [apps/gateway/src/weixin/ilink/client.ts:272](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/weixin/ilink/client.ts:272): the old polling loop read `this.creds.baseUrl` and `this.creds.botToken` for every `getUpdates` request. The new code captures `creds` once and reuses it at line 291. Concrete difference: start polling account A, then call `login()` on the same client and confirm account B; the old code’s next poll uses B, while the new code continues polling A indefinitely. The added tests do not cover credential replacement while running.

Verification: 368 scoped tests passed. Ten `llm.test.ts` cases could not run because the sandbox rejects `Bun.serve({ port: 0 })` with `EADDRINUSE`. No other findings.