import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Transaction, verifyAuthorization, verifyMessage, verifyTypedData } from 'ethers'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { FireblocksSignerEvm } from '../index.js'
import { FakeFireblocksClient } from './fake-fireblocks-client.js'

// throwaway test mnemonics, never funded
const MNEMONIC = 'test test test test test test test test test test test junk'
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function setup (opts = {}) {
  const client = new FakeFireblocksClient(MNEMONIC, opts)
  const signer = new FireblocksSignerEvm({ client, vaultAccountId: 3, pollIntervalMs: 1, ...opts })
  const wallet = new WalletManagerEvm(SEED)
  wallet.addSigner('fireblocks', signer)
  return { client, signer, wallet, expected: client._wallet('3', 'ETH_TEST5').address }
}

test('requires a client and a vault account', () => {
  assert.throws(() => new FireblocksSignerEvm({}), /client/)
  assert.throws(() => new FireblocksSignerEvm({ client: {} }), /vault account/)
})

test('is not derivable and cannot be the default signer', async () => {
  const { signer } = setup()
  assert.equal(signer.isDerivable, false)
  await assert.rejects(signer.derive('0/0/1'), /register the signer by name/)
  assert.throws(() => new WalletManagerEvm(signer), /derivable/)
})

test('address and public key of the vault account, checksummed', async () => {
  const { client, wallet, expected } = setup()
  const account = await wallet.getAccount('fireblocks')
  assert.equal(await account.getAddress(), expected)
  assert.equal(account.keyPair.privateKey, null)
  assert.equal(account.keyPair.publicKey.length, 65)
  await account.getAddress()
  assert.equal(client.calls.filter(c => c === 'addresses').length, 1)
})

test('signs a message as an EIP-191 typed message', async () => {
  const { client, wallet, expected } = setup()
  const account = await wallet.getAccount('fireblocks')
  const sig = await account.sign('hello from wdk')
  assert.equal(verifyMessage('hello from wdk', sig), expected)
  assert.ok(client.calls.includes('create:TYPED_MESSAGE'))
})

test('signs an EIP-1559 transaction with RAW signing', async () => {
  const { client, wallet, expected } = setup()
  const account = await wallet.getAccount('fireblocks')
  const signed = await account.signTransaction({
    chainId: 11155111, nonce: 0, to: expected, value: 0n, data: '0x', type: 2,
    gasLimit: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n
  })
  assert.equal(Transaction.from(signed).from, expected)
  assert.ok(client.calls.includes('create:RAW'))
})

test('signs a legacy transaction', async () => {
  const { wallet, expected } = setup()
  const account = await wallet.getAccount('fireblocks')
  const signed = await account.signTransaction({ chainId: 11155111, nonce: 0, to: expected, value: 0n, type: 0, gasLimit: 21000n, gasPrice: 1_000_000_000n })
  assert.equal(Transaction.from(signed).from, expected)
})

test('rejects a transaction from another address', async () => {
  const { signer } = setup()
  await assert.rejects(signer.signTransaction({ from: '0x0000000000000000000000000000000000000001', chainId: 1, nonce: 0 }), /does not match/)
})

test('signs typed data as an EIP-712 typed message', async () => {
  const { wallet, expected } = setup()
  const account = await wallet.getAccount('fireblocks')
  const typed = {
    domain: { name: 'WDK', version: '1', chainId: 11155111, verifyingContract: expected },
    types: { Transfer: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
    message: { to: expected, amount: 42 }
  }
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, await account.signTypedData(typed)), expected)
})

test('signs an EIP-7702 authorization with RAW signing', async () => {
  const { wallet, expected } = setup()
  const account = await wallet.getAccount('fireblocks')
  const auth = await account.signAuthorization({ address: expected, nonce: 1, chainId: 11155111 })
  assert.equal(verifyAuthorization(auth, auth.signature), expected)
})

test('polls until the transaction completes', async () => {
  const { client, signer } = setup({ pendingPolls: 3 })
  await signer.sign('slow')
  assert.equal(client.calls.filter(c => c === 'get').length, 4)
})

test('surfaces a blocked transaction', async () => {
  const { client, signer } = setup()
  client.failWith = 'BLOCKED'
  await assert.rejects(signer.sign('x'), /status BLOCKED: BLOCKED_BY_POLICY/)
})

test('gives up after the timeout', async () => {
  const { signer } = setup({ pendingPolls: 1000, timeoutMs: 20 })
  await assert.rejects(signer.sign('x'), /still PENDING_SIGNATURE/)
})

test('dispose ends the signer', async () => {
  const { signer } = setup()
  signer.dispose()
  await assert.rejects(signer.getAddress(), /disposed/)
})
