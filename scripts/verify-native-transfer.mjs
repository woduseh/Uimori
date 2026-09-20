import { runBrowserVerification } from './browser-verification.mjs';
import widths from '../fixtures/browser-viewports.json' with { type: 'json' };
await runBrowserVerification({
  name: 'native-transfer',
  prefix: 'native-transfer',
  scope:
    'Single native Risu import entry, synthetic bot/persona card import, new-chat navigation, and module library registration',
  files: ['tests/native-transfer-browser.spec.ts'],
  requiredCases: ['NATIVEUI01', 'NATIVEUI02', 'NATIVEUI03', 'NATIVEUI04'],
  requiredScreenshots: [
    `native-transfer-entry-${widths.mobile}.png`,
    `native-transfer-modal-${widths.mobile}.png`,
    `native-transfer-entry-${widths.desktop}.png`,
    `native-transfer-modal-${widths.desktop}.png`,
  ],
  timeout: 180000,
  limitations: [
    'Synthetic Risu card JSON and module JSON only; no charx/risum browser upload, private source execution, live provider, or physical-device proof.',
  ],
});
