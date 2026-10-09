import { defineConfig } from '@playwright/test';

// Generated specs pin `test.use({ channel: 'msedge' })` themselves; this config
// just gives them sane defaults (headed Edge, per-step timeout, artifacts on failure).
export default defineConfig({
  testDir: './generated',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    channel: 'msedge',
    headless: false,
    viewport: null,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  fullyParallel: false,
  workers: 1,
});