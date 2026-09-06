# N1 result — non-standard ports (shared helper, backend, CLI, docs)

Scope delivered: shared port-candidate module + probe, `POST /api/setup/precheck` port probing,
new `POST /api/mesh/relay/resolve` + api-client method, `GET /api/tls` builtin `publicUrl`,
CLI probing for `relay enroll` / `relay reauth` / `relay join --tenant` / `hub join`,
`tmex init` public-HTTPS-port question, and the deployment/relay/onboarding docs.
`apps/fe`, locale JSONs and `apps/gateway/src/portmap` were not touched.

## Final API shapes (as fixed in plan-02; N2 can rely on these)

### `POST /api/setup/precheck` → `SetupPrecheckResponse`
```ts
{
  reachable: boolean;
  isSelf: boolean;
  status: number | null;
  error: string | null;
  resolvedUrl: string | null;   // 探到的地址（含端口）；未探测或没探到为 null
  triedPorts: number[];         // 实际发起过探测的端口；未探测为 []
  probed: boolean;              // 只有 https 且地址没写端口时才是 true
}
```
- Probing runs only when the URL parses as `https:` **without** an explicit port
  (`http://127.0.0.1[:port]` and any explicit port keep the old single-`/healthz` behaviour, `probed:false`).
- When probing finds a port, `resolvedUrl` is the canonical address **with** the port and the
  `/healthz` confirmation (which fills `reachable` / `isSelf` / `status`) is run against it.
- When nothing answers: `reachable:false`, `status:null`, `resolvedUrl:null`, `probed:true`,
  `error = "no response on 443 or the built-in candidate ports (443, 2053, …)"`.
- The self-signed CA from `precheckCaPem` is applied to the probe requests too.

### `POST /api/mesh/relay/resolve` (node-session auth, same guard as the rest of `/api/mesh/relay/*`)
Request `{ url: string }` → 200:
```ts
{ url: string | null; port: number | null; explicit: boolean; triedPorts: number[] }
```
- `400 { code: 'INVALID_URL' }` for empty / non-string / non-https (loopback `http://` is allowed) /
  unparseable input — validated with `normalizeRelayUrl` **before** probing, and the returned `url`
  is re-normalised, so it is byte-identical to what `proof-material` / `enroll` will accept.
- Must be called **before** `POST /api/mesh/relay/enroll/proof-material` (the proof is signed over
  `hubHostFromUrl(url)`, which includes the port).
- Hairpin: on a `relay,node` machine, candidates whose **hostname** matches
  `TMEX_RELAY_PUBLIC_URL` are dialled through the loopback gateway
  (`relayProbeDialUrl`, a hostname-based widening of `resolveRelayDialUrl` — the existing
  helper compares host *including* port, which never matches a swept candidate port).
- Client: `RelayTenantApi.resolveRelayAddress(url): Promise<RelayResolveResult>`
  (`packages/api-client/src/relay/tenant-api.ts`, exported through `packages/api-client/src/index.ts`'s
  existing `export *`).

### `GET /api/tls` → `https` section
`resolveEffectiveHttps` now returns a `publicUrl` for the built-in listener:
`{ source: 'builtin', verified: true, publicUrl: 'https://<domain>[:port]' | null }`.
Domain resolution order: ACME domain (when `mode === 'acme'`) → first certificate SAN that is a real
DNS name (has a dot, not `*`, not an IP, not `*.localhost`) → hostname of the configured public URL →
`null`. Port is `listener.port ?? tlsPort`; `443` is omitted, anything else is explicit.
`reverse-proxy` / `none` branches are unchanged.

## Shared module

`packages/shared/src/net/port-candidates.ts`, re-exported from `@tmex/shared/net` (browser-safe,
no `node:*`, injectable `fetchImpl`).

```ts
SUGGESTED_HIGH_PORTS = [2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443]
PROBE_DEFAULT_TIMEOUT_MS = 4000, PROBE_DEFAULT_GRACE_MS = 800, PROBE_DEFAULT_STAGGER_MS = 150
parseProbeTarget(hostOrUrl): { base, protocol, explicitPort, port }
candidateUrls(hostOrUrl, ports?): string[]
probeAddressPorts(hostOrUrl, options): Promise<PortProbeResult>
pickSuggestedPort(rng?) / pickSuggestedPortAvoiding(used, rng?)
isLoopbackHostname(hostname)
```

Probe semantics: explicit port ⇒ a single confirmation, never silently changed (an explicit `:443`
is detected from the raw authority, since `URL` drops the default port); no port ⇒ 443 first with an
800 ms grace window, then the 8 candidates staggered 150 ms, 443 still racing and still able to win;
first healthy answer wins and every loser is aborted; `redirect: 'error'`, per-attempt
`AbortSignal.timeout`; relay ⇒ `GET /api/relay/health` with `ok === true`, hub ⇒ `GET /healthz` with
`status === 'ok'`; loopback and non-https targets have exactly one candidate.

**Deviation from plan-02's signature:** `probeAddressPorts` resolves to a `PortProbeResult` object
whose `url`/`port` are `null` when nothing answers, instead of resolving to `null`. Required because
both the new endpoint and `precheck` must report `triedPorts` on failure. `candidateUrls` /
`parseProbeTarget` / the option names are as planned; an extra `resolveDialUrl?: (url) => string`
option was added for the gateway's hairpin rewrite.

**Concurrency note:** N2 twice overwrote this file (untracked at the time) with their own version.
The current file is N2's reconstruction from my `port-candidates.test.ts`; I reviewed it line by
line against the intended semantics above (443-first + grace, stagger, late-443 win, explicit port
never changed, `redirect:'error'`, per-attempt timeout, loser abort, `triedPorts` = ports actually
attempted, `resolveDialUrl`) and it matches. Their narrowed
`pickSuggestedPort(Avoiding): (typeof SUGGESTED_HIGH_PORTS)[number]` return type was kept.
One cosmetic difference from my original: single-candidate detection keys off *loopback* rather than
*non-https*; unreachable in practice because every caller validates the URL first.

## CLI

New `packages/app/src/lib/probe-address.ts` (`probeAddressForCli`, `requireProbedAddress`,
`probeNotFoundMessage`, `CLI_PROBE_TIMEOUT_MS`) and
`packages/app/src/commands/hub-join-probe.ts` (`probeHubJoinUrl`, `HUB_CA_FETCH_TIMEOUT_MS`).

- `tmex relay enroll|reauth <url>`, `tmex relay join <url> --tenant …`, `tmex hub join <url>`:
  when the address has no port, probe first. Success prints
  `已在 13443 端口探测到中继，使用 https://relay.example.com:13443` /
  `relay found on port 13443; using …` (`port.probe.foundRelay` / `foundHub`, both languages in
  `packages/app/src/i18n/index.ts`); before that, `port.probe.searching`
  (`地址未写端口，正在探测 443 及内置候选端口……`).
  Nothing answering aborts with `port.probe.notFound`
  (`443 及内置候选端口（443, 2053, …）均无响应，请放行端口或直接填写带端口的地址`); the relay
  password-join path maps it to `RelayPasswordJoinError('relay_unreachable', …)`.
- Skipped for explicit ports, loopback hosts, `http://`, and `hub join --insecure-local`.
  The `r3.` join-token path (`hub join --token r3.…` → `runRelayJoin`) is deliberately **not**
  probed: the token carries the authoritative URLs and `orderRelayEntries` requires a byte match.
- Probe requests use `tls: { rejectUnauthorized: false }` — they carry no credentials and only pick a
  port, so a self-signed relay/hub on a high port is still discoverable; the real request that
  follows performs full verification (or CA pinning).
- `fetchPinnedHubCa` now has the missing timeout (`AbortSignal.timeout(HUB_CA_FETCH_TIMEOUT_MS)`,
  15 s, matching `relay-ca.ts`).
- Dead `--url` read in `tmex relay join` deleted (the flag was never in the `relay.join` allowlist,
  so `assertKnownFlags` rejected it before it could be read).

### `tmex init`
- New question before the public-URL prompt:
  `公网 HTTPS 端口（443 为标准端口，{{suggested}} 为建议的高位端口）` /
  `Public HTTPS port (443 = standard, {{suggested}} = suggested when the ISP blocks 443)`
  (`init.prompt.publicPort`), default `443`; the suggestion comes from
  `pickSuggestedPortAvoiding([gatewayPort, peerPort, DEFAULT_TLS_PORT])`. Asked only for
  `hub,node` / `relay` / `relay,node`. Implemented as a text prompt (the CLI has no choice widget) —
  typing any port is the "custom" branch.
- The chosen port is applied with `applyPublicPort(raw, port)`: an address that already has an
  explicit port wins; otherwise the port is appended before validation. `443` is a no-op.
- Non-interactive flag `--public-port <n>` (added to the `init` allowlist in `lib/args.ts` and to
  both `cli/help.ts` usage lines); it only takes effect when `--hub-public-url` /
  `--relay-public-url` has no port of its own.
- `resolveHubPublicUrl` now validates through the new `normalizeHubPublicUrl` (https, `http` only
  for loopback, canonicalised) with the same 3-attempt retry loop as the relay path — previously it
  accepted anything, including an empty or `ftp://` string.

## Files

New: `packages/shared/src/net/port-candidates.ts` (+ `.test.ts`),
`packages/app/src/lib/probe-address.ts` (+ `.test.ts`),
`packages/app/src/commands/hub-join-probe.ts`,
`apps/gateway/src/mesh/relay-resolve-route.ts` (+ `.test.ts`),
`docs/deployment/2026090605-nonstandard-ports.md`.

Edited: `packages/shared/src/net/index.ts`; `packages/app/src/runtime/setup-service.ts`,
`runtime/tls-routes.ts`, `commands/relay.ts`, `commands/hub.ts`, `commands/init.ts`,
`commands/relay-password-join.ts`, `lib/relay-password-join.ts`, `lib/args.ts`, `cli/help.ts`,
`i18n/index.ts`; `packages/api-client/src/local/types.ts`, `src/relay/tenant-api.ts`;
`apps/gateway/src/mesh/relay-routes.ts` (one route-table line + one import);
`docs/relay/2026090304-relay-role.md` (§1 env-var pointer paragraph),
`docs/onboarding/2026083101-connect-devices-panel.md` (new 非标端口 section).
Tests updated: `setup-service.test.ts`, `setup-routes.test.ts`, `tls-routes.test.ts`,
`commands/relay.test.ts`, `commands/init.test.ts`, `commands/relay-password-join.test.ts`,
`lib/hub-password-self-admit.test.ts`, `api-client/src/local/setup-api.test.ts`,
`gateway/src/mesh/relay-routes.test.ts`.

`scripts/complexity/allowlist.json` is **unchanged**: the hub-join probing and the CA timeout
constant went into `commands/hub-join-probe.ts`, leaving `commands/hub.ts` at 1297 lines
(cap 1298, baseline 1294).

## Gates

- `bunx tsc --noEmit`: 0 errors in `packages/shared`, `packages/api-client`, `packages/app`,
  `apps/gateway` (and `apps/fe` was clean too when checked, informational).
- `bun test`: `packages/shared` 826 pass / 0 fail (baseline 799 + 27 new);
  `packages/api-client` 282 / 0; `packages/app` 969 / 0 (baseline 949; +20 new);
  `apps/gateway` 5072 pass / 10 fail — exactly the known baseline (9 "mesh phase-2 integration"
  + 1 flaky DataChannel 8 MiB), with 10 new passing tests
  (`relay-resolve-route.test.ts` 9, `relay-routes.test.ts` +1).
  Two intermediate full runs showed extra relay-integration failures; they were load flakes
  (`posix_spawn failed: EAGAIN` while several agents ran suites at once) and did not reproduce
  in isolation. `apps/gateway/src/relay/integration/relay-mesh-harness.ts` was still hardened:
  its in-process fetch/ws interception now matches the relay by **hostname** instead of host, so a
  port probe's candidate ports (`relay.example:2053`, …) can never escape to the real network.
- `bunx biome check` clean on every touched file.
- `bun scripts/complexity/gate.ts`: ok (1807 files, 15755 functions), no allowlist change.

## Notes for the commander

0. `apps/gateway/src/relay/integration/relay-mesh-harness.ts` was touched (hostname-based
   interception, see above) — it is a test harness, not product code.
1. Existing test fixtures that fake a hub/relay now need a `/healthz` or `/api/relay/health` branch
   when the address under test has no port; three fixtures were updated
   (`hub-password-self-admit.test.ts`, `relay-password-join.test.ts`, `relay.test.ts`'s
   `fakeGateway` origin match). Any new CLI test using a portless URL needs the same.
2. The web "加入已有 Hub" form has no probe of its own — it must submit the `resolvedUrl` returned by
   `precheck` (N2's side). `POST /api/setup/join` does **not** probe internally, by design:
   probing there would happen after the user already confirmed an address.
3. `POST /api/setup/relay-join` (web password join) **does** probe internally, because it goes
   through `performRelayPasswordJoin`.
4. Out of scope and still open from EX4 §8: portmap reserved ports should include `tls_port`, and
   `GET /api/system/addresses` should surface the HTTPS port for the mobile QR candidate.
5. The doc names 1.1.37 as the first version carrying this; adjust if the release number moves.
