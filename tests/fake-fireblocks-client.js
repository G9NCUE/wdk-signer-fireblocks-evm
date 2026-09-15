// Stands in for `new Fireblocks(...)` of @fireblocks/ts-sdk, signing with a local HD wallet.
// Shapes follow the ts-sdk 31 models: axios-style { data } results, RAW and TYPED_MESSAGE
// operations, transactions that complete after one poll.
import { HDNodeWallet, SigningKey, TypedDataEncoder, hashMessage } from 'ethers'

export class FakeFireblocksClient {
  constructor (mnemonic, { pendingPolls = 1 } = {}) {
    this.root = HDNodeWallet.fromPhrase(mnemonic, undefined, 'm')
    this.pendingPolls = pendingPolls
    this.calls = []
    this.txs = new Map()
    this.vaults = {
      getVaultAccountAssetAddressesPaginated: async ({ vaultAccountId, assetId }) => {
        this.calls.push('addresses')
        return { data: { addresses: [{ address: this._wallet(vaultAccountId, assetId).address.toLowerCase(), bip44AddressIndex: 0 }] } }
      },
      getPublicKeyInfoForAddress: async ({ vaultAccountId, assetId, compressed }) => {
        this.calls.push('publicKey')
        const w = this._wallet(vaultAccountId, assetId)
        return { data: { algorithm: 'MPC_ECDSA_SECP256K1', publicKey: SigningKey.computePublicKey(w.privateKey, compressed).slice(2) } }
      }
    }
    this.transactions = {
      createTransaction: async ({ transactionRequest }) => {
        this.calls.push('create:' + transactionRequest.operation)
        const id = `tx-${this.txs.size + 1}`
        const w = this._wallet(transactionRequest.source.id, transactionRequest.assetId)
        const { r, s, v } = w.signingKey.sign(this._digest(transactionRequest))
        this.txs.set(id, { id, status: 'PENDING_SIGNATURE', polls: 0, signedMessages: [{ publicKey: w.publicKey.slice(2), signature: { r: r.slice(2), s: s.slice(2), v: v - 27, fullSig: r.slice(2) + s.slice(2) } }] })
        return { data: { id, status: 'SUBMITTED' } }
      },
      getTransaction: async ({ txId }) => {
        this.calls.push('get')
        const tx = this.txs.get(txId)
        if (!tx) throw new Error('unknown tx ' + txId)
        tx.polls++
        if (this.failWith) return { data: { ...tx, status: this.failWith, subStatus: 'BLOCKED_BY_POLICY' } }
        return { data: { ...tx, status: tx.polls > this.pendingPolls ? 'COMPLETED' : 'PENDING_SIGNATURE' } }
      }
    }
  }

  // one key per vault account and asset, like Fireblocks (coin type 1 for testnet assets)
  _wallet (vaultAccountId, assetId) {
    const coin = assetId.startsWith('ETH_TEST') ? 1 : 60
    return this.root.derivePath(`44/${coin}/${vaultAccountId}/0/0`)
  }

  _digest ({ operation, extraParameters }) {
    const [m] = extraParameters.rawMessageData.messages
    if (operation === 'RAW') {
      if (extraParameters.rawMessageData.algorithm !== 'MPC_ECDSA_SECP256K1') throw new Error('fake: bad algorithm')
      if (m.content.length !== 64) throw new Error('fake: RAW content must be 32 bytes')
      return '0x' + m.content
    }
    if (operation !== 'TYPED_MESSAGE') throw new Error('fake: unsupported operation ' + operation)
    if (m.type === 'EIP191') return hashMessage(Buffer.from(m.content, 'hex'))
    if (m.type === 'EIP712') {
      const { EIP712Domain, ...types } = m.content.types
      return TypedDataEncoder.hash(m.content.domain, types, m.content.message)
    }
    throw new Error('fake: unsupported message type ' + m.type)
  }
}
