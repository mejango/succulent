# Succulent

A mobile-first live feed of everything happening across Juicebox V6, for succulent.money.

One page, one data source: the bendystraw indexer's `activityEvents`, rendered with the same
row grammar as the Latest rail on juicebox.money.

**Post** (top right) picks a Page (a Juicebox project), takes a memo and an optional ETH payment,
and sends one `pay` to the Page's terminal. A zero-value pay is a valid memo-only post. **Create a
page** pins a name and optional logo through juicebox.center, then launches the simplest open-ended
project (`src/lib/page-launch.ts`): ETH in, rules changeable any time, owner may mint and use surplus,
cash outs off. Wallets: the browser's injected wallet only, so on phones open it inside a wallet app.

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
