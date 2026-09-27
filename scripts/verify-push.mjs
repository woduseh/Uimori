import { runBrowserVerification } from './browser-verification.mjs';

await runBrowserVerification({
  name: 'push',
  scope:
    'Optional Push consent, revocation and protected manuscript/bookmark navigation with synthetic relay and browser subscription data',
  files: ['tests/push-browser.spec.ts'],
  limitations: [
    'Physical-phone installation, real push relay delivery and locked-device notifications are not verified by these tests.',
  ],
});
