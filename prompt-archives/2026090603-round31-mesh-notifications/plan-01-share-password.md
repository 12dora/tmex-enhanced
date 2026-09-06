# plan-01：分享口令查看/修改 + 带口令链接

探索报告 `sub/EX7-share-password-report.md`。

## 契约
- 迁移：`shares.password_enc text`（AES-256-GCM，`apps/gateway/src/crypto` `encrypt/decrypt`，master key）；`password_hash` 继续用于登录校验；旧分享 `password_enc` 为 null → 口令不可查看，只能修改。
- `GET /api/share/:id/password` → `{password}` | 409 `SHARE_PASSWORD_UNAVAILABLE` | 404。
- `POST /api/share/:id/password` `{password, endSessions}` → `{share, endedSessions}`；`endSessions` 时删除该分享全部 access token + ws `closeAll(id, 4401, 'SHARE_LOGIN_REQUIRED')`（前端回到密码表单）；否则在线观众不受影响。
- 带口令链接：`<share.url>#p=<encodeURIComponent(password)>`，纯前端拼接；接收页读 hash 预填 `SharePasswordForm`（只填不提交），随即 `history.replaceState` 抹掉。
- UI：分享弹窗进行中态 Checkbox「链接中包含口令」；设置 → 分享 → 进行中：查看口令 / 修改口令（新口令 + 「同时断开当前所有观看者」）/ 复制带口令的链接。
