import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Provide a valid JWT_SECRET for startup validation in index.ts.
    // Individual test files may override process.env.JWT_SECRET for their own jwt.sign calls.
    env: {
      JWT_SECRET: 'test-secret-for-vitest-startup-validation!!',
    },
    server: {
      deps: {
        external: ['puppeteer'],
      },
    },
  },
})
