import { JBCoreContracts, NATIVE_TOKEN, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildLaunchProjectTx,
  buildOmnichainLaunchProjectTx,
  buildRulesetConfiguration,
  buildRulesetMetadata,
  buildTerminalConfigurations,
} from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type Hex } from 'viem'

/** 10,000 tokens per ETH paid, the juicebox.money default. */
const WEIGHT = 10n ** 22n
/** JBFundAccessLimitGroup "unlimited" sentinel. */
const UNLIMITED = 2n ** 224n - 1n
/** 100% cash-out tax = cash outs off; the owner can relax this in a later ruleset. */
const CASH_OUTS_OFF = 10_000
/** Token-keyed currency id for the native token: uint32(uint160(0xEeee…EEeE)). */
const NATIVE_CURRENCY = Number(BigInt(NATIVE_TOKEN) & 0xffffffffn)
/** JBConstants.SPLITS_TOTAL_PERCENT. */
const SPLITS_TOTAL = 1_000_000_000

/** One earnings recipient on one chain: an address, or another page (its tokens go to `beneficiary`). */
export type PageSplit = {
  /** Share of every payout, 0 < percent <= 100, up to two decimals. */
  percent: number
  beneficiary: Address
  /** 0 for a plain address recipient. */
  projectId: bigint
}

/** Whole-number share out of 1e9; the total is capped by the caller at 100%. */
export function splitPercent(percent: number): number {
  return Math.round(percent * (SPLITS_TOTAL / 100))
}

/**
 * A Page is the simplest open-ended Juicebox project: accepts ETH (any token via the
 * router), no duration so rules can change any time, the owner may mint, cash outs off.
 * Earnings route out by payout: every recipient in `splits` gets its share and the owner
 * receives the rest (JBMultiTerminal sends the leftover to the project owner).
 */
function pageRuleset(chainId: JBChainId, mustStartAtOrAfter: number, splits: readonly PageSplit[]) {
  return buildRulesetConfiguration({
        mustStartAtOrAfter,
        weight: WEIGHT,
        splitGroups: splits.length
          ? [
              {
                groupId: BigInt(NATIVE_TOKEN),
                splits: splits.map(split => ({
                  percent: splitPercent(split.percent),
                  projectId: split.projectId,
                  beneficiary: split.beneficiary,
                  preferAddToBalance: false,
                  lockedUntil: 0,
                  hook: zeroAddress,
                })),
              },
            ]
          : [],
        metadata: buildRulesetMetadata({
          cashOutTaxRate: CASH_OUTS_OFF,
          allowOwnerMinting: true,
          allowSetCustomToken: true,
          allowTerminalMigration: true,
          allowSetTerminals: true,
          allowSetController: true,
          allowAddAccountingContext: true,
          allowAddPriceFeed: true,
        }),
        fundAccessLimitGroups: [
          {
            terminal: jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][chainId] as Address,
            token: NATIVE_TOKEN,
            payoutLimits: [{ amount: UNLIMITED, currency: NATIVE_CURRENCY }],
            surplusAllowances: [],
          },
        ],
  })
}

export function pageLaunchTx(args: {
  chainId: JBChainId
  owner: Address
  projectUri: string
  creationFee: bigint
  /** Shared across chains when the same page launches on several. 0 = deploy block. */
  mustStartAtOrAfter?: number
  splits?: readonly PageSplit[]
}) {
  const { chainId, mustStartAtOrAfter = 0, splits = [], ...rest } = args
  return buildLaunchProjectTx({
    ...rest,
    chainId,
    memo: 'Created on Succulent',
    rulesetConfigurations: [pageRuleset(chainId, mustStartAtOrAfter, splits)],
    terminalConfigurations: buildTerminalConfigurations({ chainId }),
  })
}

/**
 * The same page on several chains: one transaction per chain through the omnichain deployer,
 * which also deploys CCIP suckers so the deployments pair as one project. Every chain must get
 * the same salt, sender, and start timestamp or the deterministic sucker addresses diverge.
 */
export function pageOmnichainLaunchTx(args: {
  chainId: JBChainId
  chainIds: JBChainId[]
  owner: Address
  projectUri: string
  creationFee: bigint
  salt: Hex
  mustStartAtOrAfter: number
  splits?: readonly PageSplit[]
}) {
  const { chainId, mustStartAtOrAfter, splits = [], ...rest } = args
  return buildOmnichainLaunchProjectTx({
    ...rest,
    chainId,
    memo: 'Created on Succulent',
    rulesetConfigurations: [pageRuleset(chainId, mustStartAtOrAfter, splits)],
    terminalConfigurations: buildTerminalConfigurations({ chainId }),
  })
}
