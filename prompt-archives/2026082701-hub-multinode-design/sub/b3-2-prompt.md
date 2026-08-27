# Task B3-2 — bulk file transfer over the direct PeerConnection (apps/gateway/src/mesh/rtc/bulk.ts + minimal files API hooks)

Context: design `docs/hub/2026082700-hub-node-architecture.md` §3 "DataChannel 消息尺寸与背压 / bulk 协议" and "已确认的取舍" (文件传输 row). Existing file API: `apps/gateway/src/api/files.ts` — read it fully first (upload = `init` → sequential HTTP PUT chunks (8 MiB) → `commit` (NDJSON); download = `prepare` (NDJSON) → HTTP stream; temp-file paths and cleanup). RTC layer: `sub/b3-1-result.md` (`RtcPeerManager` exposes the browser `PeerConnection` after `acceptBrowser`; `bulk:*` channels reuse it without re-authentication; `DataChannelLike` typings in `mesh/rtc/native.ts`; fragmenter; `Buffer.from` for sends).

## Protocol (implement exactly)

- Upload: browser did REST `init` (through the entry) → opens DataChannel `bulk:<transferId>` on the authorized PeerConnection → first message JSON `{op:'put', transferId, size}` → binary 64 KiB data frames (raw bytes, no fragment header — the channel carries whole 64 KiB messages; enforce `maxMessageSize`) → `{op:'done'}` → node verifies byte count and replies `{ok:true}` or `{ok:false, code}` → browser calls REST `commit`. Node writes to the **same temp-file path** the HTTP PUT path uses for that transfer so `commit` is unchanged.
- Download: browser did REST `prepare` → opens `bulk:<transferId>` → `{op:'get'}` → node streams 64 KiB frames honoring backpressure (`bufferedAmount` high-water 4 MiB / low 1 MiB) → `{op:'eof'}`.
- `{op:'abort'}` from either side or channel close → cleanup (same cleanup the HTTP path does on request abort); any failure → browser falls back to REST (v1: whole-transfer retry), so the node must leave state such that REST can restart from `init`/`prepare` cleanly.
- The channel belongs to the authenticated browser session of the PeerConnection; `transferId` must belong to that session's uid (files API must expose a lookup `getTransferOwner(transferId) → {uid, tempPath, expectedSize} | null` for uploads and `openDownload(transferId) → ReadableStream | null` for downloads — add those as minimal, well-typed exports in `files.ts` without changing existing HTTP behavior).

## Deliverables

- `apps/gateway/src/mesh/rtc/bulk.ts`: `BulkTransferService({files: FilesBulkHooks, now?})` with `attachChannel(dc: DataChannelLike, ctx: {uid})` (label parsing, state machine `idle → put|get → done|eof|aborted`, size accounting, backpressure, timeouts: 30 s without data → abort), tests with fake channels (happy upload, size mismatch, abort mid-way cleans temp, download backpressure pause/resume, wrong uid rejected, unknown transfer rejected, oversize message rejected).
- `apps/gateway/src/api/files.ts`: the two hooks + a `FilesBulkHooks` type; existing tests must stay green.
- Report the exact integration line for `RtcPeerManager` (`onDataChannel` label filter → `bulk.attachChannel`).

File scope: `apps/gateway/src/mesh/rtc/bulk.ts` (+test), `apps/gateway/src/api/files.ts` (+ its existing tests if signatures need adapting). Nothing else. Acceptance: `cd apps/gateway && bun test src/mesh/rtc src/api/files` green, tsc 0 in your files, biome clean. Result: `prompt-archives/2026082701-hub-multinode-design/sub/b3-2-result.md`.
