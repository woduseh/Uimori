import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'model-pricing',
  scope: 'Model pricing settings and estimated cost display with synthetic API and UI evidence',
  files: ['tests/model-pricing-browser.spec.ts'],
  requiredCases: [`PRICEUI${MOBILE_WIDTH}`, `PRICEUI${DESKTOP_WIDTH}`, 'PRICECOST01'],
  requiredScreenshots: [
    `model-pricing-${MOBILE_WIDTH}.png`,
    `model-pricing-${DESKTOP_WIDTH}.png`,
    `estimate-cost-${MOBILE_WIDTH}.png`,
    `estimate-cost-${DESKTOP_WIDTH}.png`,
  ],
  expectedCount: 3,
});
