import { runBrowserVerification } from './browser-verification.mjs';
import widths from '../fixtures/browser-viewports.json' with { type: 'json' };

await runBrowserVerification({
  name: 'native-transfer',
  prefix: 'native-transfer',
  scope:
    'Synthetic native library graph export, reviewed copy import, model mapping, uncertain response recovery, Risu card JSON import with new-chat navigation and module JSON library registration',
  files: ['tests/native-transfer-browser.spec.ts'],
  requiredCases: ['NATIVEUI01', 'NATIVEUI02', 'NATIVEUI03', 'NATIVEUI04'],
  requiredScreenshots: [
    `native-transfer-${widths.mobile}.png`,
    `native-transfer-${widths.desktop}.png`,
  ],
  timeout: 180000,
  limitations: [
    'Synthetic native files, Risu card JSON and module JSON only; no charx/risum browser upload, private source execution, live provider, or Linux updater proof.',
  ],
});
