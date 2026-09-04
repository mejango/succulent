const ENDPOINT = `${(process.env.NEXT_PUBLIC_BENDYSTRAW_URL ?? 'https://bendystraw.up.railway.app').replace(/\/+$/, '')}/graphql`

/** Rows per page, server-rendered first page and each client fetch. */
export const PAGE_SIZE = 30

export type ActivityEvent = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  from: string
  txHash: string
  /** The page's cross-chain identity; the same on every chain it lives on. */
  suckerGroupId: string | null
  project: {
    name: string | null
    handle: string | null
    logoUri: string | null
    tokenSymbol: string | null
    decimals: number | null
    deployErc20Events: { items: { symbol: string | null }[] }
  } | null
  payEvent?: { amount: string; amountUsd: string | null; beneficiary: string; memo: string | null; newlyIssuedTokenCount: string } | null
  cashOutTokensEvent?: { cashOutCount: string; reclaimAmount: string; reclaimAmountUsd: string | null; beneficiary: string } | null
  projectCreateEvent?: { from: string } | null
  addToBalanceEvent?: { amount: string; memo: string | null; from: string } | null
  mintTokensEvent?: { beneficiary: string; beneficiaryTokenCount: string; caller: string; from: string } | null
  sendPayoutsEvent?: { amount: string; amountPaidOut: string; amountPaidOutUsd: string | null; caller: string; from: string } | null
  sendReservedTokensToSplitsEvent?: { tokenCount: string; from: string } | null
  /** One per split the distribution above reached; same tx as its `sendReservedTokensToSplitsEvent`. */
  sendReservedTokensToSplitEvent?: { tokenCount: string; beneficiary: string; splitProjectId: number; from: string; txHash: string; timestamp: number } | null
  autoIssueEvent?: { beneficiary: string; count: string; stageId: string; from: string } | null
  borrowLoanEvent?: { borrowAmount: string; collateral: string; beneficiary: string; token: string; from: string } | null
  repayLoanEvent?: { repayBorrowAmount: string; collateralCountToReturn: string; from: string } | null
  liquidateLoanEvent?: { borrowAmount: string; collateral: string; from: string } | null
  mintNftEvent?: { tierId: string; tokenId: string; beneficiary: string; totalAmountPaid: string; from: string } | null
  deployErc20Event?: { symbol: string | null; name: string | null; token: string; from: string } | null
  setUriEvent?: { uri: string; caller: string; from: string } | null
  projectTransferEvent?: { previousOwner: string; owner: string; from: string } | null
  rulesetQueuedEvent?: { cycleNumber: number; caller: string; from: string } | null
  addNftTierEvent?: { tierId: string; price: string; category: string; caller: string; from: string } | null
  removeNftTierEvent?: { tierId: string; caller: string; from: string } | null
  swapEvent?: { direction: string; terminalTokenAmount: string; projectTokenAmount: string; caller: string; from: string } | null
  buybackPoolEvent?: { terminalToken: string; poolId: string; caller: string; from: string } | null
  bridgeClaimEvent?: { peerChainId: number; token: string; beneficiary: string; projectTokenCount: string; terminalTokenAmount: string; caller: string; from: string } | null
}

const EVENT_KINDS = [
  'payEvent', 'cashOutTokensEvent', 'projectCreateEvent', 'addToBalanceEvent', 'mintTokensEvent',
  'sendPayoutsEvent', 'sendReservedTokensToSplitsEvent', 'sendReservedTokensToSplitEvent', 'autoIssueEvent', 'borrowLoanEvent',
  'repayLoanEvent', 'liquidateLoanEvent', 'mintNftEvent', 'deployErc20Event', 'setUriEvent',
  'projectTransferEvent', 'rulesetQueuedEvent', 'addNftTierEvent', 'removeNftTierEvent',
  'swapEvent', 'buybackPoolEvent', 'bridgeClaimEvent',
] as const

/** `suckerGroupId: null` in a where clause matches nothing, so the filter is only written when there is a group. */
const query = (withGroup: boolean, kinds: readonly string[] = EVENT_KINDS) => `query($limit: Int!, $offset: Int!${withGroup ? ', $group: String!' : ''}) {
  activityEvents(
    where: { version: 6, ${withGroup ? 'suckerGroupId: $group, ' : ''}OR: [${kinds.map(kind => `{ ${kind}_not: null }`).join(' ')}] }
    orderBy: "timestamp"
    orderDirection: "desc"
    limit: $limit
    offset: $offset
  ) {
    items {
      id chainId projectId timestamp from txHash suckerGroupId
      project { name handle logoUri tokenSymbol decimals deployErc20Events(limit: 1) { items { symbol } } }
      payEvent { amount amountUsd beneficiary memo newlyIssuedTokenCount }
      cashOutTokensEvent { cashOutCount reclaimAmount reclaimAmountUsd beneficiary }
      projectCreateEvent { from }
      addToBalanceEvent { amount memo from }
      mintTokensEvent { beneficiary beneficiaryTokenCount caller from }
      sendPayoutsEvent { amount amountPaidOut amountPaidOutUsd caller from }
      sendReservedTokensToSplitsEvent { tokenCount from }
      sendReservedTokensToSplitEvent { tokenCount beneficiary splitProjectId from txHash timestamp }
      autoIssueEvent { beneficiary count stageId from }
      borrowLoanEvent { borrowAmount collateral beneficiary token from }
      repayLoanEvent { repayBorrowAmount collateralCountToReturn from }
      liquidateLoanEvent { borrowAmount collateral from }
      mintNftEvent { tierId tokenId beneficiary totalAmountPaid from }
      deployErc20Event { symbol name token from }
      setUriEvent { uri caller from }
      projectTransferEvent { previousOwner owner from }
      rulesetQueuedEvent { cycleNumber caller from }
      addNftTierEvent { tierId price category caller from }
      removeNftTierEvent { tierId caller from }
      swapEvent { direction terminalTokenAmount projectTokenAmount caller from }
      buybackPoolEvent { terminalToken poolId caller from }
      bridgeClaimEvent { peerChainId token beneficiary projectTokenCount terminalTokenAmount caller from }
    }
  }
}`

/** Newest V6 events across every project. Server-side only. */
export async function getRecentActivity(
  limit: number,
  offset: number,
  group: string | null = null,
  /** Indexed event fields to include; default every kind the feed shows. */
  kinds: readonly string[] = EVENT_KINDS,
): Promise<ActivityEvent[]> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: query(group !== null, kinds), variables: group ? { limit, offset, group } : { limit, offset } }),
    signal: AbortSignal.timeout(9_000),
    next: { revalidate: 10 },
  })
  if (!response.ok) throw new Error(`bendystraw ${response.status}`)
  const json = (await response.json()) as {
    data?: { activityEvents?: { items?: ActivityEvent[] } }
    errors?: { message: string }[]
  }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data?.activityEvents?.items ?? []
}

export type FeedPage = { events: ActivityEvent[]; hasMore: boolean; fetchedAt: number }

/** One feed page plus the clock it was read at, so server and client agree on "how long ago". */
export async function getFeedPage(offset: number, group: string | null = null, kinds?: readonly string[]): Promise<FeedPage> {
  const page = await getRecentActivity(PAGE_SIZE + 1, offset, group, kinds)
  return { events: page.slice(0, PAGE_SIZE), hasMore: page.length > PAGE_SIZE, fetchedAt: Date.now() }
}

export type PageRef = {
  chainId: number
  projectId: number
  name: string | null
  logoUri: string | null
  suckerGroupId: string | null
  /** The same page's ids on every chain it lives on (its sucker group), itself included. */
  peers: { chainId: number; projectId: number }[]
}
type RawPageRef = Omit<PageRef, 'peers'> & { suckerGroup: { projects: { items: { chainId: number; projectId: number }[] } } | null }

const PAGE_FIELDS = 'chainId projectId name logoUri suckerGroupId suckerGroup { projects { items { chainId projectId } } }'

function withPeers(page: RawPageRef): PageRef {
  const { suckerGroup, ...rest } = page
  const peers = suckerGroup?.projects.items ?? []
  return { ...rest, peers: peers.length ? peers : [{ chainId: page.chainId, projectId: page.projectId }] }
}

/** One row per sucker group: the same page on several chains collapses into its first (biggest) hit. */
function collapsePeers(pages: PageRef[]): PageRef[] {
  const seen = new Set<string>()
  return pages.filter(page => {
    const key = page.peers.map(peer => `${peer.chainId}:${peer.projectId}`).sort().join(',')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Pages matching a name/handle fragment, biggest first, plus every Page `owner` holds. */
export async function searchPages(query: string, owner: string | null): Promise<{ mine: PageRef[]; found: PageRef[] }> {
  const gql = `query($q: String!, $owner: String!, $withOwner: Boolean!) {
    found: projects(where: { version: 6, OR: [{ name_contains_nocase: $q }, { handle_contains_nocase: $q }] }, orderBy: "volumeUsd", orderDirection: "desc", limit: 12) { items { ${PAGE_FIELDS} } }
    mine: projects(where: { version: 6, owner: $owner }, orderBy: "createdAt", orderDirection: "desc", limit: 20) @include(if: $withOwner) { items { ${PAGE_FIELDS} } }
  }`
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { q: query, owner: owner?.toLowerCase() ?? '', withOwner: !!owner } }),
    signal: AbortSignal.timeout(9_000),
  })
  if (!response.ok) throw new Error(`bendystraw ${response.status}`)
  const json = (await response.json()) as {
    data?: { found?: { items: RawPageRef[] }; mine?: { items: RawPageRef[] } }
    errors?: { message: string }[]
  }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return {
    found: collapsePeers((json.data?.found?.items ?? []).map(withPeers)),
    mine: collapsePeers((json.data?.mine?.items ?? []).map(withPeers)),
  }
}

export type PinnedPage = { group: string; name: string; logoUri: string | null; handle: string | null; chainId: number; projectId: number }

/** A page by juicebox.money's `<chain>:<projectId>` reference or by handle, for the linkable pinned feed. */
export async function findPinnedPage(ref: { chainId: number; projectId: number } | { handle: string }): Promise<PinnedPage | null> {
  const where = 'handle' in ref ? 'handle: $handle, version: 6' : 'chainId: $chainId, projectId: $projectId, version: 6'
  const vars = 'handle' in ref ? '$handle: String!' : '$chainId: Int!, $projectId: Int!'
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query(${vars}) { projects(where: { ${where} }, limit: 1) { items { chainId projectId name handle logoUri suckerGroupId } } }`,
      variables: ref,
    }),
    signal: AbortSignal.timeout(9_000),
    next: { revalidate: 60 },
  })
  if (!response.ok) return null
  const json = (await response.json()) as {
    data?: { projects?: { items: { chainId: number; projectId: number; name: string | null; handle: string | null; logoUri: string | null; suckerGroupId: string | null }[] } }
  }
  const page = json.data?.projects?.items[0]
  if (!page?.suckerGroupId) return null
  return { group: page.suckerGroupId, name: page.name?.trim() || `Page ${page.projectId}`, logoUri: page.logoUri, handle: page.handle, chainId: page.chainId, projectId: page.projectId }
}
