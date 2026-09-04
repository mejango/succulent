import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { combinedActivityParts, groupSameTxEvents } from '@/lib/activity'
import type { ActivityEvent } from '@/lib/bendystraw'

const base = {
  chainId: 8453,
  projectId: 7,
  timestamp: 1_700_000_000,
  from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  txHash: '0xtx',
  suckerGroupId: null,
  project: {
    name: 'Markee',
    handle: null,
    logoUri: null,
    tokenSymbol: 'ETH',
    decimals: 18,
    deployErc20Events: { items: [{ symbol: 'MARKEE' }] },
  },
} satisfies Omit<ActivityEvent, 'id'>

const text = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>).replace(/<[^>]+>/g, '')

test('a buyback pay folds swap and remint into one row', () => {
  const events: ActivityEvent[] = [
    { ...base, id: 'mint', mintTokensEvent: { beneficiary: '0xb', beneficiaryTokenCount: '950000000000000000000', caller: '0xc', from: '0xa' } },
    { ...base, id: 'swap', swapEvent: { direction: 'buy', terminalTokenAmount: '1000', projectTokenAmount: '1000000000000000000000', caller: '0xpool', from: '0xb' } },
    { ...base, id: 'pay', payEvent: { amount: '1000', amountUsd: '2500000000000000000', beneficiary: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', memo: 'gm', newlyIssuedTokenCount: '0' } },
    { ...base, id: 'other', txHash: '0xother', payEvent: { amount: '1', amountUsd: null, beneficiary: '0xd', memo: null, newlyIssuedTokenCount: '5000000000000000000' } },
  ]
  const groups = groupSameTxEvents(events)
  expect(groups.map(group => group.length)).toEqual([3, 1])

  const row = combinedActivityParts(groups[0])
  expect(row.actor).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  expect(row.direction).toBe('in')
  expect(row.memo).toBe('gm')
  expect(row.amountUsd).toBe('2500000000000000000')
  expect(text(row.action)).toBe('bought 1k MARKEE via the buyback pool, and received 950 MARKEE after the 5% reserve')

  expect(text(combinedActivityParts(groups[1]).action)).toBe('bought 5 MARKEE from issuance')
})

test('a project without an ERC-20 counts in token credits', () => {
  const event: ActivityEvent = {
    ...base,
    id: 'x',
    project: { ...base.project, deployErc20Events: { items: [] } },
    cashOutTokensEvent: { cashOutCount: '12000000000000000000', reclaimAmount: '5', reclaimAmountUsd: null, beneficiary: '0xe' },
  }
  const row = combinedActivityParts([event])
  expect(text(row.action)).toBe('cashed out 12 token credits')
  expect(row.direction).toBe('out')
})

test('a reserved distribution lists its split receipts, biggest first, instead of separate rows', () => {
  const events: ActivityEvent[] = [
    { ...base, id: 'small', sendReservedTokensToSplitEvent: { tokenCount: '1000000000000000000000', beneficiary: '0xcccccccccccccccccccccccccccccccccccccccc', splitProjectId: 0, from: '0xa', txHash: '0xtx', timestamp: base.timestamp } },
    { ...base, id: 'all', sendReservedTokensToSplitsEvent: { tokenCount: '3600000000000000000000000', from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
    { ...base, id: 'big', sendReservedTokensToSplitEvent: { tokenCount: '3599000000000000000000000', beneficiary: '0x0000000000000000000000000000000000000000', splitProjectId: 9, from: '0xa', txHash: '0xtx', timestamp: base.timestamp } },
    { ...base, id: 'lone', txHash: '0xlone', sendReservedTokensToSplitEvent: { tokenCount: '2000000000000000000', beneficiary: '0xdddddddddddddddddddddddddddddddddddddddd', splitProjectId: 0, from: '0xa', txHash: '0xlone', timestamp: base.timestamp } },
  ]
  const groups = groupSameTxEvents(events)
  expect(groups.map(group => group.length)).toEqual([3, 1])

  const row = combinedActivityParts(groups[0])
  expect(row.actor).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  expect(text(row.action)).toBe('distributed reserved 3.6m MARKEE')
  expect(row.recipients.map(recipient => [recipient.splitProjectId, recipient.beneficiary])).toEqual([
    [9, '0x0000000000000000000000000000000000000000'],
    [0, '0xcccccccccccccccccccccccccccccccccccccccc'],
  ])

  const lone = combinedActivityParts(groups[1])
  expect(lone.actor).toBe('0xdddddddddddddddddddddddddddddddddddddddd')
  expect(text(lone.action)).toBe('received 2 MARKEE from a reserved split')
  expect(lone.recipients).toEqual([])
})
