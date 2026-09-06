import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const executablePath = process.env.NR_BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
export default defineConfig({
  testDir: './tests', testMatch: '**/browser.spec.ts', fullyParallel: false, workers: 1,
  retries: 0, timeout: 30000, expect: { timeout: 10000 },
  outputDir: process.env.NR_BROWSER_OUTPUT || 'output/playwright/manual',
  use: { baseURL: process.env.NR_BASE_URL, headless: true, launchOptions: { executablePath }, viewport: { width: 390, height: 844 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
