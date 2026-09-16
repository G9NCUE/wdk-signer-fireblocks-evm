# wdk-signer-fireblocks-evm

[Fireblocks](https://developers.fireblocks.com/) signer for the
[Tether WDK](https://github.com/tetherto/wdk-wallet-evm). Implements the `ISignerEvm` contract of
`@tetherto/wdk-wallet-evm` 1.0.0-beta.18 on one vault account, through `@fireblocks/ts-sdk`.

A Fireblocks vault account holds one key per asset (`m/44/coin/vaultAccountId/0/0`), so the signer
is **not derivable**: register it by name with `wallet.addSigner()`.

## How each operation maps

| WDK call | Fireblocks transaction | What Fireblocks sees |
|---|---|---|
| `sign(message)` | `TYPED_MESSAGE`, `EIP191` | the message bytes, Fireblocks adds the prefix |
| `signTypedData(...)` | `TYPED_MESSAGE`, `EIP712` | the full typed payload |
| `signTransaction(tx)` | `RAW`, key named by vault account, asset and index | the unsigned hash only |
| `signAuthorization(auth)` | `RAW`, same | the EIP-7702 hash only |

Each signature is a Fireblocks transaction polled until `COMPLETED` (default every 2 s, 3 min
timeout). `BLOCKED`, `REJECTED`, `FAILED`, `CANCELLED` reject with the sub-status. The signer does
not use `CONTRACT_CALL` or `TRANSFER`: Fireblocks would broadcast itself and never hand back a
signed transaction; here the WDK stays the broadcaster.

## Requirements

- Sandbox workspace: RAW and typed-message signing are on, every transaction auto-approves.
- Production workspace: RAW signing is a paid feature enabled by Fireblocks, and both RAW and
  typed messages need a Transaction Authorization Policy rule; otherwise `BLOCKED_BY_POLICY`.
- Sepolia asset id `ETH_TEST5` (Holesky `ETH_TEST6`, mainnet `ETH`). Testnet assets derive under
  coin type 1, so the Sepolia key differs from the mainnet key of the same vault account.
- Fireblocks says EIP-7702 delegation is not supported on vault accounts in production.

## Usage

```js
import { readFileSync } from 'node:fs'
import { BasePath, Fireblocks } from '@fireblocks/ts-sdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { FireblocksSignerEvm } from 'wdk-signer-fireblocks-evm'

const client = new Fireblocks({ apiKey, secretKey: readFileSync('fireblocks_secret.key', 'utf8'), basePath: BasePath.Sandbox })
const signer = new FireblocksSignerEvm({ client, vaultAccountId: '0', assetId: 'ETH_TEST5' })

const wallet = new WalletManagerEvm(seed, { provider })
wallet.addSigner('fireblocks', signer)
const account = await wallet.getAccount('fireblocks')
```

## Tests

```
npm install
npm test                                       # 13 offline tests on a fake client
node --env-file=.env examples/sign-with-fireblocks.js   # the four operations against a workspace
```

## Status

Prototype, not published on npm (`"private": true`). Written against the SDK's types and the
public docs, not yet run against a live workspace. See
[wdk-signers-demo](https://github.com/G9NCUE/wdk-signers-demo).
