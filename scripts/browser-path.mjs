import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

export function browserPath() {
  if (process.env.UIMORI_BROWSER_PATH) return process.env.UIMORI_BROWSER_PATH;
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
    chromium.executablePath(),
  ].find(existsSync);
}
