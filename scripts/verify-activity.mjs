import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'activity',
  prefix: 'activity-ui',
  scope:
    'Synthetic reader activity timers, paginated notifications, acknowledgment, translation recovery and mobile layout',
  files: ['tests/activity-browser.spec.ts'],
  timeout: 180000,
});
