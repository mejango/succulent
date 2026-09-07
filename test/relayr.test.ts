import { JBCoreContracts, jbContractAddress } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { assertForwardRequestBindings, bindQuote, bundleHash, getBundle, payQuote, paymentDetails, paymentOptions, requestQuote, signForwardRequests, supportsRelayrChains, validateBundle, verifyForwardRequests, waitForBundle, type ChainPayment, type RelayrBundle, type RelayrCall, type RelayrEntry, type RelayrQuote, type SignedRelayrEntry } from '@/lib/relayr'

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(), getPublicClient: vi.fn(), sendTransaction: vi.fn(), signTypedData: vi.fn(), switchChain: vi.fn(),
  request: vi.fn(), readContract: vi.fn(), estimateGas: vi.fn(), call: vi.fn(), fetch: vi.fn(),
}))
vi.mock('wagmi/actions', () => mocks)
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/chains', () => ({ chainName: (chain: number) => `Chain ${chain}` }))

// A public deterministic test account; no production key or wallet is used.
const wallet = privateKeyToAccount(`0x${'0'.repeat(63)}1`)
const account = wallet.address
const TARGET = '0x2222222222222222222222222222222222222222'
const PAYMENT = '0x1c05f7841379d4393574c0ffa17908ec40ffd97d'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033'
const BUNDLE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const IDS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-aaaaaaaaaaaa']
const HASH = `0x${'12'.repeat(32)}` as Hex
const NOW = 1_800_000_000

function payment(chain = 8453, deadline = NOW + 600): ChainPayment {
  const encoded = encodeAbiParameters([{ type: 'bytes16' }, { type: 'uint40' }], [`0x${BUNDLE.replaceAll('-', '')}`, deadline])
  return { chain, target: PAYMENT, token: NATIVE, amount: '12345', payment_deadline: deadline,
    calldata: `0x103903a7${encoded.slice(2)}` }
}
function entry(chain = 8453): RelayrEntry {
  return { chain, target: TARGET, value: '5', data: '0xabcdef' }
}
function quote(payments = [payment()]): RelayrQuote {
  return { bundle_uuid: BUNDLE, payment_info: payments,
    expectedTransactions: [8453, 1].map((chain, index) => ({ txUuid: IDS[index], chain, entry: entry(chain) })) }
}
function bundle(): RelayrBundle {
  return { bundle_uuid: BUNDLE, payment_received: true, transactions: [8453, 1].map((chain, index) => ({
    tx_uuid: IDS[index], request: entry(chain), status: { state: 'Success', data: { hash: HASH } },
  })) }
}
function calls(): RelayrCall[] {
  return [8453, 1].map(chainId => ({ chainId: chainId as RelayrCall['chainId'], to: TARGET, value: 5n, data: '0xabcdef' }))
}
function paymentRun(destinations = [8453, 1]) {
  return { bundleUuid: BUNDLE, destinationChainIds: destinations, onSending: vi.fn(), onSubmitted: vi.fn(), reverify: vi.fn(async () => {}) }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.getAccount.mockReturnValue({ address: account })
  mocks.switchChain.mockResolvedValue(undefined)
  mocks.sendTransaction.mockResolvedValue(HASH)
  mocks.estimateGas.mockResolvedValue(300_000n)
  mocks.call.mockResolvedValue({ data: '0x' })
  mocks.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_getCode' ? RUNTIME : '0x')
  mocks.readContract.mockImplementation(async (chainId: number, { functionName }: { functionName: string }) => {
    if (functionName === 'nonces') return 0n
    if (functionName === 'eip712Domain') return ['0x0f', 'Juicebox', '1', BigInt(chainId), jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chainId as 8453], `0x${'0'.repeat(64)}`, []]
    return true
  })
  mocks.getPublicClient.mockImplementation((_config, { chainId }: { chainId: number }) => ({
    getChainId: async () => chainId, request: mocks.request,
    readContract: (args: { functionName: string }) => mocks.readContract(chainId, args),
    estimateGas: mocks.estimateGas, call: mocks.call,
  }))
  mocks.signTypedData.mockImplementation((_config, args: Parameters<typeof wallet.signTypedData>[0]) => wallet.signTypedData(args))
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Relayr funding quotes', () => {
  test('supports each complete network family and rejects empty, mixed, unknown, duplicate destinations', () => {
    expect(supportsRelayrChains([1, 10, 8453, 42161])).toBe(true)
    expect(supportsRelayrChains([11155111, 11155420, 84532, 421614])).toBe(true)
    for (const ids of [[], [1, 84532], [1, 1], [137]]) expect(supportsRelayrChains(ids)).toBe(false)
  })

  test('only offered, canonical, unexpired, same-family options reach the picker, and returned choices are cloned', () => {
    const valid = payment(1)
    const response = quote([payment(137), payment(84532), { ...payment(10), target: TARGET }, valid, payment(1), payment(8453, NOW)])
    expect(paymentOptions(response, [8453, 10])).toEqual([valid])
    const options = paymentOptions(response, [8453, 10])
    options[0].amount = '900'
    expect(response.payment_info[3].amount).toBe('12345')
    expect(paymentOptions(quote([payment(1), payment(11155420)]), [84532, 11155111])).toEqual([payment(11155420)])
  })

  test.each([
    ['target', { target: TARGET }], ['token', { token: TARGET }], ['missing token', { token: undefined }],
    ['negative value', { amount: '-1' }], ['noninteger value', { amount: '1.5' }], ['overflow value', { amount: (2n ** 256n).toString() }],
    ['wrong deadline', { payment_deadline: NOW + 601 }], ['missing deadline', { payment_deadline: undefined }],
    ['empty calldata', { calldata: '0x' }], ['unknown chain', { chain: 137 }],
  ])('rejects invalid %s', (_name, change) => {
    expect(() => paymentDetails({ ...payment(), ...change } as ChainPayment, BUNDLE)).toThrow()
  })

  test('binds payment to canonical ABI UUID padding, selector, exact uint40 deadline and expiry', () => {
    const valid = payment()
    expect(() => paymentDetails(valid, IDS[0])).toThrow(/bundle/)
    expect(() => paymentDetails({ ...valid, calldata: `${valid.calldata}00` }, BUNDLE)).toThrow(/bundle/)
    expect(() => paymentDetails({ ...valid, calldata: `0x00000000${valid.calldata.slice(10)}` }, BUNDLE)).toThrow(/bundle/)
    const noncanonical = `${valid.calldata.slice(0, 42)}${'1'.repeat(32)}${valid.calldata.slice(74)}` as Hex
    expect(() => paymentDetails({ ...valid, calldata: noncanonical }, BUNDLE)).toThrow(/bundle/)
    const overflow = `0x103903a7${BUNDLE.replaceAll('-', '')}${'0'.repeat(32)}${(2n ** 40n).toString(16).padStart(64, '0')}` as Hex
    expect(() => paymentDetails({ ...valid, calldata: overflow, payment_deadline: Number(2n ** 40n) }, BUNDLE)).toThrow(/deadline/)
    expect(() => paymentDetails(payment(8453, NOW + 15), BUNDLE)).toThrow(/expired/)
    expect(paymentDetails({ ...valid, payment_deadline: new Date((NOW + 600) * 1000).toISOString() }, BUNDLE).deadline).toBe(BigInt(NOW + 600))
  })

  test('snapshots submitted entries and binds unique quote IDs with the current API nonce mode', async () => {
    const entries = [entry(), entry(1)]
    const response = { ...quote(), tx_uuids: IDS }
    mocks.fetch.mockImplementation(async () => {
      entries[0].value = '999'
      return { ok: true, json: async () => response }
    })
    const result = await requestQuote(entries)
    expect(result.expectedTransactions[0].entry.value).toBe('5')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ virtual_nonce_mode: 'ChainIndependent', transactions: [{ chain: 8453, virtual_nonce: 0 }, { chain: 1, virtual_nonce: 0 }] })
    response.payment_info[0].amount = '999'
    expect(result.payment_info[0].amount).toBe('12345')
  })

  test.each([
    {}, { tx_uuids: [IDS[0]] }, { tx_uuids: [IDS[0], IDS[0]] }, { tx_uuids: ['bad', IDS[1]] },
    { tx_uuids: IDS, txn_uuids: [...IDS].reverse() },
  ])('rejects missing or ambiguous quoted transaction bindings: %j', async ids => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...quote(), ...ids }) })
    await expect(requestQuote([entry(), entry(1)])).rejects.toThrow(/bind/)
  })

  test('supports the legacy transaction ID spelling when unambiguous', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...quote(), txn_uuids: IDS }) })
    await expect(requestQuote([entry(), entry(1)])).resolves.toMatchObject({ expectedTransactions: [{ txUuid: IDS[0] }, { txUuid: IDS[1] }] })
  })

  test('binds reversed POST IDs by exact GET requests before offering the quote', async () => {
    const response = bundle()
    response.transactions.reverse()
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...quote(), tx_uuids: [...IDS].reverse() }) })
      .mockResolvedValueOnce({ ok: true, json: async () => response })
    const raw = await requestQuote([entry(), entry(1)])
    expect(raw.expectedTransactions[0].txUuid).toBe(IDS[1])
    const bound = await bindQuote(raw, [entry(), entry(1)])
    expect(bound.expectedTransactions.map(binding => binding.txUuid)).toEqual(IDS)
    expect(raw.expectedTransactions[0].txUuid).toBe(IDS[1])
  })

  test.each(['foreign ID', 'changed request', 'missing request'])('does not offer quotes whose GET status has %s', async cause => {
    const response = bundle()
    if (cause === 'foreign ID') response.transactions[0].tx_uuid = BUNDLE
    if (cause === 'changed request') response.transactions[0].request.value = '999'
    if (cause === 'missing request') response.transactions.pop()
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => response })
    await expect(bindQuote(quote(), [entry(), entry(1)])).rejects.toThrow()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('Relayr payment boundary', () => {
  test('authenticates runtime and exact simulation, then journals sending and hash before returning', async () => {
    const events: string[] = []
    const options = paymentRun()
    options.onSending.mockImplementation(() => events.push('sending'))
    options.onSubmitted.mockImplementation(hash => { expect(hash).toBe(HASH); events.push('submitted') })
    mocks.sendTransaction.mockImplementation(async () => { events.push('wallet'); return HASH })
    await expect(payQuote(payment(10), account, options)).resolves.toBe(HASH)
    expect(events).toEqual(['sending', 'wallet', 'submitted'])
    expect(options.reverify).toHaveBeenCalledTimes(2)
    expect(mocks.request).toHaveBeenCalledWith({ method: 'eth_getCode', params: [PAYMENT, 'latest'] })
    expect(mocks.request).toHaveBeenCalledWith({ method: 'eth_call', params: [{ from: account, to: PAYMENT, value: '0x3039', data: payment(10).calldata, gas: '0x249f0' }, 'latest'] })
    expect(mocks.sendTransaction).toHaveBeenCalledWith({}, { chainId: 10, account, to: PAYMENT, value: 12345n, data: payment(10).calldata, gas: 150_000n })
  })

  test('testnet deployment funding accepts a returned option on another testnet', async () => {
    await payQuote(payment(421614), account, paymentRun([84532, 11155111]))
    expect(mocks.sendTransaction.mock.calls[0][1].chainId).toBe(421614)
  })

  test.each(['code', 'simulation', 'account', 'chain', 'mutation', 'expiry', 'family'])('stops before sending on %s mismatch', async cause => {
    const selected = payment()
    const options = paymentRun()
    if (cause === 'code') mocks.request.mockResolvedValue('0x6000')
    if (cause === 'simulation') mocks.request.mockImplementation(async ({ method }) => method === 'eth_getCode' ? RUNTIME : '0x01')
    if (cause === 'account') mocks.switchChain.mockImplementation(async () => { mocks.getAccount.mockReturnValue({ address: TARGET }) })
    if (cause === 'chain') mocks.getPublicClient.mockReturnValue({ getChainId: async () => 1 })
    if (cause === 'mutation') mocks.switchChain.mockImplementation(async () => { selected.amount = '999999' })
    if (cause === 'expiry') mocks.switchChain.mockImplementation(async () => { vi.spyOn(Date, 'now').mockReturnValue((NOW + 900) * 1000) })
    if (cause === 'family') options.destinationChainIds = [84532, 11155111]
    await expect(payQuote(selected, account, options)).rejects.toThrow()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    expect(options.onSending).not.toHaveBeenCalled()
  })

  test('does not retry or erase an uncertain wallet submission', async () => {
    const options = paymentRun()
    mocks.sendTransaction.mockRejectedValue(new Error('Provider disconnected after broadcast'))
    await expect(payQuote(payment(), account, options)).rejects.toThrow(/disconnected/)
    expect(options.onSending).toHaveBeenCalledOnce()
    expect(options.onSubmitted).not.toHaveBeenCalled()
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
  })

  test('propagates journal failures before broadcast and preserves a submitted hash when later persistence fails', async () => {
    const options = paymentRun()
    options.onSending.mockImplementation(() => { throw new Error('Storage unavailable') })
    await expect(payQuote(payment(), account, options)).rejects.toThrow(/Storage/)
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    options.onSending.mockReset()
    options.onSubmitted.mockImplementation(() => { throw new Error('Storage full') })
    await expect(payQuote(payment(), account, options)).rejects.toThrow(/Storage full/)
    expect(options.onSubmitted).toHaveBeenCalledWith(HASH)
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
  })
})

describe('saved destination authorizations', () => {
  test('signs and verifies testnet destinations using their canonical domain and forwarder', async () => {
    const selected = [11155111, 84532].map(chainId => ({ ...calls()[0], chainId: chainId as RelayrCall['chainId'] }))
    let saved: SignedRelayrEntry[] = []
    const signed = await signForwardRequests(selected, account, vi.fn(), { onSigned: entries => { saved = entries } })
    expect(signed.map(item => item.chain)).toEqual([11155111, 84532])
    expect(mocks.signTypedData.mock.calls.map(([, args]) => args.domain.chainId)).toEqual([11155111, 84532])
    await expect(verifyForwardRequests(selected, account, saved)).resolves.toBeUndefined()
  })

  test('journals each signed request before the next signature; resumes without signing the saved chain again', async () => {
    let saved: SignedRelayrEntry[] = []
    const onSigned = vi.fn((entries: SignedRelayrEntry[]) => { saved = entries })
    mocks.signTypedData.mockImplementationOnce((_config, args: Parameters<typeof wallet.signTypedData>[0]) => wallet.signTypedData(args))
      .mockRejectedValueOnce(new Error('User rejected second signature'))
    await expect(signForwardRequests(calls(), account, vi.fn(), { onSigned })).rejects.toThrow(/second/)
    expect(saved).toHaveLength(1)
    expect(saved[0].nonce).toBe('0')
    const entries = await signForwardRequests(calls(), account, vi.fn(), { signed: saved, onSigned })
    expect(entries).toHaveLength(2)
    expect(mocks.signTypedData).toHaveBeenCalledTimes(3)
    expect(saved).toHaveLength(2)
    await expect(verifyForwardRequests(calls(), account, saved)).resolves.toBeUndefined()
  })

  test('destination simulation reverts never fall back to a gas guess or open a signature', async () => {
    mocks.estimateGas.mockRejectedValue(new Error('Execution reverted: creation fee'))
    await expect(signForwardRequests(calls(), account, vi.fn())).rejects.toThrow(/creation fee/)
    expect(mocks.signTypedData).not.toHaveBeenCalled()
  })

  test('a forwarder simulation failure leaves its authorization saved and never signs the next chain', async () => {
    const onSigned = vi.fn()
    mocks.call.mockRejectedValue(new Error('Forwarded execution reverted'))
    await expect(signForwardRequests(calls(), account, vi.fn(), { onSigned })).rejects.toThrow(/Forwarded/)
    expect(onSigned).toHaveBeenCalledOnce()
    expect(mocks.signTypedData).toHaveBeenCalledOnce()
  })

  test.each(['trust', 'domain', 'nonce', 'signature', 'call', 'value', 'expiry'])('rejects changed %s before reusing a saved signature', async cause => {
    let saved: SignedRelayrEntry[] = []
    const selected = calls().slice(0, 1)
    await signForwardRequests(selected, account, vi.fn(), { onSigned: entries => { saved = entries } })
    const normalRead = mocks.readContract.getMockImplementation()!
    mocks.readContract.mockImplementation(async (chainId, args) => {
      if (cause === 'trust' && args.functionName === 'isTrustedForwarder') return false
      if (cause === 'nonce' && args.functionName === 'nonces') return 1n
      const result = await normalRead(chainId, args)
      if (cause === 'domain' && args.functionName === 'eip712Domain') result[3] = 1n
      return result
    })
    if (cause === 'signature') saved[0].entry.data = `${saved[0].entry.data.slice(0, -66)}${'0'.repeat(66)}` as Hex
    if (cause === 'call') selected[0].data = '0xaaaa'
    if (cause === 'value') selected[0].value = 6n
    if (cause === 'expiry') vi.spyOn(Date, 'now').mockReturnValue((saved[0].deadline + 1) * 1000)
    await expect(verifyForwardRequests(selected, account, saved)).rejects.toThrow()
    expect(mocks.signTypedData).toHaveBeenCalledOnce()
  })

  test('historical receipt bindings remain valid after execution but reject another original call', async () => {
    let saved: SignedRelayrEntry[] = []
    await signForwardRequests(calls(), account, vi.fn(), { onSigned: entries => { saved = entries } })
    vi.spyOn(Date, 'now').mockReturnValue((saved[0].deadline + 1) * 1000)
    expect(() => assertForwardRequestBindings(calls(), account, saved)).not.toThrow()
    expect(() => assertForwardRequestBindings(calls(), TARGET, saved)).toThrow(/matches/)
    expect(() => assertForwardRequestBindings(calls().reverse(), account, saved)).toThrow(/destination/)
  })
})

describe('exact bundle status bindings', () => {
  test('matches reordered API records by exact original request and original quoted UUID', () => {
    const response = bundle()
    response.transactions.reverse()
    const validated = validateBundle(response, BUNDLE, [entry(), entry(1)], quote().expectedTransactions)
    expect(validated.transactions.map(tx => tx.request.chain)).toEqual([8453, 1])
    response.transactions[1].request.value = '999'
    expect(validated.transactions[0].request.value).toBe('5')
  })

  test.each(['uuid', 'tx id', 'count', 'chain', 'target', 'data', 'value', 'duplicate', 'hash'])('rejects %s substitution even with success labels', cause => {
    const response = bundle()
    if (cause === 'uuid') response.bundle_uuid = IDS[0]
    if (cause === 'tx id') response.transactions[0].tx_uuid = BUNDLE
    if (cause === 'count') response.transactions.pop()
    if (cause === 'chain') response.transactions[0].request.chain = 10
    if (cause === 'target') response.transactions[0].request.target = PAYMENT
    if (cause === 'data') response.transactions[0].request.data = '0xaaaa'
    if (cause === 'value') response.transactions[0].request.value = '999'
    if (cause === 'duplicate') response.transactions[1] = response.transactions[0]
    if (cause === 'hash') response.transactions[0].status!.data = { hash: '0x1234' }
    expect(() => validateBundle(response, BUNDLE, [entry(), entry(1)], quote().expectedTransactions)).toThrow(/original signed/)
  })

  test('conflicting hash shapes are not silently resolved', () => {
    const transaction = bundle().transactions[0]
    transaction.status!.data!.transaction = { hash: `0x${'ab'.repeat(32)}` }
    expect(() => bundleHash(transaction)).toThrow(/conflicting/)
  })

  test('single status reads bind the saved requests for uncertain-payment recovery', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => bundle() })
    await expect(getBundle(BUNDLE, [entry(), entry(1)], quote().expectedTransactions)).resolves.toMatchObject({ transactions: [{ request: { chain: 8453 } }, { request: { chain: 1 } }] })
  })

  test('status requests retain their original bindings while the API response is pending', async () => {
    const entries = [entry(), entry(1)]
    const bindings = quote().expectedTransactions
    mocks.fetch.mockImplementation(async () => {
      entries[0].value = '999'
      bindings[0].entry.value = '999'
      bindings[0].txUuid = BUNDLE
      return { ok: true, json: async () => bundle() }
    })
    const result = await getBundle(BUNDLE, entries, bindings)
    expect(result.transactions[0].request.value).toBe('5')
    expect(result.transactions[0].tx_uuid).toBe(IDS[0])
  })

  test('polls past success labels without hashes and yields candidate hashes even when labels are stale', async () => {
    vi.useFakeTimers()
    const pending = bundle()
    for (const transaction of pending.transactions) transaction.status!.data = undefined
    const landed = bundle()
    for (const transaction of landed.transactions) transaction.status!.state = 'Pending'
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => pending })
      .mockResolvedValueOnce({ ok: true, json: async () => landed })
    const onUpdate = vi.fn()
    const result = waitForBundle(BUNDLE, [entry(), entry(1)], onUpdate, quote().expectedTransactions)
    await vi.advanceTimersByTimeAsync(2_500)
    await expect(result).resolves.toMatchObject({ transactions: [{ status: { state: 'Pending' } }, { status: { state: 'Pending' } }] })
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })

  test('does not poll through a malicious bundle mismatch', async () => {
    const mismatch = bundle()
    mismatch.transactions.pop()
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => mismatch })
    await expect(waitForBundle(BUNDLE, [entry(), entry(1)], vi.fn(), quote().expectedTransactions)).rejects.toThrow(/original signed/)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
})
