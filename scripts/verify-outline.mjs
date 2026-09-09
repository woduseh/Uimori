import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'outline',
  scope:
    'Hierarchical composition: five levels, level rules, targeted edits and writing one designated unit at mobile and desktop widths; synthetic provider only',
  files: ['tests/outline-browser.spec.ts'],
  requiredCases: ['OUTUI01', 'OUTUI02'],
  expectedCount: 4,
  requiredScreenshots: [
    'outline-panel-390.png',
    'outline-panel-1440.png',
    'outline-written-390.png',
    'outline-written-1440.png',
  ],
});
