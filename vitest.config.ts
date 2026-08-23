import { defineConfig } from 'vitest/config'

// Harness packages resolve from the published @deepseek-ai/* packages in
// node_modules (peer + dev dependencies); no tsconfig path aliases exist.
export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
