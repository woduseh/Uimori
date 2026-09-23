import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function browserPath() {
  if (process.env.UIMORI_BROWSER_PATH) return process.env.UIMORI_BROWSER_PATH;
  const installed = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].find(existsSync);
  if (installed) return installed;
  // Deployment imports the shared utilities without needing test packages installed.
  // Resolve Playwright only when a browser command actually asks for its managed binary.
  try {
    const browser = require('@playwright/test').chromium.executablePath();
    return existsSync(browser) ? browser : undefined;
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}
