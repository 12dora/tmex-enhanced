# C5-2 结果

## 做了什么

`node-datachannel@0.33.1` 仅作为 `packages/app` **devDependency**（`bun add -d --cwd packages/app node-datachannel@0.33.1 --exact`），未进入 published runtime 依赖。JS 层 vendored + 改写 native `require` 为 `TMEX_NATIVE_DIR` 绝对路径；`.node` 按平台在 `tmex direct enable` 时从 npm registry 下载。

### 文件

| 路径 | 作用 |
|---|---|
| `packages/app/src/lib/native-manifest.ts` | pinned 表、libc 探测、sha512 integrity |
| `packages/app/src/lib/native-manifest.test.ts` | 平台/libc 查找 + integrity |
| `packages/app/src/lib/native-datachannel.ts` | 运行时 loader |
| `packages/app/src/lib/native-datachannel.test.ts` | 缺失/损坏 addon → `null` |
| `packages/app/src/lib/native-tarball.ts` | npm tarball pack/extract |
| `packages/app/src/lib/install-layout.ts` | `nativeDir = <installDir>/native` |
| `packages/app/src/lib/install-layout.test.ts` | nativeDir |
| `packages/app/src/commands/direct.ts` | `enableDirect` / `disableDirect` / CLI |
| `packages/app/src/commands/direct.test.ts` | 假 registry、integrity、disable、upgrade skip |
| `packages/app/src/vendor/node-datachannel/**` | MPL-2.0 JS 层（loader 已改写） |
| `packages/app/src/vendor/detect-libc/**` | Apache-2.0 LICENSE + NOTICE |
| `packages/app/scripts/vendor-node-datachannel.ts` | 从 pinned 包重生 vendor |
| `packages/app/scripts/poc/node-datachannel-loader.ts` | 回环 PoC（不随包发布） |
| `packages/app/scripts/build-runtime.ts` | `--external cpu-features`；校验 vendor JS 可 inline |
| `packages/app/package.json` / `bun.lock` | 仅 devDependency |

## PoC（B3-1 必须补的回环项）

`bun packages/app/scripts/poc/node-datachannel-loader.ts`：**POC_OK**（macOS arm64, Bun 1.3.14）

- JS 层可被 `Bun.build` 打成单文件；bundle **8860 B**；无 `detect-libc`、无 `require('@node-datachannel/…')`。
- 运行时 `TMEX_NATIVE_DIR` → `require(<dir>/node_datachannel.node)` 成功。
- 回环 DataChannel：`sendMessageBinary(Buffer.from(...))` 成功；`Uint8Array` 不要直接传（C++ `IsBuffer()`）。
- `remoteFingerprint()` → `{ value: "AA:BB:…", algorithm: "sha-256" }`（带冒号）。
- `localDescription().sdp` 的 `a=fingerprint` 可解析；`parseSdpFingerprint` 会去冒号并转大写，**比对前必须两边归一化**。
- `bufferedAmount()=0`（小包发完）、`maxMessageSize()=262144`（DC 与 Peer 相同）、`setBufferedAmountLowThreshold` / `onBufferedAmountLow` 可调用。
- `getLibraryVersion()` = `0.24.3`（libdatachannel，不是 npm `0.33.1`）。
- ICE：`{ iceServers: [], enableIceUdpMux: true }` **15s 超时**；`{ iceServers: ['stun:stun.l.google.com:19302'] }` **23ms** 通。空 candidate 不要 `addRemoteCandidate`。

## Manifest（v1，N-API 8，addon 路径 `package/node_datachannel.node`）

| platformId | npm | integrity (sha512) |
|---|---|---|
| `darwin-arm64` | `@node-datachannel/darwin-arm64@0.33.1` | `sha512-6reyGKzuYNzuJypm4KrpJVTpION39rZmLoqDNMiehTVuSZzV1yoYyLHCzJ9XNVpOViGdaUvAWXJTlHcoQOZtrw==` |
| `darwin-x64` | `@node-datachannel/darwin-x64@0.33.1` | `sha512-1zXH/E79bswwRfbUwilw9iPNCCI4GLul/xxsjx/H7jbPT9SeMgkHKcx7Emuw91NBeYYPvYSYwQ705h4FTVDxow==` |
| `linux-x64-gnu` | `@node-datachannel/linux-x64-gnu@0.33.1` | `sha512-0mTxq+0fYatoQ/7y9uMLDSRbnb0/Vrrl1Fhsuys8PfB06ft3IA8+6/qdFgRriHbCNkCkB3mSvWEIjCVjXuPr1A==` |
| `linux-arm64-gnu` | `@node-datachannel/linux-arm64-gnu@0.33.1` | `sha512-FriA+y9cKnr9shQaNz4AdqkaNb7yqBcj1U/OgAlLvJtY/mJLvRX7R3iic18aUA5BkMMK+wwqBI/0Al3brxdRAw==` |

tarball：`https://registry.npmjs.org/@node-datachannel/<id>/-/<id>-0.33.1.tgz`  
linux `musl` / win32 / 其他 arch → `lookupNativePin` 返回 `null`（unsupported）。linux libc 缺省按 gnu。

安装后写入 `<installDir>/native/manifest.json`：`{ platform, version, sha256, napiVersion }`（sha256 是 **addon 文件**，不是 tarball）。

## Loader / CLI API

```ts
loadNodeDatachannel({ nativeDir: string, log?: (msg: string) => void }): Promise<NodeDatachannelModule | null>
nativeAddonPath(nativeDir: string): string
nativeManifestPath(nativeDir: string): string
parseSdpFingerprint(sdp: string): { algorithm: string; value: string }
readInstalledNativeManifest(nativeDir: string): Promise<InstalledNativeManifest | null>

lookupNativePin({ platform, arch, libc }): NativePin | null
detectLibcFamily(deps?: LibcDetectDeps): 'gnu' | 'musl' | null
detectCurrentNativePin(input?): NativePin | null
verifyNpmIntegrity(data: Uint8Array, integrity: string): boolean

enableDirect(options: EnableDirectOptions): Promise<DirectEnableResult>  // 失败 { ok:false }，不抛
disableDirect({ installDir }): Promise<void>
reenableDirectIfNeeded(options): Promise<DirectEnableResult>            // 无 native 则 skip；version 不同才重下
shouldEnableDirectForRoles(roles: string | string[]): boolean           // 含 'node' 则为 true
runDirect(parsed: ParsedArgs, deps?: { pin?: NativePin }): Promise<void>
```

`NodeDatachannelModule`：`PeerConnection` / `cleanup` / `preload` / `initLogger` / `getLibraryVersion`。失败一律 `null` + log，供 `direct_capable=false`。

`createInstallLayout(installDir).nativeDir` = `<installDir>/native`。

## 尺寸

无法用 `git stash` 对比 main（`dist/` 不进 git）。本次 `bun scripts/build-runtime.ts`：

| 产物 | 字节 |
|---|---:|
| `dist/runtime/server.js` | 5,706,477（5.71 MB，当前 gateway 全量，**尚未**含 native JS） |
| vendored node-datachannel JS（单独 bundle 校验） | **11,383** |
| hash-wasm + `@noble/curves` + `@noble/hashes` 冒烟 bundle | **113,782**，`wasmEmbedded=true` |

设计预算 tarball 增量 **< 1 MB**：native JS 11 KB + argon2/noble ~114 KB ≪ 1 MB。native JS 要等 B3-1 import 后才会进 `server.js`。

`hash-wasm` / `@noble/*` 可从 `packages/shared` 解析并打进单文件。`@simplewebauthn/server` 当前不在 `server.ts` 图里；本次 boot **不需要** `reflect-metadata`。mesh auth 接入后若出现 `tsyringe requires a reflect polyfill`，在 `build-runtime.ts` 加 `--inject` `import 'reflect-metadata'`。

为让 runtime 能编过，`build-runtime.ts` 增加了 `--external cpu-features`（与 gateway 先例一致；optional native 本机不存在）。

## 启动验证

`NODE_ENV=test TMEX_ROLES=standalone GATEWAY_PORT=27117 TMEX_BIND_HOST=127.0.0.1`，`TMEX_FE_DIST_DIR` 指向临时空前端目录，`TMEX_MIGRATIONS_DIR=apps/gateway/drizzle`，**未**碰 9883 / 生产 install。

`GET /healthz` → **200** `{status:ok}`。`[env] 已加载 test.env`。

## 测试 / tsc

- C5-2 + 既有 `src/lib|runtime|i18n`：`130 pass  0 fail  Ran 130 tests across 19 files.`
- 仅 C5-2 新文件：`20 pass  0 fail  Ran 20 tests across 4 files.`
- 裸 `cd packages/app && bun test` 会捡到 **其他 agent** 的 `hub/join/enroll/mesh/assemble`（`decodeUplinkAuth` 缺失），与本任务无关。
- tsc：before **1** / after **1**（仍是 `Cannot find type definition file for 'node'`）。
- biome：上述源文件 clean；**未** lint vendor。

## 指挥官 / 其他 agent 必须接的钩子

**C5-1 `cli-node.ts`（本任务不能改）：**

```ts
case 'direct':
  await runDirect(parsed);
  return;
```

**C5-1 `init.ts`：** `init --role node|hub,node` 在部署完 runtime 后：

```ts
import { enableDirect, shouldEnableDirectForRoles } from './direct';
if (shouldEnableDirectForRoles(config.roles /* 或 'node' | 'hub,node' */)) {
  await enableDirect({ installDir: config.installDir }); // 已非致命
}
```

**C5-1 `upgrade.ts`：** 在 `deployRuntimeFiles` 之后：

```ts
import { reenableDirectIfNeeded } from './direct';
await reenableDirectIfNeeded({ installDir });
```

standalone 无 `native/` → skip，不下载。

**C5-1 `install.ts` `writeRunScript`（建议）：** `export TMEX_NATIVE_DIR=<installDir>/native`。loader 自己会 set env，没有也能工作，但便于诊断。

**B3-1 `RtcPeerManager`：**

```ts
import { loadNodeDatachannel, parseSdpFingerprint } from 'packages/app/src/lib/native-datachannel';
const mod = await loadNodeDatachannel({ nativeDir: installLayout.nativeDir /* 或 process.env.TMEX_NATIVE_DIR */ });
const directCapable = mod !== null;
// sendMessageBinary(Buffer.from(u8))
// 指纹比对前归一化 remoteFingerprint().value 与 parseSdpFingerprint(sdp).value
```

不要静态 `import '../vendor/node-datachannel'`（无 addon 时会抛）。不要把 `node-datachannel` 加进 runtime/gateway dependencies。

**i18n：** `direct.ts` 目前是英文 `console.log`（不能改 `packages/app/src/i18n`）。需要中文/help 文案时由 C5-1 或指挥官加 key。

**biome.json：** 可选 ignore `packages/app/src/vendor/**`。
