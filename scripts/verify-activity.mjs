import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'activity',
  prefix: 'activity-ui',
  scope:
    'Synthetic reader activity timers, paginated notifications, acknowledgment, translation recovery and mobile layout',
  files: ['tests/activity-browser.spec.ts'],
  timeout: 180000,
  limitations: [
    'This runner does not replace provider codec, loopback transport, M0 or M1-local verification.',
  ],
});
