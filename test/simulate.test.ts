/**
 * Live simulations against the real chains (eth_call from a funded stand-in). Run with LIVE=1.
 * They prove the encoded pay and launch transactions are accepted by the deployed contracts.
 */
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { buildPayTx, getAccountingContexts, getProjectCreationFee, resolvePaymentTerminal } from '@bananapus/nana-sdk-core/v6'
import { createPublicClient, http, parseEther, toHex, type Address, type PublicClient } from 'viem'
import { base, mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'
import { pageLaunchTx, pageOmnichainLaunchTx } from '@/lib/page-launch'
import { payOptionsFor } from '@/lib/pay-options'
import { projectIdFromLogs } from '@/lib/tx'

const live = process.env.LIVE === '1'
const account: Address = '0x1111111111111111111111111111111111111111'
const rich = [{ address: account, balance: parseEther('10') }]
// OP-stack chain types add transaction formatters the SDK's generic PublicClient does not model.
const baseClient = createPublicClient({ chain: base, transport: http('https://base-rpc.publicnode.com') }) as unknown as PublicClient
const mainnetClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') }) as unknown as PublicClient

describe.skipIf(!live)('live simulations', () => {
  test('memo-only and ETH pays to Markee (Base 7) go through JBMultiTerminal', async () => {
    const terminal = await resolvePaymentTerminal(baseClient, { chainId: 8453, projectId: 7n, token: NATIVE_TOKEN })
    expect(terminal.isRouter).toBe(false)
    for (const amount of [0n, parseEther('0.001')]) {
      const tx = buildPayTx({ chainId: 8453, terminal: terminal.address, projectId: 7n, token: NATIVE_TOKEN, amount, beneficiary: account, memo: 'succulent simulation' })
      const { result } = await baseClient.simulateContract({ ...tx, account, stateOverride: rich })
      expect(typeof result).toBe('bigint')
    }
  }, 60_000)

  test('Artizen (Base 6) accounts in USDC and takes ETH through its primary ETH terminal (a router)', async () => {
    const contexts = await getAccountingContexts(baseClient, { chainId: 8453, projectId: 6n })
    expect(contexts.some(c => c.token.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(true)
    expect(contexts.some(c => c.token.toLowerCase() === NATIVE_TOKEN.toLowerCase())).toBe(false)
    const eth = await resolvePaymentTerminal(baseClient, { chainId: 8453, projectId: 6n, token: NATIVE_TOKEN })
    const tx = buildPayTx({ chainId: 8453, terminal: eth.address, projectId: 6n, token: NATIVE_TOKEN, amount: parseEther('0.001'), beneficiary: account, memo: 'succulent simulation' })
    const { result } = await baseClient.simulateContract({ ...tx, account, stateOverride: rich })
    expect(typeof result).toBe('bigint')
  }, 60_000)

  test('pay options come from the chain: Artizen leads with USDC, Markee with ETH', async () => {
    const artizen = await payOptionsFor(baseClient, 8453, 6)
    expect(artizen.map(o => `${o.symbol}${o.viaRouter ? '*' : ''}`)).toEqual(['USDC', 'ETH*'])
    const markee = await payOptionsFor(baseClient, 8453, 7)
    expect(markee[0]).toMatchObject({ symbol: 'ETH', viaRouter: false })
    console.log('Markee options', markee.map(o => `${o.symbol}${o.viaRouter ? '*' : ''}`))
  }, 60_000)

  test('the project id is read from a real omnichain-deployer launch receipt', async () => {
    // Base page 14 ("choo") was launched through JBOmnichainDeployer on 2026-09-02; SDK < 2.4.1 decoded it
    // to null because that path emits LaunchRulesets, not LaunchProject.
    const center = createPublicClient({ chain: base, transport: http('https://juicebox.center/v1/rpc/8453', { fetchOptions: { headers: { Origin: 'https://succulent.money' } } }) })
    const receipt = await center.getTransactionReceipt({ hash: '0x03b504bb085597fb199512c11663b92c825ce45db4d6546c6659a2b1cc7afb1f' })
    expect(projectIdFromLogs(receipt.logs, 8453)).toBe(14)
  }, 60_000)

  test('a single-network page launches through JBController', async () => {
    const creationFee = await getProjectCreationFee(baseClient, 8453)
    const tx = pageLaunchTx({
      chainId: 8453,
      owner: account,
      projectUri: 'ipfs://QmSimulation',
      creationFee,
      splits: [{ percent: 10, beneficiary: '0x2222222222222222222222222222222222222222', projectId: 0n }, { percent: 5, beneficiary: account, projectId: 6n }],
    })
    const { result } = await baseClient.simulateContract({ ...tx, account, stateOverride: rich })
    expect(result).toBeGreaterThan(0n)
  }, 60_000)

  test('a two-network page launches through JBOmnichainDeployer on both chains', async () => {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
    const mustStartAtOrAfter = Math.floor(Date.now() / 1000)
    for (const [client, chainId] of [[baseClient, 8453], [mainnetClient, 1]] as const) {
      const creationFee = await getProjectCreationFee(client, chainId)
      const tx = pageOmnichainLaunchTx({ chainId, chainIds: [8453, 1], owner: account, projectUri: 'ipfs://QmSimulation', creationFee, salt, mustStartAtOrAfter })
      const { result } = await client.simulateContract({ ...tx, account, stateOverride: rich } as never)
      expect(result).toBeDefined()
    }
  }, 120_000)
})
