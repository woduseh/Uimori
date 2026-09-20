import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'turn-activity',
  prefix: 'turn-activity-ui',
  scope:
    'Synthetic per-response activity expansion, lazy diagnostics, ownership, progress, failures and mobile layout',
  files: ['tests/turn-activity-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
