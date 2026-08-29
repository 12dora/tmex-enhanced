# Batch 3 contract — direct add-on: install/remove button separate from the enable switch

## GET /api/local/status → `direct`

```json
{ "supported": boolean, "installed": boolean, "enabled": boolean, "capable": boolean, "version": string | null, "platform": string }
```

`enabled` = env `TMEX_DIRECT_ENABLED` (absent → `true`). When `enabled=false` the runtime does not load the addon (`capable=false`) even if installed.

## POST /api/local/direct

Body `{ "action": "install" | "remove" | "enable" | "disable" }`.

- `install`: download addon (60 s, abortable, atomic swap), then set `TMEX_DIRECT_ENABLED=true`.
- `remove`: delete `native/`, set `TMEX_DIRECT_ENABLED=false`.
- `enable`: requires installed (`409 direct_not_installed`), writes `TMEX_DIRECT_ENABLED=true`.
- `disable`: writes `TMEX_DIRECT_ENABLED=false`.

Response `200 { "ok": true, "installed", "enabled", "capable" (current runtime value), "restartRequired": true }`.
Errors as before: `409 direct_unsupported`, `502 direct_download_failed`, `500 direct_failed`, `400 invalid_action`.

The legacy body `{ "enable": boolean }` is removed. Setup wizard `directEnable` = install + enable (unchanged externally).
