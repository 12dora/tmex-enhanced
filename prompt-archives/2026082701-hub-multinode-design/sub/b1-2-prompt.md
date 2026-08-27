# Task B1-2 — link codec, flow control, LinkSession implementations (packages/shared/src/link/)

## Context

tmex is adding a hub/node mesh. All node↔hub ("uplink"), node↔node ("peer link") and hub-relayed connections share one multiplexed framing layer. You are building that layer as a new, self-contained module `packages/shared/src/link/` (Bun + browser compatible except where noted). Read `docs/hub/2026082700-hub-node-architecture.md` §3 (sections "帧格式", "流类型" — only the closing semantics matter to you, not the payload schemas — and the `SecureChannelLink` description) and §2 "链路身份与握手" step 3 (key derivation is given to you below; you do NOT implement the handshake/signature part, only the encrypted framing given already-derived keys).

Library facts (verified, from `sub/e0-4-result.md`): `@noble/hashes@2.3.0` and `@noble/curves@2.3.0` are installed in `packages/shared` and are ESM-only — import ONLY via `.js` subpaths, e.g. `import { hkdf } from '@noble/hashes/hkdf.js'`, `import { sha256 } from '@noble/hashes/sha2.js'`, `import { x25519 } from '@noble/curves/ed25519.js'`. AES-256-GCM: use WebCrypto `crypto.subtle` (available in Bun 1.3 and browsers; output is `ciphertext‖tag`, tag 16 bytes, 12-byte IV, `additionalData` supported). `@noble/ciphers` is NOT installed; if you find WebCrypto insufficient say so in the report rather than adding deps.

## Spec

Frame: `[streamId u32 LE][op u8][flags u8][len u32 LE][payload]`, op ∈ `OPEN=1 / DATA=2 / END=3 / RST=4 / WINDOW=5`. Stream 0 is the fixed `ctl` stream (always open, bidirectional, never END/RST; only DATA). Initiator side opens odd stream ids, acceptor side even ids. Per-stream initial receive window 1 MiB; receiver sends `WINDOW{delta u32}` (payload) after consuming; single frame payload cap 1 MiB (oversize → protocol error → link close); per-link total unacknowledged outbound buffer cap 32 MiB (exceed → link close with error). `flags` bit 0 = `head` (used by `http` streams on the first response DATA; the link layer just carries it). `END` half-closes the sender's direction only; both directions END → stream finished. `RST` (payload: optional UTF-8 reason) terminates both directions immediately. OPEN payload is opaque bytes (upper layer's concern). Receiving DATA on an unknown/closed stream → send RST for that id, ignore.

API (design it cleanly, this is the contract Phase 2 builds on):

```ts
interface LinkStream {
  readonly id: number;
  readonly openPayload: Uint8Array;
  readonly readable: ReadableStream<{ bytes: Uint8Array; head: boolean }>;   // or an equivalent pull/callback API — pick one, document it
  write(bytes: Uint8Array, opts?: { head?: boolean }): Promise<void>;         // resolves when accepted into the window; rejects on RST/close
  end(): void;            // half-close our send direction
  reset(reason?: string): void;
  readonly closed: Promise<{ reason: 'end' | 'rst' | 'link-closed'; message?: string }>;
  onAbort(cb): void;      // fired on RST from peer / link close (Phase 2 maps this to Request.signal)
}
interface LinkSession {
  openStream(openPayload: Uint8Array): Promise<LinkStream>;
  onStream(cb: (stream: LinkStream) => void): void;
  readonly ctl: { send(bytes: Uint8Array): void; onMessage(cb: (bytes: Uint8Array) => void): void };
  close(reason?: string): void;
  readonly closed: Promise<{ reason: string }>;
}
```

Implementations:

1. `codec.ts` — frame encode/decode with an incremental decoder (handles partial and coalesced input; all transports may split frames arbitrarily).
2. `mux.ts` — `LinkMux`: the stream state machine + window flow control over an abstract byte transport `{ send(bytes): void|Promise<void>; onData(cb); onClose(cb); close() }`. Both `LinkSession` sides are `LinkMux` instances with `role: 'initiator' | 'acceptor'`.
3. `in-memory-link.ts` — `createInMemoryLinkPair(): [LinkSession, LinkSession]` (direct in-process pipe, used for hub+node in one process and for tests).
4. `websocket-link.ts` — `WebSocketLink` over a `WebSocket`-like object (client side: standard `WebSocket` with `binaryType='arraybuffer'`, works in Bun; server side: accept an adapter interface `{ send(bytes): number|void; close(); onmessage/onclose hooks }` so the gateway can wrap a Bun `ServerWebSocket` without this package importing Bun types). Keep it Bun/browser neutral (no `bun` or `node:` imports).
5. `secure-channel-link.ts` — `SecureChannelLink`: wraps an inner byte transport (a relay stream) with per-direction AES-256-GCM. Constructor takes already-derived `{ sendKey, recvKey }` (32 bytes each) and `direction` constants; nonce = 32-bit direction constant (LE) ‖ 64-bit counter (LE); AAD = the 10-byte frame header of the plaintext frame; wire format per frame: header (plaintext, 10 bytes) ‖ ciphertext ‖ tag, with `len` in the header = ciphertext length + 16. Counter near 2^63 → emit a `rekeyNeeded` event and refuse further sends (the handshake layer will renegotiate). Also export `deriveSecureChannelKeys(sharedSecret, transcriptHash, senderNodeId, receiverNodeId)` implementing `k = HKDF-SHA-256(ss, salt = transcriptHash, info = "tmex-sc/v1/" ‖ sender ‖ "->" ‖ receiver, 32)` and `x25519SharedSecret(sk, pk)` via noble, so Phase 2 has a single place for the key schedule.
6. `index.ts` — barrel. Do NOT add it to `packages/shared/src/index.ts` (the browser main entry); instead add a package.json `exports` entry `"./link": "./src/link/index.ts"`.

## Tests (bun test, in `packages/shared/src/link/*.test.ts`)

Codec round-trip and partial-input reassembly; stream id parity; window accounting (writer blocks at 1 MiB until WINDOW arrives, resumes); oversize frame → link error; 32 MiB link cap → link close; half-close in each direction; RST propagates to `onAbort` and rejects pending writes; unknown stream DATA → RST; ctl stream never closes; `InMemoryLink` end-to-end with concurrent streams; `WebSocketLink` using a fake WebSocket pair; `SecureChannelLink`: encrypt/decrypt round-trip, nonce uniqueness across frames, tampering with ciphertext/AAD fails, two directions have distinct keys, `deriveSecureChannelKeys` fixed test vector (compute it once with your implementation, hard-code it, and document inputs — the coordinator will cross-check with the auth module).

## Your file scope

`packages/shared/src/link/**` (new) and the `exports` field of `packages/shared/package.json`. Nothing else in `packages/shared` (another agent is creating `packages/shared/src/auth/` concurrently — do not touch it). Nothing outside `packages/shared`.

## Acceptance

`cd packages/shared && bun test` all green (141 existing + yours); `bunx tsc --noEmit -p packages/shared` → 0 errors; biome clean on your files.

## Result file

`prompt-archives/2026082701-hub-multinode-design/sub/b1-2-result.md`
