'use client'

import { JBCoreContracts, erc2771ForwarderAbi, jbContractAddress } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeFunctionData, isAddress, isAddressEqual, keccak256, parseEther, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { getAccount, getPublicClient, sendTransaction, signTypedData, switchChain } from 'wagmi/actions'
import { chainName } from './chains'
import { wagmiConfig, type PageChainId } from './wagmi'

const RELAYR_API = 'https://api.relayr.ba5ed.com'
const FORWARDER_DEADLINE_SECONDS = 47 * 60 * 60
const MAINNETS = [1, 10, 8453, 42161]
const TESTNETS = [11155111, 11155420, 84532, 421614]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BYTES = /^0x(?:[0-9a-f]{2})*$/i
const HASH = /^0x[0-9a-f]{64}$/i
const MAX_UINT256 = 2n ** 256n - 1n
const PAYMENT_ADDRESS = '0x1c05f7841379d4393574c0ffa17908ec40ffd97d' as Address
const PAYMENT_CODE_HASH = '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6'
const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address
const PAYMENT_GAS = 150_000n
const TRUSTED_FORWARDER_ABI = [{ type: 'function', name: 'isTrustedForwarder', stateMutability: 'view',
  inputs: [{ name: 'forwarder', type: 'address' }], outputs: [{ type: 'bool' }] }] as const

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const

export type RelayrCall = { chainId: PageChainId; to: Address; data: Hex; value: bigint }
export type RelayrEntry = { chain: number; target: Address; data: Hex; value: string; virtual_nonce?: number }
/** The nonce is signed but absent from execute calldata, so save it alongside each authorization. */
export type SignedRelayrEntry = { entry: RelayrEntry; nonce: string; deadline: number }
export type ChainPayment = { chain: number; target: Address; amount: Hex | string; calldata: Hex; payment_deadline?: string | number; token?: Address }
export type RelayrBinding = { txUuid: string; chain: number; entry: RelayrEntry }
export type RelayrQuote = { bundle_uuid: string; payment_info: ChainPayment[]; expectedTransactions: RelayrBinding[] }
export type RelayrBundle = {
  bundle_uuid: string
  payment_received?: boolean
  transactions: { tx_uuid: string; request: RelayrEntry; status?: { state?: string; data?: { hash?: Hex; transaction?: { hash?: Hex } } } }[]
}

export function supportsRelayrChains(chainIds: readonly number[]): boolean {
  return chainIds.length > 0 && new Set(chainIds).size === chainIds.length &&
    (chainIds.every(chain => MAINNETS.includes(chain)) || chainIds.every(chain => TESTNETS.includes(chain)))
}

function fundingChains(destinations: readonly number[]): number[] {
  if (!supportsRelayrChains(destinations)) throw new Error('Choose supported destinations from one network family: mainnets or testnets.')
  return MAINNETS.includes(destinations[0]) ? MAINNETS : TESTNETS
}

function uint256(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:\d+|0x[0-9a-f]+)$/i.test(value)) throw new Error('Relayr returned an invalid native amount.')
  const amount = BigInt(value)
  if (amount < 0n || amount > MAX_UINT256) throw new Error('Relayr returned an invalid native amount.')
  return amount
}

function cloneEntry(entry: RelayrEntry): RelayrEntry {
  if (!entry || !Number.isSafeInteger(entry.chain) || !isAddress(entry.target) || !BYTES.test(entry.data)) throw new Error('Invalid signed Relayr transaction.')
  return { chain: entry.chain, target: entry.target, data: entry.data, value: uint256(entry.value).toString(),
    ...(entry.virtual_nonce === undefined ? {} : { virtual_nonce: entry.virtual_nonce }) }
}

function sameEntry(left: RelayrEntry, right: RelayrEntry): boolean {
  return left.chain === right.chain && isAddressEqual(left.target, right.target) &&
    left.data.toLowerCase() === right.data.toLowerCase() && uint256(left.value) === uint256(right.value)
}

function ensureAccount(expected: Address) {
  const live = getAccount(wagmiConfig).address
  if (!live || !isAddressEqual(live, expected)) throw new Error('Connected account changed. Resume with the original launch account.')
}

function destinationClient(chainId: number) {
  const client = getPublicClient(wagmiConfig, { chainId: chainId as PageChainId })
  if (!client) throw new Error(`${chainName(chainId)} is unavailable.`)
  return client
}

function canonicalForwarder(chainId: PageChainId): Address {
  const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chainId] as Address | undefined
  if (!forwarder) throw new Error(`No Juicebox forwarder on ${chainName(chainId)}.`)
  return forwarder
}

async function authorizationContext(call: RelayrCall, account: Address) {
  const forwarder = canonicalForwarder(call.chainId)
  const client = destinationClient(call.chainId)
  const [rpcChain, domain, nonce, trusted] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'eip712Domain' }),
    client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account] }),
    client.readContract({ address: call.to, abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', args: [forwarder] }),
  ])
  if (rpcChain !== call.chainId || domain[0] !== '0x0f' || domain[1] !== 'Juicebox' || domain[2] !== '1' ||
      domain[3] !== BigInt(call.chainId) || !isAddressEqual(domain[4], forwarder) || domain[6].length !== 0 || !trusted) {
    throw new Error(`The trusted forwarder or signing domain on ${chainName(call.chainId)} could not be verified.`)
  }
  return { client, forwarder, nonce, domain: { name: domain[1], version: domain[2], chainId: call.chainId, verifyingContract: forwarder } }
}

function boundForwardRequest(call: RelayrCall, account: Address, signed: SignedRelayrEntry) {
  const entry = cloneEntry(signed.entry)
  if (entry.chain !== call.chainId || !isAddressEqual(entry.target, canonicalForwarder(call.chainId))) {
    throw new Error('The saved relay destination changed. Check the original launch before signing again.')
  }
  uint256(signed.nonce)
  const decoded = decodeFunctionData({ abi: erc2771ForwarderAbi, data: entry.data })
  if (decoded.functionName !== 'execute') throw new Error('The saved relay authorization is not a forward request.')
  const request = decoded.args[0]
  if (!isAddressEqual(request.from, account) || !isAddressEqual(request.to, call.to) ||
      request.value !== call.value || request.value !== uint256(entry.value) || request.data.toLowerCase() !== call.data.toLowerCase() ||
      request.deadline !== signed.deadline || request.gas <= 0n ||
      encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: [request] }).toLowerCase() !== entry.data.toLowerCase()) {
    throw new Error('The saved relay authorization no longer matches this launch.')
  }
  return { entry, request }
}

/** Historical receipt recovery still proves the original calls after their nonce or deadline passed. */
export function assertForwardRequestBindings(calls: RelayrCall[], account: Address, signed: SignedRelayrEntry[]): void {
  fundingChains(calls.map(call => call.chainId))
  if (signed.length !== calls.length) throw new Error('This launch is missing saved relay authorizations.')
  for (const [index, call] of calls.entries()) boundForwardRequest(call, account, signed[index])
}

async function verifyAuthorization(call: RelayrCall, account: Address, signed: SignedRelayrEntry) {
  const { entry, request } = boundForwardRequest(call, account, signed)
  const { client, forwarder, nonce, domain } = await authorizationContext(call, account)
  if (uint256(signed.nonce) !== nonce || request.deadline <= Math.floor(Date.now() / 1000) + 120) {
    throw new Error('The saved relay nonce changed or the signature expired. Check the original launch before signing again.')
  }
  const signer = await recoverTypedDataAddress({ domain, types: FORWARD_REQUEST_TYPES, primaryType: 'ForwardRequest', message: { ...request, nonce }, signature: request.signature })
  if (!isAddressEqual(signer, account) || !await client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'verify', args: [request] })) {
    throw new Error('The saved relay signature could not be verified for the original account.')
  }
  // The actual forwarded call must simulate successfully, including creation fees, even when the
  // signer owns no destination ETH. Never replace a genuine revert with an arbitrary gas limit.
  await client.call({ account, to: forwarder, data: entry.data, value: request.value,
    gas: request.gas + request.gas / 63n + 100_000n,
    stateOverride: [{ address: account, balance: request.value + parseEther('1') }] })
  ensureAccount(account)
}

/** Verify the complete saved authorizations immediately before paying their quote. */
export async function verifyForwardRequests(calls: RelayrCall[], account: Address, signed: SignedRelayrEntry[]): Promise<void> {
  calls = calls.map(call => ({ ...call }))
  signed = signed.map(item => ({ ...item, entry: cloneEntry(item.entry) }))
  fundingChains(calls.map(call => call.chainId))
  if (signed.length !== calls.length) throw new Error('This launch is missing saved relay authorizations.')
  for (const [index, call] of calls.entries()) await verifyAuthorization(call, account, signed[index])
}

/** Save each signature before requesting the next; retries reuse only the exact original calls. */
export async function signForwardRequests(calls: RelayrCall[], account: Address, onStep: (step: string) => void, options: {
  signed?: SignedRelayrEntry[]
  onSigned?: (signed: SignedRelayrEntry[]) => void
} = {}): Promise<RelayrEntry[]> {
  calls = calls.map(call => ({ ...call }))
  fundingChains(calls.map(call => call.chainId))
  const saved = (options.signed ?? []).map(item => ({ ...item, entry: cloneEntry(item.entry) }))
  if (saved.length > calls.length) throw new Error('The saved launch contains unexpected relay authorizations.')
  for (const [index, call] of calls.entries()) {
    ensureAccount(account)
    if (saved[index]) {
      await verifyAuthorization(call, account, saved[index])
      continue
    }
    onStep(`Sign for ${chainName(call.chainId)} (${index + 1}/${calls.length})`)
    await switchChain(wagmiConfig, { chainId: call.chainId })
    ensureAccount(account)
    const { client, forwarder, nonce, domain } = await authorizationContext(call, account)
    const gas = await client.estimateGas({ account, to: call.to, data: call.data, value: call.value,
      stateOverride: [{ address: account, balance: call.value + parseEther('1') }] }) * 2n
    const request = { from: account, to: call.to, value: call.value, gas, nonce,
      deadline: Math.floor(Date.now() / 1000) + FORWARDER_DEADLINE_SECONDS, data: call.data }
    const signature = await signTypedData(wagmiConfig, { account, domain, types: FORWARD_REQUEST_TYPES, primaryType: 'ForwardRequest', message: request })
    const entry: RelayrEntry = { chain: call.chainId, target: forwarder, value: call.value.toString(),
      data: encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: [{
        from: request.from, to: request.to, value: request.value, gas: request.gas,
        deadline: request.deadline, data: request.data, signature,
      }] }) }
    saved.push({ entry, nonce: nonce.toString(), deadline: request.deadline })
    options.onSigned?.(saved.map(item => ({ ...item, entry: cloneEntry(item.entry) })))
    ensureAccount(account)
    await verifyAuthorization(call, account, saved[index])
  }
  return saved.map(item => cloneEntry(item.entry))
}

/** Quotes bind every transaction UUID to an immutable snapshot of its signed destination call. */
export async function requestQuote(entries: RelayrEntry[]): Promise<RelayrQuote> {
  fundingChains(entries.map(entry => entry.chain))
  const ordered = entries.map(entry => ({ ...cloneEntry(entry), virtual_nonce: 0 }))
  const response = await fetch(`${RELAYR_API}/v1/bundle/prepaid`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactions: ordered, virtual_nonce_mode: 'ChainIndependent' }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`Relayr could not quote this launch (${response.status}). ${(await response.text()).slice(0, 200)}`)
  const body = await response.json() as Partial<RelayrQuote> & { tx_uuids?: unknown; txn_uuids?: unknown }
  const bundleUuid = String(body?.bundle_uuid ?? '').toLowerCase()
  const current = Array.isArray(body?.tx_uuids) ? body.tx_uuids : null
  const legacy = Array.isArray(body?.txn_uuids) ? body.txn_uuids : null
  const ids = (current ?? legacy ?? []).map(value => String(value).toLowerCase())
  if (!UUID.test(bundleUuid) || !Array.isArray(body?.payment_info) ||
      (current && legacy && JSON.stringify(current) !== JSON.stringify(legacy)) ||
      ids.length !== ordered.length || ids.some(id => !UUID.test(id)) || new Set(ids).size !== ordered.length) {
    throw new Error('Relayr did not bind a valid quote to every signed transaction. Nothing was paid.')
  }
  return { bundle_uuid: bundleUuid, payment_info: body.payment_info.map(payment => ({ ...payment })),
    expectedTransactions: ordered.map((entry, index) => ({ txUuid: ids[index], chain: entry.chain, entry })) }
}

/** POST returns transaction IDs without their requests. Authenticate the ID set against GET before
 * offering a payment, then bind IDs by their exact signed request rather than either API ordering. */
export async function bindQuote(quote: RelayrQuote, entries: RelayrEntry[]): Promise<RelayrQuote> {
  const expected = entries.map(cloneEntry)
  const snapshot: RelayrQuote = { bundle_uuid: quote.bundle_uuid,
    payment_info: quote.payment_info.map(payment => ({ ...payment })),
    expectedTransactions: quote.expectedTransactions.map(binding => ({ ...binding, entry: cloneEntry(binding.entry) })) }
  const ids = new Set(snapshot.expectedTransactions.map(binding => binding.txUuid.toLowerCase()))
  if (snapshot.expectedTransactions.length !== expected.length || ids.size !== expected.length || [...ids].some(id => !UUID.test(id)) ||
      expected.some(entry => snapshot.expectedTransactions.filter(binding => binding.chain === entry.chain && sameEntry(binding.entry, entry)).length !== 1)) {
    throw new Error('The saved quote no longer binds every original signed transaction.')
  }
  const bundle = await getBundle(snapshot.bundle_uuid, expected)
  if (bundle.transactions.some(transaction => !ids.has(transaction.tx_uuid.toLowerCase()))) {
    throw new Error('Relayr status returned different transaction IDs from its original quote. Nothing was paid.')
  }
  return { ...snapshot, expectedTransactions: bundle.transactions.map((transaction, index) => ({
    txUuid: transaction.tx_uuid, chain: expected[index].chain, entry: expected[index],
  })) }
}

function deadlineSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) && number >= 0 ? number : null
  }
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.floor(milliseconds / 1000) : null
}

/** The quote service cannot choose arbitrary calldata, assets, contracts, or destination families. */
export function paymentDetails(payment: ChainPayment, bundleUuid: string) {
  if (!payment || ![...MAINNETS, ...TESTNETS].includes(payment.chain) ||
      !isAddress(payment.target) || !isAddressEqual(payment.target, PAYMENT_ADDRESS) ||
      !payment.token || !isAddress(payment.token) || !isAddressEqual(payment.token, NATIVE_TOKEN)) {
    throw new Error('Relayr returned an unsupported payment chain, contract, or token.')
  }
  const amount = uint256(payment.amount)
  const uuid = bundleUuid.toLowerCase()
  const calldata = String(payment.calldata ?? '').toLowerCase()
  if (!UUID.test(uuid) || !/^0x[0-9a-f]{136}$/.test(calldata) || calldata.slice(0, 10) !== '0x103903a7' ||
      calldata.slice(10, 74) !== `${uuid.replaceAll('-', '')}${'0'.repeat(32)}`) {
    throw new Error('Relayr payment calldata does not match the quoted bundle.')
  }
  const deadline = BigInt(`0x${calldata.slice(74)}`)
  const quotedDeadline = deadlineSeconds(payment.payment_deadline)
  if (deadline > 0xffffffffffn || quotedDeadline === null || BigInt(quotedDeadline) !== deadline) throw new Error('Relayr payment calldata does not match the quote deadline.')
  if (deadline <= BigInt(Math.floor(Date.now() / 1000) + 15)) throw new Error('This Relayr quote expired. Request a fresh quote for the saved launch.')
  return { chainId: payment.chain as PageChainId, target: PAYMENT_ADDRESS, amount, calldata: calldata as Hex, deadline }
}

/** Only validated, deduplicated options returned by Relayr belong in the funding picker. */
export function paymentOptions(quote: RelayrQuote, destinations: readonly number[]): ChainPayment[] {
  const allowed = fundingChains(destinations)
  const seen = new Set<number>()
  return quote.payment_info.flatMap(payment => {
    try {
      const { chainId } = paymentDetails(payment, quote.bundle_uuid)
      if (!allowed.includes(chainId) || seen.has(chainId)) return []
      seen.add(chainId)
      return [{ ...payment }]
    } catch { return [] }
  })
}

/** Persist sending before opening the wallet and the hash immediately after broadcast. Receipt
 * verification belongs to the durable launch runner, which must never pay an uncertain send again. */
export async function payQuote(payment: ChainPayment, account: Address, options: {
  bundleUuid: string
  destinationChainIds: readonly number[]
  onSending: () => void
  onSubmitted: (hash: Hex) => void
  reverify?: () => Promise<void>
}): Promise<Hex> {
  const allowed = fundingChains(options.destinationChainIds)
  const reviewed = paymentDetails(payment, options.bundleUuid)
  const bound = () => {
    const live = paymentDetails(payment, options.bundleUuid)
    if (!allowed.includes(live.chainId) || live.chainId !== reviewed.chainId || live.amount !== reviewed.amount || live.calldata !== reviewed.calldata) {
      throw new Error('The Relayr payment changed or uses another network family. Review the original quote again.')
    }
    return live
  }
  bound()
  ensureAccount(account)
  await options.reverify?.()
  await switchChain(wagmiConfig, { chainId: reviewed.chainId })
  ensureAccount(account)
  const client = destinationClient(reviewed.chainId)
  if (await client.getChainId() !== reviewed.chainId) throw new Error('The payment RPC returned a different network.')
  const code = await client.request({ method: 'eth_getCode', params: [PAYMENT_ADDRESS, 'latest'] })
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code.length > 4098 || keccak256(code) !== PAYMENT_CODE_HASH) {
    throw new Error('Could not authenticate the Relayr payment contract.')
  }
  const details = bound()
  const result = await client.request({ method: 'eth_call', params: [{ from: account, to: details.target,
    value: `0x${details.amount.toString(16)}`, data: details.calldata, gas: `0x${PAYMENT_GAS.toString(16)}` }, 'latest'] })
  if (result !== '0x') throw new Error('Relayr payment simulation returned an unexpected result.')
  await options.reverify?.()
  bound()
  ensureAccount(account)
  options.onSending()
  const hash = await sendTransaction(wagmiConfig, { chainId: details.chainId, account,
    to: details.target, value: details.amount, data: details.calldata, gas: PAYMENT_GAS })
  if (!HASH.test(hash)) throw new Error('The wallet did not return a transaction hash. Keep checking this launch; do not pay again.')
  options.onSubmitted(hash)
  return hash
}

export function bundleHash(transaction: RelayrBundle['transactions'][number]): Hex | undefined {
  const direct = transaction.status?.data?.hash
  const nested = transaction.status?.data?.transaction?.hash
  if ((direct && !HASH.test(direct)) || (nested && !HASH.test(nested)) ||
      (direct && nested && direct.toLowerCase() !== nested.toLowerCase())) throw new Error('Relayr returned an invalid or conflicting destination hash.')
  return direct ?? nested
}

class InvalidBundleError extends Error {}

/** API order and success labels are not execution proof. Bind every record to its exact request. */
export function validateBundle(bundle: RelayrBundle, bundleUuid: string, entries: RelayrEntry[], bindings?: RelayrBinding[]): RelayrBundle {
  try {
    fundingChains(entries.map(entry => entry.chain))
    if (!UUID.test(bundleUuid) || bundle?.bundle_uuid?.toLowerCase() !== bundleUuid.toLowerCase() ||
        !Array.isArray(bundle.transactions) || bundle.transactions.length !== entries.length ||
        new Set(bundle.transactions.map(tx => tx.tx_uuid?.toLowerCase())).size !== entries.length) throw new Error()
    if (bindings && (bindings.length !== entries.length || new Set(bindings.map(binding => binding.txUuid.toLowerCase())).size !== entries.length)) throw new Error()
    const transactions = entries.map(entry => {
      const matches = bundle.transactions.filter(tx => sameEntry(cloneEntry(tx.request), entry))
      if (matches.length !== 1 || !UUID.test(matches[0].tx_uuid)) throw new Error()
      const transaction = matches[0]
      if (bindings) {
        const matchesBinding = bindings.filter(binding => binding.chain === entry.chain && sameEntry(binding.entry, entry))
        if (matchesBinding.length !== 1 || matchesBinding[0].txUuid.toLowerCase() !== transaction.tx_uuid.toLowerCase()) throw new Error()
      }
      const hash = bundleHash(transaction)
      return { tx_uuid: transaction.tx_uuid.toLowerCase(), request: cloneEntry(transaction.request),
        ...(transaction.status ? { status: { state: transaction.status.state, ...(hash ? { data: { hash } } : {}) } } : {}) }
    })
    return { bundle_uuid: bundleUuid.toLowerCase(), payment_received: bundle.payment_received === true, transactions }
  } catch { throw new InvalidBundleError('Relayr status does not match every original signed transaction. Keep this launch pending; do not pay again.') }
}

export async function getBundle(bundleUuid: string, entries: RelayrEntry[], bindings?: RelayrBinding[]): Promise<RelayrBundle> {
  if (!UUID.test(bundleUuid)) throw new Error('Invalid Relayr bundle ID.')
  const expected = entries.map(cloneEntry)
  const expectedBindings = bindings?.map(binding => ({ ...binding, entry: cloneEntry(binding.entry) }))
  const response = await fetch(`${RELAYR_API}/v1/bundle/${bundleUuid}`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Relayr status is temporarily unavailable (${response.status}). Keep this launch pending.`)
  return validateBundle(await response.json() as RelayrBundle, bundleUuid, expected, expectedBindings)
}

/** Hashes only identify candidate transactions. The caller must prove each canonical receipt. */
export async function waitForBundle(bundleUuid: string, entries: RelayrEntry[], onUpdate: (bundle: RelayrBundle) => void, bindings?: RelayrBinding[]): Promise<RelayrBundle> {
  entries = entries.map(cloneEntry)
  bindings = bindings?.map(binding => ({ ...binding, entry: cloneEntry(binding.entry) }))
  for (let attempt = 0; attempt < 180; attempt += 1) {
    let bundle: RelayrBundle | undefined
    try { bundle = await getBundle(bundleUuid, entries, bindings) } catch (error) {
      if (error instanceof InvalidBundleError) throw error
    }
    if (bundle) {
      onUpdate(bundle)
      if (bundle.transactions.every(transaction => Boolean(bundleHash(transaction)))) return bundle
    }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
  throw new Error('Relayr is still executing. Keep checking this saved launch; do not pay again.')
}
