import type { ReactNode } from 'react'
import type { ActivityEvent } from './bendystraw'
import { chainName } from './chains'
import { formatCompactTokenAmount, truncateAddress } from './format'

/**
 * Row grammar ported from juicebox.money's activity feeds: same-tx grouping, the
 * primary event's actor/amount/direction, and one action fragment per event.
 */

type Category =
  | 'projectCreate' | 'pay' | 'addToBalance' | 'nftMint' | 'cashOut' | 'buybackSwap'
  | 'tokenMint' | 'autoIssue' | 'bridgeClaim'

/** Every kind of row the feed shows, with the label the filter menu uses. Order is the menu order. */
export const ACTIVITY_FILTERS = [
  ['pay', 'Payments'],
  ['cashOut', 'Cash outs'],
  ['buybackSwap', 'Buyback swaps'],
  ['tokenMint', 'Mints'],
  ['payout', 'Payouts'],
  ['reserved', 'Reserved tokens'],
  ['autoIssue', 'Auto issuance'],
  ['nftMint', 'Shop purchases'],
  ['shopItem', 'Shop items'],
  ['loan', 'Loans'],
  ['bridgeClaim', 'Bridge claims'],
  ['projectCreate', 'New pages'],
  ['reconfigure', 'Rule changes'],
  ['tokenDeploy', 'Token deploys'],
  ['infoUpdate', 'Info updates'],
  ['ownershipTransfer', 'Ownership'],
  ['addToBalance', 'Deposits'],
  ['buybackPool', 'Buyback pools'],
] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number][0]

export function activityFilterOf(event: ActivityEvent): ActivityFilter | null {
  if (event.payEvent) return 'pay'
  if (event.cashOutTokensEvent) return 'cashOut'
  if (event.swapEvent) return 'buybackSwap'
  if (event.mintTokensEvent) return 'tokenMint'
  if (event.sendPayoutsEvent) return 'payout'
  if (event.sendReservedTokensToSplitsEvent) return 'reserved'
  if (event.autoIssueEvent) return 'autoIssue'
  if (event.mintNftEvent) return 'nftMint'
  if (event.addNftTierEvent || event.removeNftTierEvent) return 'shopItem'
  if (event.borrowLoanEvent || event.repayLoanEvent || event.liquidateLoanEvent) return 'loan'
  if (event.bridgeClaimEvent) return 'bridgeClaim'
  if (event.projectCreateEvent) return 'projectCreate'
  if (event.rulesetQueuedEvent) return 'reconfigure'
  if (event.deployErc20Event) return 'tokenDeploy'
  if (event.setUriEvent) return 'infoUpdate'
  if (event.projectTransferEvent) return 'ownershipTransfer'
  if (event.addToBalanceEvent) return 'addToBalance'
  if (event.buybackPoolEvent) return 'buybackPool'
  return null
}

/** Reading order inside a group; the first present event also anchors the row. */
const GROUP_ORDER: Category[] = [
  'projectCreate', 'pay', 'addToBalance', 'nftMint', 'cashOut', 'buybackSwap',
  'tokenMint', 'autoIssue', 'bridgeClaim',
]

function category(event: ActivityEvent): Category | null {
  if (event.projectCreateEvent) return 'projectCreate'
  if (event.payEvent) return 'pay'
  if (event.addToBalanceEvent) return 'addToBalance'
  if (event.mintNftEvent) return 'nftMint'
  if (event.cashOutTokensEvent) return 'cashOut'
  if (event.swapEvent) return 'buybackSwap'
  if (event.mintTokensEvent) return 'tokenMint'
  if (event.autoIssueEvent) return 'autoIssue'
  if (event.bridgeClaimEvent) return 'bridgeClaim'
  return null
}

function rank(event: ActivityEvent): number {
  const index = GROUP_ORDER.indexOf(category(event) as Category)
  return index === -1 ? GROUP_ORDER.length : index
}

/** Collapse one transaction's events (per chain, per project) into one feed item, order preserved. */
export function groupSameTxEvents(events: ActivityEvent[]): ActivityEvent[][] {
  const groups = new Map<string, ActivityEvent[]>()
  const order: ActivityEvent[][] = []
  for (const event of events) {
    const key = `${event.chainId}:${event.projectId}:${event.txHash}`
    const group = groups.get(key)
    if (group) group.push(event)
    else {
      const fresh = [event]
      groups.set(key, fresh)
      order.push(fresh)
    }
  }
  return order
}

/** The ERC-20 symbol once deployed, else the protocol's own word for pre-token balances. */
export function tokenUnit(event: ActivityEvent): string {
  return event.project?.deployErc20Events.items[0]?.symbol || 'token credits'
}

function positive(value: string | null | undefined): boolean {
  try {
    return BigInt(value ?? '0') > 0n
  } catch {
    return false
  }
}

function Address({ address }: { address: string }) {
  return <span title={address}>{truncateAddress(address)}</span>
}

function Amount({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>
}

export type Parts = {
  actor: string
  action: ReactNode
  direction: 'in' | 'out' | null
  memo: string | null
  amountUsd: string | null | undefined
  amountRaw: string | null | undefined
}

export function activityParts(event: ActivityEvent, unit: string): Parts {
  const pay = event.payEvent
  const cashOut = event.cashOutTokensEvent
  const mint = event.mintTokensEvent
  const loan = event.borrowLoanEvent
  const swap = event.swapEvent
  const swapIsSell = swap?.direction.toLowerCase() === 'sell'
  const actor =
    pay?.beneficiary ??
    cashOut?.beneficiary ??
    mint?.beneficiary ??
    event.autoIssueEvent?.beneficiary ??
    loan?.beneficiary ??
    event.mintNftEvent?.beneficiary ??
    event.bridgeClaimEvent?.beneficiary ??
    event.projectCreateEvent?.from ??
    event.addToBalanceEvent?.from ??
    event.deployErc20Event?.from ??
    event.sendPayoutsEvent?.from ??
    event.sendReservedTokensToSplitsEvent?.from ??
    event.repayLoanEvent?.from ??
    event.liquidateLoanEvent?.from ??
    event.setUriEvent?.caller ??
    event.projectTransferEvent?.previousOwner ??
    event.rulesetQueuedEvent?.caller ??
    event.addNftTierEvent?.caller ??
    event.removeNftTierEvent?.caller ??
    // PoolManager emits the swap; `from` is the human payer.
    swap?.from ??
    swap?.caller ??
    event.buybackPoolEvent?.caller ??
    event.from
  const rawTokenCount =
    pay?.newlyIssuedTokenCount ??
    cashOut?.cashOutCount ??
    mint?.beneficiaryTokenCount ??
    event.autoIssueEvent?.count ??
    event.sendReservedTokensToSplitsEvent?.tokenCount ??
    swap?.projectTokenAmount ??
    event.bridgeClaimEvent?.projectTokenCount ??
    '0'
  const tokens = (
    <Amount>
      {formatCompactTokenAmount(rawTokenCount)} {unit}
    </Amount>
  )
  const direction: Parts['direction'] =
    pay || event.addToBalanceEvent
      ? 'in'
      : cashOut || event.sendPayoutsEvent || loan || event.liquidateLoanEvent || swapIsSell
        ? 'out'
        : event.repayLoanEvent || event.mintNftEvent || (swap && !swapIsSell) || event.bridgeClaimEvent
          ? 'in'
          : null

  const action: ReactNode = pay ? (
    positive(pay.newlyIssuedTokenCount) ? <>bought {tokens} from issuance</> : <>paid into the project</>
  ) : cashOut ? (
    <>cashed out {tokens}</>
  ) : mint ? (
    <>minted {tokens}</>
  ) : event.projectCreateEvent ? (
    <>created the project</>
  ) : event.addToBalanceEvent ? (
    <>added to balance</>
  ) : event.deployErc20Event ? (
    <>deployed token {event.deployErc20Event.symbol ? `$${event.deployErc20Event.symbol}` : ''}</>
  ) : event.sendPayoutsEvent ? (
    <>paid out</>
  ) : event.sendReservedTokensToSplitsEvent ? (
    <>distributed reserved {tokens}</>
  ) : event.autoIssueEvent ? (
    <>auto-issued {tokens}</>
  ) : loan ? (
    <>borrowed against {formatCompactTokenAmount(loan.collateral)} {unit}</>
  ) : event.repayLoanEvent ? (
    <>repaid a loan</>
  ) : event.liquidateLoanEvent ? (
    <>liquidated a loan</>
  ) : event.mintNftEvent ? (
    <>minted shop item #{event.mintNftEvent.tierId}</>
  ) : event.setUriEvent ? (
    <>updated project info</>
  ) : event.projectTransferEvent ? (
    <>transferred ownership to <Address address={event.projectTransferEvent.owner} /></>
  ) : event.rulesetQueuedEvent ? (
    <>reconfigured the project</>
  ) : event.addNftTierEvent ? (
    <>added shop item #{event.addNftTierEvent.tierId}</>
  ) : event.removeNftTierEvent ? (
    <>removed shop item #{event.removeNftTierEvent.tierId}</>
  ) : swap ? (
    <>{swapIsSell ? 'sold' : 'bought'} {tokens} via the buyback pool</>
  ) : event.buybackPoolEvent ? (
    <>set up a buyback pool</>
  ) : event.bridgeClaimEvent ? (
    <>claimed {tokens} from {chainName(event.bridgeClaimEvent.peerChainId)}</>
  ) : (
    <>updated the project</>
  )

  return {
    actor,
    action,
    direction,
    memo: pay?.memo ?? event.addToBalanceEvent?.memo ?? null,
    amountUsd: pay?.amountUsd ?? cashOut?.reclaimAmountUsd ?? event.sendPayoutsEvent?.amountPaidOutUsd,
    amountRaw:
      pay?.amount ??
      cashOut?.reclaimAmount ??
      event.addToBalanceEvent?.amount ??
      event.sendPayoutsEvent?.amountPaidOut ??
      swap?.terminalTokenAmount,
  }
}

function reservePercent(swapOut: string, minted: string): string | null {
  try {
    const gross = BigInt(swapOut)
    const net = BigInt(minted)
    if (gross <= 0n || net <= 0n || net > gross) return null
    const percent = Number(((gross - net) * 10_000n) / gross) / 100
    return percent > 0 ? percent.toFixed(percent % 1 ? 1 : 0) : null
  } catch {
    return null
  }
}

function join(nodes: ReactNode[]): ReactNode {
  if (nodes.length <= 1) return nodes[0] ?? null
  return nodes.map((node, index) => (
    <span key={index}>
      {index > 0 ? (index === nodes.length - 1 ? ', and ' : ', ') : null}
      {node}
    </span>
  ))
}

/** One row's worth of parts for a same-tx group: the primary event anchors, the rest read as clauses. */
export function combinedActivityParts(group: ActivityEvent[]): Parts {
  const unit = tokenUnit(group[0])
  const sorted = [...group].sort((a, b) => rank(a) - rank(b))
  // An issuance-route pay already says "bought X"; its mintTokensEvent is the same issuance.
  const payIssued = sorted.some(entry => positive(entry.payEvent?.newlyIssuedTokenCount))
  const ordered = payIssued ? sorted.filter(entry => !entry.mintTokensEvent) : sorted
  const parts = ordered.map(entry => activityParts(entry, unit))

  // A buyback pay pairs the pool swap (gross) with the reserved-rate remint (net).
  const buy = ordered.find(entry => entry.swapEvent && entry.swapEvent.direction.toLowerCase() !== 'sell')?.swapEvent
  const mints = ordered.filter(entry => entry.mintTokensEvent)
  if (buy && mints.length === 1) {
    const mint = mints[0].mintTokensEvent!
    const percent = reservePercent(buy.projectTokenAmount, mint.beneficiaryTokenCount)
    if (percent) {
      parts[ordered.indexOf(mints[0])].action = (
        <>
          received <Amount>{formatCompactTokenAmount(mint.beneficiaryTokenCount)} {unit}</Amount> after the {percent}% reserve
        </>
      )
    }
  }
  // A zero-issuance pay's "paid into the project" adds nothing beside the amount and "in" tag.
  const withFragments =
    ordered.length > 1
      ? ordered.filter(entry => !entry.payEvent || positive(entry.payEvent.newlyIssuedTokenCount))
      : ordered
  const actions = (withFragments.length ? withFragments : ordered).map(entry => parts[ordered.indexOf(entry)].action)

  return {
    ...parts[0],
    action: join(actions),
    memo: parts.find(part => part.memo)?.memo ?? null,
    amountUsd: parts.find(part => part.amountUsd != null)?.amountUsd,
    amountRaw: parts.find(part => part.amountRaw != null)?.amountRaw,
    direction: parts.find(part => part.direction)?.direction ?? null,
  }
}
