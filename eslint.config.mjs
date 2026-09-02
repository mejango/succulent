import { fixupConfigRules } from '@eslint/compat'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  ...fixupConfigRules([...nextVitals, ...nextTypeScript]),
  {
    rules: {
      // React Compiler eligibility checks. The compiler is not enabled here, and the wallet
      // provider stack ported from eth.shop relies on refs and synchronous effect state.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  globalIgnores(['.next/**', 'node_modules/**', 'next-env.d.ts']),
])
