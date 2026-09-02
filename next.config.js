/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value:
              "frame-ancestors https://app.safe.global https://app.5afe.dev; img-src 'self' data: blob: https://juicebox.center",
          },
        ],
      },
    ]
  },
  // Same wallet-stack shims as eth.shop / juicebox.money.
  webpack(config, { webpack }) {
    config.externals.push('pino-pretty', 'lokijs', 'encoding')
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false }
    // Para dynamically imports optional peers we do not use; resolve them to empty modules.
    for (const missing of [
      '@farcaster/miniapp-sdk',
      '@farcaster/miniapp-wagmi-connector',
      '@getpara/cosmos-wallet-connectors',
      '@getpara/evm-wallet-connectors',
      '@getpara/solana-wallet-connectors',
      '@x402/core',
      '@x402/evm',
      '@x402/svm',
      '@react-native-async-storage/async-storage',
    ]) {
      config.resolve.alias[missing] = false
    }
    for (const provider of ['alchemy', 'biconomy', 'cdp', 'gelato', 'pimlico', 'porto', 'rhinestone', 'safe', 'thirdweb', 'zerodev']) {
      config.resolve.alias[`@getpara/aa-${provider}`] = false
    }
    // Para's wagmi bridge imports the connector barrel; wagmi 3 makes its vendor SDKs optional there.
    config.resolve.alias['wagmi/connectors$'] = '@wagmi/core'
    // @coinbase/wallet-sdk's worker ends in `export {}`, which the minifier rejects as a classic worker.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/[\\/]HeartbeatWorker(\.js)?$/, `${__dirname}/src/vendor/HeartbeatWorker.js`),
    )
    return config
  },
}
