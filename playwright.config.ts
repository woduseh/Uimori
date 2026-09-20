import { MOBILE_WIDTH } from './tests/fixtures/browser-viewports.js';
import { defineConfig } from '@playwright/test';
import { browserPath } from './scripts/browser-path.mjs';
const executablePath = browserPath();
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*browser.spec.ts',
  testIgnore:
    process.env.UIMORI_PRIVATE_MATERIALS === '1' ? [] : ['**/risu-native-samples-browser.spec.ts'],
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  outputDir: process.env.UIMORI_BROWSER_OUTPUT || 'output/playwright/manual',
  use: {
    baseURL: process.env.UIMORI_BASE_URL,
    headless: true,
    // Every verified server is a loopback address; a system PAC proxy must not intercept it.
    launchOptions: { executablePath, args: ['--no-proxy-server'] },
    viewport: { width: MOBILE_WIDTH, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
