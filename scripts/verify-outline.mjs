import browserWidths from '../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'outline',
  scope:
    'Hierarchical composition: five levels, level rules, targeted edits and writing one designated unit at mobile and desktop widths; synthetic provider only',
  files: ['tests/outline-browser.spec.ts'],
  requiredCases: ['OUTUI01', 'OUTUI02', 'OUTUI03', 'OUTUI04'],
  expectedCount: 8,
  requiredScreenshots: [
    `outline-panel-${MOBILE_WIDTH}.png`,
    `outline-panel-${DESKTOP_WIDTH}.png`,
    `outline-written-${MOBILE_WIDTH}.png`,
    `outline-written-${DESKTOP_WIDTH}.png`,
  ],
});
