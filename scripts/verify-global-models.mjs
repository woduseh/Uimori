import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'global-models',
  scope:
    'Global role model settings, mobile/desktop navigation and immutable Run reservations; no provider calls',
  files: ['tests/global-models-browser.spec.ts'],
  requiredCases: ['GMUI01'],
  expectedCount: 2,
});
