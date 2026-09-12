import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/extension',
  testMatch: '**/*.pw.ts',
  outputDir: 'test-results/extension',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
})
