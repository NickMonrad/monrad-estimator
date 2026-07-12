import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config.js'

export default defineConfig({
  test: {
    // Inherit all base settings
    ...baseConfig.test,
    // Override env to enable the integration-test guard
    env: {
      ...baseConfig.test?.env,
      INTEGRATION_TEST: 'true',
    },
  },
})
