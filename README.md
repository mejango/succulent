# Succulent

A mobile-first live feed of everything happening across Juicebox V6, for succulent.money.

One page, one data source: the bendystraw indexer's `activityEvents`, rendered with the same
row grammar as the Latest rail on juicebox.money.

**Post** (top right) picks a Page (a Juicebox project), takes a memo and an optional ETH payment,
and sends one `pay` to the Page's terminal. A zero-value pay is a valid memo-only post. **Create a
page** pins a name and optional logo through juicebox.center, then launches the simplest open-ended
project (`src/lib/page-launch.ts`): ETH in, rules changeable any time, owner may mint and use surplus,
cash outs off. Wallets include injected wallets, WalletConnect, Coinbase, Safe, and optional Para sign-in.

Multi-network creation uses Relayr on either the four mainnets or the four Sepolia testnets. The
launch is saved before signing; each chain's authorization and every quote remain available after a
reload. Only after Relayr returns and binds its quote to the exact signed calls does the payer choose
a funding chain and its quoted ETH cost. One payment covers destination gas and creation fees.
Single-network launches and Safe or non-forwarding targets use direct wallet transactions with the
same saved-launch recovery. Safe execution hashes can be supplied when its service is unavailable.
An interrupted payment or launch stays pending until its original transactions are verified on chain;
resuming never automatically repeats an uncertain wallet submission. Launch recovery requires browser
storage and Web Locks. The name, logo, splits, and networks stay fixed while a launch is pending.

juicebox.center allowlists pin requests by Origin. `extensions/jbcenter` has `https://succulent.money`,
`https://dev.succulent.money`, and `http://localhost:3004` added; until that deploys, Create a page fails
with "Origin is not allowed".

```
npm install --legacy-peer-deps   # Para's optional peer chain conflicts with viem's ox otherwise
npm run dev      # http://localhost:3004
npm run check    # typecheck, lint, tests, build
LIVE=1 npm test  # also simulates the pay and launch transactions against Base and Ethereum
```

Env: see `.env.example`. Deploys as a Dockerfile service on Railway (`railway.json`).

## Look

Deliberately not juicebox.money. The palette is the plant: a powdery farina ground `#E4EAE2`,
pine ink `#1B2C27`, stem greys, moss `#2C6A4D` for inflows and stressed-tip rose `#B94A6A` for
outflows. Type is Young Serif for the wordmark and sheet titles only, IBM Plex Sans for prose, IBM Plex Mono
for times, addresses, chains, and amounts. The signature is the stem: a continuous line down the
left with a node per transaction and mono timestamps in the gutter. On load the wordmark shows for a
beat, is eaten letter by letter from the right, and the watermelon slides onto the stem; the header
stays fixed while rows scroll under it. Rows that arrive from a poll bloom briefly. Tokens live in `src/app/globals.css`.
