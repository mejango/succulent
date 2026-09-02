import { expect, test } from 'vitest'
import { pageLaunchTx, pageOmnichainLaunchTx, splitPercent } from '@/lib/page-launch'
import { destinationOn, recipientsProblem, splitsOn } from '@/lib/tx'

test('a page launch is open-ended, owner-flexible, and pays exactly the creation fee', () => {
  const tx = pageLaunchTx({
    chainId: 8453,
    owner: '0x1111111111111111111111111111111111111111',
    projectUri: 'ipfs://cid',
    creationFee: 123n,
  })
  expect(tx.functionName).toBe('launchProjectFor')
  expect(tx.value).toBe(123n)
  const [owner, uri, rulesets, terminals] = tx.args
  expect(owner).toBe('0x1111111111111111111111111111111111111111')
  expect(uri).toBe('ipfs://cid')
  expect(rulesets).toHaveLength(1)
  const ruleset = rulesets[0]
  expect(ruleset.duration).toBe(0)
  expect(ruleset.weight).toBe(10n ** 22n)
  expect(ruleset.metadata.cashOutTaxRate).toBe(10_000)
  expect(ruleset.metadata.allowOwnerMinting).toBe(true)
  expect(ruleset.metadata.allowSetTerminals).toBe(true)
  expect(ruleset.fundAccessLimitGroups[0].payoutLimits[0].amount).toBe(2n ** 224n - 1n)
  expect(ruleset.fundAccessLimitGroups[0].surplusAllowances).toHaveLength(0)
  expect(ruleset.splitGroups).toHaveLength(0)
  // Multi terminal for ETH plus the router registry so any token can pay in.
  expect(terminals.length).toBeGreaterThanOrEqual(1)
  expect(terminals[0].accountingContextsToAccept[0].token.toLowerCase()).toBe('0x000000000000000000000000000000000000eeee')
})

test('a multi-network page goes through the omnichain deployer with a sucker per other chain', () => {
  const salt = `0x${'ab'.repeat(32)}` as const
  const tx = pageOmnichainLaunchTx({
    chainId: 8453,
    chainIds: [8453, 1, 10],
    owner: '0x1111111111111111111111111111111111111111',
    projectUri: 'ipfs://cid',
    creationFee: 5n,
    salt,
    mustStartAtOrAfter: 1_800_000_000,
  })
  expect(tx.functionName).toBe('launchProjectFor')
  expect(tx.value).toBe(5n)
  const rulesets = tx.args[2]
  if (!Array.isArray(rulesets)) throw new Error('expected ruleset configurations')
  expect(rulesets[0].mustStartAtOrAfter).toBe(1_800_000_000)
  const suckers = tx.args[5]
  if (typeof suckers === 'string' || !('salt' in suckers)) throw new Error('expected the sucker deployment config')
  expect(suckers.salt).toBe(salt)
  expect(suckers.deployerConfigurations).toHaveLength(2)
})

test('earnings splits encode per chain: one percent, a destination that can differ by network', () => {
  const owner = '0x1111111111111111111111111111111111111111'
  const wallet = '0x2222222222222222222222222222222222222222' as const
  const artizen = { chainId: 8453, projectId: 6, name: 'Artizen', logoUri: null, suckerGroupId: 'g', peers: [{ chainId: 8453, projectId: 6 }, { chainId: 1, projectId: 9 }] }
  const recipients = [
    { percent: 12.5, destination: { kind: 'address' as const, address: wallet } },
    { percent: 10, destination: { kind: 'page' as const, page: artizen } },
  ]
  expect(splitsOn(8453, recipients, owner)).toEqual([
    { percent: 12.5, beneficiary: wallet, projectId: 0n },
    { percent: 10, beneficiary: owner, projectId: 6n },
  ])
  expect(splitsOn(1, recipients, owner)[1].projectId).toBe(9n)
  // Where the page is not deployed there is no split by default: the owner keeps that share.
  expect(splitsOn(10, recipients, owner)).toEqual([{ percent: 12.5, beneficiary: wallet, projectId: 0n }])
  expect(destinationOn(recipients[1], 10)).toEqual({ kind: 'none' })
  // A per-network destination redirects it: on Optimism the share goes to an address instead.
  const routed = [recipients[0], { ...recipients[1], perChain: { 10: { kind: 'address' as const, address: wallet } } }]
  expect(splitsOn(10, routed, owner)[1]).toEqual({ percent: 10, beneficiary: wallet, projectId: 0n })
  // An explicit "no split" on a chain where the page does exist also drops it there.
  const dropped = [{ ...recipients[1], perChain: { 8453: { kind: 'none' as const } } }]
  expect(splitsOn(8453, dropped, owner)).toHaveLength(0)
  expect(recipientsProblem([{ ...recipients[0], percent: 101 }])).toMatch(/101%/)
  expect(splitPercent(12.5)).toBe(125_000_000)

  const tx = pageLaunchTx({ chainId: 8453, owner, projectUri: 'ipfs://cid', creationFee: 1n, splits: splitsOn(8453, recipients, owner) })
  const group = tx.args[2][0].splitGroups[0]
  expect(group.groupId).toBe(BigInt('0x000000000000000000000000000000000000EEEe'))
  expect(group.splits.map(split => split.percent)).toEqual([125_000_000, 100_000_000])
  expect(group.splits[1].projectId).toBe(6n)
})
