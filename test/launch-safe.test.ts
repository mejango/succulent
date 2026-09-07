import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, type Hex, type TransactionReceipt } from 'viem'
import { expect, test, vi } from 'vitest'
import { safeExecutionHash, verifySafeLaunch } from '@/lib/launch-safe'

const abi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])
const safe = '0x1111111111111111111111111111111111111111' as const
const proposal = `0x${'ab'.repeat(32)}` as Hex
const call = { chainId: 8453 as const, to: '0x2222222222222222222222222222222222222222' as const, value: 5n, data: '0x1234' as const }
const input = (operation = 0) => encodeFunctionData({ abi, functionName: 'execTransaction', args: [call.to, call.value, call.data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
const receipt = { logs: [{ address: safe, topics: encodeEventTopics({ abi, eventName: 'ExecutionSuccess' }),
  data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [proposal, 0n]) }] } as unknown as TransactionReceipt

test('a Safe launch requires both its exact inner call and matching successful proposal event', () => {
  expect(() => verifySafeLaunch({ safe, proposal, call, to: safe, input: input(), receipt })).not.toThrow()
  expect(() => verifySafeLaunch({ safe, proposal, call, to: safe, input: input(1), receipt })).toThrow('does not match')
  expect(() => verifySafeLaunch({ safe, proposal, call: { ...call, value: 6n }, to: safe, input: input(), receipt })).toThrow('does not match')
  expect(() => verifySafeLaunch({ safe, proposal, call, to: call.to, input: input(), receipt })).toThrow('different account')
  expect(() => verifySafeLaunch({ safe, proposal, call, to: safe, input: input(), receipt: { ...receipt, logs: [] } })).toThrow('successful execution event')
  expect(() => verifySafeLaunch({ safe, proposal: `0x${'cd'.repeat(32)}`, call, to: safe, input: input(), receipt })).toThrow('successful execution event')
})

test('pending and unsupported Safe service lookups preserve the original proposal', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ transactionHash: null }) })
  vi.stubGlobal('fetch', fetchMock)
  await expect(safeExecutionHash(8453, proposal)).rejects.toThrow('awaiting execution')
  await expect(safeExecutionHash(11155420, proposal)).rejects.toThrow('no hosted transaction service')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  vi.unstubAllGlobals()
})
