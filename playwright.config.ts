import { MOBILE_WIDTH } from './tests/fixtures/browser-viewports.js';
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
// Kept in step with `browserPath()` in scripts/lib.mjs; see the note there.
const executablePath =
  process.env.NR_BROWSER_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].find(existsSync);
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  outputDir: process.env.NR_BROWSER_OUTPUT || 'output/playwright/manual',
  use: {
    baseURL: process.env.NR_BASE_URL,
    headless: true,
    // Every verified server is a loopback address; a system PAC proxy must not intercept it.
    launchOptions: { executablePath, args: ['--no-proxy-server'] },
    viewport: { width: MOBILE_WIDTH, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
