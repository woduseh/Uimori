import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'model-pricing',
  scope: 'Model pricing settings and estimated cost display with synthetic API and UI evidence',
  files: ['tests/model-pricing-browser.spec.ts'],
  requiredCases: ['PRICEUI390', 'PRICEUI1440', 'PRICECOST01'],
  requiredScreenshots: [
    'model-pricing-390.png',
    'model-pricing-1440.png',
    'estimate-cost-390.png',
    'estimate-cost-1440.png',
  ],
  expectedCount: 3,
});
