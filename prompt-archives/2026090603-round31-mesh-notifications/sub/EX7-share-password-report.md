# EX7 — 分享口令探索报告（Opus 子代理，要点）

- 口令：`shares.password_hash` argon2id（`relay-password.ts:59`），明文仅 `create()` 返回一次；不可恢复。可逆设施 `apps/gateway/src/crypto/index.ts` `encrypt/decrypt/decryptWithContext`（AES-256-GCM，master key；bot token/LLM key 同款）。
- 观众会话：`share_access_tokens.token_hash` 与口令解耦；`verifyAccessToken` 不碰口令；`ShareSessionIndex.closeAll(id, code)` 支持自定义关闭码（`ws/share-session-index.ts:54`）；前端 4401 → 回密码表单，4410 → 已结束。
- 接收页：`SharePage.tsx` + `share-password-form.tsx`（useState 初值可预填）；fragment 不进 HTTP，转发/前缀重写/SPA 回退均不丢；仓库无 fragment 传参先例；进入终端态后 `createShareAppPath` 不带 hash 自动抹掉。
- 管理路由挂 `/api/share/...`（会话鉴权），匿名面只有 `/api/share-access/:id{,/login,/logout}` 白名单。
- 契约见 `plan-01-share-password.md`。
