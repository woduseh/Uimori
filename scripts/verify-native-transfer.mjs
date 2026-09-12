import { runBrowserVerification } from './browser-verification.mjs';
import widths from '../fixtures/browser-viewports.json' with { type: 'json' };

await runBrowserVerification({
  name: 'native-transfer',
  prefix: 'native-transfer',
  scope:
    'Synthetic native library graph export, reviewed copy import, model mapping and uncertain response recovery',
  files: ['tests/native-transfer-browser.spec.ts'],
  requiredCases: ['NATIVEUI01', 'NATIVEUI02'],
  requiredScreenshots: [
    `native-transfer-${widths.mobile}.png`,
    `native-transfer-${widths.desktop}.png`,
  ],
  timeout: 180000,
  limitations: [
    'Synthetic local files only; no Risu import, private source execution, live provider, or Linux updater proof.',
  ],
});
