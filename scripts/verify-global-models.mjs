import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'global-models',
  scope:
    'Global defaults, chat-pinned writing settings, mobile/desktop navigation and immutable Run reservations; no provider calls',
  files: ['tests/global-models-browser.spec.ts'],
  requiredCases: ['GMUI01', 'GMUI02'],
  expectedCount: 4,
});
