import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'model-pricing',
  scope: 'Model pricing settings and estimated cost display with synthetic API and UI evidence',
  files: ['tests/model-pricing-browser.spec.ts'],
});
