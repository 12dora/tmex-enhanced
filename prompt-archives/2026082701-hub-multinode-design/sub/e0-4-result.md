# E0-4 依赖 API 研究报告

研究基线：

- Bun：`1.3.14`
- 未向仓库安装任何依赖，仓库文件未修改。
- `hash-wasm`、Noble、SimpleWebAuthn 未在仓库中可直接运行；主要通过上游源码、包清单和本地 Bun cache 核对。
- 现有仓库状态与开始时一致，仅有预先存在的未跟踪目录 `prompt-archives/2026082701-hub-multinode-design/sub/`。

## 结论摘要

| 组件 | 结论 |
|---|---|
| `hash-wasm` | API 与架构设计匹配；WASM 以 base64 嵌入 JS。未能直接运行包本身 |
| `@noble/curves` / `@noble/hashes` 2.x | API 清晰，ESM-only，必须使用 `.js` 子路径；适合浏览器/Bun |
| SimpleWebAuthn 13.x | 浏览器端可直接使用；服务器端源码采用 WebCrypto，但 Bun 单文件构建存在 `reflect-metadata` 风险 |
| `node-datachannel` 0.33.1 | PoC 使用的主要 API 仍然有效，但现有 `Uint8Array` 发送与 C++ `IsBuffer()` 检查存在不一致 |
| 仓库 Borsh/Zorsh | 可以直接复用于独立签名对象，不依赖 WS envelope |
| Bun WebCrypto | Bun 1.3.14 已实测 AES-GCM 与 HKDF；现代浏览器同样支持 |

## 1. `hash-wasm` 4.x

核对来源：

- [4.12.0 package.json](https://raw.githubusercontent.com/Daninet/hash-wasm/master/package.json)
- [lib/argon2.ts](https://raw.githubusercontent.com/Daninet/hash-wasm/master/lib/argon2.ts)
- [lib/WASMInterface.ts](https://raw.githubusercontent.com/Daninet/hash-wasm/master/lib/WASMInterface.ts)
- [rollup.config.mjs](https://raw.githubusercontent.com/Daninet/hash-wasm/master/rollup.config.mjs)

### 已验证 API

实际签名：

```ts
argon2id<T extends IArgon2Options>(
  options: T
): Promise<Uint8Array | string>
```

选项：

```ts
{
  password: string | Buffer | Uint8Array | Uint16Array | Uint32Array;
  salt: string | Buffer | Uint8Array | Uint16Array | Uint32Array;
  secret?: string | Buffer | Uint8Array | Uint16Array | Uint32Array;
  iterations: number;
  parallelism: number;
  memorySize: number; // KiB，1024 字节
  hashLength: number; // 字节
  outputType?: 'hex' | 'binary' | 'encoded';
}
```

行为：

- `memorySize` 单位是 KiB，`65536` 即 64 MiB。
- `outputType: 'binary'` 返回 `Uint8Array`。
- `outputType: 'hex'` 返回十六进制字符串。
- `outputType: 'encoded'` 返回 PHC 格式字符串。
- 不指定 `outputType` 时默认为 `'hex'`。
- Argon2 版本固定为 `0x13`，即 Argon2 v1.3，编码格式为 `v=19`。
- `salt` 最少 8 字节。
- `hashLength` 最少 4 字节。
- `memorySize` 至少为 `8 * parallelism`。

推荐调用：

```ts
import { argon2id } from 'hash-wasm';

const digest = await argon2id({
  password: new TextEncoder().encode('tmex-test'),
  salt: new Uint8Array(16).fill(1),
  parallelism: 1,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
  outputType: 'binary',
});
```

### WASM 是否嵌入 JS

是。

源码通过：

```ts
import wasmJson from '../wasm/argon2.wasm.json';
```

然后在运行时：

```ts
const asm = decodeBase64(binary.data);
const module = await WebAssembly.compile(asm);
wasmInstance = await WebAssembly.instantiate(module, {});
```

Rollup 配置使用 JSON 插件，将 `argon2.wasm.json` 编译进：

- `dist/index.esm.js`
- `dist/index.umd.js`

因此使用已发布的 ESM/CJS/UMD 构建时，不需要额外处理 `.wasm` 文件路径，也不需要运行时读取资产文件。Vite 和 Bun 单文件构建都可以把 base64 字符串打包进去。

如果直接导入 `lib/argon2.ts` 源文件，则仍然需要 bundler 支持 JSON 导入。

### ESM/CJS 入口

`package.json`：

```json
{
  "main": "dist/index.umd.js",
  "module": "dist/index.esm.js"
}
```

该包没有显式 `exports` 字段：

- Vite 等 bundler 通常使用 `module`。
- CommonJS 使用 `main`。
- Bun 单文件构建应优先确认最终使用的是已打包的 ESM 文件。

### Bun 兼容性

源码只使用：

- `WebAssembly.compile`
- `WebAssembly.instantiate`
- `Uint8Array`
- `DataView`
- `Promise`

这些都是 Bun 支持的标准 API。没有发现 `fs`、动态 `.wasm` 文件加载或 Node 专用运行时路径。

但本次没有直接安装并运行 `hash-wasm`，原因是 registry DNS 不可用。因此“源码兼容”已验证，“hash-wasm 包在 Bun 1.3.14 中实际运行”尚未验证。

### Argon2 向量

使用 Bun `1.3.14` 和本地可用的独立 Argon2id v1.3 实现，参数完全相同：

```text
password = "tmex-test"
salt = 16 × 0x01
m = 65536 KiB
t = 3
p = 1
len = 32
```

输出：

```text
c309e52473a3209eb21f065c873725f397a79dc8de84d30b078f95c2a3ae8c85
```

这是独立实现的 Bun 向量，不应标记为“已直接由 hash-wasm 产生”；应在正式依赖加入后补充一次 `hash-wasm` 对照测试。

### Gotchas

- `validateOptions()` 会就地改写 `password`、`salt`、`secret` 和默认 `outputType`，不要复用冻结对象。
- 规范编码场景应传 `Uint8Array`，避免字符串编码差异。
- 建议使用 `outputType: 'binary'` 后再进行 Ed25519 公钥派生或签名。

## 2. `@noble/curves` 2.x 与 `@noble/hashes` 2.x

核对来源：

- [@noble/curves 2.3.0 package.json](https://raw.githubusercontent.com/paulmillr/noble-curves/main/package.json)
- [ed25519.ts](https://raw.githubusercontent.com/paulmillr/noble-curves/main/src/ed25519.ts)
- [edwards.ts](https://raw.githubusercontent.com/paulmillr/noble-curves/main/src/abstract/edwards.ts)
- [montgomery.ts](https://raw.githubusercontent.com/paulmillr/noble-curves/main/src/abstract/montgomery.ts)
- [@noble/hashes hkdf.ts](https://raw.githubusercontent.com/paulmillr/noble-hashes/main/src/hkdf.ts)
- [@noble/hashes README](https://raw.githubusercontent.com/paulmillr/noble-hashes/main/README.md)

NPM 当前观察到的发布版本：

- `@noble/curves`: `2.3.0`
- `@noble/hashes`: `2.3.0`

当前 `noble-hashes` GitHub 主分支 package.json 已显示 `2.4.0`，但该版本不应在未确认 NPM 发布前使用。

### 2.x 导入路径

```ts
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
```

2.x 是 ESM-only，必须使用 `.js` 后缀：

```ts
// 旧版 1.x
import { ed25519 } from '@noble/curves/ed25519';

// 2.x
import { ed25519 } from '@noble/curves/ed25519.js';
```

不要使用：

```ts
import * from '@noble/curves';
import * from '@noble/hashes';
```

官方 README 明确建议使用子路径导入。

### Ed25519

```ts
const seed = new Uint8Array(32);

const publicKey = ed25519.getPublicKey(seed);
const signature = ed25519.sign(message, seed);
const valid = ed25519.verify(signature, message, publicKey);
```

类型与长度：

- 输入均为 `Uint8Array`。
- Ed25519 seed：32 字节。
- 公钥：32 字节。
- 签名：64 字节。
- `verify()` 返回 `boolean`。
- `sign()` 和 `getPublicKey()` 返回 `Uint8Array`。

32 字节 seed 可以直接作为 `secretKey` 传给 Noble 的 `getPublicKey()` 和 `sign()`。但它的语义是 Ed25519 seed，不是已经展开并裁剪后的私钥标量。Noble 会在内部执行 SHA-512 和 scalar clamping。

### X25519

```ts
const self = x25519.keygen();
const peer = x25519.keygen();

const sharedSecret = x25519.getSharedSecret(
  self.secretKey,
  peer.publicKey,
);
```

类型与长度：

- 私钥：32 字节 `Uint8Array`。
- 公钥：32 字节 `Uint8Array`。
- shared secret：32 字节 `Uint8Array`。

源码明确说明：`getSharedSecret()` 默认拒绝低阶点输入，而不是返回全零 shared secret。这与 E0-4 的安全要求一致。

### HKDF 与 SHA-256

```ts
const transcriptHash = sha256(transcript);

const key = hkdf(
  sha256,
  sharedSecret,
  salt,
  info,
  32,
);
```

精确签名：

```ts
hkdf(
  hash,
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array
```

SHA-256：

```ts
const digest: Uint8Array = sha256(message);
```

需要字符串时，先用 `TextEncoder` 或：

```ts
import { utf8ToBytes } from '@noble/hashes/utils.js';
```

### 浏览器与 Bun

- 2.x package 使用 ESM 和标准 `Uint8Array`、`BigInt`。
- `@noble/curves` package 自带 `test:bun` 脚本。
- `@noble/hashes` README 声明支持主要运行时。
- 没有发现 Node-only 加载逻辑。
- 本次没有实际安装 Noble 2.x 并在 Bun 1.3.14 执行；项目当前本地仍是 Noble 1.x。

### Gotchas

- 必须固定并记录 enum、Borsh schema 和 HKDF `info` 的字节表示。
- `@noble/curves` 的 Ed25519 默认验证包含 ZIP-215 语义；如协议要求 RFC 8032 严格行为，需要传 `{ zip215: false }`。
- 不要把 Ed25519 seed 与 X25519 scalar 混用；如果确实需要转换，应使用 `ed25519.utils.toMontgomerySecret()`。

## 3. SimpleWebAuthn 13.x

核对来源：

- [generateRegistrationOptions.ts](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/registration/generateRegistrationOptions.ts)
- [verifyRegistrationResponse.ts](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/registration/verifyRegistrationResponse.ts)
- [generateAuthenticationOptions.ts](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/authentication/generateAuthenticationOptions.ts)
- [verifyAuthenticationResponse.ts](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/authentication/verifyAuthenticationResponse.ts)
- [startRegistration.ts](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/browser/src/methods/startRegistration.ts)
- [startAuthentication.ts](https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/browser/src/methods/startAuthentication.ts)
- [server 13.3.2 package.json](https://app.unpkg.com/@simplewebauthn/server@13.3.2/files/package.json)
- [browser NPM 页面](https://www.npmjs.com/package/%40simplewebauthn/browser)

本报告按 server `13.3.2` 包清单和当前上游源码核对。NPM 页面目前显示 server 已有 `13.3.3`，正式接入时应锁定具体版本。

### 注册选项

```ts
const options = await generateRegistrationOptions({
  rpName: 'tmex',
  rpID: 'entry.example.com',
  userName: uid,
  userID: uidBytes,
  challenge: challengeBytes,
  attestationType: 'none',
  excludeCredentials: [],
});
```

接受的关键字段：

- `rpName: string`
- `rpID: string`
- `userName: string`
- `userID?: Uint8Array`
- `challenge?: string | Uint8Array`
- `userDisplayName?: string`
- `timeout?: number`
- `attestationType?: 'direct' | 'enterprise' | 'none'`
- `excludeCredentials?`
- `authenticatorSelection?`
- `extensions?`
- `supportedAlgorithmIDs?`

默认值：

- challenge：随机生成
- timeout：`60000`
- attestation：`none`
- user verification：`preferred`
- 默认算法：`[-8, -7, -257]`
- 自动加入 `extensions.credProps = true`

字符串 challenge 会先按 UTF-8 编码，然后输出为 base64url。

### 注册验证

```ts
const result = await verifyRegistrationResponse({
  response: registrationResponse,
  expectedChallenge: options.challenge,
  expectedOrigin: 'https://entry.example.com',
  expectedRPID: 'entry.example.com',
});
```

参数：

```ts
{
  response: RegistrationResponseJSON;
  expectedChallenge:
    | string
    | ((challenge: string) => boolean | Promise<boolean>);
  expectedOrigin: string | string[];
  expectedRPID?: string | string[];
  expectedType?: string | string[];
  requireUserPresence?: boolean;
  requireUserVerification?: boolean;
  supportedAlgorithmIDs?: COSEAlgorithmIdentifier[];
}
```

返回：

```ts
{
  verified: true,
  registrationInfo: {
    fmt: string,
    aaguid: string,
    credentialType: 'public-key',
    credential: {
      id: string,
      publicKey: Uint8Array,
      counter: number,
      transports?: AuthenticatorTransportFuture[],
    },
    attestationObject: Uint8Array,
    userVerified: boolean,
    credentialDeviceType: 'singleDevice' | 'multiDevice',
    credentialBackedUp: boolean,
    origin: string,
    rpID?: string,
    authenticatorExtensionResults?: unknown,
  }
}
```

重要结论：

- `credential.publicKey` 是 COSE_Key 的 CBOR 编码字节，类型是 `Uint8Array`。
- 不是 PEM、DER、JWK 或 WebCrypto `CryptoKey`。
- `counter` 必须持久化，认证后用 `newCounter` 更新。
- `transports` 位于 `response.response.transports`，应持久化到 credential。
- `credentialDeviceType` 与 `credentialBackedUp` 是单独的返回字段，不属于传入的最小 `WebAuthnCredential` 结构。

### 认证选项

```ts
const options = await generateAuthenticationOptions({
  rpID: 'entry.example.com',
  challenge: challengeBytes,
  allowCredentials: [
    {
      id: credential.id,
      transports: credential.transports,
    },
  ],
});
```

参数：

```ts
{
  rpID: string;
  allowCredentials?: {
    id: string;
    transports?: AuthenticatorTransportFuture[];
  }[];
  challenge?: string | Uint8Array;
  timeout?: number;
  userVerification?: 'required' | 'preferred' | 'discouraged';
  extensions?: AuthenticationExtensionsClientInputs;
}
```

默认：

- timeout：`60000`
- user verification：`preferred`
- 未提供 challenge 时自动生成随机 challenge。

### 认证验证

```ts
const result = await verifyAuthenticationResponse({
  response: authenticationResponse,
  expectedChallenge: options.challenge,
  expectedOrigin: 'https://entry.example.com',
  expectedRPID: 'entry.example.com',
  credential,
});
```

参数：

```ts
{
  response: AuthenticationResponseJSON;
  expectedChallenge:
    | string
    | ((challenge: string) => boolean | Promise<boolean>);
  expectedOrigin: string | string[];
  expectedRPID: string | string[];
  credential: WebAuthnCredential;
  expectedType?: string | string[];
  requireUserVerification?: boolean;
  advancedFIDOConfig?: {
    userVerification?: UserVerificationRequirement;
  };
}
```

返回：

```ts
{
  verified: boolean,
  authenticationInfo: {
    credentialID: string,
    newCounter: number,
    userVerified: boolean,
    credentialDeviceType: 'singleDevice' | 'multiDevice',
    credentialBackedUp: boolean,
    origin: string,
    rpID: string,
    authenticatorExtensionResults?: unknown,
  }
}
```

认证验证会检查：

- credential ID 与 `rawId`
- `webauthn.get`
- challenge
- origin
- RP ID hash
- user presence
- user verification
- counter 单调递增
- 签名

### 浏览器端调用形状

注册：

```ts
const response = await startRegistration({
  optionsJSON: registrationOptions,
});
```

认证：

```ts
const response = await startAuthentication({
  optionsJSON: authenticationOptions,
});
```

`startRegistration()` 返回 `RegistrationResponseJSON`，其中：

```ts
response.response.transports
```

由浏览器的 `getTransports()` 转换得到。

`startAuthentication()` 返回：

```ts
{
  id,
  rawId,
  response: {
    authenticatorData,
    clientDataJSON,
    signature,
    userHandle?,
  },
  type: 'public-key',
  clientExtensionResults,
  authenticatorAttachment?,
}
```

v13 仍兼容旧的 positional 调用，但会输出警告；新代码应统一使用 `{ optionsJSON }`。

### 自定义 challenge

生成函数支持：

```ts
challenge: Uint8Array
```

或 UTF-8 字符串：

```ts
challenge: 'custom challenge'
```

验证时应保存并传入生成结果中的 base64url challenge：

```ts
expectedChallenge: registrationOptions.challenge
```

不要直接把原始字符串传给 `expectedChallenge`，因为浏览器回传的 `clientDataJSON.challenge` 是 base64url 字符串。

也可以使用回调进行一次性消费：

```ts
expectedChallenge: async (challenge) => {
  return await consumeStoredChallenge(challenge);
}
```

### RP ID 与 origin

根据 [WebAuthn Level 3 规范](https://www.w3.org/TR/webauthn-3/)：

- RP ID 只包含域名，不包含 scheme 和 port。
- `https://login.example.com` 可使用：
  - `login.example.com`
  - `example.com`
- 不能使用：
  - `m.login.example.com`
  - `com`
- 浏览器 WebAuthn 通常要求 HTTPS；`http://localhost` 是例外。
- `expectedOrigin` 是完整 origin，例如 `https://entry.example.com`，需要精确匹配 scheme、host 和 port。
- `expectedRPID` 是域名，不是完整 URL。

### Bun 兼容性

SimpleWebAuthn 的 `iso` helper 注释明确将 Bun 列为目标运行时。server 使用 WebCrypto、Uint8Array 和 CBOR 等 Web API。

但是，server 13.3.2 的实际依赖包括：

```text
@hexagon/base64
@levischuck/tiny-cbor
@peculiar/asn1-android
@peculiar/asn1-ecc
@peculiar/asn1-rsa
@peculiar/asn1-schema
@peculiar/asn1-x509
@peculiar/x509
```

不是旧版的 `cbor`，但 `@peculiar/x509` 的依赖链会包含 `tsyringe` 和 `reflect-metadata`。

上游已有 [Bun 单文件构建问题报告](https://github.com/MasterKale/SimpleWebAuthn/discussions/744)：SimpleWebAuthn 13.2.x 之后在 Bun 构建产物中可能触发：

```text
tsyringe requires a reflect polyfill
```

因此结论是：

- 源码层面具备 WebCrypto/Bun 适配设计。
- 浏览器包无运行时依赖，风险较低。
- server 在 Bun 普通运行模式下可能可用。
- Bun `build --compile` 单文件模式必须单独验证，并可能需要保留：

```ts
import 'reflect-metadata';
```

本次未直接运行完整 SimpleWebAuthn server Bun 集成测试。

## 4. `node-datachannel` 0.33.1

核对来源：

- 本地 Bun cache：
  - `/Users/konata/.bun/install/cache/node-datachannel@0.33.1@@@1/package.json`
  - `src/lib/node-datachannel.ts`
  - `dist/types/lib/types.d.ts`
  - `dist/types/lib/index.d.ts`
  - `src/cpp/peer-connection-wrapper.cpp`
  - `src/cpp/data-channel-wrapper.cpp`
  - `CMakeLists.txt`
- [官方 GitHub README](https://github.com/murat-dogan/node-datachannel)
- [NPM 包页面](https://www.npmjs.com/package/node-datachannel)

### 包布局

主包：

```json
{
  "main": "./dist/cjs/lib/index.cjs",
  "module": "./dist/esm/lib/index.mjs",
  "types": "./dist/types/lib/index.d.ts",
  "dependencies": {
    "detect-libc": "^2.0.4"
  },
  "binary": {
    "napi_versions": [8]
  },
  "engines": {
    "node": ">=18.20.0"
  }
}
```

平台可选依赖：

```text
@node-datachannel/android-arm64
@node-datachannel/darwin-arm64
@node-datachannel/darwin-x64
@node-datachannel/linux-arm64-gnu
@node-datachannel/linux-arm64-musl
@node-datachannel/linux-x64-gnu
@node-datachannel/linux-x64-musl
@node-datachannel/win32-arm64-msvc
@node-datachannel/win32-x64-msvc
```

每个平台 tarball 的实际结构：

```text
node_datachannel.node
package.json
```

平台包的 `main` 是：

```json
{
  "main": "node_datachannel.node"
}
```

### binding 加载路径

`src/lib/node-datachannel.ts` 的逻辑：

1. 先尝试本地构建路径：
   - `../../build/node_datachannel.node`
   - `../../../build/node_datachannel.node`
   - 对应 `build/Release`
   - 对应 `build/Debug`
2. 再通过 `process.platform`、`process.arch` 和 `detect-libc` 选择平台包。
3. 使用：

```ts
require('@node-datachannel/darwin-arm64');
```

4. 平台包再解析其根目录的 `node_datachannel.node`。

这与架构文档中“安装到独立 native 目录、运行时按绝对路径加载”的设计不完全一致。`build-runtime` 如果内联 JS 层，需要将默认 loader 改为：

```ts
require('<installDir>/native/node_datachannel.node');
```

### `remoteFingerprint()`

类型：

```ts
type CertificateFingerprint = {
  value: string;
  algorithm:
    | 'sha-1'
    | 'sha-224'
    | 'sha-256'
    | 'sha-384'
    | 'sha-512'
    | 'md5'
    | 'md2';
};
```

调用：

```ts
const remote = peer.remoteFingerprint();
// {
//   value: 'AA:BB:...',
//   algorithm: 'sha-256'
// }
```

C++ 实现将 libdatachannel 的结果转换为：

```cpp
{
  value: fingerprint.value,
  algorithm: AlgorithmIdentifier(fingerprint.algorithm)
}
```

注意：PeerConnection 销毁后，C++ 实现返回数字 `0`，尽管 TypeScript 声明仍是 `CertificateFingerprint`。

### 获取本地 DTLS 指纹

本地指纹不通过 `remoteFingerprint()` 获取，而是从本地 SDP 的 `a=fingerprint` 行解析。

```ts
function parseFingerprint(sdp: string) {
  const match = sdp.match(
    /(?:^|\r?\n)a=fingerprint:([^\s]+)\s+([0-9a-f:]+)\s*$/im,
  );

  if (!match) {
    throw new Error('Missing DTLS fingerprint');
  }

  return {
    algorithm: match[1].toLowerCase(),
    value: match[2].replaceAll(':', '').toUpperCase(),
  };
}

peer.onLocalDescription((sdp, type) => {
  const localFingerprint = parseFingerprint(sdp);
  // 发送给对端或浏览器
});

peer.setLocalDescription('offer');
```

`localDescription()` 也可读取：

```ts
const description = peer.localDescription();

if (description) {
  const fingerprint = parseFingerprint(description.sdp);
}
```

未禁用自动协商时，`createDataChannel()` 可能自动触发本地 description，因此监听 `onLocalDescription()` 通常比手动重复调用更安全。

### DataChannel 背压 API

声明文件中的 API：

```ts
dc.bufferedAmount(): number;
dc.maxMessageSize(): number;
dc.setBufferedAmountLowThreshold(bytes: number): void;
dc.onBufferedAmountLow(() => void): void;
dc.sendMessage(message: string): boolean;
dc.sendMessageBinary(buffer: Buffer | Uint8Array): boolean;
```

PeerConnection 也有：

```ts
peer.maxMessageSize(): number;
```

`maxMessageSize()` 返回字节数。

建议适配方式：

```ts
dc.setBufferedAmountLowThreshold(1024 * 1024);

dc.onBufferedAmountLow(() => {
  resumeSending();
});

const accepted = dc.sendMessageBinary(Buffer.from(chunk));

if (!accepted) {
  pauseSending();
}
```

源码没有明确保证 `sendMessageBinary()` 返回 `false` 时一定代表“背压”；它是底层 libdatachannel 的布尔返回值，可能还表示发送失败。因此 `false` 的具体语义仍应由集成测试锁定。

### N-API 与 Bun

- N-API 版本：8。
- Node engine：`>=18.20.0`。
- Bun 1.3.x 的 Node-API 兼容层理论上可加载此类 `.node`，但本次没有在当前工作区重新加载 native addon。
- 架构文档中已有 Bun 1.3.14 PoC 通过的历史记录，但本次研究没有重复执行。

### 现有 PoC 是否仍反映 API

`prompt-archives/2026082701-hub-multinode-design/rtc-poc.ts` 使用的这些 API 仍然有效：

- 默认导入 `node-datachannel`
- `new PeerConnection(name, config)`
- `onLocalDescription`
- `onLocalCandidate`
- `setRemoteDescription`
- `addRemoteCandidate`
- `onDataChannel`
- `createDataChannel`
- `onOpen`
- `sendMessageBinary`

但 PoC 存在三个缺口：

1. 没有验证 `remoteFingerprint()`。
2. 没有解析本地 SDP 的 `a=fingerprint`。
3. 没有测试 `bufferedAmount()`、`maxMessageSize()` 和低水位事件。

另外，PoC 使用：

```ts
const payload = new Uint8Array(...);
dc1.sendMessageBinary(payload);
```

而 C++ 实现实际先检查：

```cpp
if (length < 1 || !info[0].IsBuffer())
```

声明文件虽然允许 `Uint8Array`，但原生入口明确要求 Buffer。正式 PoC 应改为：

```ts
dc1.sendMessageBinary(Buffer.from(payload));
```

这是当前最重要的兼容性风险。

## 5. 仓库 Borsh/Zorsh 实现

核对来源：

- `packages/shared/src/ws-borsh/schema.ts`
- `packages/shared/src/ws-borsh/codec.ts`
- `packages/shared/src/ws-borsh/canonical-state.ts`
- `/Users/konata/.bun/install/cache/@zorsh/zorsh@0.4.0@@@1/dist/src/schema.d.ts`
- `/Users/konata/.bun/install/cache/@zorsh/zorsh@0.4.0@@@1/dist/src/registry.js`
- `/Users/konata/.bun/install/cache/@zorsh/zorsh@0.4.0@@@1/dist/src/binary-io.js`

仓库依赖：

```json
"@zorsh/zorsh": "0.4.0"
```

### Schema 声明

```ts
import { b } from '@zorsh/zorsh';

const Schema = b.struct({
  field: b.string(),
});

type Value = b.infer<typeof Schema>;

const encoded = Schema.serialize(value);
const decoded = Schema.deserialize(encoded);
```

仓库现有代码也是同一模式：

```ts
export const EnvelopeSchema = b.struct({
  magic: b.bytes(2),
  version: b.u16(),
  kind: b.u16(),
  flags: b.u16(),
  seq: b.u32(),
  payload: b.bytes(),
});
```

### 类型和编码

| 类型 | 编码/解码 |
|---|---|
| `u8/u16/u32` | 小端整数，JavaScript `number` |
| `u64/u128` | 小端整数，JavaScript `bigint` |
| `i64/i128` | `bigint` |
| `string` | UTF-8，前置 `u32` 字节长度 |
| `b.bytes()` | `u32` 长度 + 原始字节 |
| `b.bytes(N)` | 固定 N 字节，无长度前缀，解码为 `Uint8Array` |
| `b.array(schema, N)` | 固定 N 个元素，无长度前缀，解码为普通数组 |
| `b.vec(schema)` | `u32` 长度 + 元素 |
| `b.option(schema)` | `u8` discriminator：0 为 `null`，1 后跟值 |
| `b.enum({...})` | `u8` variant index，之后是 variant 数据 |
| `b.unit()` | 空对象 `{}`，不产生字节 |
| `b.struct({...})` | 按声明顺序编码字段，不编码字段名 |

固定 32 字节哈希应使用：

```ts
b.bytes(32)
```

而不是：

```ts
b.array(b.u8(), 32)
```

因为后者解码为 `number[]`。

### 独立签名对象示例

```ts
import { b } from '@zorsh/zorsh';

const SignedObjectTypeSchema = b.enum({
  Enroll: b.unit(),
  Revoke: b.unit(),
  RotateRoot: b.unit(),
});

export const SignedObjectSchema = b.struct({
  domain: b.string(),
  uid: b.string(),
  seq: b.u64(),
  prev_hash: b.bytes(32),
  root_epoch: b.u32(),
  type: SignedObjectTypeSchema,
  payload: b.bytes(),
});

export type SignedObject = b.infer<typeof SignedObjectSchema>;
```

示例值：

```ts
const object: SignedObject = {
  domain: 'tmex/user-key/v1',
  uid: 'user-1',
  seq: 1n,
  prev_hash: new Uint8Array(32),
  root_epoch: 0,
  type: { Enroll: {} },
  payload: new Uint8Array([1, 2, 3]),
};

const bytes = SignedObjectSchema.serialize(object);
```

`packages/shared/src/ws-borsh/codec.ts` 的接口已经证明 schema 不依赖 envelope：

```ts
export function encodePayload<T>(
  schema: Schema<T>,
  data: T,
): Uint8Array {
  return schema.serialize(data);
}
```

因此可以直接：

1. `SignedObjectSchema.serialize(object)`；
2. 对结果签名；
3. 将签名和原始对象字节保存或传输。

不需要经过 `EnvelopeSchema`。

### Gotchas

- `u64` 输入必须是 `bigint`，例如 `1n`。
- enum variant 顺序就是编码 index，新增或重排 variant 会破坏兼容性。
- 结构体字段顺序必须固定。
- `option` 使用 `null`，不是 `undefined`。
- 字符串长度按 UTF-8 字节数计算，不是 JavaScript 字符数。

## 6. Bun 与浏览器 WebCrypto

核对来源：

- [Bun Web APIs](https://bun.sh/docs/runtime/web-apis)
- [Bun globals](https://bun.sh/docs/runtime/globals)
- [MDN AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)
- [MDN HkdfParams](https://developer.mozilla.org/en-US/docs/Web/API/HkdfParams)
- [MDN SubtleCrypto.deriveBits](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits)

### AES-GCM

Bun 1.3.14 实测通过：

```ts
const key = await crypto.subtle.importKey(
  'raw',
  keyBytes,
  'AES-GCM',
  false,
  ['encrypt', 'decrypt'],
);

const ciphertext = await crypto.subtle.encrypt(
  {
    name: 'AES-GCM',
    iv,                 // 12 bytes
    additionalData: aad,
    tagLength: 128,     // 16-byte tag
  },
  key,
  plaintext,
);

const plaintext2 = await crypto.subtle.decrypt(
  {
    name: 'AES-GCM',
    iv,
    additionalData: aad,
    tagLength: 128,
  },
  key,
  ciphertext,
);
```

实测参数：

```text
Bun: 1.3.14
AES key: 32 bytes, each byte 0x07
IV: 12 bytes, each byte 0x08
AAD: "tmex-aad"
plaintext: "tmex plaintext"
```

输出：

```text
ciphertext || tag:
482d3be6d74b8a9cb75000188401f6a65e5cd9b9db89260043a2f9a1d34c

decrypted:
tmex plaintext
```

结论：

- AES-256-GCM 可用。
- 12 字节 IV 可用，也是推荐长度。
- 128-bit tag 可用。
- `additionalData` 可用。
- WebCrypto 返回的是 `ciphertext || tag`，不是分离的 tag；如协议需要独立 tag，应切分末尾 16 字节。
- 同一密钥下 IV 必须唯一。
- 解密时 AAD 必须完全一致。

### HKDF-SHA-256

Bun 1.3.14 实测通过：

```ts
const baseKey = await crypto.subtle.importKey(
  'raw',
  ikm,
  'HKDF',
  false,
  ['deriveBits'],
);

const derived = await crypto.subtle.deriveBits(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info,
  },
  baseKey,
  256,
);
```

实测输出：

```text
932a8cbd72c81ab5eea4dc3c5e438bf1e03407dc16c1bc20e2557f26841b445b
```

### 浏览器

现代浏览器支持：

- `AES-GCM`
- 256-bit AES key
- 12-byte IV
- 128-bit authentication tag
- `additionalData`
- `HKDF`
- `SHA-256`
- `SubtleCrypto.deriveBits()` / `deriveKey()`

WebCrypto 通常要求安全上下文，即 HTTPS；localhost 是浏览器的受信任例外。

## 最终建议

E0-4 可以按以下版本和约束推进：

```text
hash-wasm           4.12.0
@noble/curves       2.3.0
@noble/hashes       2.3.0
node-datachannel    0.33.1
@zorsh/zorsh        0.4.0
SimpleWebAuthn      锁定具体 13.x 版本
```

实现前必须补充三项集成验证：

1. `hash-wasm` 与 Bun/Noble Argon2id 向量完全一致。
2. `node-datachannel` 使用 `Buffer.from()` 的回环测试，并覆盖 DTLS 指纹、背压和 `maxMessageSize()`。
3. SimpleWebAuthn server 在 Bun 普通运行和 `bun build --compile` 两种模式下分别测试，特别关注 `reflect-metadata`。