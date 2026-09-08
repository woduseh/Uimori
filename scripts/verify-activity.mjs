import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'activity',
  prefix: 'activity-ui',
  scope:
    'Synthetic reader activity timers, collapse, completion expiry, failures and mobile layout',
  files: ['tests/activity-browser.spec.ts'],
  requiredCases: ['ACTUI01', 'ACTUI02', 'ACTUI03', 'ACTUI04', 'ACTUI05'],
  requiredScreenshots: ['activity-desktop.png', 'activity-mobile.png'],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
