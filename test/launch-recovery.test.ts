import { beforeEach, expect, test, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type { RelayrCall } from '@/lib/relayr'

const mocks = vi.hoisted(() => ({
  owner: '0x1111111111111111111111111111111111111111' as Address,
  connector: { id: 'injected', type: 'injected' },
  send: vi.fn(), call: vi.fn(), transaction: vi.fn(), receipt: vi.fn(), block: vi.fn(), waitReceipt: vi.fn(),
  sign: vi.fn(), quote: vi.fn(), pay: vi.fn(), bundle: vi.fn(), verify: vi.fn(), pin: vi.fn(),
}))
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }))
vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ address: mocks.owner, connector: mocks.connector }),
  getPublicClient: () => ({ readContract: vi.fn().mockResolvedValue(true), call: mocks.call,
    getTransaction: mocks.transaction, getTransactionReceipt: mocks.receipt, getBlock: mocks.block, waitForTransactionReceipt: mocks.waitReceipt }),
  switchChain: vi.fn(), sendTransaction: mocks.send, readContract: vi.fn(), waitForTransactionReceipt: vi.fn(), writeContract: vi.fn(),
}))
vi.mock('@bananapus/nana-sdk-core/jbcenter', () => ({ createJBCenterClient: () => ({ pinJson: mocks.pin }) }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getProjectCreationFee: vi.fn().mockResolvedValue(1n), projectIdFromLaunchLogs: vi.fn().mockReturnValue(99n),
}))
vi.mock('@/lib/relayr', () => ({
  supportsRelayrChains: (chains: number[]) => [ [1, 10, 8453, 42161], [11155111, 11155420, 84532, 421614] ]
    .some(family => chains.length > 0 && chains.length === new Set(chains).size && chains.every(chain => family.includes(chain))),
  paymentOptions: (quote: { payment_info: unknown[] }) => quote.payment_info,
  signForwardRequests: mocks.sign, requestQuote: mocks.quote, verifyForwardRequests: mocks.verify,
  assertForwardRequestBindings: vi.fn(),
  payQuote: mocks.pay, getBundle: mocks.bundle,
  bindQuote: async (quote: unknown) => quote,
  bundleHash: (transaction: { status?: { data?: { hash?: Hex } } }) => transaction.status?.data?.hash,
}))

import { launchQuotedPage, quoteMultichainPage, resumePageQuote } from '@/lib/tx'
import { clearPageLaunch, loadPageLaunch, savePageLaunch } from '@/lib/page-launch-session'

const hash = `0x${'ab'.repeat(32)}` as Hex
const blockHash = `0x${'cd'.repeat(32)}` as Hex
const payment = { chain: 8453, target: '0x1c05f7841379d4393574c0ffa17908ec40ffd97d' as Address, amount: '100', calldata: '0xab' as Hex }
const args = () => ({ chainIds: [8453, 10] as (8453 | 10)[], name: 'Saved page', logo: null, owner: mocks.owner, recipients: [], onStep: vi.fn() })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connector = { id: 'injected', type: 'injected' }
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}) } })
  mocks.pin.mockResolvedValue({ uri: 'ipfs://saved-page' })
  mocks.call.mockResolvedValue({ data: '0x' })
  mocks.transaction.mockRejectedValue(new Error('RPC pending'))
  mocks.block.mockResolvedValue({ hash: blockHash })
  mocks.receipt.mockResolvedValue({ transactionHash: hash, blockHash, blockNumber: 100n, status: 'success', logs: [] })
  mocks.waitReceipt.mockResolvedValue({ status: 'success' })
  mocks.sign.mockImplementation(async (calls: RelayrCall[], _owner: Address, _step: unknown, options: { onSigned: (signed: unknown[]) => void; signed: unknown[] }) => {
    const signed = calls.map(call => ({ entry: { chain: call.chainId, target: call.to, data: call.data, value: call.value.toString() }, nonce: '7', deadline: 2_000_000_000 }))
    options.onSigned(signed)
    return signed.map(item => item.entry)
  })
  mocks.quote.mockImplementation(async entries => ({ bundle_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payment_info: [payment],
    expectedTransactions: entries.map((entry: unknown, index: number) => ({ txUuid: `transaction-${index}`, entry })) }))
  mocks.bundle.mockRejectedValue(new Error('The original launch is pending.'))
})

test('quote funding requires explicit returned choice, with no payment during signing or quote', async () => {
  const session = await quoteMultichainPage(args())
  expect(session.phase).toBe('quoted')
  expect(session.payment).toBeUndefined()
  expect(mocks.pay).not.toHaveBeenCalled()
  await expect(launchQuotedPage({ quoted: session, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() })).rejects.toThrow('Choose one')
  expect(mocks.pay).not.toHaveBeenCalled()
})

test('an ambiguous payment without a hash survives reload and never pays or signs again', async () => {
  const session = await quoteMultichainPage(args())
  mocks.pay.mockImplementationOnce(async (_payment, _owner, callbacks) => {
    callbacks.onSending()
    throw new Error('Wallet disconnected after send')
  })
  const payArgs = { quoted: session, payment, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() }
  await expect(launchQuotedPage(payArgs)).rejects.toThrow('disconnected')
  expect(loadPageLaunch()?.phase).toBe('payment-sending')
  await expect(launchQuotedPage({ ...payArgs, quoted: loadPageLaunch()! })).rejects.toThrow('original launch is pending')
  await expect(resumePageQuote({ session, owner: mocks.owner, onStep: vi.fn() })).rejects.toThrow('original Relayr payment')
  expect(mocks.pay).toHaveBeenCalledTimes(1)
  expect(mocks.sign).toHaveBeenCalledTimes(1)
  expect(mocks.quote).toHaveBeenCalledTimes(1)
})

test('payment hash persists before confirmation and explicit rejection permits the same quoted payment', async () => {
  const session = await quoteMultichainPage(args())
  mocks.pay.mockImplementationOnce(async (_payment, _owner, callbacks) => {
    callbacks.onSending()
    throw Object.assign(new Error('Rejected'), { code: 4001 })
  })
  const payArgs = { quoted: session, payment, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() }
  await expect(launchQuotedPage(payArgs)).rejects.toThrow('Rejected')
  expect(loadPageLaunch()?.phase).toBe('quoted')
  mocks.pay.mockImplementationOnce(async (_payment, _owner, callbacks) => { callbacks.onSending(); callbacks.onSubmitted(hash); return hash })
  await expect(launchQuotedPage(payArgs)).rejects.toThrow('original launch is pending')
  expect(loadPageLaunch()).toMatchObject({ phase: 'submitted', paymentHash: hash })
  await expect(launchQuotedPage(payArgs)).rejects.toThrow('original launch is pending')
  expect(mocks.pay).toHaveBeenCalledTimes(2)
})

test('quote refresh resumes the saved authorizations without repinning or changing the launch salt', async () => {
  const session = await quoteMultichainPage(args())
  const resumed = await resumePageQuote({ session, owner: mocks.owner, onStep: vi.fn() })
  expect(resumed.id).toBe(session.id)
  expect(mocks.pin).toHaveBeenCalledTimes(1)
  expect(mocks.sign.mock.calls[1][3].signed).toEqual(session.signed)
  expect(mocks.quote.mock.calls[1][0]).toEqual(mocks.quote.mock.calls[0][0])
  await expect(clearPageLaunch(resumed)).rejects.toThrow('saved authorizations')
})

test('a direct no-hash wallet timeout is durably blocked instead of creating another page', async () => {
  mocks.send.mockRejectedValueOnce(new Error('Wallet disconnected'))
  await expect(quoteMultichainPage({ ...args(), chainIds: [8453] })).rejects.toThrow('disconnected')
  const session = loadPageLaunch()!
  expect(session.direct[8453]).toEqual({ phase: 'sending' })
  await expect(resumePageQuote({ session, owner: mocks.owner, onStep: vi.fn() })).rejects.toThrow('uncertain')
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.pin).toHaveBeenCalledTimes(1)
})

test('direct confirmation resumes its saved hash and proves the canonical exact destination', async () => {
  let sent: { to: Address; data: Hex; value: bigint }
  mocks.send.mockImplementationOnce(async (_config, call) => { sent = call; return hash })
  mocks.waitReceipt.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(quoteMultichainPage({ ...args(), chainIds: [8453] })).rejects.toThrow('RPC unavailable')
  const session = loadPageLaunch()!
  expect(session.direct[8453]).toMatchObject({ hash, phase: 'submitted' })
  mocks.transaction.mockImplementation(async () => ({ hash, from: mocks.owner, to: sent.to, input: sent.data, value: sent.value, chainId: 8453, blockHash }))
  const done = await resumePageQuote({ session, owner: mocks.owner, onStep: vi.fn() })
  expect(done.phase).toBe('complete')
  expect(done.launched).toEqual([{ chainId: 8453, projectId: 99, hash }])
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

test('storage and duplicate-tab failures stop before metadata uploads or signatures', async () => {
  vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, run: (lock: null) => unknown) => run(null) } })
  await expect(quoteMultichainPage(args())).rejects.toThrow('another tab')
  expect(mocks.pin).not.toHaveBeenCalled()
  expect(mocks.sign).not.toHaveBeenCalled()
})

test('mixed-family plans and a competing saved session cannot start a new launch', async () => {
  await expect(quoteMultichainPage({ ...args(), chainIds: [8453, 84532] })).rejects.toThrow('one network environment')
  const session = await quoteMultichainPage(args())
  await expect(quoteMultichainPage(args())).rejects.toThrow('already saved')
  const changed = structuredClone(session)
  changed.id = `0x${'ff'.repeat(32)}`
  savePageLaunch(changed)
  await expect(launchQuotedPage({ quoted: session, payment, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() })).rejects.toThrow('saved launch changed')
  expect(mocks.pay).not.toHaveBeenCalled()
})

test('a stale unsigned tab cannot discard the signed journal another tab saved', async () => {
  const session = await quoteMultichainPage(args())
  const stale = { ...session, phase: 'prepared' as const, signed: [], quote: undefined }
  await expect(clearPageLaunch(stale)).rejects.toThrow('saved authorizations')
  expect(loadPageLaunch()?.signed).toEqual(session.signed)
})

test('a reverted payment stays locked until its exact receipt is finalized', async () => {
  const session = await quoteMultichainPage(args())
  session.payment = payment
  session.paymentHash = hash
  session.phase = 'submitted'
  savePageLaunch(session)
  mocks.transaction.mockResolvedValue({ hash, from: mocks.owner, to: payment.target, input: payment.calldata, value: 100n, chainId: payment.chain, blockHash })
  mocks.receipt.mockResolvedValue({ transactionHash: hash, blockHash, blockNumber: 100n, status: 'reverted', logs: [] })
  mocks.block.mockImplementation(async options => ({ hash: blockHash, number: options.blockTag === 'finalized' ? 99n : options.blockNumber }))
  const payArgs = { quoted: session, payment, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() }
  await expect(launchQuotedPage(payArgs)).rejects.toThrow('not finalized')
  expect(loadPageLaunch()).toMatchObject({ phase: 'submitted', paymentHash: hash })
  mocks.block.mockImplementation(async options => ({ hash: blockHash, number: options.blockTag === 'finalized' ? 101n : options.blockNumber }))
  await expect(launchQuotedPage(payArgs)).rejects.toThrow('reverted on chain')
  expect(loadPageLaunch()).toMatchObject({ phase: 'quoted', failedPayments: [{ chainId: payment.chain, hash }] })
  expect(loadPageLaunch()?.paymentHash).toBeUndefined()
  expect(mocks.pay).not.toHaveBeenCalled()
})

test('saved exact destination hashes can finish every chain while Relayr is unavailable', async () => {
  const session = await quoteMultichainPage(args())
  const otherHash = `0x${'ef'.repeat(32)}` as Hex
  session.phase = 'executing'
  session.candidates = { 8453: [hash], 10: [otherHash] }
  savePageLaunch(session)
  mocks.transaction.mockImplementation(async ({ hash: requested }) => {
    const entry = session.signed.find(item => item.entry.chain === (requested === hash ? 8453 : 10))!.entry
    return { hash: requested, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash }
  })
  mocks.receipt.mockImplementation(async ({ hash: requested }) => ({ transactionHash: requested, blockHash, blockNumber: 100n, status: 'success', logs: [] }))
  const pages = await launchQuotedPage({ quoted: session, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() })
  expect(pages).toEqual([{ chainId: 8453, projectId: 99, hash }, { chainId: 10, projectId: 99, hash: otherHash }])
  expect(loadPageLaunch()?.phase).toBe('complete')
  expect(mocks.pay).not.toHaveBeenCalled()
})

test('a completed destination is saved while its peer still has no hash', async () => {
  const session = await quoteMultichainPage(args())
  session.phase = 'executing'
  savePageLaunch(session)
  const entry = session.signed[0].entry
  mocks.bundle.mockResolvedValueOnce({ transactions: session.signed.map((item, index) => ({ request: item.entry,
    status: index === 0 ? { data: { hash } } : undefined })) })
  mocks.transaction.mockResolvedValue({ hash, to: entry.target, input: entry.data, value: BigInt(entry.value), chainId: entry.chain, blockHash })
  await expect(launchQuotedPage({ quoted: session, owner: mocks.owner, onStep: vi.fn(),
    onProgress: () => { throw new Error('View interrupted') } })).rejects.toThrow('View interrupted')
  expect(loadPageLaunch()).toMatchObject({ candidates: { 8453: [hash] }, launched: [{ chainId: 8453, projectId: 99, hash }] })
  expect(mocks.pay).not.toHaveBeenCalled()
})

test('refresh retains prior bundle bindings and detects their funding before another payment', async () => {
  const session = await quoteMultichainPage(args())
  mocks.quote.mockResolvedValueOnce({ ...session.quote, bundle_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
  const refreshed = await resumePageQuote({ session, owner: mocks.owner, onStep: vi.fn() })
  expect(refreshed.previousQuotes?.[0].bundle_uuid).toBe(session.quote?.bundle_uuid)
  mocks.bundle.mockResolvedValueOnce({ payment_received: false, transactions: [] })
    .mockResolvedValueOnce({ payment_received: true, transactions: [] })
  mocks.pay.mockImplementationOnce(async (_payment, _owner, callbacks) => callbacks.reverify())
  await expect(launchQuotedPage({ quoted: refreshed, payment, owner: mocks.owner, onStep: vi.fn(), onProgress: vi.fn() })).rejects.toThrow('already has funding')
  expect(loadPageLaunch()?.phase).toBe('executing')
  expect(mocks.send).not.toHaveBeenCalled()
})

test('an exact direct call from a different sender is not accepted as this launch', async () => {
  let sent: { to: Address; data: Hex; value: bigint }
  mocks.send.mockImplementationOnce(async (_config, call) => { sent = call; return hash })
  mocks.waitReceipt.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(quoteMultichainPage({ ...args(), chainIds: [8453] })).rejects.toThrow('RPC unavailable')
  const session = loadPageLaunch()!
  mocks.transaction.mockImplementation(async () => ({ hash, from: payment.target, to: sent.to, input: sent.data, value: sent.value, chainId: 8453, blockHash }))
  await expect(resumePageQuote({ session, owner: mocks.owner, onStep: vi.fn() })).rejects.toThrow('different account')
  expect(loadPageLaunch()?.launched).toEqual([])
  expect(mocks.send).toHaveBeenCalledTimes(1)
})
