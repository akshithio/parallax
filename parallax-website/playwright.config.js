import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/workflow',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/preview.js',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  },
});
