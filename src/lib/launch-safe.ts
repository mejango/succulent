'use client'

import { decodeFunctionData, isAddressEqual, parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import type { RelayrCall } from './relayr'

const ABI = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])
const PREFIX: Partial<Record<number, string>> = { 1: 'eth', 10: 'oeth', 8453: 'base', 42161: 'arb1', 11155111: 'sep', 84532: 'basesep' }

/** The service supplies only a candidate hash; the transaction and event are verified on chain. */
export async function safeExecutionHash(chainId: number, proposal: Hex): Promise<Hex> {
  const prefix = PREFIX[chainId]
  if (!prefix) throw new Error('This Safe network has no hosted transaction service. The proposal remains saved; check its execution in Safe.')
  const response = await fetch(`https://api.safe.global/tx-service/${prefix}/api/v1/multisig-transactions/${proposal}/`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('The Safe proposal is saved. Check again after its owners execute it.')
  const result = await response.json() as { transactionHash?: unknown }
  if (typeof result.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)) throw new Error('The Safe proposal is awaiting execution. Check again after its owners execute it.')
  return result.transactionHash as Hex
}

export function verifySafeLaunch(args: { safe: Address; proposal: Hex; call: RelayrCall; to: Address; input: Hex; receipt: TransactionReceipt }): void {
  if (!isAddressEqual(args.to, args.safe)) throw new Error('The Safe execution came from a different account.')
  const decoded = decodeFunctionData({ abi: ABI, data: args.input })
  const [to, value, data, operation] = decoded.args
  if (decoded.functionName !== 'execTransaction' || !isAddressEqual(to, args.call.to) || value !== args.call.value ||
      data.toLowerCase() !== args.call.data.toLowerCase() || operation !== 0) throw new Error('The Safe execution does not match the saved launch.')
  const success = parseEventLogs({ abi: ABI, eventName: 'ExecutionSuccess', logs: args.receipt.logs })
    .some(log => isAddressEqual(log.address, args.safe) && log.args.txHash.toLowerCase() === args.proposal.toLowerCase())
  if (!success) throw new Error('The Safe launch has no matching successful execution event.')
}
