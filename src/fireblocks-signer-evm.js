'use strict'

import { ISigner, InvalidSignerError, ValueError } from '@tetherto/wdk-wallet'
import { Signature, Transaction, TypedDataEncoder, getAddress, getBytes, hashAuthorization, hexlify, toUtf8Bytes } from 'ethers'

const DONE = 'COMPLETED'
const DEAD = new Set(['FAILED', 'BLOCKED', 'CANCELLED', 'CANCELLING', 'REJECTED', 'TIMEOUT'])

// Follows the ISignerEvm contract by shape: wdk-wallet-evm beta.18 does not export the class.
// One Fireblocks vault account is one key per asset, so the signer is not derivable: register it
// by name with wallet.addSigner(). Every signature is a Fireblocks transaction (RAW for digests,
// TYPED_MESSAGE for EIP-191 and EIP-712) that is polled until it completes, seconds to minutes.
export default class FireblocksSignerEvm extends ISigner {
  // client is `new Fireblocks({ apiKey, secretKey, basePath })` from @fireblocks/ts-sdk
  constructor ({ client, vaultAccountId, assetId = 'ETH_TEST5', pollIntervalMs = 2000, timeoutMs = 180000, note = 'wdk' } = {}) {
    super()
    if (!client) throw new ValueError('A Fireblocks client is required.')
    if (vaultAccountId === undefined || vaultAccountId === null || vaultAccountId === '') throw new ValueError('A Fireblocks vault account id is required.')
    this._client = client
    this._vaultAccountId = String(vaultAccountId)
    this._assetId = assetId
    this._pollIntervalMs = pollIntervalMs
    this._timeoutMs = timeoutMs
    this._note = note
    this._address = undefined
    this._publicKey = null
  }

  static async connect (opts) {
    const signer = new FireblocksSignerEvm(opts)
    await signer.getAddress()
    return signer
  }

  get isDerivable () { return false }
  get index () { return undefined }
  get path () { return undefined }
  get address () { return this._address }
  get keyPair () { return { privateKey: null, publicKey: this._publicKey } }

  async derive () {
    throw new InvalidSignerError('Cannot derive: a Fireblocks vault account holds one key per asset, register the signer by name.')
  }

  async getAddress () {
    if (this._address) return this._address
    const client = this._live()
    const { data } = await client.vaults.getVaultAccountAssetAddressesPaginated({ vaultAccountId: this._vaultAccountId, assetId: this._assetId })
    const first = data?.addresses?.[0]
    if (!first?.address) throw new InvalidSignerError(`Vault account ${this._vaultAccountId} has no ${this._assetId} address.`)
    this._address = getAddress(first.address)
    try {
      const { data: info } = await client.vaults.getPublicKeyInfoForAddress({
        vaultAccountId: this._vaultAccountId, assetId: this._assetId, change: 0, addressIndex: 0, compressed: false
      })
      this._publicKey = info?.publicKey ? getBytes(hex0x(info.publicKey)) : null
    } catch {
      this._publicKey = null
    }
    return this._address
  }

  // Fireblocks adds the EIP-191 prefix itself, the content is the raw message bytes
  async sign (message) {
    const sig = await this._signTyped({ content: hexlify(toUtf8Bytes(message)).slice(2), type: 'EIP191' })
    return sig.serialized
  }

  // the transaction is signed as a digest: RAW signing, then the signature goes back on the tx
  async signTransaction (unsignedTx) {
    const address = await this.getAddress()
    const { from, ...txLike } = unsignedTx
    if (from && from.toLowerCase() !== address.toLowerCase()) {
      throw new ValueError(`Transaction "from" (${from}) does not match the signer address (${address}).`)
    }
    const tx = Transaction.from(txLike)
    tx.signature = await this._signRaw(tx.unsignedHash)
    return tx.serialized
  }

  // sent as the full typed payload so Fireblocks policies see the fields
  async signTypedData ({ domain, types, message }) {
    const payload = TypedDataEncoder.getPayload(domain, types, message)
    const sig = await this._signTyped({ content: payload, type: 'EIP712' })
    return sig.serialized
  }

  async signAuthorization (auth) {
    const populated = { address: auth.address, nonce: BigInt(auth.nonce ?? 0), chainId: BigInt(auth.chainId ?? 0) }
    const signature = await this._signRaw(hashAuthorization(populated))
    return { ...populated, signature }
  }

  dispose () {
    this._client = undefined
    this._publicKey = null
  }

  _live () {
    if (!this._client) throw new InvalidSignerError('The signer has been disposed.')
    return this._client
  }

  async _signRaw (digest) {
    return this._submit('RAW', { algorithm: 'MPC_ECDSA_SECP256K1', messages: [{ content: digest.slice(2), bip44addressIndex: 0, bip44change: 0 }] })
  }

  async _signTyped (message) {
    return this._submit('TYPED_MESSAGE', { messages: [message] })
  }

  async _submit (operation, rawMessageData) {
    await this.getAddress()
    const client = this._live()
    const { data: created } = await client.transactions.createTransaction({
      transactionRequest: {
        operation,
        assetId: this._assetId,
        source: { type: 'VAULT_ACCOUNT', id: this._vaultAccountId },
        note: this._note,
        extraParameters: { rawMessageData }
      }
    })
    const tx = await this._waitFor(created.id)
    const signed = tx.signedMessages?.[0]?.signature
    if (!signed) throw new InvalidSignerError(`Fireblocks transaction ${created.id} completed without a signature.`)
    // Fireblocks gives r and s without 0x and v as the recovery id, 0 or 1
    return Signature.from({ r: hex0x(signed.r), s: hex0x(signed.s), v: 27 + Number(signed.v) })
  }

  async _waitFor (txId) {
    const deadline = Date.now() + this._timeoutMs
    for (;;) {
      const { data: tx } = await this._live().transactions.getTransaction({ txId })
      if (tx.status === DONE) return tx
      if (DEAD.has(tx.status)) throw new InvalidSignerError(`Fireblocks did not sign (status ${tx.status}${tx.subStatus ? ': ' + tx.subStatus : ''}).`)
      if (Date.now() > deadline) throw new InvalidSignerError(`Fireblocks transaction ${txId} still ${tx.status} after ${this._timeoutMs} ms.`)
      await new Promise(resolve => setTimeout(resolve, this._pollIntervalMs))
    }
  }
}

function hex0x (hex) {
  return hex.startsWith('0x') ? hex : `0x${hex}`
}
