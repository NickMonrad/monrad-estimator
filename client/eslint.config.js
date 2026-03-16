import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Allow ternary and short-circuit expressions used for side-effects (e.g. toggle pattern)
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true, allowShortCircuit: true }],
      // Allow variables/args prefixed with _ to be intentionally unused
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Advisory: any types in Axios error handlers and legacy API response shapes
      '@typescript-eslint/no-explicit-any': 'warn',
      // Advisory: setState-in-effect is a common sync pattern; refactor separately
      'react-hooks/set-state-in-effect': 'warn',
      // Advisory: immutability ordering issue; refactor separately
      'react-hooks/immutability': 'warn',
      // Advisory: React Compiler memoization preservation; refactor separately
      'react-hooks/preserve-manual-memoization': 'warn',
      // Advisory: useAuth exports hook + context utilities from same file
      'react-refresh/only-export-components': 'warn',
    },
  },
])
