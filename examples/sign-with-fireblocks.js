// Runs each ISignerEvm operation against a real Fireblocks vault account. Nothing is broadcast.
// Run: node --env-file=.env examples/sign-with-fireblocks.js
// .env: FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_KEY_FILE (RSA private key), FIREBLOCKS_VAULT_ACCOUNT_ID,
//       optional FIREBLOCKS_BASE_PATH (sandbox, default) and FIREBLOCKS_ASSET_ID (ETH_TEST5, default)
import { readFileSync } from 'node:fs'
import { BasePath, Fireblocks } from '@fireblocks/ts-sdk'
import { Transaction, verifyAuthorization, verifyMessage, verifyTypedData } from 'ethers'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { FireblocksSignerEvm } from '../index.js'

const env = (k, fallback) => process.env[k] ?? fallback ?? (() => { throw new Error(`${k} is not set`) })()
const basePaths = { sandbox: BasePath.Sandbox, us: BasePath.US, eu: BasePath.EU, eu2: BasePath.EU2 }

const client = new Fireblocks({
  apiKey: env('FIREBLOCKS_API_KEY'),
  secretKey: readFileSync(env('FIREBLOCKS_SECRET_KEY_FILE'), 'utf8'),
  basePath: basePaths[env('FIREBLOCKS_BASE_PATH', 'sandbox')]
})

const signer = new FireblocksSignerEvm({ client, vaultAccountId: env('FIREBLOCKS_VAULT_ACCOUNT_ID'), assetId: env('FIREBLOCKS_ASSET_ID', 'ETH_TEST5') })
const wallet = new WalletManagerEvm('test test test test test test test test test test test junk')
wallet.addSigner('fireblocks', signer)
const account = await wallet.getAccount('fireblocks')
const address = await account.getAddress()
console.log('getAddress       ', address, 'public key', account.keyPair.publicKey ? 'ok' : 'unavailable')

const time = async (label, fn) => { const t = Date.now(); const ok = await fn(); console.log(label, ok ? 'ok' : 'FAIL', `${Date.now() - t} ms`) }

await time('sign             ', async () => verifyMessage('hello from wdk', await account.sign('hello from wdk')) === address)
await time('signTransaction  ', async () => Transaction.from(await account.signTransaction({
  chainId: 11155111, nonce: 0, to: address, value: 0n, data: '0x', type: 2,
  gasLimit: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n
})).from === address)
const typed = {
  domain: { name: 'WDK', version: '1', chainId: 11155111, verifyingContract: address },
  types: { Transfer: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  message: { to: address, amount: 42 }
}
await time('signTypedData    ', async () => verifyTypedData(typed.domain, typed.types, typed.message, await account.signTypedData(typed)) === address)
await time('signAuthorization', async () => { const a = await account.signAuthorization({ address, nonce: 1, chainId: 11155111 }); return verifyAuthorization(a, a.signature) === address })

wallet.dispose()
